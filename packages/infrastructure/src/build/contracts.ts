import type {
  ImagePlatform,
  RegistryMediaType,
  ResolvedImagePlatform,
} from '../registry/contracts.js';

/** This wire protocol deliberately has no persistence/domain dependencies. */
export interface RunEpoch {
  generation: number;
  ownershipEpoch: number;
}
export interface BuildDestination {
  authority: string;
  repository: string;
}
export interface BuildProfile {
  instanceId: string;
  profileRevision: number;
  buildkitVersion: string;
  frontendDigest: string;
}
export interface BuildSource {
  githubRepositoryId: string;
  commitSha: string;
  recipeHash: string;
  dockerfilePath: string;
  contextPath: string;
  buildArgs: Record<string, string>;
  buildSecrets: Array<{ mountId: string; version: string }>;
  platforms: ImagePlatform[];
}
export interface BuildLimits {
  cpuMillis: number;
  memoryMiB: number;
  pids: number;
  diskBytes: string;
  timeoutSeconds: number;
}
export interface OciArtifact {
  id: string;
  producedByRunId: string;
  contentHash: string;
  commitSha: string;
  recipeHash: string;
  rootDigest: string;
  rootMediaType: RegistryMediaType;
  platforms: ResolvedImagePlatform[];
  archive: {
    builderInstanceId: string;
    handle: string;
    sha256: string;
    bytes: string;
    expiresAt: string;
  };
  producedAt: string;
}
export type BuildRunSpec = {
  version: 1;
  installationId: string;
  runId: string;
  deploymentId: string;
  source: BuildSource;
  profile: BuildProfile;
  destination: BuildDestination;
  limits: BuildLimits;
  deadlineAt: string;
} & ({ action: 'build_and_push' } | { action: 'push_existing'; artifact: OciArtifact });
export type BuildPhase = 'checkout' | 'building' | 'exporting' | 'pushing';
export type CredentialPhase = 'checkout' | 'building' | 'pushing';
export type EndDisposition =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; phase: BuildPhase; code: string; exitCode: number | null }
  | { outcome: 'cancelled' }
  | { outcome: 'timed_out'; phase: BuildPhase };
export type TerminationEvidence =
  | { kind: 'never_started' }
  | { kind: 'cgroup_empty'; executionGroupId: string; bootId: string }
  | { kind: 'host_rebooted'; executionBootId: string; observedBootId: string };
