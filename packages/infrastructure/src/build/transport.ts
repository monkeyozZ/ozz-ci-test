import { request as httpsRequest } from 'node:https';
import {
  BuilderError,
  type BuilderClient,
  type BuildSubmit,
  type BuildCancel,
  type BuildCredentials,
  type RunEpoch,
  type BuilderErrorCode,
  type BuildInstallationFence,
} from './contracts.js';
import {
  parseSubmit,
  parseCancel,
  parseCredentials,
  parseEpoch,
  parseObservation,
  parseEventPage,
  parseIdentity,
  parseInstallationFence,
  parseFenceReceipt,
  parseInventoryPage,
  inventoryCursor,
  challenge as parseChallenge,
  isoDate,
  sha256,
  sequence,
  uuid,
} from './validation.js';

export interface BuilderHttpRequest {
  method: 'GET' | 'PUT' | 'POST';
  path: string;
  body?: string;
  signal?: AbortSignal;
}
export interface BuilderHttpResponse {
  status: number;
  body: string;
}
/** Test injection still exercises the production request/response schemas. */
export interface BuilderHttpTransport {
  request(input: BuilderHttpRequest): Promise<BuilderHttpResponse>;
}
export interface BuilderTlsConnection {
  origin: string;
  caCertificate: string;
  clientCertificate: string;
  clientPrivateKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export class HttpsBuilderTransport implements BuilderHttpTransport {
  private readonly origin: URL;
  constructor(private readonly connection: BuilderTlsConnection) {
    try {
      this.origin = new URL(connection.origin);
      if (
        this.origin.protocol !== 'https:' ||
        this.origin.username ||
        this.origin.password ||
        this.origin.pathname !== '/' ||
        this.origin.search ||
        this.origin.hash
      )
        throw new Error();
      if (
        !connection.caCertificate ||
        !connection.clientCertificate ||
        !connection.clientPrivateKey
      )
        throw new Error();
    } catch {
      throw new BuilderError('BUILD_AUTH_INVALID');
    }
  }
  async request(input: BuilderHttpRequest): Promise<BuilderHttpResponse> {
    if (input.signal?.aborted) throw new BuilderError('BUILD_TRANSPORT_CANCELLED', true);
    if (input.body && Buffer.byteLength(input.body) > 524288)
      throw new BuilderError('BUILD_PROTOCOL_INVALID');
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: BuilderError, result?: BuilderHttpResponse) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const request = httpsRequest(
        new URL(input.path, this.origin),
        {
          method: input.method,
          ca: this.connection.caCertificate,
          cert: this.connection.clientCertificate,
          key: this.connection.clientPrivateKey,
          rejectUnauthorized: true,
          agent: false,
          headers: {
            accept: 'application/json',
            ...(input.body
              ? {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(input.body),
                }
              : {}),
          },
        },
        (response) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (this.connection.maxResponseBytes ?? 1048576)) {
              finish(new BuilderError('BUILD_PROTOCOL_INVALID'));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => finish(new BuilderError('BUILD_UNAVAILABLE', true)));
          response.on('end', () =>
            finish(undefined, {
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      const timer = setTimeout(() => {
        finish(new BuilderError('BUILD_TIMEOUT', true));
        request.destroy();
      }, this.connection.timeoutMs ?? 10000);
      const abort = () => {
        finish(new BuilderError('BUILD_TRANSPORT_CANCELLED', true));
        request.destroy();
      };
      input.signal?.addEventListener('abort', abort, { once: true });
      request.on('error', (error: NodeJS.ErrnoException) =>
        finish(
          new BuilderError(
            error.code && /CERT|TLS|SSL|VERIFY/u.test(error.code)
              ? 'BUILD_TLS_INVALID'
              : 'BUILD_UNAVAILABLE',
            true,
          ),
        ),
      );
      if (input.signal?.aborted) abort();
      request.end(input.body);
    });
  }
}
export class HttpBuilderClient implements BuilderClient {
  constructor(private readonly transport: BuilderHttpTransport) {}
  private async request(
    method: BuilderHttpRequest['method'],
    path: string,
    body: unknown,
    signal?: AbortSignal,
    allowMissing = false,
  ): Promise<unknown> {
    const response = await this.transport.request({
      method,
      path,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (allowMissing && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      const codes: Record<number, BuilderErrorCode> = {
        400: 'BUILD_PROTOCOL_INVALID',
        401: 'BUILD_AUTH_INVALID',
        403: 'BUILD_AUTH_INVALID',
        404: 'BUILD_RUN_UNKNOWN',
        409: 'BUILD_SPEC_CONFLICT',
        410: 'BUILD_INVENTORY_EXPIRED',
        412: 'BUILD_EPOCH_STALE',
        422: 'BUILD_CREDENTIALS_REJECTED',
        429: 'BUILD_BUSY',
        503: 'BUILD_UNAVAILABLE',
      };
      throw new BuilderError(
        codes[response.status] ?? 'BUILD_UNAVAILABLE',
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new BuilderError('BUILD_PROTOCOL_INVALID');
    }
  }
  async identity(challenge: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(challenge))
      throw new BuilderError('BUILD_PROTOCOL_INVALID');
    return parseIdentity(
      await this.request('GET', `/v1/identity?challenge=${challenge}`, undefined, signal),
    );
  }
  async fence(request: BuildInstallationFence, signal?: AbortSignal) {
    return parseFenceReceipt(
      await this.request('POST', '/v1/installation/fence', parseInstallationFence(request), signal),
    );
  }
  async inventory(challenge: string, cursor?: string, signal?: AbortSignal) {
    return parseInventoryPage(
      await this.request(
        'GET',
        `/v1/installation?challenge=${parseChallenge(challenge)}${cursor === undefined ? '' : `&cursor=${inventoryCursor(cursor)}`}`,
        undefined,
        signal,
      ),
    );
  }
  async submit(request: BuildSubmit, signal?: AbortSignal) {
    const input = parseSubmit(request);
    return parseObservation(
      await this.request('PUT', `/v1/runs/${input.spec.runId}`, input, signal),
    );
  }
  async get(runId: string, signal?: AbortSignal) {
    const value = await this.request('GET', `/v1/runs/${uuid(runId)}`, undefined, signal, true);
    return value === null ? null : parseObservation(value);
  }
  async renew(
    runId: string,
    request: { specHash: string; epoch: RunEpoch; leaseUntil: string },
    signal?: AbortSignal,
  ) {
    return parseObservation(
      await this.request(
        'PUT',
        `/v1/runs/${uuid(runId)}/lease`,
        {
          specHash: sha256(request.specHash),
          epoch: parseEpoch(request.epoch),
          leaseUntil: isoDate(request.leaseUntil),
        },
        signal,
      ),
    );
  }
  async cancel(runId: string, request: BuildCancel, signal?: AbortSignal) {
    return parseObservation(
      await this.request('POST', `/v1/runs/${uuid(runId)}/cancel`, parseCancel(request), signal),
    );
  }
  async credentials(runId: string, request: BuildCredentials, signal?: AbortSignal) {
    return parseObservation(
      await this.request(
        'POST',
        `/v1/runs/${uuid(runId)}/credentials`,
        parseCredentials(request),
        signal,
      ),
    );
  }
  async events(runId: string, after: string, signal?: AbortSignal) {
    return parseEventPage(
      await this.request(
        'GET',
        `/v1/runs/${uuid(runId)}/events?after=${sequence(after)}`,
        undefined,
        signal,
      ),
    );
  }
}
