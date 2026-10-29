import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CERT_MANAGER_IMAGES,
  CERT_MANAGER_MANIFEST,
  CERT_MANAGER_MAX_OBJECT_BYTES,
  CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS,
  CERT_MANAGER_VERSION,
  loadCertManagerManifests,
  parseCertManagerManifests,
} from '../../packages/infrastructure/src/networking/cert-manager-assets.js';
import { NetworkingAdapterError } from '../../packages/infrastructure/src/networking/contracts.js';

const manifestPath = new URL(
  '../../packages/infrastructure/assets/cert-manager-v1.21.3.yaml',
  import.meta.url,
);
const lockPath = new URL('../../infra/cert-manager/assets.lock.json', import.meta.url);

describe('packaged official cert-manager installation assets', () => {
  it('loads the complete upstream installation, including large CRDs and original RBAC names', async () => {
    const objects = await loadCertManagerManifests();
    expect(objects).toHaveLength(47);
    expect(objects.filter((object) => object.kind === 'CustomResourceDefinition')).toHaveLength(6);
    expect(objects.filter((object) => object.kind === 'Deployment')).toHaveLength(3);
    expect(objects).toContainEqual(
      expect.objectContaining({
        kind: 'Role',
        metadata: expect.objectContaining({
          name: 'cert-manager:leaderelection',
          namespace: 'kube-system',
        }),
      }),
    );
    const largest = Math.max(...objects.map((object) => Buffer.byteLength(JSON.stringify(object))));
    expect(largest).toBe(146_637);
    expect(largest).toBeLessThan(CERT_MANAGER_MAX_OBJECT_BYTES);
  });

  it('returns independent unmodified objects so one installation cannot poison another', async () => {
    const first = await loadCertManagerManifests();
    const original = JSON.stringify(first);
    const metadata = first[0]!.metadata as Record<string, unknown>;
    metadata.labels = { 'platform.ozz/installation-id': 'installation-a' };
    first.splice(1, 1);
    const second = await loadCertManagerManifests();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.metadata).not.toBe(metadata);
    expect(JSON.stringify(second)).toBe(original);
  });

  it('rejects truncated, oversized and same-size tampered assets without exposing their bytes', async () => {
    const official = await readFile(manifestPath);
    const tampered = Buffer.from(official);
    tampered.write('synthetic-sensitive-content', 0, 'utf8');
    for (const input of [
      official.subarray(0, -1),
      Buffer.concat([official, Buffer.from('\n')]),
      tampered,
    ]) {
      let caught: unknown;
      try {
        parseCertManagerManifests(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(NetworkingAdapterError);
      expect(caught).toMatchObject({ code: 'CERT_MANAGER_ASSET_INVALID', retryable: false });
      expect(String(caught)).not.toContain('synthetic-sensitive-content');
    }
  });

  it('keeps the distributable lock, runtime constants and multi-architecture pins aligned', async () => {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(lock.version).toBe(CERT_MANAGER_VERSION);
    expect(lock.manifest).toMatchObject(CERT_MANAGER_MANIFEST);
    expect(lock.manifest.maxObjectJsonBytes).toBe(CERT_MANAGER_MAX_OBJECT_BYTES);
    expect(lock.compatibility).toMatchObject({
      kubernetesMajor: 1,
      supportedMinors: [...CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS],
      testedMinors: [...CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS],
    });
    expect(Object.keys(lock.images).sort()).toEqual(Object.keys(CERT_MANAGER_IMAGES).sort());
    for (const [name, pin] of Object.entries(CERT_MANAGER_IMAGES)) {
      const image = lock.images[name];
      expect(pin).toBe(`${image.repository}:${image.tag}@${image.manifestListDigest}`);
      expect(pin).toMatch(
        new RegExp(`^quay\\.io/jetstack/cert-manager-${name}:v1\\.21\\.3@sha256:[a-f0-9]{64}$`),
      );
      expect(image['linux/amd64']).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(image['linux/arm64/v8']).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(
        new Set([image.manifestListDigest, image['linux/amd64'], image['linux/arm64/v8']]).size,
      ).toBe(3);
    }
    const packageJson = JSON.parse(
      await readFile(
        new URL('../../packages/infrastructure/package.json', import.meta.url),
        'utf8',
      ),
    );
    expect(packageJson.files).toEqual(expect.arrayContaining(['dist', 'assets']));
  });
});
