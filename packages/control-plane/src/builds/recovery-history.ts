import {
  BuilderError,
  artifactIdentityHash,
  canonicalJson,
  compareEpoch,
  hashJson,
  parseEndProof,
  parseEpoch,
  parseObservation,
  verifySigned,
  type BuildEndProof,
  type BuilderInventoryRun,
  type RunEpoch,
} from '@ozz/infrastructure/build';

export const BUILD_RECOVERY_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
export const BUILD_RECOVERY_HISTORY_ACTION = 'recovery:accept-builder-history';

export interface BuildRecoveryScope {
  installationId: string;
  generation: number;
  lockedAt: string;
  databaseIdentityHash: string;
  recoveryAuditId: string | null;
}
export interface BuildRecoveryHistoricalRun {
  builderId: string;
  builderInstanceId: string;
  runId: string;
  specHash: string;
  epoch: RunEpoch;
  ledgerRevision: string;
  proofHash: string;
  proof: BuildEndProof;
}
export interface BuildRecoveryManifest {
  version: 1;
  kind: 'ozz-builder-recovery-history';
  id: string;
  createdAt: string;
  scope: BuildRecoveryScope;
  localFingerprint: string;
  historyMetadataRestored: false;
  builders: Array<{
    builderId: string;
    builderInstanceId: string;
    endpoint: string;
    publicKeyFingerprint: string;
    highGeneration: number;
    inventoryRevision: string;
    runInventoryHash: string;
    totalRuns: number;
  }>;
  unknownRuns: BuildRecoveryHistoricalRun[];
}
export interface AcceptedBuilderHistory {
  auditId: string;
  acceptedAt: string;
  manifestHash: string;
  manifest: BuildRecoveryManifest;
}

