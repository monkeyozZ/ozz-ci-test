import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRegistryFixtureProxy } from './s6-registry-proxy.mjs';

// These exact HTTPS authorities were observed from the pinned Dockerfile frontend
// and nginx manifests. No wildcard, arbitrary public host, fixture, private IP,
// token issuer, or control-plane endpoint is reachable through this proxy.
export const buildProxyAuthorities = Object.freeze([
  'registry-1.docker.io:443',
  'auth.docker.io:443',
  'production.cloudfront.docker.com:443',
]);

export function createBuildFixtureProxy(upstream) {
  if (!upstream) throw new Error('S6_BUILD_PROXY_UPSTREAM_REQUIRED');
  return createRegistryFixtureProxy({
    upstream,
    fixtureDestinations: new Map(),
    upstreamAuthorities: new Set(buildProxyAuthorities),
  });
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== 'serve')
    throw new Error('S6_BUILD_PROXY_COMMAND_INVALID');
  const path = resolve(process.argv[3]);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 8192 ||
    (await realpath(path)) !== path
  )
    throw new Error('S6_BUILD_PROXY_CONFIG_INVALID');
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (
    config.owner !== 'ozz-s6-build-proxy-v1' ||
    config.listenHost !== '127.0.0.1' ||
    config.listenPort !== 51449
  )
    throw new Error('S6_BUILD_PROXY_CONFIG_INVALID');
  const proxy = createBuildFixtureProxy(config.upstream);
  await new Promise((done, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(config.listenPort, config.listenHost, done);
  });
  console.log(
    JSON.stringify({
      event: 'listening',
      owner: config.owner,
      port: config.listenPort,
      authorities: buildProxyAuthorities,
      tls: 'end-to-end, no interception',
    }),
  );
  process.once('SIGTERM', () => {
    void proxy.close();
  });
  process.once('SIGINT', () => {
    void proxy.close();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(JSON.stringify({ error: 'S6_BUILD_PROXY_START_FAILED' }));
    process.exitCode = 1;
  });
}