export interface BuildEndProofPayload {
  version: 1;
  installationId: string;
  builderInstanceId: string;
  runId: string;
  specHash: string;
  epoch: RunEpoch;
  ledgerRevision: string;
  endedAt: string;
  disposition: EndDisposition;
  processes: Record<'checkout' | 'solve' | 'uploader', 'never_started' | 'terminated'>;
  executionClosed: true;
  cancelTombstone: boolean;
  terminationEvidence: TerminationEvidence;
  artifactIdentityHash: string | null;
  pushReceipt: { destination: BuildDestination; rootDigest: string; confirmedAt: string } | null;
}
export interface SignedPayload<T> {
  payload: T;
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
}
export type BuildEndProof = SignedPayload<BuildEndProofPayload>;
export interface BuildRunObservation {
  version: 1;
  installationId: string;
  builderInstanceId: string;
  runId: string;
  specHash: string;
  epoch: RunEpoch;
  ledgerRevision: string;
  phase: BuildPhase;
  state: 'awaiting_credentials' | 'running' | 'cancelling' | 'ended';
  leaseUntil: string;
  credentialRequest: { phase: CredentialPhase; nonce: string } | null;
  artifact: OciArtifact | null;
  proof: BuildEndProof | null;
}
export interface BuildSubmit {
  spec: BuildRunSpec;
  specHash: string;
  epoch: RunEpoch;
  leaseUntil: string;
}
export interface BuildCancel {
  specHash: string;
  epoch: RunEpoch;
  reason: 'cancelled' | 'superseded' | 'deadline';
}
export type BuildCredentials = {
  specHash: string;
  epoch: RunEpoch;
  nonce: string;
  expiresAt: string;
} & (
  | {
      phase: 'checkout';
      githubRepositoryId: string;
      fullName: string;
      cloneUrl: string;
      caCertificate?: string;
      commitSha: string;
      token: string;
    }
  | { phase: 'building'; secrets: Array<{ mountId: string; version: string; value: string }> }
  | {
      phase: 'pushing';
      authority: string;
      username: string;
      password: string;
      caCertificate?: string;
      tokenServiceOrigins?: string[];
    }
);
export interface BuildEvent {
  sequence: string;
  phase: BuildPhase;
  at: string;
  kind: 'output' | 'truncated' | 'phase';
  text: string;
}
export interface BuildEventPage {
  events: BuildEvent[];
  nextSequence: string;
  truncated: boolean;
  expired: boolean;
}
export interface BuilderIdentity {
  version: 1;
  challenge: string;
  instanceId: string;
  profile: BuildProfile;
  platform: ImagePlatform;
  isolation: {
    rootless: true;
    processSandbox: true;
    separateUids: true;
    cgroupV2: true;
    hardDiskQuota: true;
    egressPolicy: true;
    independentWatchdog: true;
  };
  limits: BuildLimits;
  maxConcurrency: number;
  highGeneration: number;
  checkedAt: string;
}
export interface BuildInstallationFence {
  installationId: string;
  builderInstanceId: string;
  requestId: string;
  generation: number;
  challenge: string;
}
export interface BuilderFenceReceipt extends BuildInstallationFence {
  version: 1;
  highGeneration: number;
  fencedAt: string;
}
export interface BuilderInventoryRun {
  runId: string;
  specHash: string;
  epoch: RunEpoch;
  ledgerRevision: string;
  executionClosed: boolean;
  proofHash: string | null;
}
export interface BuilderInventoryPage {
  version: 1;
  installationId: string;
  builderInstanceId: string;
  challenge: string;
  highGeneration: number;
  inventoryRevision: string;
  snapshotId: string;
  expiresAt: string;
  offset: number;
  totalRuns: number;
  runs: BuilderInventoryRun[];
  nextCursor: string | null;
}
export interface BuilderClient {
  identity(challenge: string, signal?: AbortSignal): Promise<SignedPayload<BuilderIdentity>>;
  fence(
    request: BuildInstallationFence,
    signal?: AbortSignal,
  ): Promise<SignedPayload<BuilderFenceReceipt>>;
  inventory(
    challenge: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SignedPayload<BuilderInventoryPage>>;
  submit(request: BuildSubmit, signal?: AbortSignal): Promise<BuildRunObservation>;
  get(runId: string, signal?: AbortSignal): Promise<BuildRunObservation | null>;
  renew(
    runId: string,
    request: { specHash: string; epoch: RunEpoch; leaseUntil: string },
    signal?: AbortSignal,
  ): Promise<BuildRunObservation>;
  credentials(
    runId: string,
    request: BuildCredentials,
    signal?: AbortSignal,
  ): Promise<BuildRunObservation>;
  cancel(runId: string, request: BuildCancel, signal?: AbortSignal): Promise<BuildRunObservation>;
  events(runId: string, after: string, signal?: AbortSignal): Promise<BuildEventPage>;
}
export type BuilderErrorCode =
  | 'BUILD_SPEC_INVALID'
  | 'BUILD_PROTOCOL_INVALID'
  | 'BUILD_IDENTITY_MISMATCH'
  | 'BUILD_PROOF_INVALID'
  | 'BUILD_SPEC_CONFLICT'
  | 'BUILD_EPOCH_STALE'
  | 'BUILD_RUN_UNKNOWN'
  | 'BUILD_BUSY'
  | 'BUILD_UNAVAILABLE'
  | 'BUILD_TIMEOUT'
  | 'BUILD_TRANSPORT_CANCELLED'
  | 'BUILD_TLS_INVALID'
  | 'BUILD_AUTH_INVALID'
  | 'BUILD_CREDENTIALS_REJECTED'
  | 'BUILD_ISOLATION_UNAVAILABLE'
  | 'BUILD_ARTIFACT_MISSING'
  | 'BUILD_ARTIFACT_INVALID'
  | 'BUILD_PATH_INVALID'
  | 'BUILD_FRONTEND_REJECTED'
  | 'BUILD_INVENTORY_EXPIRED'
  | 'BUILD_CHECKOUT_FAILED'
  | 'BUILD_SOLVE_FAILED'
  | 'BUILD_PUSH_FAILED'
  | 'BUILD_LIMIT_EXCEEDED';
/** Never retain request bodies, credentials, remote output, URLs, or raw causes. */
export class BuilderError extends Error {
  constructor(
    readonly code: BuilderErrorCode,
    readonly retryable = false,
    readonly httpStatus?: number,
  ) {
    super(code);
    this.name = 'BuilderError';
  }
}
