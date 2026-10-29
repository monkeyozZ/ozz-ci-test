import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { downloadArtifact, verifyArtifact } from './download.mjs';

const root = resolve(import.meta.dirname, '../..');
const cache = resolve(root, '.local/local-lab/cache');
const lock = JSON.parse(
  await readFile(resolve(import.meta.dirname, 'private-registry-assets.lock.json'), 'utf8'),
);
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const source = lock.sourceImage;
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const exists = (path) =>
  stat(path).then(
    () => true,
    (error) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    },
  );

async function protectedWrite(path, bytes) {
  await writeFile(`${path}.part`, bytes, { mode: 0o600 });
  await chmod(`${path}.part`, 0o600);
  await rename(`${path}.part`, path);
}

export async function ensureRegistryRelease({ verifyOnly = false } = {}) {
  const directory = resolve(cache, `registry-${lock.registry.version}`);
  const artifact = verifyOnly
    ? await verifyArtifact(lock.registry, directory)
    : await downloadArtifact(lock.registry, directory);
  const provenance = resolve(directory, 'provenance.json');
  if (await exists(provenance)) {
    const prior = JSON.parse(await readFile(provenance, 'utf8'));
    if (prior.sha256 !== lock.registry.sha256 || prior.version !== lock.registry.version)
      throw new Error('PRIVATE_REGISTRY_RELEASE_PROVENANCE_CHANGED');
  } else if (!verifyOnly) {
    await protectedWrite(provenance, `${JSON.stringify(lock.registry, null, 2)}\n`);
  }
  return { artifact, directory, ...lock.registry };
}

// This fixture downloads one public, digest-pinned image. Credentials are never
// read here. A short-lived anonymous GHCR token stays in memory and is omitted
// from redirected requests; only the official GHCR blob CDN is accepted.
function getPublic(url, { authorization, accept, maxBytes }, redirects = 0) {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !['ghcr.io', 'pkg-containers.githubusercontent.com'].includes(url.hostname)
  ) {
    throw new Error('PRIVATE_REGISTRY_SOURCE_ORIGIN_REJECTED');
  }
  return new Promise((acceptResponse, reject) => {
    const call = https.get(
      url,
      {
        rejectUnauthorized: true,
        family: 4,
        agent: false,
        signal: globalThis.AbortSignal.timeout(60_000),
        headers: {
          'user-agent': 'ozz-private-registry-fixture',
          Accept: accept,
          ...(authorization ? { Authorization: authorization } : {}),
        },
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (redirects >= 2 || !response.headers.location) {
            reject(new Error('PRIVATE_REGISTRY_SOURCE_REDIRECT_REJECTED'));
            return;
          }
          try {
            acceptResponse(
              getPublic(
                new URL(response.headers.location, url),
                { accept, maxBytes },
                redirects + 1,
              ),
            );
          } catch {
            reject(new Error('PRIVATE_REGISTRY_SOURCE_REDIRECT_REJECTED'));
          }
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('PRIVATE_REGISTRY_SOURCE_HTTP_FAILED'));
          return;
        }
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > maxBytes) {
            response.destroy(new Error('PRIVATE_REGISTRY_SOURCE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', () => reject(new Error('PRIVATE_REGISTRY_SOURCE_READ_FAILED')));
        response.once('end', () => acceptResponse(Buffer.concat(chunks)));
      },
    );
    call.setTimeout(60_000, () => call.destroy(new Error('PRIVATE_REGISTRY_SOURCE_TIMEOUT')));
    call.once('error', () => reject(new Error('PRIVATE_REGISTRY_SOURCE_CONNECTION_FAILED')));
  });
}

