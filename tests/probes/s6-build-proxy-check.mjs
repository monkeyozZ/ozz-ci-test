import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import { buildProxyAuthorities, createBuildFixtureProxy } from './support/s6-build-proxy.mjs';

const observed = [];
const upstream = createServer((_request, response) => response.writeHead(405).end());
const upstreamSockets = new Set();
upstream.on('connection', (socket) => {
  upstreamSockets.add(socket);
  socket.once('close', () => upstreamSockets.delete(socket));
});
upstream.on('connect', (request, socket) => {
  observed.push(request.url);
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  socket.on('error', () => socket.destroy());
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const proxy = createBuildFixtureProxy(`http://127.0.0.1:${upstream.address().port}`);
const report = {
  at: new Date().toISOString(),
  scope: 'Real HTTP CONNECT admission against a controlled upstream; no OCI build certified.',
  checks: [],
};
try {
  await new Promise((done) => proxy.server.listen(0, '127.0.0.1', done));
  const call = (method, path) =>
    new Promise((done, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port: proxy.server.address().port,
        method,
        path,
        agent: false,
        signal: globalThis.AbortSignal.timeout(5000),
      });
      req.once('error', reject);
      req.once('connect', (response, socket) => {
        socket.destroy();
        done(response.statusCode);
      });
      req.once('response', (response) => {
        response.resume();
        response.once('end', () => done(response.statusCode));
      });
      req.end();
    });
  for (const authority of buildProxyAuthorities) {
    assert.equal(await call('CONNECT', authority), 200);
    report.checks.push({ authority, result: 'allowed' });
  }
  const targets = [
    '127.0.0.1:3000',
    '169.254.169.254:80',
    '192.168.5.2:7890',
    'host.lima.internal:50444',
    'host.lima.internal:51445',
    'host.lima.internal:51446',
    'example.com:443',
    'registry-1.docker.io:80',
    'registry-1.docker.io.:443',
    'registry-1.docker.io.evil.example:443',
    'user@registry-1.docker.io:443',
    'registry-1.docker.io:443/extra',
  ];
  for (const authority of targets) {
    assert.ok([400, 403].includes(await call('CONNECT', authority)));
    report.checks.push({ authority, result: 'denied' });
  }
  assert.equal(await call('GET', 'http://registry-1.docker.io/v2/'), 405);
  report.checks.push({ method: 'GET', result: 'denied' });
  assert.deepEqual(observed, [...buildProxyAuthorities]);
  report.checks.push({ check: 'denied-targets-never-reached-upstream', result: 'passed' });
  const directory = resolve(import.meta.dirname, '../../.local/local-lab/builder/network');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `connect-policy-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: 'passed', checks: report.checks.length, report: path }));
} finally {
  await proxy.close();
  for (const socket of upstreamSockets) socket.destroy();
  await new Promise((done) => upstream.close(done));
}
