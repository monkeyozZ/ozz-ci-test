import { X509Certificate } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve } from 'node:path';
import {
  GitHubAdapter,
  HttpsGitHubTransport,
} from '../../../packages/infrastructure/dist/github.js';

export const productRoot = resolve(import.meta.dirname, '../../..');
export const productDirectory = resolve(productRoot, '.local/local-lab/s6-github/product');
export const fixtureOwner = 'ozz-s6-github-fixture-v1';
export const apiOrigin = 'https://127.0.0.1:51446';
export const cloneOrigin = 'https://host.lima.internal:51446';
export const registryProxyOrigin = 'http://127.0.0.1:51447';
export const publicAppOrigin = 'https://127.0.0.1:51448';
export const productHttpsOwner = 'ozz-s6-product-https-v1';

export async function privateFile(directory, name) {
  const path = resolve(directory, name);
  if (!path.startsWith(`${directory}/`)) throw new Error('S6_PRODUCT_PATH_INVALID');
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size < 1 ||
    info.size > 1024 * 1024 ||
    (await realpath(path)) !== path
  )
    throw new Error('S6_PRODUCT_PRIVATE_FILE_INVALID');
  return readFile(path, 'utf8');
}

export async function readProductConfiguration() {
  const info = await lstat(productDirectory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(productDirectory)) !== productDirectory
  )
    throw new Error('S6_PRODUCT_DIRECTORY_INVALID');
  const [fixtureText, metadataText, ca, certificate, proxyText] = await Promise.all([
    privateFile(productDirectory, 'config.json'),
    privateFile(productDirectory, 'metadata.json'),
    privateFile(productDirectory, 'ca.crt'),
    privateFile(productDirectory, 'server.crt'),
    privateFile(productDirectory, 'registry-proxy.json'),
  ]);
  const fixture = JSON.parse(fixtureText);
  const metadata = JSON.parse(metadataText);
  const proxy = JSON.parse(proxyText);
  if (
    fixture.owner !== fixtureOwner ||
    fixture.fixtureId !== metadata.fixtureId ||
    metadata.owner !== fixtureOwner ||
    !/^ozz-s6-product-[0-9a-f-]{36}$/u.test(metadata.fixtureId) ||
    !/^[0-9a-f]{40}$/u.test(metadata.initialSha) ||
    metadata.apiOrigin !== apiOrigin ||
    metadata.cloneOrigin !== cloneOrigin ||
    metadata.publicAppOrigin !== publicAppOrigin ||
    fixture.stateFile !== 'state.json' ||
    fixture.gitRoot !== 'repositories' ||
    fixture.gitExecutable !== '/usr/bin/git' ||
    fixture.listenHost !== '0.0.0.0' ||
    fixture.listenPort !== 51446 ||
    fixture.apiOrigin !== apiOrigin ||
    fixture.tlsCertificateFile !== 'server.crt' ||
    fixture.tlsKeyFile !== 'server.key' ||
    proxy.owner !== 'ozz-s6-registry-proxy-v1' ||
    proxy.listenHost !== '127.0.0.1' ||
    proxy.listenPort !== 51447
  )
    throw new Error('S6_PRODUCT_CONFIGURATION_INVALID');
  validateUpstream(proxy.upstream);
  const authority = new X509Certificate(ca);
  const server = new X509Certificate(certificate);
  if (
    !authority.ca ||
    !server.verify(authority.publicKey) ||
    !server.checkIP('127.0.0.1') ||
    !server.checkHost('host.lima.internal') ||
    Date.parse(server.validFrom) > Date.now() ||
    Date.parse(server.validTo) <= Date.now() ||
    Date.parse(authority.validFrom) > Date.now() ||
    Date.parse(authority.validTo) <= Date.now()
  )
    throw new Error('S6_PRODUCT_CERTIFICATE_INVALID');
  return { fixture, metadata, ca, proxy };
}

export function validateUpstream(upstream) {
  if (upstream === undefined) return;
  const url = new URL(upstream);
  if (
    typeof upstream !== 'string' ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin === registryProxyOrigin
  )
    throw new Error('S6_PRODUCT_PROXY_UPSTREAM_INVALID');
}

export async function createProductGitHubAdapter() {
  const { ca } = await readProductConfiguration();
  return new GitHubAdapter({
    apiOrigin,
    cloneOrigin,
    cloneCaCertificate: ca,
    transport: new HttpsGitHubTransport({ caCertificate: ca }),
  });
}

export async function checkFixtureHealth(configuration) {
  return checkHealth(configuration, apiOrigin, '/healthz', fixtureOwner);
}

export async function checkProductHttpsHealth(configuration) {
  return checkHealth(configuration, publicAppOrigin, '/__ozz_s6_health', productHttpsOwner);
}

async function checkHealth(configuration, origin, path, owner) {
  const { ca, fixture } = configuration;
  await new Promise((accept, reject) => {
    const connection = request(
      `${origin}${path}`,
      {
        ca,
        rejectUnauthorized: true,
        agent: false,
        signal: globalThis.AbortSignal.timeout(3000),
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 8192) response.destroy(new Error('S6_PRODUCT_HEALTH_INVALID'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks));
            if (
              response.statusCode !== 200 ||
              value.owner !== owner ||
              value.fixtureId !== fixture.fixtureId
            )
              throw new Error('S6_PRODUCT_HEALTH_INVALID');
            accept();
          } catch {
            reject(new Error('S6_PRODUCT_HEALTH_INVALID'));
          }
        });
      },
    );
    connection.once('error', reject);
    connection.end();
  });
}
