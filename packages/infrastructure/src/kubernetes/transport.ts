import { Agent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type {
  PromiseHttpLibrary,
  RequestContext,
  ResponseContext,
} from '@kubernetes/client-node' with { 'resolution-mode': 'import' };
import { connectionMaterial } from './config.js';
import {
  KubernetesAdapterError,
  type KubernetesAdapterOptions,
  type ParsedKubernetesConnection,
} from './contracts.js';

type KubernetesSdk = typeof import('@kubernetes/client-node', {
  with: { 'resolution-mode': 'import' },
});

export interface TransportLimits {
  /** Explicitly enlarged only for fixed, hash-verified installation manifests. */
  maxRequestBytes?: number;
  requestTimeoutMs: number;
  inspectionTimeoutMs: number;
  maxResponseBytes: number;
  maxInspectionBytes: number;
  maxNodes: number;
}

export function transportLimits(options: KubernetesAdapterOptions): TransportLimits {
  const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < min || result > max)
      throw new TypeError('Invalid Kubernetes Adapter limit');
    return result;
  };
  return {
    requestTimeoutMs: bounded(options.requestTimeoutMs, 15_000, 10, 60_000),
    inspectionTimeoutMs: bounded(options.inspectionTimeoutMs, 60_000, 10, 120_000),
    maxResponseBytes: bounded(options.maxResponseBytes, 4 * 1024 * 1024, 1024, 8 * 1024 * 1024),
    maxInspectionBytes: bounded(
      options.maxInspectionBytes,
      16 * 1024 * 1024,
      1024,
      32 * 1024 * 1024,
    ),
    maxNodes: bounded(options.maxNodes, 500, 1, 1000),
  };
}

function retryAfter(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^\d{1,6}$/u.test(value)) return Math.min(Number(value) * 1000, 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 60_000) : undefined;
}

export function statusError(response: IncomingMessage): KubernetesAdapterError | null {
  const status = response.statusCode ?? 0;
  const details = { httpStatus: status, retryAfterMs: retryAfter(response.headers['retry-after']) };
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400)
    return new KubernetesAdapterError('KUBERNETES_REDIRECT_REJECTED', false, details);
  if (status === 401)
    return new KubernetesAdapterError('KUBERNETES_UNAUTHENTICATED', false, details);
  if (status === 403) return new KubernetesAdapterError('KUBERNETES_FORBIDDEN', false, details);
  if (status === 404) return new KubernetesAdapterError('KUBERNETES_API_NOT_FOUND', false, details);
  if (status === 408 || status === 504)
    return new KubernetesAdapterError('KUBERNETES_TIMEOUT', true, details);
  if (status === 429) return new KubernetesAdapterError('KUBERNETES_RATE_LIMITED', true, details);
  if (status === 410)
    return new KubernetesAdapterError('KUBERNETES_RESOURCE_VERSION_EXPIRED', true, details);
  if (status >= 500 && status <= 599)
    return new KubernetesAdapterError('KUBERNETES_API_UNAVAILABLE', true, details);
  return new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE', false, details);
}

export function safeKubernetesError(error: unknown): KubernetesAdapterError {
  if (error instanceof KubernetesAdapterError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    [
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'INVALID_CA',
      'CERT_SIGNATURE_FAILURE',
      'CERT_UNTRUSTED',
    ].includes(code)
  )
    return new KubernetesAdapterError('KUBERNETES_TLS_INVALID');
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code))
    return new KubernetesAdapterError('KUBERNETES_TIMEOUT', true);
  if (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
    ].includes(code)
  )
    return new KubernetesAdapterError('KUBERNETES_UNREACHABLE', true);
  return new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
}

/**
 * Official SDK API serializers use this private PromiseHttpLibrary. It supplies
 * exactly one origin's credentials, does not follow redirects or environment
 * proxies, and owns all sockets until close(). No SDK/default global auth cache.
 */
class BoundedHttpsTransport implements PromiseHttpLibrary {
  readonly agent: Agent;
  private bytesRead = 0;
  private closed = false;

  constructor(
    private readonly sdk: KubernetesSdk,
    private readonly connection: ParsedKubernetesConnection,
    private readonly limits: TransportLimits,
    private readonly signal: AbortSignal,
  ) {
    const material = connectionMaterial(connection);
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: 4,
      maxFreeSockets: 1,
      timeout: limits.requestTimeoutMs,
      ca: material.ca,
      cert: material.certificate,
      key: material.privateKey,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
  }

  close(): void {
    this.closed = true;
    this.agent.destroy();
  }

