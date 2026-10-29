import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BuilderError,
  HttpBuilderClient,
  canonicalJson,
  hashBuildSpec,
  parseBuildRunSpec,
  parseCredentials,
  parseEpoch,
  parseEndProof,
  parseEventPage,
  repositoryPath,
  signPayload,
  verifyEndProof,
} from '../../packages/infrastructure/src/build.js';
import { buildSpec, endPayload, openObservation } from './build-fixture.js';

describe('Builder wire identity and termination proof', () => {
  it('admits generation zero and hashes canonical content without maintenance authentication', () => {
    expect(parseEpoch({ generation: 0, ownershipEpoch: 1 })).toEqual({
      generation: 0,
      ownershipEpoch: 1,
    });
    const spec = buildSpec();
    const changed = structuredClone(spec);
    spec.source.buildArgs = { FIRST: '1', SECOND: '2' };
    changed.source.buildArgs = { SECOND: '2', FIRST: '1' };
    expect(hashBuildSpec(spec)).toBe(hashBuildSpec(changed));
    expect(() => parseBuildRunSpec({ ...spec, token: 'must-not-enter-spec' })).toThrow(
      BuilderError,
    );
    expect(() =>
      parseBuildRunSpec({ ...spec, source: { ...spec.source, revision: { id: randomUUID() } } }),
    ).toThrow(BuilderError);
    expect(() => parseEpoch({ generation: -1, ownershipEpoch: 1 })).toThrow(BuilderError);
    expect(() => parseEpoch({ generation: 0, ownershipEpoch: 0 })).toThrow(BuilderError);
  });
  it.each([
    '/Dockerfile',
    '../Dockerfile',
    'a/../Dockerfile',
    'a\\Dockerfile',
    'a//Dockerfile',
    './Dockerfile',
    'a\0b',
  ])('rejects unsafe repository path %j', (path) => {
    expect(() => repositoryPath(path)).toThrow(BuilderError);
  });
  it('requires a full immutable commit and fixed secret version tokens', () => {
    const spec = buildSpec();
    expect(() =>
      parseBuildRunSpec({ ...spec, source: { ...spec.source, commitSha: 'main' } }),
    ).toThrow();
    expect(() =>
      parseBuildRunSpec({
        ...spec,
        source: {
          ...spec.source,
          buildSecrets: [{ mountId: 'secret', version: '1', value: 'secret-bytes' }],
        },
      }),
    ).toThrow();
  });
  it('keeps credentials out of the immutable hash while strictly binding their phase and clone locator', () => {
    const spec = buildSpec();
    const base = {
      specHash: hashBuildSpec(spec),
      epoch: { generation: 0, ownershipEpoch: 1 },
      nonce: randomUUID(),
      expiresAt: new Date().toISOString(),
      phase: 'checkout',
      githubRepositoryId: spec.source.githubRepositoryId,
      fullName: 'owner/repo',
      cloneUrl: 'https://github.com/owner/repo.git',
      commitSha: spec.source.commitSha,
      token: 'write-only-fixture',
    };
    expect(parseCredentials(base).phase).toBe('checkout');
    expect(() =>
      parseCredentials({ ...base, cloneUrl: 'https://github.com/another/repo.git' }),
    ).toThrow();
    expect(() =>
      parseCredentials({ ...base, cloneUrl: 'https://token@github.com/owner/repo.git' }),
    ).toThrow();
    expect(() => parseCredentials({ ...base, phase: 'pushing' })).toThrow();
    expect(() => parseCredentials({ ...base, pullPassword: 'not-a-builder-credential' })).toThrow();
  });
  it('accepts the original terminal epoch in the GET-to-takeover race, but rejects stale observed facts', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const spec = buildSpec();
    const proof = signPayload(endPayload(spec), privateKey);
    expect(
      verifyEndProof(proof, {
        spec,
        specHash: hashBuildSpec(spec),
        publicKey: key,
        minimumEpoch: { generation: 0, ownershipEpoch: 1 },
        maximumEpoch: { generation: 0, ownershipEpoch: 2 },
        minimumLedgerRevision: '1',
        artifact: null,
      }),
    ).toEqual(proof);
    expect(() =>
      verifyEndProof(proof, {
        spec,
        specHash: hashBuildSpec(spec),
        publicKey: key,
        minimumEpoch: { generation: 1, ownershipEpoch: 1 },
      }),
    ).toThrow();
    expect(() =>
      verifyEndProof(proof, {
        spec,
        specHash: hashBuildSpec(spec),
        publicKey: key,
        minimumLedgerRevision: '3',
      }),
    ).toThrow();
    expect(() =>
      verifyEndProof(
        { ...proof, payload: { ...proof.payload, runId: randomUUID() } },
        { spec, specHash: hashBuildSpec(spec), publicKey: key },
      ),
    ).toThrow();
    expect(() =>
      verifyEndProof(proof, {
        spec: { ...spec, profile: { ...spec.profile, instanceId: randomUUID() } },
        specHash: hashBuildSpec(spec),
        publicKey: key,
      }),
    ).toThrow();
  });
  it('rejects a reboot assertion with unchanged boot ID and false never-started evidence', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const spec = buildSpec();
    const bootId = randomUUID();
    expect(() =>
      parseEndProof(
        signPayload(
          {
            ...endPayload(spec),
            terminationEvidence: {
              kind: 'host_rebooted',
              executionBootId: bootId,
              observedBootId: bootId,
            },
          },
          privateKey,
        ),
      ),
    ).toThrow();
    expect(() =>
      parseEndProof(
        signPayload(
          {
            ...endPayload(spec),
            processes: {
              checkout: 'terminated',
              solve: 'never_started',
              uploader: 'never_started',
            },
          },
          privateKey,
        ),
      ),
    ).toThrow();
  });
  it('preserves decimal bigint cursors and bounds remote output', () => {
    const event = {
      sequence: '9007199254740993',
      phase: 'building',
      at: new Date().toISOString(),
      kind: 'output',
      text: 'output',
    };
    expect(
      parseEventPage({
        events: [event],
        nextSequence: event.sequence,
        truncated: false,
        expired: false,
      }).nextSequence,
    ).toBe('9007199254740993');
    expect(() =>
      parseEventPage({
        events: [{ ...event, text: 'x'.repeat(8193) }],
        nextSequence: event.sequence,
        truncated: false,
        expired: false,
      }),
    ).toThrow();
    expect(() => canonicalJson({ bigintAsNumber: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});

describe('production Builder HTTP adapter with a controlled transport', () => {
  it('distinguishes an absent ledger from transport failure and never fabricates termination', async () => {
    const client = new HttpBuilderClient({
      async request() {
        return { status: 404, body: '{}' };
      },
    });
    expect(await client.get(randomUUID())).toBeNull();
    const unavailable = new HttpBuilderClient({
      async request() {
        throw new BuilderError('BUILD_TIMEOUT', true);
      },
    });
    await expect(unavailable.get(randomUUID())).rejects.toMatchObject({ code: 'BUILD_TIMEOUT' });
  });
  it('serializes the immutable submit request and rejects an invalid successful response', async () => {
    const spec = buildSpec();
    let body: unknown;
    const client = new HttpBuilderClient({
      async request(input) {
        body = JSON.parse(input.body!);
        return { status: 200, body: JSON.stringify(openObservation(spec)) };
      },
    });
    await client.submit({
      spec,
      specHash: hashBuildSpec(spec),
      epoch: { generation: 0, ownershipEpoch: 1 },
      leaseUntil: new Date().toISOString(),
    });
    expect(body).toMatchObject({
      spec: { source: { commitSha: spec.source.commitSha } },
      epoch: { generation: 0 },
    });
    const invalid = new HttpBuilderClient({
      async request() {
        return { status: 200, body: '{"state":"failed","pidExited":true}' };
      },
    });
    await expect(invalid.get(spec.runId)).rejects.toThrow(BuilderError);
  });
});