function invalid(): never {
  throw new BuilderError('BUILD_PROOF_INVALID');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, pattern: RegExp, maximum = 256): string {
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) return invalid();
  return value;
}
const uuid = (value: unknown) => string(value, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
const sha256 = (value: unknown) => string(value, /^[0-9a-f]{64}$/u);
function integer(value: unknown, maximum = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    return invalid();
  return value;
}
function date(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value as unknown[];
}

/** Untrusted operator files and retained audit JSON use the same closed shape. */
export function parseRecoveryManifest(value: unknown): BuildRecoveryManifest {
  if (Buffer.byteLength(canonicalJson(value)) > BUILD_RECOVERY_MANIFEST_MAX_BYTES) return invalid();
  const item = object(value, [
    'version',
    'kind',
    'id',
    'createdAt',
    'scope',
    'localFingerprint',
    'historyMetadataRestored',
    'builders',
    'unknownRuns',
  ]);
  if (
    item.version !== 1 ||
    item.kind !== 'ozz-builder-recovery-history' ||
    item.historyMetadataRestored !== false
  )
    return invalid();
  const scope = object(item.scope, [
    'installationId',
    'generation',
    'lockedAt',
    'databaseIdentityHash',
    'recoveryAuditId',
  ]);
  const builders = array(item.builders, 1000).map((raw) => {
    const builder = object(raw, [
      'builderId',
      'builderInstanceId',
      'endpoint',
      'publicKeyFingerprint',
      'highGeneration',
      'inventoryRevision',
      'runInventoryHash',
      'totalRuns',
    ]);
    return {
      builderId: uuid(builder.builderId),
      builderInstanceId: uuid(builder.builderInstanceId),
      endpoint: string(builder.endpoint, /^https:\/\/[^\s]+$/u, 2048),
      publicKeyFingerprint: sha256(builder.publicKeyFingerprint),
      highGeneration: integer(builder.highGeneration),
      inventoryRevision: sha256(builder.inventoryRevision),
      runInventoryHash: sha256(builder.runInventoryHash),
      totalRuns: integer(builder.totalRuns, 200000),
    };
  });
  const unknownRuns = array(item.unknownRuns, 200000).map((raw) => {
    const run = object(raw, [
      'builderId',
      'builderInstanceId',
      'runId',
      'specHash',
      'epoch',
      'ledgerRevision',
      'proofHash',
      'proof',
    ]);
    const result = {
      builderId: uuid(run.builderId),
      builderInstanceId: uuid(run.builderInstanceId),
      runId: uuid(run.runId),
      specHash: sha256(run.specHash),
      epoch: parseEpoch(run.epoch),
      ledgerRevision: string(run.ledgerRevision, /^(0|[1-9][0-9]{0,29})$/u),
      proofHash: sha256(run.proofHash),
      proof: parseEndProof(run.proof),
    };
    if (hashJson(result.proof) !== result.proofHash) return invalid();
    return result;
  });
  if (
    new Set(builders.map((builder) => builder.builderId)).size !== builders.length ||
    new Set(unknownRuns.map((run) => run.builderId + ':' + run.runId)).size !==
      unknownRuns.length ||
    unknownRuns.some(
      (run) =>
        !builders.some(
          (builder) =>
            builder.builderId === run.builderId &&
            builder.builderInstanceId === run.builderInstanceId,
        ),
    )
  )
    return invalid();
  return {
    version: 1,
    kind: 'ozz-builder-recovery-history',
    id: uuid(item.id),
    createdAt: date(item.createdAt),
    scope: {
      installationId: uuid(scope.installationId),
      generation: integer(scope.generation),
      lockedAt: date(scope.lockedAt),
      databaseIdentityHash: sha256(scope.databaseIdentityHash),
      recoveryAuditId: scope.recoveryAuditId === null ? null : uuid(scope.recoveryAuditId),
    },
    localFingerprint: sha256(item.localFingerprint),
    historyMetadataRestored: false,
    builders,
    unknownRuns,
  };
}

/** Export time and review ID are not authority; fresh complete observations are. */
export function recoveryManifestFacts(manifest: BuildRecoveryManifest): string {
  const { id: _id, createdAt: _createdAt, ...facts } = manifest;
  return hashJson(facts);
}

/** Verifies closure only. No absent source, Deployment, or artifact ownership is invented. */
export function verifyHistoricalRun(
  builder: { id: string; instanceId: string; identityPublicKey: string },
  installationId: string,
  remote: BuilderInventoryRun,
  raw: unknown,
): BuildRecoveryHistoricalRun {
  const observation = parseObservation(raw);
  if (!remote.executionClosed || !observation.proof) return invalid();
  const proof = observation.proof;
  const payload = verifySigned(proof, builder.identityPublicKey);
  if (
    observation.installationId !== installationId ||
    observation.builderInstanceId !== builder.instanceId ||
    observation.runId !== remote.runId ||
    observation.specHash !== remote.specHash ||
    observation.ledgerRevision !== remote.ledgerRevision ||
    compareEpoch(observation.epoch, remote.epoch) !== 0 ||
    payload.installationId !== installationId ||
    payload.builderInstanceId !== builder.instanceId ||
    payload.runId !== remote.runId ||
    payload.specHash !== remote.specHash ||
    payload.ledgerRevision !== remote.ledgerRevision ||
    compareEpoch(payload.epoch, remote.epoch) !== 0 ||
    hashJson(proof) !== remote.proofHash ||
    payload.artifactIdentityHash !==
      (observation.artifact ? artifactIdentityHash(observation.artifact) : null) ||
    (payload.pushReceipt &&
      (!observation.artifact || payload.pushReceipt.rootDigest !== observation.artifact.rootDigest))
  )
    return invalid();
  return {
    builderId: builder.id,
    builderInstanceId: builder.instanceId,
    runId: remote.runId,
    specHash: remote.specHash,
    epoch: remote.epoch,
    ledgerRevision: remote.ledgerRevision,
    proofHash: hashJson(proof),
    proof,
  };
}
