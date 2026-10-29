import type { IncomingHttpHeaders } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import {
  RegistryAdapterError,
  type ParsedImageReference,
  type RegistryAdapterOptions,
} from './contracts.js';
import type { RegistryAccessMaterial } from './access.js';
import { publicRedirectAddress, publicRedirectLookup } from './redirects.js';

export interface RegistryLimits {
  httpProxy?: string;
  proxyBlobOrigins: string[];
  requestTimeoutMs: number;
  resolutionTimeoutMs: number;
  maxResponseBytes: number;
  maxResolutionBytes: number;
  maxRequests: number;
  maxDescriptors: number;
}

export function registryLimits(options: RegistryAdapterOptions): RegistryLimits {
  let httpProxy: string | undefined;
  if (options.httpProxy !== undefined) {
    try {
      const url = new URL(options.httpProxy);
      if (
        options.httpProxy.length > 2048 ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error();
      httpProxy = url.origin;
    } catch {
      throw new RangeError('Invalid Registry Adapter proxy');
    }
  }
  const proxyBlobOrigins = options.proxyBlobOrigins ?? [];
  if (proxyBlobOrigins.length > 8 || (proxyBlobOrigins.length > 0 && !httpProxy))
    throw new RangeError('Invalid Registry Adapter proxy blob origins');
  for (const origin of proxyBlobOrigins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
        throw new Error();
    } catch {
      throw new RangeError('Invalid Registry Adapter proxy blob origins');
    }
  }
  const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < min || result > max)
      throw new RangeError('Invalid Registry Adapter limit');
    return result;
  };
  return {
    ...(httpProxy ? { httpProxy } : {}),
    proxyBlobOrigins,
    requestTimeoutMs: bounded(options.requestTimeoutMs, 15_000, 10, 60_000),
    resolutionTimeoutMs: bounded(options.resolutionTimeoutMs, 60_000, 10, 180_000),
    maxResponseBytes: bounded(options.maxResponseBytes, 4 * 1024 * 1024, 1024, 8 * 1024 * 1024),
    maxResolutionBytes: bounded(
      options.maxResolutionBytes,
      16 * 1024 * 1024,
      1024,
      32 * 1024 * 1024,
    ),
    maxRequests: bounded(options.maxRequests, 64, 1, 128),
    maxDescriptors: bounded(options.maxDescriptors, 128, 1, 256),
  };
}

export interface RegistryHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export function retryAfter(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^\d{1,9}$/u.test(value)) return Math.min(Number(value) * 1000, 120_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 120_000) : undefined;
}

export function statusError(response: RegistryHttpResponse): RegistryAdapterError {
  const details = {
    httpStatus: response.status,
    retryAfterMs: retryAfter(response.headers['retry-after']),
  };
  if (response.status >= 300 && response.status < 400)
    return new RegistryAdapterError('REGISTRY_REDIRECT_REJECTED', false, details);
  if (response.status === 401)
    return new RegistryAdapterError('REGISTRY_UNAUTHENTICATED', false, details);
  if (response.status === 403)
    return new RegistryAdapterError('REGISTRY_FORBIDDEN', false, details);
  if (response.status === 404)
    return new RegistryAdapterError('REGISTRY_IMAGE_NOT_FOUND', false, details);
  if (response.status === 408 || response.status === 504)
    return new RegistryAdapterError('REGISTRY_TIMEOUT', true, details);
  if (response.status === 429)
    return new RegistryAdapterError('REGISTRY_RATE_LIMITED', true, details);
  if (response.status >= 500 && response.status <= 599)
    return new RegistryAdapterError('REGISTRY_UNAVAILABLE', true, details);
  return new RegistryAdapterError('REGISTRY_INVALID_RESPONSE', false, details);
}

function safeError(error: unknown): RegistryAdapterError {
  if (error instanceof RegistryAdapterError) return error;
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
    return new RegistryAdapterError('REGISTRY_TLS_INVALID');
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code))
    return new RegistryAdapterError('REGISTRY_TIMEOUT', true);
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
    return new RegistryAdapterError('REGISTRY_UNREACHABLE', true);
  return new RegistryAdapterError('REGISTRY_INVALID_RESPONSE');
}