  async send(context: RequestContext): Promise<ResponseContext> {
    if (this.closed) throw new KubernetesAdapterError('KUBERNETES_CANCELLED');
    const url = new URL(context.getUrl());
    if (url.origin !== this.connection.endpoint || url.username || url.password || url.hash)
      throw new KubernetesAdapterError('KUBERNETES_REDIRECT_REJECTED');
    const material = connectionMaterial(this.connection);
    const body = context.getBody();
    if (
      body !== undefined &&
      (typeof body !== 'string' ||
        Buffer.byteLength(body) > (this.limits.maxRequestBytes ?? 64 * 1024))
    )
      throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
    const headers = { ...context.getHeaders() };
    for (const key of Object.keys(headers)) {
      if (
        [
          'authorization',
          'cookie',
          'host',
          'proxy-authorization',
          'accept-encoding',
          'content-length',
          'transfer-encoding',
        ].includes(key.toLowerCase())
      )
        delete headers[key];
    }
    headers['Accept-Encoding'] = 'identity';
    headers['User-Agent'] = 'ozz-kubernetes-adapter/0.1';
    // DELETE does not get Node's implicit POST framing. Preconditions must be
    // transmitted for every SDK request that carries a body.
    if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
    if (material.token) headers.Authorization = `Bearer ${material.token}`;
    const signals = [this.signal];
    const contextSignal = context.getSignal();
    if (contextSignal) signals.push(contextSignal);
    const timeout = AbortSignal.timeout(this.limits.requestTimeoutMs);
    signals.push(timeout);
    const signal = AbortSignal.any(signals);
    const aborted = () =>
      this.signal.aborted || contextSignal?.aborted
        ? new KubernetesAdapterError(
            this.signal.reason === 'inspection_timeout'
              ? 'KUBERNETES_TIMEOUT'
              : 'KUBERNETES_CANCELLED',
            this.signal.reason === 'inspection_timeout',
          )
        : new KubernetesAdapterError('KUBERNETES_TIMEOUT', true);
    if (signal.aborted) throw aborted();

    return new Promise<ResponseContext>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(signal.aborted ? aborted() : safeKubernetesError(error));
      };
      const request = httpsRequest(
        url,
        {
          method: context.getHttpMethod(),
          headers,
          agent: this.agent,
          signal,
          maxHeaderSize: 16 * 1024,
        },
        (response) => {
          const responseError = statusError(response);
          if (responseError) {
            fail(responseError);
            response.destroy();
            request.destroy();
            return;
          }
          const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
          const encoding = response.headers['content-encoding'];
          if (
            (contentType !== 'application/json' && !contentType?.endsWith('+json')) ||
            (encoding && encoding !== 'identity')
          ) {
            fail(new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE'));
            response.destroy();
            request.destroy();
            return;
          }
          const length = response.headers['content-length'];
          if (typeof length === 'string' && Number(length) > this.limits.maxResponseBytes) {
            fail(new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE'));
            response.destroy();
            request.destroy();
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('error', fail);
          response.on('aborted', () =>
            fail(new KubernetesAdapterError('KUBERNETES_UNREACHABLE', true)),
          );
          response.on('data', (data: Buffer) => {
            bytes += data.length;
            this.bytesRead += data.length;
            if (
              bytes > this.limits.maxResponseBytes ||
              this.bytesRead > this.limits.maxInspectionBytes
            ) {
              fail(new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE'));
              response.destroy();
              request.destroy();
            } else {
              chunks.push(data);
            }
          });
          response.once('end', () => {
            if (settled) return;
            settled = true;
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers))
              if (typeof value === 'string') responseHeaders[key] = value;
            const buffer = Buffer.concat(chunks, bytes);
            resolve(
              new this.sdk.ResponseContext(
                response.statusCode!,
                responseHeaders,
                new this.sdk.SelfDecodingBody(Promise.resolve(buffer)),
              ),
            );
          });
        },
      );
      request.on('error', fail);
      request.end(body);
    });
  }
}

export async function createInspectionClient(
  connection: ParsedKubernetesConnection,
  limits: TransportLimits,
  signal: AbortSignal,
) {
  if (
    limits.maxRequestBytes !== undefined &&
    (!Number.isSafeInteger(limits.maxRequestBytes) ||
      limits.maxRequestBytes < 1024 ||
      limits.maxRequestBytes > 1024 * 1024)
  )
    throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
  const sdk = await import('@kubernetes/client-node');
  const transport = new BoundedHttpsTransport(sdk, connection, limits, signal);
  const configuration = sdk.createConfiguration({
    baseServer: new sdk.ServerConfiguration(connection.endpoint, {}),
    httpApi: sdk.wrapHttpLibrary(transport),
  });
  return {
    /** Raw CRD JSON still uses the same origin, TLS, authentication and byte/time bounds. */
    request: async (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<unknown> => {
      if (
        !/^(?:\/api\/v1|\/apis\/[a-z0-9.-]+\/v[0-9][a-z0-9]*)\/[A-Za-z0-9./_:-]+(?:\?[A-Za-z0-9%=&_.-]+)?$/u.test(
          path,
        ) ||
        path.includes('..') ||
        path.includes('//') ||
        path.length > 2048 ||
        !['GET', 'POST', 'PUT', 'DELETE'].includes(method) ||
        (method === 'GET' && body !== undefined)
      )
        throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
      const context = new sdk.RequestContext(`${connection.endpoint}${path}`, method);
      context.setHeaderParam('Accept', 'application/json');
      if (body !== undefined) {
        context.setHeaderParam('Content-Type', 'application/json');
        context.setBody(JSON.stringify(body));
      }
      const response = await transport.send(context);
      try {
        return JSON.parse(await response.body.text()) as unknown;
      } catch {
        throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
      }
    },
    core: new sdk.CoreV1Api(configuration),
    version: new sdk.VersionApi(configuration),
    authorization: new sdk.AuthorizationV1Api(configuration),
    custom: new sdk.CustomObjectsApi(configuration),
    apps: new sdk.AppsV1Api(configuration),
    batch: new sdk.BatchV1Api(configuration),
    networking: new sdk.NetworkingV1Api(configuration),
    storage: new sdk.StorageV1Api(configuration),
    close: () => transport.close(),
  };
}

export type InspectionClient = Awaited<ReturnType<typeof createInspectionClient>>;
