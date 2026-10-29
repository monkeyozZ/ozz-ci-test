import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { extname, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  privateFile,
  productDirectory,
  productHttpsOwner,
  productRoot,
  publicAppOrigin,
  readProductConfiguration,
} from './s6-github-product.mjs';

const assets = resolve(productRoot, 'apps/console/dist');
const maxRequestBytes = 512 * 1024;
const maxResponseBytes = 16 * 1024 * 1024;
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json'],
  ['.map', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function headersForRelay(headers) {
  const excluded = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'forwarded',
    ...String(headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((value) => value.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !excluded.has(name.toLowerCase()) && !name.toLowerCase().startsWith('x-forwarded-'),
    ),
  );
}

function limitedStream(maximum) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(
        bytes > maximum ? new Error('S6_HTTPS_SIZE_LIMIT') : null,
        bytes > maximum ? undefined : chunk,
      );
    },
  });
}

function failure(response, status, code) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ code });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function relayApi(request, response, activeRequests) {
  if (Number(request.headers['content-length'] ?? '0') > maxRequestBytes) {
    request.resume();
    failure(response, 413, 'S6_HTTPS_BODY_TOO_LARGE');
    return;
  }
  // The original body bytes and authentication headers are never decoded or reconstructed.
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: request.url,
    method: request.method,
    agent: false,
    headers: {
      ...headersForRelay(request.headers),
      host: '127.0.0.1:3000',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': new URL(publicAppOrigin).host,
    },
  });
  activeRequests.add(upstream);
  upstream.once('close', () => activeRequests.delete(upstream));
  const body = limitedStream(maxRequestBytes);
  body.once('error', () => {
    request.unpipe(body);
    request.resume();
    upstream.destroy();
    failure(response, 413, 'S6_HTTPS_BODY_TOO_LARGE');
  });
  request.once('aborted', () => {
    body.destroy();
    upstream.destroy();
  });
  request.once('error', () => {
    body.destroy();
    upstream.destroy();
    response.destroy();
  });
  response.once('close', () => {
    body.destroy();
    upstream.destroy();
  });
  upstream.setTimeout(120_000, () => {
    upstream.destroy();
    failure(response, 504, 'S6_HTTPS_UPSTREAM_TIMEOUT');
  });
  upstream.once('error', () => failure(response, 502, 'S6_HTTPS_UPSTREAM_UNAVAILABLE'));
  upstream.once('response', (reply) => {
    if (response.headersSent || response.destroyed || response.writableEnded) {
      reply.destroy();
      return;
    }
    response.writeHead(reply.statusCode ?? 502, headersForRelay(reply.headers));
    const bounded = limitedStream(maxResponseBytes);
    bounded.once('error', () => {
      reply.destroy();
      response.destroy();
    });
    reply.once('error', () => response.destroy());
    response.once('close', () => {
      bounded.destroy();
      reply.destroy();
    });
    // Node preserves Set-Cookie arrays here; SSE responses stream with backpressure.
    reply.pipe(bounded).pipe(response);
  });
  request.pipe(body).pipe(upstream);
}

async function openAsset(path) {
  if (!path.startsWith(`${assets}/`)) throw new Error('S6_HTTPS_ASSET_INVALID');
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maxResponseBytes ||
    (await realpath(path)) !== path ||
    !mimeTypes.has(extname(path))
  )
    throw new Error('S6_HTTPS_ASSET_INVALID');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = await handle.stat();
  if (!opened.isFile() || opened.size !== info.size || opened.ino !== info.ino) {
    await handle.close();
    throw new Error('S6_HTTPS_ASSET_CHANGED');
  }
  return { handle, size: info.size, type: mimeTypes.get(extname(path)) };
}

