import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createSecureContext, rootCertificates } from 'node:tls';
import {
  GitHubError,
  type GitHubClient,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubHttpTransport,
  type GitHubRepository,
  type GitHubPage,
  type GitHubHook,
} from './contracts.js';

export function parseGitHubToken(payload: unknown): string {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => key !== 'token')
  )
    throw new GitHubError('GITHUB_CREDENTIAL_INVALID');
  const token = (payload as { token?: unknown }).token;
  if (typeof token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,240}$/.test(token))
    throw new GitHubError('GITHUB_CREDENTIAL_INVALID');
  return token;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GitHubError('GITHUB_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function decimal(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  throw new GitHubError('GITHUB_INVALID_RESPONSE');
}
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function commitTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  let title = '';
  for (const character of value) {
    if (character === '\r' || character === '\n') break;
    if (hasControlCharacter(character)) continue;
    if (title.length + character.length > 160) break;
    title += character;
  }
  return title;
}
function string(value: unknown, max = 255): string {
  if (typeof value !== 'string' || !value || value.length > max || hasControlCharacter(value))
    throw new GitHubError('GITHUB_INVALID_RESPONSE');
  return value;
}
export function gitBranchRef(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('refs/heads/') || value.length > 270)
    throw new GitHubError('GITHUB_COMMIT_INVALID');
  const ref = value.slice(11);
  if (
    !ref ||
    hasControlCharacter(ref) ||
    Array.from(ref).some((character) => ' ~^:?*[\\'.includes(character)) ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    ref.endsWith('.') ||
    ref.endsWith('/') ||
    ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  )
    throw new GitHubError('GITHUB_COMMIT_INVALID');
  return value;
}
export function gitCommitSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value) || /^0{40}$/.test(value))
    throw new GitHubError('GITHUB_COMMIT_INVALID');
  return value;
}
export function gitRelativePath(value: unknown, allowRoot = false): string {
  if (allowRoot && value === '.') return '.';
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 500 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    hasControlCharacter(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  )
    throw new GitHubError('GITHUB_PATH_INVALID');
  return value;
}
function repository(value: unknown): GitHubRepository {
  const row = object(value),
    fullName = string(row.full_name);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) ||
    fullName.split('/').some((part) => part === '.' || part === '..') ||
    typeof row.private !== 'boolean' ||
    typeof row.archived !== 'boolean'
  )
    throw new GitHubError('GITHUB_INVALID_RESPONSE');
  const defaultBranch = string(row.default_branch);
  gitBranchRef(`refs/heads/${defaultBranch}`);
  return {
    id: decimal(row.id),
    fullName,
    defaultBranch,
    private: row.private,
    archived: row.archived,
  };
}
function hook(value: unknown): GitHubHook {
  const row = object(value),
    config = object(row.config);
  if (
    row.name !== 'web' ||
    typeof row.active !== 'boolean' ||
    !Array.isArray(row.events) ||
    row.events.length > 100
  )
    throw new GitHubError('GITHUB_HOOK_INVALID');
  return {
    id: decimal(row.id),
    active: row.active,
    url: string(config.url, 2048),
    events: row.events.map((event) => string(event, 100)),
  };
}

function linkParts(value: string): string[] {
  const parts: string[] = [];
  let start = 0,
    angle = false,
    quote = false,
    escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && char === '\\') {
      escaped = true;
      continue;
    }
    if (!angle && char === '"') quote = !quote;
    if (!quote && char === '<') {
      if (angle) throw new GitHubError('GITHUB_PAGINATION_INVALID');
      angle = true;
    }
    if (!quote && char === '>') {
      if (!angle) throw new GitHubError('GITHUB_PAGINATION_INVALID');
      angle = false;
    }
    if (char === ',' && !angle && !quote) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (angle || quote || escaped) throw new GitHubError('GITHUB_PAGINATION_INVALID');
  parts.push(value.slice(start));
  return parts;
}

function validateCaCertificate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536)
    throw new GitHubError('GITHUB_TLS_INVALID');
  try {
    const certificates = value.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    );
    if (
      !certificates?.length ||
      certificates.length > 16 ||
      certificates.join('').replace(/\s/g, '') !== value.replace(/\s/g, '') ||
      certificates.some((certificate) => !new X509Certificate(certificate).ca)
    )
      throw new Error();
    createSecureContext({ ca: value });
  } catch {
    throw new GitHubError('GITHUB_TLS_INVALID');
  }
}

