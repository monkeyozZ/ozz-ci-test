import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  RegistryAdapter,
  parseRegistryAccess,
} from '../../packages/infrastructure/dist/registry.js';
import { ensurePodinfoSource } from '../../infra/local-lab/private-registry-assets.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/local-lab/private-registry-b');
const source = resolve(directory, '../cache/workload-podinfo-ec73780a8425');
const credentials = JSON.parse(
  readFileSync(resolve(directory, '../credentials/registry-b.json'), 'utf8'),
);
const origin = `https://${credentials.registry}`;
const armRepository = 'ozz-fixture/podinfo';
const amdRepository = 'ozz-fixture/amd64-only';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const report = {
  scope:
    '真实本地 Distribution 3.1.2：TLS、Basic 认证、OCI blob 推送及 RegistryAdapter 解析；产品 API/Worker/节点部署另行验收。',
  startedAt: new Date().toISOString(),
  status: 'running',
  registry: credentials.registry,
  sourceReference:
    'ghcr.io/stefanprodan/podinfo@sha256:ec73780a8425f59ea49f5bc8cdff0d598805a224fbaa1f86c67a244f250fa9da',
  checks: [],
  blobs: [],
};
let stage = 'verify-source';
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function check(name, passed, details = {}) {
  report.checks.push({ name, passed: Boolean(passed), ...details });
  console.log(JSON.stringify({ check: name, passed: Boolean(passed) }));
  if (!passed) throw new Error('REGISTRY_FIXTURE_ASSERTION_FAILED');
}
function request(method, path, { body, mediaType, auth = true, trust = true } = {}) {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error('REGISTRY_FIXTURE_ORIGIN_CHANGED');
  const headers = { Accept: `${manifestType}, ${indexType}` };
  if (auth) {
    const password = auth === 'wrong' ? 'incorrect-fixture-password' : credentials.password;
    headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${password}`).toString('base64')}`;
  }
  if (body) headers['Content-Length'] = String(body.length);
  if (mediaType) headers['Content-Type'] = mediaType;
  return new Promise((resolveResponse, reject) => {
    const call = https.request(
      url,
      {
        method,
        headers,
        ca: trust ? credentials.caCertificate : undefined,
        rejectUnauthorized: true,
        agent: false,
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > 1024 * 1024)
            return response.destroy(new Error('REGISTRY_FIXTURE_RESPONSE_TOO_LARGE'));
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolveResponse({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    call.setTimeout(15_000, () => call.destroy(new Error('REGISTRY_FIXTURE_TIMEOUT')));
    call.on('error', reject);
    call.end(body);
  });
}
async function uploadBlob(repository, bytes, expected) {
  const digest = sha(bytes);
  if (expected && expected !== digest) throw new Error('REGISTRY_SOURCE_DIGEST_MISMATCH');
  const found = await request('HEAD', `/v2/${repository}/blobs/${digest}`);
  if (found.status === 200) return { digest, bytes: bytes.length, reused: true };
  if (found.status !== 404) throw new Error('REGISTRY_BLOB_HEAD_FAILED');
  const begin = await request('POST', `/v2/${repository}/blobs/uploads/`);
  if (begin.status !== 202 || !begin.headers.location)
    throw new Error('REGISTRY_UPLOAD_START_FAILED');
  const location = new URL(begin.headers.location, origin);
  location.searchParams.set('digest', digest);
  const uploaded = await request('PUT', location.href, {
    body: bytes,
    mediaType: 'application/octet-stream',
  });
  if (uploaded.status !== 201 || uploaded.headers['docker-content-digest'] !== digest)
    throw new Error('REGISTRY_UPLOAD_DIGEST_FAILED');
  return { digest, bytes: bytes.length, reused: false };
}
async function putManifest(repository, reference, bytes, mediaType) {
  const digest = sha(bytes);
  const value = await request('PUT', `/v2/${repository}/manifests/${reference}`, {
    body: bytes,
    mediaType,
  });
  if (value.status !== 201 || value.headers['docker-content-digest'] !== digest)
    throw new Error('REGISTRY_MANIFEST_PUT_FAILED');
  const read = await request('GET', `/v2/${repository}/manifests/${digest}`);
  if (read.status !== 200 || sha(read.body) !== digest)
    throw new Error('REGISTRY_MANIFEST_VERIFY_FAILED');
  return digest;
}
async function expectedCode(work, code) {
  try {
    await work();
    return false;
  } catch (error) {
    return error.code === code;
  }
}

try {
  await ensurePodinfoSource();
  const rootDigest = 'sha256:ec73780a8425f59ea49f5bc8cdff0d598805a224fbaa1f86c67a244f250fa9da';
  const indexBytes = readFileSync(resolve(source, 'blobs/sha256', rootDigest.split(':')[1]));
  check('source OCI index matches its immutable upstream digest', sha(indexBytes) === rootDigest);
  const index = JSON.parse(indexBytes);
  const selected = index.manifests.find(
    (item) => item.platform?.os === 'linux' && item.platform?.architecture === 'arm64',
  );
  const manifestBytes = readFileSync(
    resolve(source, 'blobs/sha256', selected.digest.split(':')[1]),
  );
  check(
    'ARM64 manifest matches the verified source index',
    sha(manifestBytes) === selected.digest && manifestBytes.length === selected.size,
  );
  const manifest = JSON.parse(manifestBytes);

  stage = 'authentication';
  check(
    'unauthenticated registry requests are rejected',
    (await request('GET', '/v2/', { auth: false })).status === 401,
  );
  check(
    'incorrect Basic credentials are rejected',
    (await request('GET', '/v2/', { auth: 'wrong' })).status === 401,
  );
  check(
    'correct Basic credentials authenticate over verified TLS',
    (await request('GET', '/v2/')).status === 200,
  );
  let tlsRejected = false;
  try {
    await request('GET', '/v2/', { auth: false, trust: false });
  } catch (error) {
    tlsRejected = [
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
    ].includes(error.code);
  }
  check('a client without the fixture CA fails TLS verification', tlsRejected);

  stage = 'push-source-arm64';
  for (const descriptor of [manifest.config, ...manifest.layers]) {
    const bytes = readFileSync(resolve(source, 'blobs/sha256', descriptor.digest.split(':')[1]));
    if (bytes.length !== descriptor.size) throw new Error('REGISTRY_SOURCE_SIZE_MISMATCH');
    const uploaded = await uploadBlob(armRepository, bytes, descriptor.digest);
    report.blobs.push(uploaded);
    console.log(JSON.stringify({ uploaded: uploaded.digest, bytes: uploaded.bytes }));
  }
  const armDigest = await putManifest(armRepository, 'arm64', manifestBytes, manifestType);
  report.arm64 = {
    repository: armRepository,
    tag: 'arm64',
    reference: `${credentials.registry}/${armRepository}:arm64`,
    digest: armDigest,
    sourcePlatformDigest: selected.digest,
  };
  check(
    'private ARM64 manifest retains the exact public source digest',
    armDigest === selected.digest,
  );

  stage = 'push-unique-runtime-variant';
  const variantPath = resolve(directory, 'runtime-variant.json');
  let variant;
  if (existsSync(variantPath)) variant = JSON.parse(readFileSync(variantPath, 'utf8'));
  else {
    const id = randomUUID();
    const layerDirectory = resolve(directory, 'runtime-layer');
    mkdirSync(resolve(layerDirectory, 'ozz-private-fixture'), { recursive: true, mode: 0o755 });
    writeFileSync(
      resolve(layerDirectory, 'ozz-private-fixture', `${id}.txt`),
      `Ozz private registry pull proof ${id}\n`,
      { mode: 0o644 },
    );
    const unpacked = execFileSync(
      'tar',
      ['--format=ustar', '-cf', '-', '-C', layerDirectory, 'ozz-private-fixture'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const layer = gzipSync(unpacked, { level: 9 });
    const imageConfiguration = JSON.parse(
      readFileSync(resolve(source, 'blobs/sha256', manifest.config.digest.split(':')[1])),
    );
    imageConfiguration.created = new Date().toISOString();
    imageConfiguration.config ??= {};
    imageConfiguration.config.Labels = {
      ...imageConfiguration.config.Labels,
      'ozz.dev/local-pull-fixture': id,
    };
    imageConfiguration.rootfs.diff_ids.push(sha(unpacked));
    imageConfiguration.history = [
      ...(imageConfiguration.history ?? []),
      {
        created: imageConfiguration.created,
        created_by: 'Ozz local fixture: harmless marker layer',
      },
    ];
    const configurationBytes = Buffer.from(JSON.stringify(imageConfiguration));
    const layerDescriptor = {
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: sha(layer),
      size: layer.length,
    };
    const runtimeManifest = Buffer.from(
      JSON.stringify({
        ...manifest,
        config: {
          ...manifest.config,
          digest: sha(configurationBytes),
          size: configurationBytes.length,
        },
        layers: [...manifest.layers, layerDescriptor],
        annotations: { ...manifest.annotations, 'ozz.dev/local-pull-fixture': id },
      }),
    );
    writeFileSync(resolve(directory, 'runtime-layer.tar.gz'), layer, { mode: 0o600 });
    writeFileSync(resolve(directory, 'runtime-config.json'), configurationBytes, { mode: 0o600 });
    writeFileSync(resolve(directory, 'runtime-manifest.json'), runtimeManifest, { mode: 0o600 });
    variant = {
      id,
      repository: `ozz-fixture/runtime-${id.replaceAll('-', '').slice(0, 16)}/podinfo`,
      manifestDigest: sha(runtimeManifest),
      configDigest: sha(configurationBytes),
      newLayer: layerDescriptor,
      newLayerDiffId: sha(unpacked),
      baseLayers: manifest.layers.map((item) => item.digest),
    };
    writeFileSync(variantPath, `${JSON.stringify(variant, null, 2)}\n`, { mode: 0o600 });
  }
  for (const descriptor of manifest.layers) {
    const bytes = readFileSync(resolve(source, 'blobs/sha256', descriptor.digest.split(':')[1]));
    await uploadBlob(variant.repository, bytes, descriptor.digest);
  }
  await uploadBlob(
    variant.repository,
    readFileSync(resolve(directory, 'runtime-layer.tar.gz')),
    variant.newLayer.digest,
  );
  await uploadBlob(
    variant.repository,
    readFileSync(resolve(directory, 'runtime-config.json')),
    variant.configDigest,
  );
  const runtimeDigest = await putManifest(
    variant.repository,
    'v1',
    readFileSync(resolve(directory, 'runtime-manifest.json')),
    manifestType,
  );
  check(
    'runtime pull fixture has a unique manifest and a new harmless layer',
    runtimeDigest === variant.manifestDigest &&
      runtimeDigest !== armDigest &&
      !variant.baseLayers.includes(variant.newLayer.digest),
  );
  report.runtimeImage = {
    ...variant,
    reference: `${credentials.registry}/${variant.repository}:v1`,
    inheritedBaseLayersMayBeCached: true,
  };

  stage = 'push-amd64-negative-fixture';
  const amdConfig = Buffer.from(
    JSON.stringify({
      created: '2026-10-25T00:00:00Z',
      architecture: 'amd64',
      os: 'linux',
      config: {
        Labels: {
          'org.opencontainers.image.title': 'Ozz AMD64-only architecture rejection fixture',
          'org.opencontainers.image.description':
            'Intentionally non-runnable scratch image for platform admission tests.',
        },
      },
      rootfs: { type: 'layers', diff_ids: [] },
      history: [],
    }),
  );
  const amdConfigReceipt = await uploadBlob(amdRepository, amdConfig);
  const amdManifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: manifestType,
      config: { mediaType: configType, digest: amdConfigReceipt.digest, size: amdConfig.length },
      layers: [],
    }),
  );
  const amdManifestDigest = await putManifest(
    amdRepository,
    sha(amdManifest),
    amdManifest,
    manifestType,
  );
  const amdIndex = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: indexType,
      manifests: [
        {
          mediaType: manifestType,
          digest: amdManifestDigest,
          size: amdManifest.length,
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ],
    }),
  );
  const amdIndexDigest = await putManifest(amdRepository, 'v1', amdIndex, indexType);
  report.amd64Only = {
    repository: amdRepository,
    tag: 'v1',
    reference: `${credentials.registry}/${amdRepository}:v1`,
    digest: amdIndexDigest,
    fixture: 'Generated valid AMD64-only OCI scratch metadata; not a runnable Podinfo image.',
  };

  stage = 'production-registry-adapter';
  const adapter = new RegistryAdapter({ requestTimeoutMs: 5000, resolutionTimeoutMs: 20_000 });
  const access = parseRegistryAccess(credentials);
  const armOptions = { access, platforms: [{ os: 'linux', architecture: 'arm64' }] };
  const resolved = await adapter.resolve(report.arm64.reference, armOptions);
  check(
    'production RegistryAdapter resolves the authenticated ARM64 image',
    resolved.manifestDigest === armDigest &&
      resolved.platformManifests[0]?.architecture === 'arm64',
  );
  const verified = await adapter.verify(resolved, armOptions);
  check(
    'production RegistryAdapter verifies the pinned private digest',
    verified.deployReference === resolved.deployReference,
  );
  const runtimeResolved = await adapter.resolve(report.runtimeImage.reference, armOptions);
  check(
    'production RegistryAdapter accepts the unique ARM64 runtime fixture',
    runtimeResolved.manifestDigest === variant.manifestDigest &&
      runtimeResolved.platformManifests[0]?.configDigest === variant.configDigest,
  );
  const anonymous = parseRegistryAccess({
    registry: credentials.registry,
    caCertificate: credentials.caCertificate,
  });
  check(
    'production RegistryAdapter reports a missing credential',
    await expectedCode(
      () => adapter.resolve(report.arm64.reference, { ...armOptions, access: anonymous }),
      'REGISTRY_AUTH_REQUIRED',
    ),
  );
  const wrong = parseRegistryAccess({ ...credentials, password: 'incorrect-fixture-password' });
  check(
    'production RegistryAdapter reports an invalid credential',
    await expectedCode(
      () => adapter.resolve(report.arm64.reference, { ...armOptions, access: wrong }),
      'REGISTRY_UNAUTHENTICATED',
    ),
  );
  check(
    'production RegistryAdapter rejects an AMD64-only index for ARM64',
    await expectedCode(
      () => adapter.resolve(report.amd64Only.reference, armOptions),
      'REGISTRY_PLATFORM_UNSUPPORTED',
    ),
  );
  const amdResolved = await adapter.resolve(report.amd64Only.reference, {
    access,
    platforms: [{ os: 'linux', architecture: 'amd64' }],
  });
  check(
    'negative fixture has internally consistent AMD64 config and index metadata',
    amdResolved.manifestDigest === amdIndexDigest &&
      amdResolved.platformManifests[0]?.architecture === 'amd64',
  );
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    code: error.code ?? null,
    message: error.code ? undefined : error.message,
  };
  console.error(JSON.stringify({ stage, failed: true, code: error.code ?? error.name }));
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (serialized.includes(credentials.password))
    // eslint-disable-next-line no-unsafe-finally -- A credential must block report output even after another failure.
    throw new Error('REGISTRY_FIXTURE_SECRET_LEAK_BLOCKED');
  writeFileSync(resolve(directory, 'seed-result.json'), serialized, { mode: 0o600 });
  writeFileSync(
    resolve(root, 'docs/acceptance/s3-private-registry-fixture-results.json'),
    serialized,
  );
}