export async function ensurePodinfoSource({ verifyOnly = false } = {}) {
  const directory = resolve(cache, 'workload-podinfo-ec73780a8425');
  const blobs = resolve(directory, 'blobs/sha256');
  if (!verifyOnly) await mkdir(blobs, { recursive: true, mode: 0o700 });
  let token;
  let downloadedBytes = 0;
  async function authorization() {
    if (token) return token;
    const url = new URL('https://ghcr.io/token');
    url.searchParams.set('service', 'ghcr.io');
    url.searchParams.set('scope', `repository:${source.repository}:pull`);
    const value = JSON.parse(
      await getPublic(url, { accept: 'application/json', maxBytes: 32 * 1024 }),
    );
    const credential = value.token ?? value.access_token;
    if (typeof credential !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(credential))
      throw new Error('PRIVATE_REGISTRY_PUBLIC_TOKEN_INVALID');
    token = `Bearer ${credential}`;
    return token;
  }
  async function blob(digest, size, type) {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(digest) ||
      (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024))
    ) {
      throw new Error('PRIVATE_REGISTRY_SOURCE_DESCRIPTOR_INVALID');
    }
    const path = resolve(blobs, digest.slice(7));
    const cached = await exists(path);
    if (!cached && verifyOnly) throw new Error('PRIVATE_REGISTRY_SOURCE_CACHE_MISSING');
    const bytes = cached
      ? await readFile(path)
      : await getPublic(new URL(`https://ghcr.io/v2/${source.repository}/${type}/${digest}`), {
          authorization: await authorization(),
          accept:
            type === 'manifests' ? `${manifestType}, ${indexType}` : 'application/octet-stream',
          maxBytes: size ?? 1024 * 1024,
        });
    if (digestOf(bytes) !== digest || (size !== undefined && bytes.length !== size))
      throw new Error('PRIVATE_REGISTRY_SOURCE_DIGEST_MISMATCH');
    if (!cached) {
      downloadedBytes += bytes.length;
      if (downloadedBytes > 64 * 1024 * 1024)
        throw new Error('PRIVATE_REGISTRY_SOURCE_TOTAL_LIMIT');
      await protectedWrite(path, bytes);
      console.log(JSON.stringify({ downloaded: digest, bytes: bytes.length }));
    }
    return bytes;
  }
  const indexBytes = await blob(source.digest, undefined, 'manifests');
  const index = JSON.parse(indexBytes);
  const selected = index.manifests?.filter(
    (item) => item.platform?.os === 'linux' && item.platform?.architecture === 'arm64',
  );
  if (index.schemaVersion !== 2 || selected?.length !== 1)
    throw new Error('PRIVATE_REGISTRY_SOURCE_PLATFORM_INVALID');
  const descriptor = selected[0];
  const manifest = JSON.parse(await blob(descriptor.digest, descriptor.size, 'manifests'));
  if (
    manifest.schemaVersion !== 2 ||
    !Array.isArray(manifest.layers) ||
    manifest.layers.length > 32
  )
    throw new Error('PRIVATE_REGISTRY_SOURCE_MANIFEST_INVALID');
  const config = JSON.parse(await blob(manifest.config.digest, manifest.config.size, 'blobs'));
  if (config.os !== 'linux' || config.architecture !== 'arm64')
    throw new Error('PRIVATE_REGISTRY_SOURCE_CONFIG_PLATFORM_INVALID');
  for (const layer of manifest.layers) await blob(layer.digest, layer.size, 'blobs');
  if (!verifyOnly) {
    for (const [name, value] of [
      ['oci-layout', { imageLayoutVersion: '1.0.0' }],
      [
        'index.json',
        {
          schemaVersion: 2,
          mediaType: indexType,
          manifests: [{ mediaType: indexType, digest: source.digest, size: indexBytes.length }],
        },
      ],
    ]) {
      const path = resolve(directory, name);
      if (!(await exists(path))) await protectedWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    }
  }
  return {
    directory,
    reference: source.reference,
    manifestDigest: descriptor.digest,
    downloadedBytes,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { 'verify-only': { type: 'boolean', default: false } } });
  try {
    const options = { verifyOnly: values['verify-only'] };
    const registry = await ensureRegistryRelease(options);
    const image = await ensurePodinfoSource(options);
    console.log(
      JSON.stringify({
        status: 'passed',
        registryVersion: registry.version,
        image,
        verifyOnly: options.verifyOnly,
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error.code ?? error.message }));
    process.exitCode = 1;
  }
}