export class HttpsGitHubTransport implements GitHubHttpTransport {
  constructor(private readonly options: { caCertificate?: string } = {}) {
    if (options.caCertificate !== undefined) validateCaCertificate(options.caCertificate);
  }
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.signal?.aborted) throw new GitHubError('GITHUB_CANCELLED');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: GitHubError, result?: GitHubHttpResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const request = httpsRequest(
        input.url,
        {
          method: input.method,
          headers: input.headers,
          agent: false,
          rejectUnauthorized: true,
          ...(this.options.caCertificate
            ? { ca: [...rootCertificates, this.options.caCertificate] }
            : {}),
        },
        (response) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > input.maxResponseBytes) {
              finish(new GitHubError('GITHUB_RESPONSE_TOO_LARGE'));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => finish(new GitHubError('GITHUB_UNAVAILABLE', true)));
          response.on('end', () =>
            finish(undefined, {
              status: response.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.join(',') : value,
                ]),
              ),
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      const timer = setTimeout(() => {
        finish(new GitHubError('GITHUB_TIMEOUT', true));
        request.destroy();
      }, input.timeoutMs);
      const abort = () => {
        finish(new GitHubError('GITHUB_CANCELLED'));
        request.destroy();
      };
      input.signal?.addEventListener('abort', abort, { once: true });
      request.on('error', (error: NodeJS.ErrnoException) =>
        finish(
          new GitHubError(
            error.code && /TLS|CERT|SSL|VERIFY/.test(error.code)
              ? 'GITHUB_TLS_INVALID'
              : 'GITHUB_UNAVAILABLE',
            true,
          ),
        ),
      );
      if (input.signal?.aborted) abort();
      request.end(input.body);
    });
  }
}

export interface GitHubAdapterOptions {
  /** Constructor injection only. The management API never accepts origins or transports. */
  apiOrigin?: string;
  cloneOrigin?: string;
  cloneCaCertificate?: string;
  transport?: GitHubHttpTransport;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}
