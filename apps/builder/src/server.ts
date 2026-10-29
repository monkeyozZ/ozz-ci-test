import { createServer, type Server, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import {
  BuilderError,
  parseEpoch,
  isoDate,
  sha256,
  sequence,
  uuid,
  type BuildCredentials,
  type BuildCancel,
  type BuildSubmit,
  type BuildInstallationFence,
} from '@ozz/infrastructure/build';
import type { BuildManager } from './manager.js';

export function builderServer(
  manager: BuildManager,
  tls: ServerOptions,
  clientFingerprints: readonly string[],
): Server {
  let inFlight = 0;
  const server = createServer(
    { ...tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
    (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      const socket = request.socket;
      if (
        !(socket instanceof TLSSocket) ||
        !socket.authorized ||
        !clientFingerprints.includes(socket.getPeerCertificate().fingerprint256)
      ) {
        response.writeHead(403).end('{"code":"BUILD_AUTH_INVALID"}');
        request.resume();
        return;
      }
      if (inFlight >= 32) {
        response.writeHead(429).end('{"code":"BUILD_BUSY"}');
        request.resume();
        return;
      }
      inFlight += 1;
      void handle(manager, request, response)
        .catch((error) => {
          const code = error instanceof BuilderError ? error.code : 'BUILD_UNAVAILABLE';
          const status =
            code === 'BUILD_RUN_UNKNOWN'
              ? 404
              : code === 'BUILD_INVENTORY_EXPIRED'
                ? 410
                : code === 'BUILD_EPOCH_STALE'
                  ? 412
                  : code === 'BUILD_SPEC_CONFLICT'
                    ? 409
                    : code === 'BUILD_BUSY'
                      ? 429
                      : code === 'BUILD_CREDENTIALS_REJECTED'
                        ? 422
                        : code === 'BUILD_UNAVAILABLE' || code === 'BUILD_ISOLATION_UNAVAILABLE'
                          ? 503
                          : 400;
          if (!response.headersSent) response.writeHead(status).end(JSON.stringify({ code }));
          else response.destroy();
        })
        .finally(() => {
          inFlight -= 1;
        });
    },
  );
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  return server;
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers['content-encoding'] ||
    !String(request.headers['content-type']).startsWith('application/json')
  )
    throw new BuilderError('BUILD_PROTOCOL_INVALID');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk as Buffer);
    bytes += data.length;
    if (bytes > 524288) throw new BuilderError('BUILD_PROTOCOL_INVALID');
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new BuilderError('BUILD_PROTOCOL_INVALID');
  }
}
async function handle(
  manager: BuildManager,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'https://builder.invalid');
  let value: unknown;
  if (url.pathname === '/v1/identity' && request.method === 'GET')
    value = await manager.identity(url.searchParams.get('challenge') ?? '');
  else if (url.pathname === '/v1/installation' && request.method === 'GET')
    value = await manager.inventory(
      url.searchParams.get('challenge') ?? '',
      url.searchParams.get('cursor') ?? undefined,
    );
  else if (url.pathname === '/v1/installation/fence' && request.method === 'POST')
    value = await manager.fence((await body(request)) as BuildInstallationFence);
  else {
    const match = /^\/v1\/runs\/([0-9a-f-]{36})(?:\/(lease|credentials|cancel|events))?$/u.exec(
      url.pathname,
    );
    if (!match) throw new BuilderError('BUILD_RUN_UNKNOWN');
    const id = uuid(match[1]);
    const action = match[2];
    if (request.method === 'GET' && !action) {
      value = await manager.get(id);
      if (!value) throw new BuilderError('BUILD_RUN_UNKNOWN');
    } else if (request.method === 'GET' && action === 'events')
      value = await manager.events(id, sequence(url.searchParams.get('after') ?? '0'));
    else if (request.method === 'PUT' && !action) {
      const input = (await body(request)) as BuildSubmit;
      if (input?.spec?.runId !== id) throw new BuilderError('BUILD_SPEC_CONFLICT');
      value = await manager.submit(input);
    } else if (request.method === 'PUT' && action === 'lease') {
      const input = (await body(request)) as Record<string, unknown>;
      value = await manager.renew(id, {
        specHash: sha256(input.specHash),
        epoch: parseEpoch(input.epoch),
        leaseUntil: isoDate(input.leaseUntil),
      });
    } else if (request.method === 'POST' && action === 'credentials')
      value = await manager.credentials(id, (await body(request)) as BuildCredentials);
    else if (request.method === 'POST' && action === 'cancel')
      value = await manager.cancel(id, (await body(request)) as BuildCancel);
    else throw new BuilderError('BUILD_PROTOCOL_INVALID');
  }
  response.writeHead(200).end(JSON.stringify(value));
}
