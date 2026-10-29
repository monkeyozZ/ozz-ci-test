import { readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';

const mode = process.env.OZZ_EGRESS_MODE;
const nonce = process.env.OZZ_EGRESS_NONCE;

if (mode === 'serve') {
  if (!/^[a-f0-9-]{36}$/.test(nonce ?? '')) throw new Error('Invalid fixture nonce');
  const tls = {
    key: readFileSync('/proof/server.key'),
    cert: readFileSync('/proof/server.crt'),
  };
  const sockets = new Set();
  const ssh = net.createServer((socket) => {
    socket.end(`SSH-2.0-OzzEgress-${nonce}\r\n`);
  });
  const kubernetes = https.createServer(tls, (request, response) => {
    response.writeHead(request.url === '/version' ? 200 : 404, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify({ gitVersion: 'v0.0.0-egress-fixture', nonce }));
  });
  const registry = https.createServer(tls, (request, response) => {
    response.writeHead(request.url === '/v2/' ? 401 : 404, {
      'content-type': 'application/json',
      'docker-distribution-api-version': 'registry/2.0',
      'www-authenticate': 'Basic realm="Ozz egress fixture"',
    });
    response.end(JSON.stringify({ nonce }));
  });
  const servers = [ssh, kubernetes, registry];
  for (const server of servers) {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }
  await Promise.all(
    servers.map(
      (server, index) =>
        new Promise((accept, reject) => {
          server.once('error', reject);
          server.listen([2222, 6443, 50443][index], '0.0.0.0', accept);
        }),
    ),
  );
  const close = () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    globalThis.clearTimeout(timer);
  };
  const timer = setTimeout(close, 120_000);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ status: 'ready', lifetimeSeconds: 120 }));
} else if (mode === 'probe') {
  const target = JSON.parse(process.env.OZZ_EGRESS_TARGET);
  if (!net.isIP(target.host)) throw new Error('Probe target must be a literal fixture address');
  const results = await Promise.all(
    ['ssh', 'kubernetes', 'registry'].map(
      (protocol) =>
        new Promise((accept) => {
          let socket;
          let request;
          let settled = false;
          let tcpConnected = false;
          const done = (verified, errorCode = null) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            socket?.destroy();
            request?.destroy();
            accept({ protocol, tcpConnected, verified, errorCode });
          };
          const timer = setTimeout(() => done(false, 'PROBE_TIMEOUT'), 2500);
          if (protocol === 'ssh') {
            let banner = '';
            socket = net.connect({ host: target.host, port: target.ports.ssh });
            socket.once('connect', () => (tcpConnected = true));
            socket.on('data', (chunk) => {
              banner += chunk.toString('utf8');
              if (banner.length > 1024) done(false, 'SSH_BANNER_TOO_LARGE');
              else if (banner.includes('\n'))
                done(banner === `SSH-2.0-OzzEgress-${target.nonce}\r\n`);
            });
            socket.once('error', (error) => done(false, error.code));
            socket.once('end', () => done(false, 'SSH_BANNER_MISSING'));
            return;
          }
          request = https.get(
            {
              hostname: target.host,
              port: target.ports[protocol],
              servername: 'egress.ozz.invalid',
              path: protocol === 'kubernetes' ? '/version' : '/v2/',
              ca: target.ca,
              rejectUnauthorized: true,
              agent: false,
            },
            (response) => {
              const chunks = [];
              let bytes = 0;
              response.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > 4096) done(false, 'FIXTURE_RESPONSE_TOO_LARGE');
                else chunks.push(chunk);
              });
              response.once('error', () => done(false, 'FIXTURE_RESPONSE_FAILED'));
              response.once('end', () => {
                let body;
                try {
                  body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                  done(false, 'FIXTURE_RESPONSE_INVALID');
                  return;
                }
                const matches =
                  body.nonce === target.nonce &&
                  (protocol === 'kubernetes'
                    ? response.statusCode === 200 && body.gitVersion === 'v0.0.0-egress-fixture'
                    : response.statusCode === 401 &&
                      response.headers['docker-distribution-api-version'] === 'registry/2.0' &&
                      response.headers['www-authenticate'] === 'Basic realm="Ozz egress fixture"');
                done(matches);
              });
            },
          );
          request.once('socket', (value) => {
            socket = value;
            socket.once('connect', () => (tcpConnected = true));
          });
          request.once('error', (error) => done(false, error.code));
        }),
    ),
  );
  console.log(JSON.stringify({ results }));
} else {
  throw new Error('Use a fixture serve/probe mode');
}