export class GitHubAdapter implements GitHubClient {
  private readonly apiOrigin: string;
  private readonly cloneOrigin: string;
  private readonly transport: GitHubHttpTransport;
  constructor(private readonly options: GitHubAdapterOptions = {}) {
    if (
      (options.requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.requestTimeoutMs) ||
          options.requestTimeoutMs < 100 ||
          options.requestTimeoutMs > 30000)) ||
      (options.maxResponseBytes !== undefined &&
        (!Number.isSafeInteger(options.maxResponseBytes) ||
          options.maxResponseBytes < 1024 ||
          options.maxResponseBytes > 4 * 1024 * 1024))
    )
      throw new GitHubError('GITHUB_INVALID_RESPONSE');
    const origin = (input: string) => {
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        throw new GitHubError('GITHUB_INVALID_RESPONSE');
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new GitHubError('GITHUB_INVALID_RESPONSE');
      return url.origin;
    };
    this.apiOrigin = origin(options.apiOrigin ?? 'https://api.github.com');
    this.cloneOrigin = origin(options.cloneOrigin ?? 'https://github.com');
    if (options.cloneCaCertificate !== undefined) validateCaCertificate(options.cloneCaCertificate);
    this.transport = options.transport ?? new HttpsGitHubTransport();
  }
  private async request(
    token: string,
    path: string,
    signal?: AbortSignal,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    value?: unknown,
  ) {
    parseGitHubToken({ token });
    const url = new URL(path, this.apiOrigin);
    if (url.origin !== this.apiOrigin || !path.startsWith('/') || path.startsWith('//'))
      throw new GitHubError('GITHUB_INVALID_RESPONSE');
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    let response: GitHubHttpResponse;
    try {
      response = await this.transport.request({
        method,
        url: url.href,
        signal,
        body,
        timeoutMs: this.options.requestTimeoutMs ?? 10000,
        maxResponseBytes: this.options.maxResponseBytes ?? 2 * 1024 * 1024,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ozz-control-plane',
          ...(body
            ? { 'content-type': 'application/json', 'content-length': String(body.length) }
            : {}),
        },
      });
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(signal?.aborted ? 'GITHUB_CANCELLED' : 'GITHUB_UNAVAILABLE', true);
    }
    if (response.body.length > (this.options.maxResponseBytes ?? 2 * 1024 * 1024))
      throw new GitHubError('GITHUB_RESPONSE_TOO_LARGE');
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 401) throw new GitHubError('GITHUB_UNAUTHENTICATED');
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers['x-ratelimit-remaining'] === '0' || response.headers['retry-after']))
      )
        throw new GitHubError('GITHUB_RATE_LIMITED', true);
      if (response.status === 403) throw new GitHubError('GITHUB_FORBIDDEN');
      if (response.status === 404) throw new GitHubError('GITHUB_NOT_FOUND');
      if (response.status >= 500) throw new GitHubError('GITHUB_UNAVAILABLE', true);
      throw new GitHubError('GITHUB_INVALID_RESPONSE');
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
      throw new GitHubError('GITHUB_INVALID_RESPONSE');
    try {
      return {
        data: JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(response.body),
        ) as unknown,
        headers: response.headers,
        url,
      };
    } catch {
      throw new GitHubError('GITHUB_INVALID_RESPONSE');
    }
  }
  private pageNumber(page: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
      throw new GitHubError('GITHUB_PAGINATION_INVALID');
    return page;
  }
  private async page<T>(
    token: string,
    path: string,
    page: number,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<GitHubPage<T>> {
    const response = await this.request(
      token,
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${this.pageNumber(page)}`,
      signal,
    );
    if (!Array.isArray(response.data) || response.data.length > 100)
      throw new GitHubError('GITHUB_INVALID_RESPONSE');
    let nextPage: number | null = null;
    const link = response.headers.link;
    if (link) {
      if (link.length > 4096) throw new GitHubError('GITHUB_PAGINATION_INVALID');
      for (const part of linkParts(link)) {
        const match = /^\s*<([^>]+)>;\s*rel="([a-z]+)"\s*$/.exec(part);
        if (!match) throw new GitHubError('GITHUB_PAGINATION_INVALID');
        if (match[2] !== 'next') continue;
        let next: URL;
        try {
          next = new URL(match[1]!);
        } catch {
          throw new GitHubError('GITHUB_PAGINATION_INVALID');
        }
        const number = Number(next.searchParams.get('page'));
        const expectedQuery = new URLSearchParams(response.url.search);
        const actualQuery = new URLSearchParams(next.search);
        expectedQuery.set('page', String(number));
        expectedQuery.sort();
        actualQuery.sort();
        if (
          nextPage !== null ||
          next.origin !== this.apiOrigin ||
          next.username ||
          next.password ||
          next.hash ||
          next.pathname !== response.url.pathname ||
          number !== page + 1 ||
          number > 1000 ||
          expectedQuery.toString() !== actualQuery.toString()
        )
          throw new GitHubError('GITHUB_PAGINATION_INVALID');
        nextPage = number;
      }
    }
    return { data: response.data.map(parse), nextPage };
  }
  async account(token: string, signal?: AbortSignal) {
    const row = object((await this.request(token, '/user', signal)).data);
    return { id: decimal(row.id), login: string(row.login, 100) };
  }
  repositories(token: string, page = 1, signal?: AbortSignal) {
    return this.page(
      token,
      '/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name',
      page,
      repository,
      signal,
    );
  }
  async repository(token: string, githubRepositoryId: string, signal?: AbortSignal) {
    const id = decimal(githubRepositoryId);
    const result = repository((await this.request(token, `/repositories/${id}`, signal)).data);
    if (result.id !== id) throw new GitHubError('GITHUB_IDENTITY_CHANGED');
    return result;
  }
  async branches(token: string, githubRepositoryId: string, page = 1, signal?: AbortSignal) {
    const repo = await this.repository(token, githubRepositoryId, signal);
    return this.page(
      token,
      `/repos/${repo.fullName}/branches`,
      page,
      (value) => {
        const row = object(value),
          name = string(row.name),
          ref = gitBranchRef(`refs/heads/${name}`);
        return { name, ref, commitSha: gitCommitSha(object(row.commit).sha) };
      },
      signal,
    );
  }
  async commit(token: string, githubRepositoryId: string, ref: string, signal?: AbortSignal) {
    const repo = await this.repository(token, githubRepositoryId, signal);
    const sha = /^[0-9a-f]{40}$/.test(ref) ? gitCommitSha(ref) : null;
    const lookup = sha ?? gitBranchRef(ref).slice(11);
    const row = object(
      (
        await this.request(
          token,
          `/repos/${repo.fullName}/commits/${encodeURIComponent(lookup)}`,
          signal,
        )
      ).data,
    );
    const actual = gitCommitSha(row.sha);
    if (sha && actual !== sha) throw new GitHubError('GITHUB_COMMIT_INVALID');
    const commit = object(row.commit),
      tree = object(commit.tree),
      committer = commit.committer == null ? null : object(commit.committer);
    const date = committer?.date;
    return {
      sha: actual,
      treeSha: gitCommitSha(tree.sha),
      title: commitTitle(commit.message),
      committedAt:
        typeof date === 'string' && Number.isFinite(Date.parse(date))
          ? new Date(date).toISOString()
          : null,
    };
  }
  async path(
    token: string,
    githubRepositoryId: string,
    commitSha: string,
    path: string,
    kind: 'file' | 'dir',
    signal?: AbortSignal,
  ) {
    const repo = await this.repository(token, githubRepositoryId, signal);
    const relative = gitRelativePath(path, kind === 'dir');
    const result = (
      await this.request(
        token,
        `/repos/${repo.fullName}/contents/${relative === '.' ? '' : relative.split('/').map(encodeURIComponent).join('/')}?ref=${gitCommitSha(commitSha)}`,
        signal,
      )
    ).data;
    if (kind === 'dir') {
      if (!Array.isArray(result)) throw new GitHubError('GITHUB_PATH_INVALID');
    } else {
      const row = object(result);
      if (
        row.type !== 'file' ||
        !Number.isSafeInteger(row.size) ||
        Number(row.size) < 0 ||
        Number(row.size) > 1048576
      )
        throw new GitHubError('GITHUB_PATH_INVALID');
    }
  }
  async checkout(
    token: string,
    githubRepositoryId: string,
    commitSha: string,
    signal?: AbortSignal,
  ) {
    const commit = await this.commit(token, githubRepositoryId, gitCommitSha(commitSha), signal);
    const repo = await this.repository(token, githubRepositoryId, signal);
    return {
      githubRepositoryId: repo.id,
      fullName: repo.fullName,
      cloneUrl: `${this.cloneOrigin}/${repo.fullName}.git`,
      commitSha: commit.sha,
      ...(this.options.cloneCaCertificate
        ? { caCertificate: this.options.cloneCaCertificate }
        : {}),
    };
  }
  async hook(token: string, githubRepositoryId: string, hookId: string, signal?: AbortSignal) {
    const repo = await this.repository(token, githubRepositoryId, signal);
    const result = hook(
      (await this.request(token, `/repos/${repo.fullName}/hooks/${decimal(hookId)}`, signal)).data,
    );
    if (result.id !== hookId) throw new GitHubError('GITHUB_HOOK_INVALID');
    return result;
  }
  async registerHook(
    token: string,
    githubRepositoryId: string,
    input: { url: string; secret: string; hookId?: string; registrationId?: string },
    signal?: AbortSignal,
  ) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new GitHubError('GITHUB_HOOK_INVALID');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(input.secret)
    )
      throw new GitHubError('GITHUB_HOOK_INVALID');
    const repo = await this.repository(token, githubRepositoryId, signal);
    let id = input.hookId;
    // Discover a previous response-lost creation by this exact callback before creating.
    if (!id) {
      for (let page = 1; page <= 10; page++) {
        const hooks = await this.page(token, `/repos/${repo.fullName}/hooks`, page, hook, signal);
        const matches = hooks.data.filter((item) => item.url === url.href);
        if (matches.length > 1) throw new GitHubError('GITHUB_HOOK_INVALID');
        if (matches[0]) {
          if (
            !input.registrationId ||
            !/^[0-9a-f-]{36}$/.test(input.registrationId) ||
            !url.pathname.endsWith(`/${input.registrationId}`)
          )
            throw new GitHubError('GITHUB_HOOK_INVALID');
          id = matches[0].id;
          break;
        }
        if (!hooks.nextPage) break;
        if (page === 10) throw new GitHubError('GITHUB_PAGINATION_INVALID');
      }
    }
    const result = hook(
      (
        await this.request(
          token,
          `/repos/${repo.fullName}/hooks${id ? `/${decimal(id)}` : ''}`,
          signal,
          id ? 'PATCH' : 'POST',
          {
            ...(id ? {} : { name: 'web' }),
            active: true,
            events: ['push'],
            config: {
              url: url.href,
              content_type: 'json',
              insecure_ssl: '0',
              secret: input.secret,
            },
          },
        )
      ).data,
    );
    if (result.url !== url.href || !result.active || !result.events.includes('push'))
      throw new GitHubError('GITHUB_HOOK_INVALID');
    return result;
  }
}
