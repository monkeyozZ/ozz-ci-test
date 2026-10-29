import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  BuilderError,
  type BuildRunSpec,
  type BuildEndProof,
  type SignedPayload,
  type OciArtifact,
  type RunEpoch,
  type BuilderInventoryRun,
  type BuilderInventoryPage,
} from './contracts.js';
import {
  compareEpoch,
  parseBuildRunSpec,
  parseEndProof,
  parseInventoryPage,
} from './validation.js';

/** Object keys are sorted recursively; JSON numbers must be finite safe integers. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  throw new BuilderError('BUILD_SPEC_INVALID');
}
export const hashJson = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const hashBuildSpec = (spec: BuildRunSpec): string => hashJson(parseBuildRunSpec(spec));
/** Excludes run/deployment/deadline and maintenance authentication. Secret version tokens remain. */
export const buildContentHash = (spec: BuildRunSpec): string =>
  hashJson({ version: 1, source: spec.source, profile: spec.profile });
export const artifactIdentityHash = (artifact: OciArtifact): string => hashJson(artifact);
export const inventoryRevision = (
  installationId: string,
  builderInstanceId: string,
  highGeneration: number,
  runs: BuilderInventoryRun[],
): string => hashJson({ version: 1, installationId, builderInstanceId, highGeneration, runs });
export function signingKeyId(publicKey: string | KeyObject): string {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new BuilderError('BUILD_IDENTITY_MISMATCH');
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}
export function signPayload<T>(payload: T, privateKey: string | KeyObject): SignedPayload<T> {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new BuilderError('BUILD_IDENTITY_MISMATCH');
  return {
    payload,
    signature: {
      algorithm: 'Ed25519',
      keyId: signingKeyId(createPublicKey(key)),
      value: sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64url'),
    },
  };
}
export function verifySigned<T>(signed: SignedPayload<T>, publicKey: string | KeyObject): T {
  try {
    const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
    if (
      signed.signature.algorithm !== 'Ed25519' ||
      signed.signature.keyId !== signingKeyId(key) ||
      !verify(
        null,
        Buffer.from(canonicalJson(signed.payload)),
        key,
        Buffer.from(signed.signature.value, 'base64url'),
      )
    )
      throw new Error();
    return signed.payload;
  } catch {
    throw new BuilderError('BUILD_PROOF_INVALID');
  }
}
export interface ProofExpectation {
  spec: BuildRunSpec;
  specHash: string;
  publicKey: string;
  /** Last *observed remote* epoch, not a just-allocated takeover epoch. */
  minimumEpoch?: RunEpoch;
  maximumEpoch?: RunEpoch;
  minimumLedgerRevision?: string;
  artifact?: OciArtifact | null;
}
export function verifyEndProof(raw: unknown, expected: ProofExpectation): BuildEndProof {
  const proof = parseEndProof(raw);
  const payload = verifySigned(proof, expected.publicKey);
  const spec = expected.spec;
  if (
    payload.installationId !== spec.installationId ||
    payload.builderInstanceId !== spec.profile.instanceId ||
    payload.runId !== spec.runId ||
    payload.specHash !== expected.specHash ||
    (expected.minimumEpoch && compareEpoch(payload.epoch, expected.minimumEpoch) < 0) ||
    (expected.maximumEpoch && compareEpoch(payload.epoch, expected.maximumEpoch) > 0) ||
    (expected.minimumLedgerRevision &&
      BigInt(payload.ledgerRevision) < BigInt(expected.minimumLedgerRevision))
  )
    throw new BuilderError('BUILD_PROOF_INVALID');
  if (
    expected.artifact !== undefined &&
    payload.artifactIdentityHash !==
      (expected.artifact ? artifactIdentityHash(expected.artifact) : null)
  )
    throw new BuilderError('BUILD_PROOF_INVALID');
  if (
    payload.pushReceipt &&
    (canonicalJson(payload.pushReceipt.destination) !== canonicalJson(spec.destination) ||
      (expected.artifact && payload.pushReceipt.rootDigest !== expected.artifact.rootDigest))
  )
    throw new BuilderError('BUILD_PROOF_INVALID');
  return proof;
}
/** A valid page is insufficient: all pages must form one complete, unexpired signed snapshot. */
export function verifyInventoryPages(
  raw: unknown[],
  expected: {
    installationId: string;
    builderInstanceId: string;
    challenge: string;
    publicKey: string;
    now?: number;
  },
): Omit<BuilderInventoryPage, 'offset' | 'nextCursor'> {
  if (!raw.length) throw new BuilderError('BUILD_PROOF_INVALID');
  const pages = raw.map((page) => verifySigned(parseInventoryPage(page), expected.publicKey));
  const first = pages[0]!;
  const runs: BuilderInventoryRun[] = [];
  const now = expected.now ?? Date.now();
  if (pages.length !== Math.max(1, Math.ceil(first.totalRuns / 100)))
    throw new BuilderError('BUILD_PROOF_INVALID');
  if (Date.parse(first.expiresAt) <= now || Date.parse(first.expiresAt) > now + 65000)
    throw new BuilderError('BUILD_INVENTORY_EXPIRED');
  for (const page of pages) {
    if (
      page.installationId !== expected.installationId ||
      page.builderInstanceId !== expected.builderInstanceId ||
      page.challenge !== expected.challenge ||
      page.snapshotId !== first.snapshotId ||
      page.inventoryRevision !== first.inventoryRevision ||
      page.highGeneration !== first.highGeneration ||
      page.totalRuns !== first.totalRuns ||
      page.expiresAt !== first.expiresAt ||
      page.offset !== runs.length
    )
      throw new BuilderError('BUILD_PROOF_INVALID');
    runs.push(...page.runs);
  }
  if (
    runs.length !== first.totalRuns ||
    pages.at(-1)!.nextCursor !== null ||
    runs.some((run, index) => index > 0 && run.runId <= runs[index - 1]!.runId) ||
    inventoryRevision(first.installationId, first.builderInstanceId, first.highGeneration, runs) !==
      first.inventoryRevision
  )
    throw new BuilderError('BUILD_PROOF_INVALID');
  const { offset: _offset, nextCursor: _cursor, ...snapshot } = first;
  return { ...snapshot, runs };
}
