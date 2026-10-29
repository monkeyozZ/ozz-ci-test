import { randomUUID } from 'node:crypto';
import {
  buildContentHash,
  hashBuildSpec,
  type BuildRunSpec,
  type BuildRunObservation,
  type BuildEndProofPayload,
  type OciArtifact,
} from '../../packages/infrastructure/src/build.js';

export function buildSpec(overrides: Partial<BuildRunSpec> = {}): BuildRunSpec {
  return {
    version: 1,
    installationId: randomUUID(),
    runId: randomUUID(),
    deploymentId: randomUUID(),
    source: {
      githubRepositoryId: '123456',
      commitSha: 'a'.repeat(40),
      recipeHash: 'b'.repeat(64),
      dockerfilePath: 'Dockerfile',
      contextPath: '.',
      buildArgs: {},
      buildSecrets: [],
      platforms: [{ os: 'linux', architecture: 'arm64' }],
    },
    profile: {
      instanceId: randomUUID(),
      profileRevision: 1,
      buildkitVersion: 'v0.25.1',
      frontendDigest: `sha256:${'c'.repeat(64)}`,
    },
    destination: { authority: 'registry.example.test', repository: 'ozz/service' },
    limits: {
      cpuMillis: 1000,
      memoryMiB: 512,
      pids: 64,
      diskBytes: '1073741824',
      timeoutSeconds: 120,
    },
    deadlineAt: new Date(Date.now() + 120000).toISOString(),
    action: 'build_and_push',
    ...overrides,
  } as BuildRunSpec;
}
export function ociArtifact(spec: BuildRunSpec): OciArtifact {
  const rootDigest = `sha256:${'d'.repeat(64)}`;
  return {
    id: randomUUID(),
    producedByRunId: spec.runId,
    contentHash: buildContentHash(spec),
    commitSha: spec.source.commitSha,
    recipeHash: spec.source.recipeHash,
    rootDigest,
    rootMediaType: 'application/vnd.oci.image.manifest.v1+json',
    platforms: [
      {
        os: 'linux',
        architecture: 'arm64',
        manifestDigest: rootDigest,
        manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
        configDigest: `sha256:${'e'.repeat(64)}`,
      },
    ],
    archive: {
      builderInstanceId: spec.profile.instanceId,
      handle: randomUUID(),
      sha256: 'f'.repeat(64),
      bytes: '10240',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    producedAt: new Date().toISOString(),
  };
}
export function endPayload(spec: BuildRunSpec): BuildEndProofPayload {
  return {
    version: 1,
    installationId: spec.installationId,
    builderInstanceId: spec.profile.instanceId,
    runId: spec.runId,
    specHash: hashBuildSpec(spec),
    epoch: { generation: 0, ownershipEpoch: 1 },
    ledgerRevision: '2',
    endedAt: new Date().toISOString(),
    disposition: { outcome: 'cancelled' },
    processes: { checkout: 'never_started', solve: 'never_started', uploader: 'never_started' },
    executionClosed: true,
    cancelTombstone: true,
    terminationEvidence: { kind: 'never_started' },
    artifactIdentityHash: null,
    pushReceipt: null,
  };
}
export function openObservation(spec: BuildRunSpec): BuildRunObservation {
  return {
    version: 1,
    installationId: spec.installationId,
    builderInstanceId: spec.profile.instanceId,
    runId: spec.runId,
    specHash: hashBuildSpec(spec),
    epoch: { generation: 0, ownershipEpoch: 1 },
    ledgerRevision: '1',
    phase: 'checkout',
    state: 'running',
    leaseUntil: new Date(Date.now() + 30000).toISOString(),
    credentialRequest: null,
    artifact: null,
    proof: null,
  };
}