export function responseJson(response: RegistryHttpResponse): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RegistryAdapterError('REGISTRY_INVALID_RESPONSE');
  }
}

export function contentType(response: RegistryHttpResponse): string {
  return (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

/** Parses one RFC 7235 challenge without splitting commas inside a quoted realm/scope. */
function challenge(value: string | string[] | undefined): {
  scheme: 'basic' | 'bearer';
  parameters: Record<string, string>;
} {
  const invalid = () => new RegistryAdapterError('REGISTRY_AUTH_CHALLENGE_INVALID');
  if (typeof value !== 'string' || value.length > 16 * 1024) throw invalid();
  const match = /^(Basic|Bearer)\s+/iu.exec(value);
  if (!match) throw invalid();
  const parameters: Record<string, string> = Object.create(null) as Record<string, string>;
  let remaining = value.slice(match[0].length);
  let count = 0;
  while (remaining.length) {
    const key = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/u.exec(remaining);
    if (!key || ++count > 16) throw invalid();
    const name = key[1]!.toLowerCase();
    if (parameters[name] !== undefined) throw invalid();
    remaining = remaining.slice(key[0].length);
    let parameter: string;
    if (remaining.startsWith('"')) {
      let text = '';
      let index = 1;
      let ended = false;
      for (; index < remaining.length; index += 1) {
        const character = remaining[index]!;
        if (character === '"') {
          ended = true;
          index += 1;
          break;
        }
        if (character === '\\') {
          index += 1;
          if (index >= remaining.length) throw invalid();
          text += remaining[index]!;
        } else text += character;
      }
      if (!ended) throw invalid();
      parameter = text;
      remaining = remaining.slice(index);
    } else {
      const token = /^[^\s,]+/u.exec(remaining);
      if (!token) throw invalid();
      parameter = token[0];
      remaining = remaining.slice(parameter.length);
    }
    if (/[\p{Cc}]/u.test(parameter)) throw invalid();
    parameters[name] = parameter;
    remaining = remaining.trimStart();
    if (remaining.length) {
      if (!remaining.startsWith(',')) throw invalid();
      remaining = remaining.slice(1).trimStart();
      if (!remaining) throw invalid();
    }
  }
  return { scheme: match[1]!.toLowerCase() as 'basic' | 'bearer', parameters };
}

/**
 * A single resolution owns its sockets, auth tokens and all response budgets.
 * No process-global auth cache, cookies, environment proxies or automatic redirects.
 */
export class RegistrySession {
  private readonly agent: Agent;
  private readonly signal: AbortSignal;
  private closed = false;
  private requestCount = 0;
  private bytes = 0;
  private registryAuthorization: string | undefined;

  constructor(
    readonly image: ParsedImageReference,
    readonly limits: RegistryLimits,
    private readonly material: RegistryAccessMaterial,
    private readonly callerSignal?: AbortSignal,
    private readonly actions: 'pull' | 'pull,push' = 'pull',
  ) {
    this.signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(limits.resolutionTimeoutMs)])
      : AbortSignal.timeout(limits.resolutionTimeoutMs);
    this.agent = new Agent({
      ...(limits.httpProxy ? { proxyEnv: { HTTPS_PROXY: limits.httpProxy } } : {}),
      keepAlive: true,
      maxSockets: 2,
      maxFreeSockets: 1,
      timeout: limits.requestTimeoutMs,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(material.ca ? { ca: [...material.ca] } : {}),
    });
  }

  close(): void {
    this.closed = true;
    this.registryAuthorization = undefined;
    this.agent.destroy();
  }

  private aborted(): RegistryAdapterError {
    return this.callerSignal?.aborted || this.closed
      ? new RegistryAdapterError('REGISTRY_CANCELLED')
      : new RegistryAdapterError('REGISTRY_TIMEOUT', true);
  }

  private async get(
    url: URL,
    accept: string,
    authorization?: string,
    requirePublicAddress = false,
    mutation?: { method: 'POST' | 'PUT' | 'DELETE'; body?: Buffer; contentType?: string },
  ): Promise<RegistryHttpResponse> {
    if (this.closed || this.signal.aborted) throw this.aborted();
    if (++this.requestCount > this.limits.maxRequests)
      throw new RegistryAdapterError('REGISTRY_REQUEST_LIMIT');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 8192 ||
      (authorization &&
        url.origin !== this.image.apiOrigin &&
        !this.material.tokenOrigins.has(url.origin))
    )
      throw new RegistryAdapterError('REGISTRY_REDIRECT_REJECTED');
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    if (requirePublicAddress && isIP(hostname) && !publicRedirectAddress(hostname))
      throw new RegistryAdapterError('REGISTRY_REDIRECT_REJECTED');
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(this.limits.requestTimeoutMs),
    ]);
    return new Promise<RegistryHttpResponse>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(signal.aborted ? this.aborted() : safeError(error));
      };
      const request = httpsRequest(
        url,
        {
          method: mutation?.method ?? 'GET',
          // A public redirect uses a fresh checked connection, not a socket
          // previously opened to an explicitly trusted private token service.
          agent: requirePublicAddress ? false : this.agent,
          ...(requirePublicAddress
            ? {
                lookup: publicRedirectLookup,
                rejectUnauthorized: true,
                minVersion: 'TLSv1.2',
                ...(this.material.ca ? { ca: [...this.material.ca] } : {}),
              }
            : {}),
          signal,
          maxHeaderSize: 16 * 1024,
          headers: {
            Accept: accept,
            'Accept-Encoding': 'identity',
            'User-Agent': 'ozz-registry-adapter/0.1',
            ...(authorization ? { Authorization: authorization } : {}),
            ...(mutation?.contentType ? { 'Content-Type': mutation.contentType } : {}),
            ...(mutation ? { 'Content-Length': String(mutation.body?.length ?? 0) } : {}),
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          response.on('error', fail);
          response.on('aborted', () =>
            fail(new RegistryAdapterError('REGISTRY_UNREACHABLE', true)),
          );
          if (status < 200 || status >= 300) {
            settled = true;
            resolve({ status, headers: response.headers, body: Buffer.alloc(0) });
            response.destroy();
            return;
          }
          const encoding = response.headers['content-encoding'];
          if (encoding && encoding !== 'identity') {
            fail(new RegistryAdapterError('REGISTRY_INVALID_RESPONSE'));
            response.destroy();
            return;
          }
          const contentLength = response.headers['content-length'];
          if (
            contentLength &&
            (!/^\d+$/u.test(contentLength) ||
              Number(contentLength) > this.limits.maxResponseBytes ||
              Number(contentLength) > this.limits.maxResolutionBytes - this.bytes)
          ) {
            fail(new RegistryAdapterError('REGISTRY_RESPONSE_TOO_LARGE'));
            response.destroy();
            return;
          }
          let received = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            received += chunk.length;
            this.bytes += chunk.length;
            if (
              received > this.limits.maxResponseBytes ||
              this.bytes > this.limits.maxResolutionBytes
            ) {
              fail(new RegistryAdapterError('REGISTRY_RESPONSE_TOO_LARGE'));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({ status, headers: response.headers, body: Buffer.concat(chunks, received) });
          });
        },
      );
      request.on('error', fail);
      request.end(mutation?.body);
    });
  }

  private async authorization(header: string | string[] | undefined): Promise<string> {
    const auth = challenge(header);
    if (auth.scheme === 'basic') {
      if (!this.material.basicAuthorization)
        throw new RegistryAdapterError('REGISTRY_AUTH_REQUIRED');
      return this.material.basicAuthorization;
    }
    let realm: URL;
    try {
      const value = auth.parameters.realm;
      if (!value || value.length > 4096 || /[\s\\]/u.test(value)) throw new Error();
      realm = new URL(value);
      if (realm.protocol !== 'https:' || realm.username || realm.password || realm.hash)
        throw new Error();
    } catch {
      throw new RegistryAdapterError('REGISTRY_AUTH_CHALLENGE_INVALID');
    }
    if (!this.material.tokenOrigins.has(realm.origin))
      throw new RegistryAdapterError('REGISTRY_TOKEN_ORIGIN_REJECTED');
    realm.searchParams.delete('account');
    realm.searchParams.set('scope', `repository:${this.image.repository}:${this.actions}`);
    if (auth.parameters.service) {
      if (auth.parameters.service.length > 512)
        throw new RegistryAdapterError('REGISTRY_AUTH_CHALLENGE_INVALID');
      realm.searchParams.set('service', auth.parameters.service);
    } else realm.searchParams.delete('service');
    const response = await this.get(realm, 'application/json', this.material.basicAuthorization);
    if (response.status !== 200) throw statusError(response);
    if (response.body.length > 32 * 1024 || contentType(response) !== 'application/json')
      throw new RegistryAdapterError('REGISTRY_AUTH_CHALLENGE_INVALID');
    const value = responseJson(response);
    const token = value.token ?? value.access_token;
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 16 * 1024 ||
      !/^[A-Za-z0-9._~+/-]+=*$/u.test(token) ||
      (value.token !== undefined &&
        value.access_token !== undefined &&
        value.token !== value.access_token) ||
      (value.expires_in !== undefined &&
        (typeof value.expires_in !== 'number' ||
          !Number.isSafeInteger(value.expires_in) ||
          value.expires_in <= 0))
    )
      throw new RegistryAdapterError('REGISTRY_AUTH_CHALLENGE_INVALID');
    return `Bearer ${token}`;
  }

  private async registryGet(path: string, accept: string): Promise<RegistryHttpResponse> {
    const url = new URL(path, this.image.apiOrigin);
    if (url.origin !== this.image.apiOrigin)
      throw new RegistryAdapterError('REGISTRY_REDIRECT_REJECTED');
    let response = await this.get(url, accept, this.registryAuthorization);
    if (response.status === 401) {
      this.registryAuthorization = await this.authorization(response.headers['www-authenticate']);
      response = await this.get(url, accept, this.registryAuthorization);
    }
    return response;
  }

  async manifest(reference: string, accept: string): Promise<RegistryHttpResponse> {
    const response = await this.registryGet(
      `/v2/${this.image.repository}/manifests/${encodeURIComponent(reference)}`,
      accept,
    );
    if (response.status !== 200) throw statusError(response);
    return response;
  }

  /** Used only by explicit platform-owned Registry probes, never by image resolution. */
  async write(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<RegistryHttpResponse> {
    const url = new URL(path, this.image.apiOrigin);
    if (
      this.actions !== 'pull,push' ||
      url.origin !== this.image.apiOrigin ||
      !url.pathname.startsWith(`/v2/${this.image.repository}/`) ||
      (body && body.length > 1024 * 1024)
    )
      throw new RegistryAdapterError('REGISTRY_REDIRECT_REJECTED');
    const mutation = { method, body, contentType };
    let response = await this.get(
      url,
      'application/json',
      this.registryAuthorization,
      false,
      mutation,
    );
    if (response.status === 401) {
      this.registryAuthorization = await this.authorization(response.headers['www-authenticate']);
      response = await this.get(
        url,
        'application/json',
        this.registryAuthorization,
        false,
        mutation,
      );
    }
    return response;
  }

  async blob(digest: string): Promise<RegistryHttpResponse> {
    const path = `/v2/${this.image.repository}/blobs/${encodeURIComponent(digest)}`;
    let currentUrl = new URL(path, this.image.apiOrigin);
    let response = await this.registryGet(path, 'application/octet-stream, application/json');
    for (let redirects = 0; response.status >= 300 && response.status < 400; redirects += 1) {
      const location = response.headers.location;
      if (redirects >= 2 || !location || ![301, 302, 303, 307, 308].includes(response.status))
        throw new RegistryAdapterError('REGISTRY_REDIRECT_REJECTED');
      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch {
        throw new RegistryAdapterError('REGISTRY_REDIRECT_REJECTED');
      }
      // A redirected URL receives no Basic/Bearer headers, cookies or token negotiation.
      currentUrl = target;
      response = await this.get(
        target,
        'application/octet-stream, application/json',
        undefined,
        !this.material.blobOrigins.has(target.origin) &&
          !this.limits.proxyBlobOrigins.includes(target.origin),
      );
    }
    if (response.status !== 200) throw statusError(response);
    return response;
  }
}