async function serveAsset(request, response, rawPath) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    request.resume();
    failure(response, 405, 'S6_HTTPS_METHOD_NOT_ALLOWED');
    return;
  }
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    failure(response, 400, 'S6_HTTPS_PATH_INVALID');
    return;
  }
  if (
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.includes('\\') ||
    path.split('/').some((part) => part.startsWith('.'))
  ) {
    failure(response, 400, 'S6_HTTPS_PATH_INVALID');
    return;
  }
  let asset;
  try {
    asset = await openAsset(resolve(assets, `.${path === '/' ? '/index.html' : path}`));
  } catch (error) {
    const navigation =
      !extname(path) &&
      !path.startsWith('/assets/') &&
      String(request.headers.accept ?? '').includes('text/html');
    if (error.code !== 'ENOENT' || !navigation) {
      failure(response, 404, 'S6_HTTPS_ASSET_NOT_FOUND');
      return;
    }
    asset = await openAsset(resolve(assets, 'index.html'));
  }
  if (response.destroyed) {
    await asset.handle.close();
    return;
  }
  response.writeHead(200, {
    'content-type': asset.type,
    'content-length': asset.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (request.method === 'HEAD') {
    await asset.handle.close();
    response.end();
    return;
  }
  const stream = asset.handle.createReadStream({ autoClose: true, highWaterMark: 64 * 1024 });
  stream.once('error', () => response.destroy());
  response.once('close', () => stream.destroy());
  stream.pipe(response);
}

export async function createProductHttpsServer() {
  const configuration = await readProductConfiguration();
  if ((await realpath(assets)) !== assets) throw new Error('S6_HTTPS_ASSET_ROOT_INVALID');
  const index = await openAsset(resolve(assets, 'index.html'));
  await index.handle.close();
  const [key, certificate] = await Promise.all([
    privateFile(productDirectory, 'server.key'),
    privateFile(productDirectory, 'server.crt'),
  ]);
  const activeRequests = new Set();
  const sockets = new Set();
  let activeResponses = 0;
  const server = createServer(
    { key, cert: certificate, minVersion: 'TLSv1.2' },
    (request, response) => {
      if (
        !request.url ||
        request.url.length > 8192 ||
        !request.url.startsWith('/') ||
        request.url.startsWith('//') ||
        request.url.includes('#')
      ) {
        request.resume();
        failure(response, 400, 'S6_HTTPS_PATH_INVALID');
        return;
      }
      if (activeResponses >= 32) {
        request.resume();
        failure(response, 503, 'S6_HTTPS_BUSY');
        return;
      }
      activeResponses++;
      response.once('close', () => {
        activeResponses--;
      });
      const rawPath = request.url.split('?')[0];
      if (rawPath === '/__ozz_s6_health' && request.method === 'GET') {
        const body = JSON.stringify({
          owner: productHttpsOwner,
          fixtureId: configuration.fixture.fixtureId,
          publicAppOrigin,
        });
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        response.end(body);
      } else if (rawPath === '/api' || rawPath.startsWith('/api/'))
        relayApi(request, response, activeRequests);
      else
        void serveAsset(request, response, rawPath).catch(() =>
          failure(response, 503, 'S6_HTTPS_ASSET_UNAVAILABLE'),
        );
    },
  );
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.requestTimeout = 15_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(120_000, (socket) => socket.destroy());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const unsupported = (_request, socket) =>
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  server.on('connect', unsupported);
  server.on('upgrade', unsupported);
  return {
    server,
    close: async () => {
      for (const request of activeRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((done) => server.close(done));
    },
  };
}

async function main() {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== 'serve' ||
    process.versions.node.split('.')[0] !== '24'
  )
    throw new Error('S6_HTTPS_COMMAND_INVALID');
  const proxy = await createProductHttpsServer();
  await new Promise((done, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(51448, '127.0.0.1', done);
  });
  console.log(JSON.stringify({ event: 'listening', owner: productHttpsOwner, publicAppOrigin }));
  process.once('SIGINT', () => {
    void proxy.close();
  });
  process.once('SIGTERM', () => {
    void proxy.close();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch(() => {
    console.error(JSON.stringify({ code: 'S6_HTTPS_START_FAILED' }));
    process.exitCode = 1;
  });
