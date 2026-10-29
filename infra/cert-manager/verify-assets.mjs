import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  CERT_MANAGER_IMAGES,
  CERT_MANAGER_MANIFEST,
  CERT_MANAGER_MAX_OBJECT_BYTES,
  CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS,
  CERT_MANAGER_VERSION,
  loadCertManagerManifests,
} from '../../packages/infrastructure/dist/networking/cert-manager-assets.js';

const lock = JSON.parse(await readFile(new URL('./assets.lock.json', import.meta.url), 'utf8'));

// This command is intentionally offline. The recorded registry digests were resolved and
// verified upstream when the lock was created; this detects local/package drift.
assert.equal(lock.formatVersion, 1);
assert.equal(lock.version, CERT_MANAGER_VERSION);
assert.equal(lock.compatibility.kubernetesMajor, 1);
assert.deepEqual(lock.compatibility.supportedMinors, CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS);
assert.deepEqual(lock.compatibility.testedMinors, CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS);
for (const key of ['filename', 'sha256', 'bytes', 'documents'])
  assert.equal(lock.manifest[key], CERT_MANAGER_MANIFEST[key]);
assert.equal(
  lock.manifest.packagePath,
  `packages/infrastructure/assets/${CERT_MANAGER_MANIFEST.filename}`,
);
assert.equal(lock.manifest.maxObjectJsonBytes, CERT_MANAGER_MAX_OBJECT_BYTES);
assert.equal(lock.license.packagePath, 'packages/infrastructure/assets/LICENSE.cert-manager');
const license = await readFile(
  new URL('../../packages/infrastructure/assets/LICENSE.cert-manager', import.meta.url),
);
assert.equal(license.byteLength, lock.license.bytes);
assert.equal(createHash('sha256').update(license).digest('hex'), lock.license.sha256);
assert.deepEqual(Object.keys(lock.images).sort(), Object.keys(CERT_MANAGER_IMAGES).sort());

const platforms = ['linux/amd64', 'linux/arm64/v8'];
for (const [name, pin] of Object.entries(CERT_MANAGER_IMAGES)) {
  const image = lock.images[name];
  assert.equal(image.repository, `quay.io/jetstack/cert-manager-${name}`);
  assert.equal(image.tag, CERT_MANAGER_VERSION);
  assert.equal(pin, `${image.repository}:${image.tag}@${image.manifestListDigest}`);
  const digests = [image.manifestListDigest, ...platforms.map((platform) => image[platform])];
  for (const digest of digests) assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(new Set(digests).size, digests.length);
}

const objects = await loadCertManagerManifests();
const largestObjectJsonBytes = Math.max(
  ...objects.map((object) => Buffer.byteLength(JSON.stringify(object))),
);
assert.equal(objects.length, lock.manifest.documents);
assert.equal(largestObjectJsonBytes, lock.manifest.largestObjectJsonBytes);

const expectedImages = Object.values(lock.images).map(
  (image) => `${image.repository}:${image.tag}`,
);
const manifestImages = new Set();
for (const object of objects) {
  if (object.kind !== 'Deployment') continue;
  for (const container of object.spec.template.spec.containers) {
    manifestImages.add(container.image);
    for (const arg of container.args ?? []) {
      if (arg.startsWith('--acme-http01-solver-image=')) manifestImages.add(arg.split('=')[1]);
    }
  }
}
assert.deepEqual([...manifestImages].sort(), expectedImages.sort());

console.log(
  JSON.stringify({
    status: 'verified',
    mode: 'offline',
    version: CERT_MANAGER_VERSION,
    manifestBytes: lock.manifest.bytes,
    manifestSha256: lock.manifest.sha256,
    objects: objects.length,
    largestObjectJsonBytes,
    imagePins: Object.keys(CERT_MANAGER_IMAGES).length,
    recordedPlatforms: platforms,
    supportedKubernetesMinors: CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS,
  }),
);
