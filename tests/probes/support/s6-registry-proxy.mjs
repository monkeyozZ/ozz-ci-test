import { readFile, lstat, realpath } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// TLS remains end-to-end. Only two fixed fixture authorities map to loopback.
// Other registry traffic can retain the operator's existing CONNECT proxy.
const destinations = new Map([
  ['host.lima.internal:50444', 50444],
  ['host.lima.internal:51445', 51445],
]);

export function createRegistryFixtureProxy({
  upstream,
  fixtureDestinations = destinations,
  upstreamAuthorities,
} = {}) {
  let proxy;
  if (upstream) {
    proxy = new URL(upstream);
    if (
      !['http:', 'https:'].includes(proxy.protocol) ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== '/' ||
      proxy.search ||
      proxy.hash
    )
      throw new Error('S6_PROXY_UPSTREAM_INVALID');
  }
  const sockets = new Set();
  const server = createServer((_request, response) => response.writeHead(405).end());
  server.maxConnections = 32;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setTimeout(120_000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (request, client, head) => {
    const authority = request.url;
    if (typeof authority !== 'string' || !/^[a-zA-Z0-9.-]+:[1-9][0-9]{0,4}$/u.test(authority)) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const bridge = (remote, buffered = Buffer.alloc(0)) => {
      sockets.add(remote);
      remote.setTimeout(120_000, () => remote.destroy());
      remote.once('close', () => {
        sockets.delete(remote);
        client.destroy();
      });
      remote.on('error', () => client.destroy());
      client.once('close', () => remote.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (buffered.length) client.write(buffered);
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    };
    if (fixtureDestinations.has(authority)) {
      const remote = connect({ host: '127.0.0.1', port: fixtureDestinations.get(authority) });
      remote.once('error', () => client.destroy());
      remote.once('connect', () => bridge(remote));
    } else if (proxy && (!upstreamAuthorities || upstreamAuthorities.has(authority))) {
      const send = proxy.protocol === 'https:' ? httpsRequest : httpRequest;
      const tunnel = send(proxy, {
        method: 'CONNECT',
        path: authority,
        headers: { host: authority },
        agent: false,
        signal: globalThis.AbortSignal.timeout(10_000),
      });
      tunnel.once('connect', (response, remote, buffered) => {
        if (response.statusCode !== 200) {
          remote.destroy();
          client.destroy();
          return;
        }
        bridge(remote, buffered);
      });
      tunnel.once('error', () => client.destroy());
      tunnel.end();
    } else client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((done) => server.close(done));
    },
  };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== 'serve')
    throw new Error('S6_PROXY_COMMAND_INVALID');
  const path = resolve(process.argv[3]);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 8192 ||
    (await realpath(path)) !== path
  )
    throw new Error('S6_PROXY_CONFIG_INVALID');
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (
    config.owner !== 'ozz-s6-registry-proxy-v1' ||
    config.listenHost !== '127.0.0.1' ||
    config.listenPort !== 51447
  )
    throw new Error('S6_PROXY_CONFIG_INVALID');
  const proxy = createRegistryFixtureProxy({ upstream: config.upstream });
  await new Promise((done, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(config.listenPort, config.listenHost, done);
  });
  console.log(JSON.stringify({ event: 'listening', owner: config.owner, port: config.listenPort }));
  process.once('SIGTERM', () => {
    void proxy.close();
  });
  process.once('SIGINT', () => {
    void proxy.close();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(JSON.stringify({ error: 'S6_PROXY_START_FAILED' }));
    process.exitCode = 1;
  });
}
