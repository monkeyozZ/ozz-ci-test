import {
  registryIndexMediaTypes,
  registryManifestMediaTypes,
  type ImagePlatform,
  type ResolvedImagePlatform,
} from '../registry/contracts.js';
import {
  BuilderError,
  type BuildRunSpec,
  type BuildSource,
  type BuildProfile,
  type BuildDestination,
  type BuildLimits,
  type RunEpoch,
  type OciArtifact,
  type BuildSubmit,
  type BuildCancel,
  type BuildCredentials,
  type BuildEndProof,
  type BuildRunObservation,
  type BuildPhase,
  type CredentialPhase,
  type EndDisposition,
  type BuildEventPage,
  type BuilderIdentity,
  type SignedPayload,
  type BuildInstallationFence,
  type BuilderFenceReceipt,
  type BuilderInventoryPage,
  type BuilderInventoryRun,
} from './contracts.js';

export function invalid(): never {
  throw new BuilderError('BUILD_PROTOCOL_INVALID');
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) return invalid();
  return record;
}
export function string(value: unknown, max = 512, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    Buffer.byteLength(value) > max ||
    (pattern && !pattern.test(value))
  )
    return invalid();
  return value;
}
export function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid();
  return value;
}
export function literal<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid();
  return value as T;
}
export const uuid = (value: unknown): string =>
  string(value, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
export const sha256 = (value: unknown): string => string(value, 64, /^[0-9a-f]{64}$/u);
export const commitSha = (value: unknown): string => string(value, 40, /^[0-9a-f]{40}$/u);
export const challenge = (value: unknown): string => string(value, 128, /^[A-Za-z0-9_-]{32,128}$/u);
export const digest = (value: unknown): string => string(value, 71, /^sha256:[0-9a-f]{64}$/u);
export function sequence(value: unknown): string {
  const result = string(value, 19, /^(0|[1-9][0-9]*)$/u);
  if (BigInt(result) > 9223372036854775807n) return invalid();
  return result;
}
export function isoDate(value: unknown): string {
  const result = string(value, 24, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result)
    return invalid();
  return result;
}
export function repositoryPath(value: unknown, allowRoot = false): string {
  const result = string(value, 512);
  if (allowRoot && result === '.') return result;
  if (
    result.startsWith('/') ||
    // eslint-disable-next-line no-control-regex -- Repository paths cannot contain control bytes.
    /[\\\u0000-\u001f\u007f]/u.test(result) ||
    result.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new BuilderError('BUILD_PATH_INVALID');
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
export function parseEpoch(value: unknown): RunEpoch {
  const item = object(value, ['generation', 'ownershipEpoch']);
  return { generation: integer(item.generation, 0), ownershipEpoch: integer(item.ownershipEpoch) };
}
export function compareEpoch(a: RunEpoch, b: RunEpoch): number {
  return Math.sign(a.generation - b.generation || a.ownershipEpoch - b.ownershipEpoch);
}
function platform(value: unknown): ImagePlatform {
  const item = object(value, ['os', 'architecture', 'variant']);
  const result: ImagePlatform = {
    os: literal(item.os, ['linux']),
    architecture: literal(item.architecture, ['amd64', 'arm64']),
  };
  if (item.variant !== undefined) result.variant = string(item.variant, 8, /^v[1-9][0-9]?$/u);
  return result;
}
export function parseDestination(value: unknown): BuildDestination {
  const item = object(value, ['authority', 'repository']);
  const authority = string(
    item.authority,
    253,
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/u,
  );
  const url = new URL(`https://${authority}`);
  if (url.host !== authority || authority.includes('..')) return invalid();
  return {
    authority,
    repository: string(
      item.repository,
      255,
      /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/u,
    ),
  };
}
export function parseProfile(value: unknown): BuildProfile {
  const item = object(value, [
    'instanceId',
    'profileRevision',
    'buildkitVersion',
    'frontendDigest',
  ]);
  return {
    instanceId: uuid(item.instanceId),
    profileRevision: integer(item.profileRevision),
    buildkitVersion: string(item.buildkitVersion, 32, /^v?\d+\.\d+\.\d+$/u),
    frontendDigest: digest(item.frontendDigest),
  };
}
export function parseLimits(value: unknown): BuildLimits {
  const item = object(value, ['cpuMillis', 'memoryMiB', 'pids', 'diskBytes', 'timeoutSeconds']);
  const diskBytes = sequence(item.diskBytes);
  if (BigInt(diskBytes) < 1048576n || BigInt(diskBytes) > 1099511627776n) return invalid();
  return {
    cpuMillis: integer(item.cpuMillis, 100, 64000),
    memoryMiB: integer(item.memoryMiB, 128, 262144),
    pids: integer(item.pids, 16, 4096),
    diskBytes,
    timeoutSeconds: integer(item.timeoutSeconds, 1, 7200),
  };
}
export function parseSource(value: unknown): BuildSource {
  const item = object(value, [
    'githubRepositoryId',
    'commitSha',
    'recipeHash',
    'dockerfilePath',
    'contextPath',
    'buildArgs',
    'buildSecrets',
    'platforms',
  ]);
  const args = object(item.buildArgs, Object.keys((item.buildArgs ?? {}) as object));
  if (Object.keys(args).length > 32) return invalid();
  const buildArgs: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(args)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) ||
      key.startsWith('BUILDKIT_') ||
      typeof value !== 'string' ||
      Buffer.byteLength(value) > 4096 ||
      value.includes('\0')
    )
      return invalid();
    buildArgs[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(buildArgs)) > 16384) return invalid();
  const buildSecrets = array(item.buildSecrets, 16).map((value) => {
    const secret = object(value, ['mountId', 'version']);
    return {
      mountId: string(secret.mountId, 64, /^[A-Za-z][A-Za-z0-9_.-]*$/u),
      version: string(secret.version, 256, /^[A-Za-z0-9:_.-]+$/u),
    };
  });
  if (new Set(buildSecrets.map((secret) => secret.mountId)).size !== buildSecrets.length)
    return invalid();
  const platforms = array(item.platforms, 2).map(platform);
  if (
    !platforms.length ||
    new Set(platforms.map((p) => `${p.os}/${p.architecture}/${p.variant ?? ''}`)).size !==
      platforms.length
  )
    return invalid();
  const githubRepositoryId = sequence(item.githubRepositoryId);
  if (githubRepositoryId === '0') return invalid();
  return {
    githubRepositoryId,
    commitSha: commitSha(item.commitSha),
    recipeHash: sha256(item.recipeHash),
    dockerfilePath: repositoryPath(item.dockerfilePath),
    contextPath: repositoryPath(item.contextPath, true),
    buildArgs,
    buildSecrets,
    platforms,
  };
}
export function parseArtifact(value: unknown): OciArtifact {
  const item = object(value, [
    'id',
    'producedByRunId',
    'contentHash',
    'commitSha',
    'recipeHash',
    'rootDigest',
    'rootMediaType',
    'platforms',
    'archive',
    'producedAt',
  ]);
  const archive = object(item.archive, [
    'builderInstanceId',
    'handle',
    'sha256',
    'bytes',
    'expiresAt',
  ]);
  const platforms: ResolvedImagePlatform[] = array(item.platforms, 2).map((value) => {
    const entry = object(value, [
      'os',
      'architecture',
      'variant',
      'manifestDigest',
      'manifestMediaType',
      'configDigest',
    ]);
    return {
      ...platform({
        os: entry.os,
        architecture: entry.architecture,
        ...(entry.variant === undefined ? {} : { variant: entry.variant }),
      }),
      manifestDigest: digest(entry.manifestDigest),
      manifestMediaType: literal(entry.manifestMediaType, registryManifestMediaTypes),
      configDigest: digest(entry.configDigest),
    };
  });
  if (!platforms.length) return invalid();
  return {
    id: uuid(item.id),
    producedByRunId: uuid(item.producedByRunId),
    contentHash: sha256(item.contentHash),
    commitSha: commitSha(item.commitSha),
    recipeHash: sha256(item.recipeHash),
    rootDigest: digest(item.rootDigest),
    rootMediaType: literal(item.rootMediaType, [
      ...registryManifestMediaTypes,
      ...registryIndexMediaTypes,
    ]),
    platforms,
    archive: {
      builderInstanceId: uuid(archive.builderInstanceId),
      handle: uuid(archive.handle),
      sha256: sha256(archive.sha256),
      bytes: sequence(archive.bytes),
      expiresAt: isoDate(archive.expiresAt),
    },
    producedAt: isoDate(item.producedAt),
  };
}
export function parseBuildRunSpec(value: unknown): BuildRunSpec {
  const item = object(value, [
    'version',
    'installationId',
    'runId',
    'deploymentId',
    'source',
    'profile',
    'destination',
    'limits',
    'deadlineAt',
    'action',
    'artifact',
  ]);
  if (item.version !== 1) return invalid();
  const base = {
    version: 1 as const,
    installationId: uuid(item.installationId),
    runId: uuid(item.runId),
    deploymentId: uuid(item.deploymentId),
    source: parseSource(item.source),
    profile: parseProfile(item.profile),
    destination: parseDestination(item.destination),
    limits: parseLimits(item.limits),
    deadlineAt: isoDate(item.deadlineAt),
  };
  if (item.action === 'push_existing')
    return { ...base, action: 'push_existing', artifact: parseArtifact(item.artifact) };
  if (item.action !== 'build_and_push' || item.artifact !== undefined) return invalid();
  return { ...base, action: 'build_and_push' };
}
export function parseSubmit(value: unknown): BuildSubmit {
  const item = object(value, ['spec', 'specHash', 'epoch', 'leaseUntil']);
  return {
    spec: parseBuildRunSpec(item.spec),
    specHash: sha256(item.specHash),
    epoch: parseEpoch(item.epoch),
    leaseUntil: isoDate(item.leaseUntil),
  };
}
export function parseCancel(value: unknown): BuildCancel {
  const item = object(value, ['specHash', 'epoch', 'reason']);
  return {
    specHash: sha256(item.specHash),
    epoch: parseEpoch(item.epoch),
    reason: literal(item.reason, ['cancelled', 'superseded', 'deadline']),
  };
}
export function parseCredentials(value: unknown): BuildCredentials {
  const item = object(value, [
    'specHash',
    'epoch',
    'nonce',
    'expiresAt',
    'phase',
    'githubRepositoryId',
    'fullName',
    'cloneUrl',
    'caCertificate',
    'commitSha',
    'token',
    'secrets',
    'authority',
    'username',
    'password',
    'tokenServiceOrigins',
  ]);
  const base = {
    specHash: sha256(item.specHash),
    epoch: parseEpoch(item.epoch),
    nonce: uuid(item.nonce),
    expiresAt: isoDate(item.expiresAt),
  };
  const phase = literal(item.phase, ['checkout', 'building', 'pushing']);
  const allowed =
    phase === 'checkout'
      ? ['githubRepositoryId', 'fullName', 'cloneUrl', 'caCertificate', 'commitSha', 'token']
      : phase === 'building'
        ? ['secrets']
        : ['authority', 'username', 'password', 'caCertificate', 'tokenServiceOrigins'];
  object(item, ['specHash', 'epoch', 'nonce', 'expiresAt', 'phase', ...allowed]);
  if (phase === 'checkout') {
    const fullName = string(
      item.fullName,
      201,
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u,
    );
    const cloneUrl = string(item.cloneUrl, 512);
    let url: URL;
    try {
      url = new URL(cloneUrl);
    } catch {
      return invalid();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/${fullName}.git` ||
      url.href !== cloneUrl
    )
      return invalid();
    const caCertificate =
      item.caCertificate === undefined ? undefined : string(item.caCertificate, 65536);
    if (
      caCertificate &&
      (!caCertificate.startsWith('-----BEGIN CERTIFICATE-----') ||
        /PRIVATE KEY/u.test(caCertificate))
    )
      return invalid();
    return {
      ...base,
      phase,
      githubRepositoryId: sequence(item.githubRepositoryId),
      fullName,
      cloneUrl,
      ...(caCertificate ? { caCertificate } : {}),
      commitSha: commitSha(item.commitSha),
      // eslint-disable-next-line no-control-regex -- Credential tokens cannot contain ASCII whitespace/control bytes.
      token: string(item.token, 8192, /^[^\u0000-\u0020\u007f]+$/u),
    };
  }
  if (phase === 'pushing') {
    const caCertificate =
      item.caCertificate === undefined ? undefined : string(item.caCertificate, 65536);
    if (
      caCertificate &&
      (!caCertificate.startsWith('-----BEGIN CERTIFICATE-----') ||
        /PRIVATE KEY/u.test(caCertificate))
    )
      return invalid();
    const tokenServiceOrigins =
      item.tokenServiceOrigins === undefined
        ? undefined
        : array(item.tokenServiceOrigins, 8).map((value) => {
            const origin = string(value, 512);
            let parsed: URL;
            try {
              parsed = new URL(origin);
            } catch {
              return invalid();
            }
            if (
              parsed.protocol !== 'https:' ||
              parsed.origin !== origin ||
              parsed.username ||
              parsed.password
            )
              return invalid();
            return origin;
          });
    return {
      ...base,
      phase,
      authority: parseDestination({ authority: item.authority, repository: 'validation' })
        .authority,
      // eslint-disable-next-line no-control-regex -- Basic auth usernames reject control bytes and separators.
      username: string(item.username, 256, /^[^\u0000-\u001f\u007f:]+$/u),
      // eslint-disable-next-line no-control-regex -- Native credential files cannot represent NUL bytes.
      password: string(item.password, 8192, /^[^\u0000]+$/u),
      ...(caCertificate ? { caCertificate } : {}),
      ...(tokenServiceOrigins ? { tokenServiceOrigins } : {}),
    };
  }
  const secrets = array(item.secrets, 16).map((value) => {
    const secret = object(value, ['mountId', 'version', 'value']);
    return {
      mountId: string(secret.mountId, 64, /^[A-Za-z][A-Za-z0-9_.-]*$/u),
      version: string(secret.version, 256, /^[A-Za-z0-9:_.-]+$/u),
      value: string(secret.value, 65536),
    };
  });
  if (
    new Set(secrets.map((entry) => entry.mountId)).size !== secrets.length ||
    secrets.reduce((n, entry) => n + Buffer.byteLength(entry.value), 0) > 262144
  )
    return invalid();
  return { ...base, phase, secrets };
}
const phases = ['checkout', 'building', 'exporting', 'pushing'] as const;
export function parseEndProof(value: unknown): BuildEndProof {
  const proof = object(value, ['payload', 'signature']);
  const item = object(proof.payload, [
    'version',
    'installationId',
    'builderInstanceId',
    'runId',
    'specHash',
    'epoch',
    'ledgerRevision',
    'endedAt',
    'disposition',
    'processes',
    'executionClosed',
    'cancelTombstone',
    'terminationEvidence',
    'artifactIdentityHash',
    'pushReceipt',
  ]);
  if (
    item.version !== 1 ||
    item.executionClosed !== true ||
    typeof item.cancelTombstone !== 'boolean'
  )
    return invalid();
  const disposition = object(item.disposition, ['outcome', 'phase', 'code', 'exitCode']);
  const outcome = literal(disposition.outcome, ['succeeded', 'failed', 'cancelled', 'timed_out']);
  let parsedDisposition: EndDisposition;
  if (outcome === 'failed')
    parsedDisposition = {
      outcome,
      phase: literal(disposition.phase, phases),
      code: string(disposition.code, 64, /^[A-Z][A-Z0-9_]+$/u),
      exitCode: disposition.exitCode === null ? null : integer(disposition.exitCode, 0, 255),
    };
  else if (outcome === 'timed_out')
    parsedDisposition = { outcome, phase: literal(disposition.phase, phases) };
  else parsedDisposition = { outcome };
  const processes = object(item.processes, ['checkout', 'solve', 'uploader']);
  const evidence = object(item.terminationEvidence, [
    'kind',
    'executionGroupId',
    'bootId',
    'executionBootId',
    'observedBootId',
  ]);
  const terminationEvidence =
    evidence.kind === 'never_started'
      ? { kind: 'never_started' as const }
      : evidence.kind === 'cgroup_empty'
        ? {
            kind: 'cgroup_empty' as const,
            executionGroupId: string(evidence.executionGroupId, 128, /^[A-Za-z0-9_.:-]+$/u),
            bootId: uuid(evidence.bootId),
          }
        : evidence.kind === 'host_rebooted'
          ? {
              kind: 'host_rebooted' as const,
              executionBootId: uuid(evidence.executionBootId),
              observedBootId: uuid(evidence.observedBootId),
            }
          : invalid();
  if (
    terminationEvidence.kind === 'host_rebooted' &&
    terminationEvidence.executionBootId === terminationEvidence.observedBootId
  )
    return invalid();
  const parsedProcesses = {
    checkout: literal(processes.checkout, ['never_started', 'terminated']),
    solve: literal(processes.solve, ['never_started', 'terminated']),
    uploader: literal(processes.uploader, ['never_started', 'terminated']),
  };
  if (
    terminationEvidence.kind === 'never_started' &&
    Object.values(parsedProcesses).some((state) => state !== 'never_started')
  )
    return invalid();
  let pushReceipt = null;
  if (item.pushReceipt !== null) {
    const receipt = object(item.pushReceipt, ['destination', 'rootDigest', 'confirmedAt']);
    pushReceipt = {
      destination: parseDestination(receipt.destination),
      rootDigest: digest(receipt.rootDigest),
      confirmedAt: isoDate(receipt.confirmedAt),
    };
  }
  if (outcome === 'succeeded' && (!pushReceipt || item.artifactIdentityHash === null))
    return invalid();
  const signature = parseSignature(proof.signature);
  return {
    payload: {
      version: 1,
      installationId: uuid(item.installationId),
      builderInstanceId: uuid(item.builderInstanceId),
      runId: uuid(item.runId),
      specHash: sha256(item.specHash),
      epoch: parseEpoch(item.epoch),
      ledgerRevision: sequence(item.ledgerRevision),
      endedAt: isoDate(item.endedAt),
      disposition: parsedDisposition,
      processes: parsedProcesses,
      executionClosed: true,
      cancelTombstone: item.cancelTombstone,
      terminationEvidence,
      artifactIdentityHash:
        item.artifactIdentityHash === null ? null : sha256(item.artifactIdentityHash),
      pushReceipt,
    },
    signature,
  };
}
function parseSignature(value: unknown): BuildEndProof['signature'] {
  const item = object(value, ['algorithm', 'keyId', 'value']);
  return {
    algorithm: literal(item.algorithm, ['Ed25519']),
    keyId: sha256(item.keyId),
    value: string(item.value, 86, /^[A-Za-z0-9_-]{86}$/u),
  };
}
export function parseObservation(value: unknown): BuildRunObservation {
  const item = object(value, [
    'version',
    'installationId',
    'builderInstanceId',
    'runId',
    'specHash',
    'epoch',
    'ledgerRevision',
    'phase',
    'state',
    'leaseUntil',
    'credentialRequest',
    'artifact',
    'proof',
  ]);
  if (item.version !== 1) return invalid();
  const state = literal(item.state, ['awaiting_credentials', 'running', 'cancelling', 'ended']);
  let credentialRequest: { phase: CredentialPhase; nonce: string } | null = null;
  if (item.credentialRequest !== null) {
    const request = object(item.credentialRequest, ['phase', 'nonce']);
    credentialRequest = {
      phase: literal(request.phase, ['checkout', 'building', 'pushing']),
      nonce: uuid(request.nonce),
    };
  }
  const proof = item.proof === null ? null : parseEndProof(item.proof);
  if (
    (state === 'ended') !== Boolean(proof) ||
    (state === 'awaiting_credentials') !== Boolean(credentialRequest)
  )
    return invalid();
  return {
    version: 1,
    installationId: uuid(item.installationId),
    builderInstanceId: uuid(item.builderInstanceId),
    runId: uuid(item.runId),
    specHash: sha256(item.specHash),
    epoch: parseEpoch(item.epoch),
    ledgerRevision: sequence(item.ledgerRevision),
    phase: literal(item.phase, phases),
    state,
    leaseUntil: isoDate(item.leaseUntil),
    credentialRequest,
    artifact: item.artifact === null ? null : parseArtifact(item.artifact),
    proof,
  };
}
export function parseEventPage(value: unknown): BuildEventPage {
  const item = object(value, ['events', 'nextSequence', 'truncated', 'expired']);
  if (typeof item.truncated !== 'boolean' || typeof item.expired !== 'boolean') return invalid();
  const events = array(item.events, 100).map((value) => {
    const event = object(value, ['sequence', 'phase', 'at', 'kind', 'text']);
    return {
      sequence: sequence(event.sequence),
      phase: literal<BuildPhase>(event.phase, phases),
      at: isoDate(event.at),
      kind: literal(event.kind, ['output', 'truncated', 'phase']),
      text: string(event.text, 8192),
    };
  });
  if (
    events.reduce((n, event) => n + Buffer.byteLength(event.text), 0) > 65536 ||
    events.some((event, i) => i > 0 && BigInt(event.sequence) <= BigInt(events[i - 1]!.sequence))
  )
    return invalid();
  return {
    events,
    nextSequence: sequence(item.nextSequence),
    truncated: item.truncated,
    expired: item.expired,
  };
}
export function parseIdentity(value: unknown): SignedPayload<BuilderIdentity> {
  const signed = object(value, ['payload', 'signature']);
  const item = object(signed.payload, [
    'version',
    'challenge',
    'instanceId',
    'profile',
    'platform',
    'isolation',
    'limits',
    'maxConcurrency',
    'highGeneration',
    'checkedAt',
  ]);
  const keys = [
    'rootless',
    'processSandbox',
    'separateUids',
    'cgroupV2',
    'hardDiskQuota',
    'egressPolicy',
    'independentWatchdog',
  ] as const;
  const isolation = object(item.isolation, keys);
  if (item.version !== 1 || keys.some((key) => isolation[key] !== true)) return invalid();
  return {
    payload: {
      version: 1,
      challenge: challenge(item.challenge),
      instanceId: uuid(item.instanceId),
      profile: parseProfile(item.profile),
      platform: platform(item.platform),
      isolation: Object.fromEntries(keys.map((key) => [key, true])) as BuilderIdentity['isolation'],
      limits: parseLimits(item.limits),
      maxConcurrency: integer(item.maxConcurrency, 1, 16),
      highGeneration: integer(item.highGeneration, 0),
      checkedAt: isoDate(item.checkedAt),
    },
    signature: parseSignature(signed.signature),
  };
}
export function parseInstallationFence(value: unknown): BuildInstallationFence {
  const item = object(value, [
    'installationId',
    'builderInstanceId',
    'requestId',
    'generation',
    'challenge',
  ]);
  return {
    installationId: uuid(item.installationId),
    builderInstanceId: uuid(item.builderInstanceId),
    requestId: uuid(item.requestId),
    generation: integer(item.generation, 0),
    challenge: challenge(item.challenge),
  };
}
export function parseFenceReceipt(value: unknown): SignedPayload<BuilderFenceReceipt> {
  const signed = object(value, ['payload', 'signature']);
  const item = object(signed.payload, [
    'version',
    'installationId',
    'builderInstanceId',
    'requestId',
    'generation',
    'challenge',
    'highGeneration',
    'fencedAt',
  ]);
  if (item.version !== 1) return invalid();
  const request = parseInstallationFence({
    installationId: item.installationId,
    builderInstanceId: item.builderInstanceId,
    requestId: item.requestId,
    generation: item.generation,
    challenge: item.challenge,
  });
  const highGeneration = integer(item.highGeneration, 0);
  if (highGeneration !== request.generation) return invalid();
  return {
    payload: { version: 1, ...request, highGeneration, fencedAt: isoDate(item.fencedAt) },
    signature: parseSignature(signed.signature),
  };
}
export function inventoryCursor(value: unknown): string {
  const result = string(value, 54, /^[0-9a-f-]{36}\.[1-9][0-9]*$/u);
  uuid(result.slice(0, 36));
  integer(Number(result.slice(37)), 1);
  if (Number(result.slice(37)) % 100 !== 0) return invalid();
  return result;
}
export function parseInventoryRun(value: unknown): BuilderInventoryRun {
  const item = object(value, [
    'runId',
    'specHash',
    'epoch',
    'ledgerRevision',
    'executionClosed',
    'proofHash',
  ]);
  if (
    typeof item.executionClosed !== 'boolean' ||
    item.executionClosed !== (item.proofHash !== null)
  )
    return invalid();
  return {
    runId: uuid(item.runId),
    specHash: sha256(item.specHash),
    epoch: parseEpoch(item.epoch),
    ledgerRevision: sequence(item.ledgerRevision),
    executionClosed: item.executionClosed,
    proofHash: item.proofHash === null ? null : sha256(item.proofHash),
  };
}
export function parseInventoryPage(value: unknown): SignedPayload<BuilderInventoryPage> {
  const signed = object(value, ['payload', 'signature']);
  const item = object(signed.payload, [
    'version',
    'installationId',
    'builderInstanceId',
    'challenge',
    'highGeneration',
    'inventoryRevision',
    'snapshotId',
    'expiresAt',
    'offset',
    'totalRuns',
    'runs',
    'nextCursor',
  ]);
  if (item.version !== 1) return invalid();
  const offset = integer(item.offset, 0);
  const totalRuns = integer(item.totalRuns, 0);
  const snapshotId = uuid(item.snapshotId);
  const runs = array(item.runs, 100).map(parseInventoryRun);
  const nextCursor = item.nextCursor === null ? null : inventoryCursor(item.nextCursor);
  if (
    offset % 100 !== 0 ||
    offset > totalRuns ||
    (totalRuns > 0 && offset === totalRuns) ||
    runs.length !== Math.min(100, totalRuns - offset) ||
    runs.some((run, index) => index > 0 && run.runId <= runs[index - 1]!.runId) ||
    nextCursor !==
      (offset + runs.length < totalRuns ? `${snapshotId}.${offset + runs.length}` : null)
  )
    return invalid();
  return {
    payload: {
      version: 1,
      installationId: uuid(item.installationId),
      builderInstanceId: uuid(item.builderInstanceId),
      challenge: challenge(item.challenge),
      highGeneration: integer(item.highGeneration, 0),
      inventoryRevision: sha256(item.inventoryRevision),
      snapshotId,
      expiresAt: isoDate(item.expiresAt),
      offset,
      totalRuns,
      runs,
      nextCursor,
    },
    signature: parseSignature(signed.signature),
  };
}
