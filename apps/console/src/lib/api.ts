import type { Envelope, Page } from './types';

export interface Problem {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
  code?: string;
  requestId?: string;
  errors?: unknown;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public problem: Problem,
  ) {
    super(
      problem.detail ||
        problem.title ||
        (status ? `请求失败（${status}）` : '无法连接控制面，请检查网络后重试。'),
    );
    this.name = 'ApiError';
  }
}
let csrfToken: string | null = null;
let sessionEpoch = 0;
let sessionLifetime = new AbortController();
let unauthorized: (() => void) | undefined;
export function setCsrfToken(value: string | null) {
  if (!value || value !== csrfToken) {
    sessionEpoch++;
    sessionLifetime.abort();
    sessionLifetime = new AbortController();
  }
  csrfToken = value;
}
export function onUnauthorized(handler: () => void) {
  unauthorized = handler;
}

interface RequestOptions {
  signal?: AbortSignal;
  body?: unknown;
  method?: string;
  idempotencyKey?: string;
  auth?: boolean;
}
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const epoch = sessionEpoch;
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, {});
  }
  if (epoch !== sessionEpoch) throw new DOMException('会话已切换', 'AbortError');
  if (!response.ok) {
    const fallback: Record<number, string> = {
      401: '需要重新登录。',
      403: '会话校验失败，请重新登录后重试。',
      404: '资源不存在或已被删除。',
      422: '请检查填写的内容。',
      429: '尝试过于频繁，请稍后重试。',
      502: '暂时无法连接控制面，请稍后重试。',
      503: '控制面暂时不可用，请稍后重试。',
    };
    const problem: Problem = await response
      .json()
      .catch(() => ({ title: fallback[response.status] ?? '请求未能完成，请稍后重试。' }));
    if (epoch !== sessionEpoch) throw new DOMException('会话已切换', 'AbortError');
    if (response.status === 401 && options.auth !== false) unauthorized?.();
    throw new ApiError(response.status, problem);
  }
  if (response.status === 204) return undefined as T;
  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    if (epoch !== sessionEpoch) throw new DOMException('会话已切换', 'AbortError');
    if (options.signal?.aborted) throw new DOMException('已取消读取', 'AbortError');
    throw unconfirmedResponse();
  }
  if (epoch !== sessionEpoch) throw new DOMException('会话已切换', 'AbortError');
  return data;
}
function unconfirmedResponse() {
  return new ApiError(0, {
    code: 'RESPONSE_UNCONFIRMED',
    detail: '未收到完整的控制面响应，请重试确认结果。',
  });
}
async function envelope<T>(path: string, options: RequestOptions): Promise<T> {
  const result = await request<Envelope<T>>(path, options);
  if (
    !result ||
    typeof result !== 'object' ||
    !Object.hasOwn(result, 'data') ||
    result.data === undefined
  )
    throw unconfirmedResponse();
  return result.data;
}
export const api = {
  get: <T>(path: string, signal?: AbortSignal) => envelope<T>(path, { signal }),
  list: <T>(path: string, signal?: AbortSignal) => request<Page<T>>(path, { signal }),
  create: <T>(path: string, body: unknown, key?: string) =>
    envelope<T>(path, { method: 'POST', body, idempotencyKey: key }),
  update: <T>(path: string, body: unknown) => envelope<T>(path, { method: 'PATCH', body }),
  delete: (path: string, revision?: number) =>
    request<void>(revision ? `${path}?revision=${revision}` : path, { method: 'DELETE' }),
};

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作没有完成，请重试。';
}

/** Stream GETs retain the same session fencing and failure handling as JSON requests. */
export async function eventStream(path: string, signal: AbortSignal): Promise<Response> {
  const epoch = sessionEpoch;
  const streamSignal = AbortSignal.any([signal, sessionLifetime.signal]);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: { Accept: 'text/event-stream' },
      credentials: 'same-origin',
      signal: streamSignal,
    });
  } catch (error) {
    if (streamSignal.aborted) throw error;
    throw new ApiError(0, {});
  }
  if (epoch !== sessionEpoch) {
    await response.body?.cancel().catch(() => undefined);
    throw new DOMException('会话已切换', 'AbortError');
  }
  if (!response.ok) {
    const problem: Problem = await response
      .json()
      .catch(() => ({ title: `日志请求未完成（${response.status}）` }));
    if (epoch !== sessionEpoch) throw new DOMException('会话已切换', 'AbortError');
    if (response.status === 401) unauthorized?.();
    throw new ApiError(response.status, problem);
  }
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    await response.body?.cancel();
    throw new ApiError(502, { detail: '日志源没有返回可读取的事件流。' });
  }
  return response;
}
