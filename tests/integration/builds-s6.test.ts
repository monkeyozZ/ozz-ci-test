import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type SecretKind } from '../../packages/database/dist/index.js';
import {
  TaskRepository,
  type DeploymentLease,
} from '../../packages/control-plane/src/tasks/repository.js';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';
import { ServiceCommands } from '../../packages/control-plane/src/services/commands.js';
import { captureGitSnapshot } from '../../packages/control-plane/src/git/commands.js';
import {
  currentTarget,
  serviceInclude,
  json,
} from '../../packages/control-plane/src/services/persistence.js';
import { BuildRepository } from '../../packages/control-plane/src/builds/repository.js';
import { BuildCoordinator } from '../../packages/control-plane/src/builds/coordinator.js';
import { readServiceSnapshot } from '../../packages/control-plane/src/services/snapshots.js';
import {
  BuildRecovery,
  BuildRecoveryBlocked,
  type BuildRecoveryPlan,
} from '../../packages/control-plane/src/builds/recovery.js';
import { fixedRegistryCredential } from '../../packages/control-plane/src/builds/access.js';
import {
  BuilderError,
  artifactIdentityHash,
  canonicalJson,
  hashJson,
  inventoryRevision,
  signPayload,
  type BuilderClient,
  type BuilderInventoryPage,
  type BuildInstallationFence,
  type BuildRunObservation,
  type BuildRunSpec,
  type BuildSubmit,
  type BuildCancel,
  type BuildCredentials,
  type OciArtifact,
  type RunEpoch,
} from '../../packages/infrastructure/dist/build.js';
import {
  buildSpec,
  ociArtifact,
  endPayload,
  openObservation,
} from '../infrastructure/build-fixture.js';

// Real task/ledger SQL in a random private schema; signed Builder responses are
// deliberate protocol fixtures. No Builder, Kubernetes or shared-schema mutation.
const execute = promisify(execFile);
const schema = `s6build_${randomUUID().replaceAll('-', '')}`;
if (!process.env.DATABASE_URL) throw new Error('Build fault tests require PostgreSQL.');
const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.searchParams.set('schema', schema);
const db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
const masterKey = randomBytes(32);
const cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, masterKey]]) });
const tasks = new TaskRepository(db, { leaseMs: 30000, retryBaseMs: 1, retryMaxMs: 1 });
const records = new BuildRepository(tasks);
const services = new ServiceCommands(tasks, cipher);
const clients = new Map<string, RemoteBuilder>();
let fixture: Awaited<ReturnType<typeof context>>;
let actor: { id: string };
let installationId: string;
let directory: string;
let tls: { caCertificate: string; clientCertificate: string; clientPrivateKey: string };

class RemoteBuilder implements BuilderClient {
  highGeneration = 0;
  readonly observations = new Map<string, BuildRunObservation>();
  readonly snapshots = new Map<string, Omit<BuilderInventoryPage, 'offset' | 'nextCursor'>>();
  readonly calls = { fence: 0, inventory: 0, submit: 0, cancel: 0, grant: 0 };
  failFence = false;
  failIdentity = false;
  inventoryFault: 'none' | 'expired' | 'wrong_identity' | 'bad_signature' = 'none';
  readonly privateKey: string;
  readonly publicKey: string;
  readonly profile: BuildRunSpec['profile'];
  constructor(readonly instanceId = randomUUID()) {
    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    this.profile = buildSpec().profile;
    this.profile.instanceId = instanceId;
  }
  async identity(challenge: string) {
    if (this.failIdentity) throw new BuilderError('BUILD_UNAVAILABLE', true);
    return signPayload(
      {
        version: 1 as const,
        challenge,
        instanceId: this.instanceId,
        profile: this.profile,
        platform: { os: 'linux' as const, architecture: 'arm64' as const },
        limits: buildSpec().limits,
        maxConcurrency: 1,
        highGeneration: this.highGeneration,
        checkedAt: new Date().toISOString(),
        isolation: {
          rootless: true as const,
          processSandbox: true as const,
          separateUids: true as const,
          cgroupV2: true as const,
          hardDiskQuota: true as const,
          egressPolicy: true as const,
          independentWatchdog: true as const,
        },
      },
      this.privateKey,
    );
  }
  async fence(request: BuildInstallationFence) {
    this.calls.fence++;
    if (this.failFence) throw new BuilderError('BUILD_UNAVAILABLE', true);
    if (
      request.installationId !== installationId ||
      request.builderInstanceId !== this.instanceId ||
      request.generation < this.highGeneration
    )
      throw new BuilderError('BUILD_EPOCH_STALE');
    this.highGeneration = request.generation;
    return signPayload(
      {
        version: 1 as const,
        ...request,
        highGeneration: request.generation,
        fencedAt: new Date().toISOString(),
      },
      this.privateKey,
    );
  }
  async inventory(challenge: string, cursor?: string) {
    this.calls.inventory++;
    let snapshot: Omit<BuilderInventoryPage, 'offset' | 'nextCursor'>;
    let offset = 0;
    if (cursor) {
      snapshot = this.snapshots.get(cursor.slice(0, 36))!;
      offset = Number(cursor.slice(37));
    } else {
      const runs = [...this.observations.values()]
        .map((observation) => ({
          runId: observation.runId,
          specHash: observation.specHash,
          epoch: observation.epoch,
          ledgerRevision: observation.ledgerRevision,
          executionClosed: Boolean(observation.proof),
          proofHash: observation.proof ? hashJson(observation.proof) : null,
        }))
        .sort((a, b) => a.runId.localeCompare(b.runId));
      snapshot = {
        version: 1,
        installationId,
        builderInstanceId: this.instanceId,
        challenge,
        highGeneration: this.highGeneration,
        inventoryRevision: inventoryRevision(
          installationId,
          this.instanceId,
          this.highGeneration,
          runs,
        ),
        snapshotId: randomUUID(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        totalRuns: runs.length,
        runs,
      };
      this.snapshots.set(snapshot.snapshotId, snapshot);
    }
    const runs = snapshot.runs.slice(offset, offset + 100);
    const payload = {
      ...snapshot,
      offset,
      runs,
      nextCursor:
        offset + runs.length < snapshot.totalRuns
          ? `${snapshot.snapshotId}.${offset + runs.length}`
          : null,
    };
    if (this.inventoryFault === 'expired')
      payload.expiresAt = new Date(Date.now() - 1).toISOString();
    if (this.inventoryFault === 'wrong_identity') payload.builderInstanceId = randomUUID();
    const result = signPayload(payload, this.privateKey);
    if (this.inventoryFault === 'bad_signature') result.signature.value = 'A'.repeat(86);
    return result;
  }
  async get(runId: string) {
    return structuredClone(this.observations.get(runId) ?? null);
  }
  async submit(_request: BuildSubmit): Promise<BuildRunObservation> {
    this.calls.submit++;
    throw new Error('Recovery must never submit source');
  }
  async cancel(_runId: string, _request: BuildCancel): Promise<BuildRunObservation> {
    this.calls.cancel++;
    throw new Error('Recovery must never cancel unknown source');
  }
  async credentials(_runId: string, _request: BuildCredentials): Promise<BuildRunObservation> {
    this.calls.grant++;
    throw new Error('Recovery must never grant build credentials');
  }
  async renew(
    _runId: string,
    _request: { specHash: string; epoch: RunEpoch; leaseUntil: string },
  ): Promise<BuildRunObservation> {
    throw new Error('Recovery must never renew execution');
  }
  async events() {
    return { events: [], nextSequence: '0', truncated: false, expired: false };
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ozz-build-fault-'));
  await execute(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      join(directory, 'client.key'),
      '-out',
      join(directory, 'client.pem'),
      '-subj',
      '/CN=private-builder-fixture',
      '-days',
      '1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { timeout: 10000 },
  );
  const certificate = await readFile(join(directory, 'client.pem'), 'utf8');
  tls = {
    caCertificate: certificate,
    clientCertificate: certificate,
    clientPrivateKey: await readFile(join(directory, 'client.key'), 'utf8'),
  };
  await execute(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../packages/database/node_modules/prisma/build/index.js', import.meta.url),
      ),
      'migrate',
      'deploy',
      '--schema',
      fileURLToPath(new URL('../../packages/database/prisma/schema.prisma', import.meta.url)),
    ],
    { env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, timeout: 25000 },
  );
  await db.$connect();
  installationId = (
    await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } })
  ).installationId;
});
beforeEach(async () => {
  // TRUNCATE is confined to this generated schema; immutable ledger DELETE guards remain tested below.
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname=${schema} AND tablename NOT IN ('_prisma_migrations','ControlPlaneState')`;
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map(({ tablename }) => `"${schema}"."${tablename.replaceAll('"', '""')}"`).join(',')} CASCADE`,
  );
  await db.controlPlaneState.update({
    where: { id: 'control-plane' },
    data: { restoreLocked: false, generation: 0 },
  });
  clients.clear();
  actor = {
    id: (
      await db.admin.create({
        data: { username: 'build-fault-fixture', passwordHash: 'not-used-for-authentication' },
      })
    ).id,
  };
  fixture = await context();
});
afterAll(async () => {
  try {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await db.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
async function secret(kind: SecretKind, payload: Record<string, unknown>) {
  return db.secretReference.create({
    data: { name: `Fault fixture ${randomUUID()}`, kind, ...cipher.encrypt(kind, payload) },
  });
}
async function registeredBuilder(enabled = true) {
  const remote = new RemoteBuilder();
  const credential = await secret('builder', tls);
  const endpoint = `https://builder-${remote.instanceId}.fixture.test`;
  const builder = await db.builder.create({
    data: {
      name: 'Fault Builder',
      instanceId: remote.instanceId,
      endpoint,
      identityPublicKey: remote.publicKey,
      credentialRefId: credential.id,
      profileJson: json(remote.profile),
      verificationState: 'verified',
      verifiedAt: new Date(),
      enabled,
    },
  });
  clients.set(endpoint, remote);
  return { builder, remote };
}
async function context() {
  const credential = await secret('kubeconfig', { kubeconfig: 'unused-fixture-kubeconfig' });
  const cluster = await db.cluster.create({
    data: {
      name: 'Build fixture',
      slug: `build-${randomUUID().slice(0, 8)}`,
      kubeSystemUid: randomUUID(),
      caFingerprint: `sha256:${'a'.repeat(64)}`,
      apiEndpoint: 'https://127.0.0.1:65534',
      credentialRefId: credential.id,
      connectionStatus: 'connected',
      lastObservedAt: new Date(),
    },
  });
  const project = await db.project.create({
    data: { name: 'Build fixture', slug: 'build-fixture', clusterId: cluster.id },
  });
  const environment = await db.environment.create({
    data: { name: 'Production', slug: 'production', projectId: project.id },
  });
  const gitCredential = await secret('git', {
    token: 'github_pat_fixture_only_12345678901234567890',
  });
  const connection = await db.gitHubConnection.create({
    data: {
      name: 'Build fixture',
      credentialRefId: gitCredential.id,
      verifiedCredentialRefId: gitCredential.id,
      verifiedAt: new Date(),
      verificationState: 'verified',
    },
  });
  const repository = await db.gitRepository.create({
    data: {
      githubConnectionId: connection.id,
      githubRepositoryId: '123456',
      fullName: 'fixture/source',
      defaultBranch: 'main',
      private: true,
      lastVerifiedAt: new Date(),
    },
  });
  const push = await secret('registry', {
    registry: 'registry.fixture.test',
    username: 'uploader',
    password: 'first-fixture-push',
  });
  const pull = await secret('registry', {
    registry: 'registry.fixture.test',
    username: 'runtime',
    password: 'first-fixture-pull',
  });
  const registry = await db.registryConnection.create({
    data: {
      name: 'Build fixture',
      authority: 'registry.fixture.test',
      namespace: 'fixture',
      pushCredentialRefId: push.id,
      pullCredentialRefId: pull.id,
      pushVerificationState: 'verified',
      pullVerificationState: 'verified',
      pushVerifiedAt: new Date(),
      pullVerifiedAt: new Date(),
    },
  });
  return { cluster, project, environment, repository, registry, ...(await registeredBuilder()) };
}
async function running(options: { submitted?: boolean; volume?: boolean; prepare?: boolean } = {}) {
  const service = await services.create({
    environmentId: fixture.environment.id,
    name: 'Build writer',
    slug: `writer-${randomUUID().slice(0, 8)}`,
    configuration: {},
    source: {
      kind: 'github',
      repositoryId: fixture.repository.id,
      branchRef: 'refs/heads/main',
      dockerfilePath: 'Dockerfile',
      contextPath: '.',
      platforms: [{ os: 'linux', architecture: 'arm64' }],
      builderId: fixture.builder.id,
      registryConnectionId: fixture.registry.id,
      imageRepository: 'application',
    },
  });
  if (service.source.kind !== 'github') throw new Error('Expected Git service');
  const revision = service.source.currentRevision;
  const deployment = await tasks.enqueueDeployment(
    actor,
    randomUUID(),
    { kind: 'git_deploy', request: { serviceId: service.id } },
    async (tx) => {
      const current = await tx.service.update({
        where: { id: service.id },
        data: { mutationRevision: { increment: 1 } },
        include: serviceInclude,
      });
      const snapshot = await captureGitSnapshot(tx, current, revision, 'a'.repeat(40));
      return {
        serviceId: current.id,
        input: { serviceId: current.id, mutationRevision: current.mutationRevision },
        configRevision: current.configRevision,
        mutationRevision: current.mutationRevision,
        snapshotJson: json(snapshot),
        targetJson: json(await currentTarget(tx, current)),
        sourceRevisionId: revision.id,
      };
    },
  );
  const lease = (await tasks.claimDeployment(deployment.id, 'build-fault-fixture'))!;
  expect(lease).not.toBeNull();
  let volumeId: string | null = null;
  if (options.volume) {
    volumeId = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.volume.create({
        data: {
          id: volumeId!,
          environmentId: fixture.environment.id,
          clusterId: fixture.cluster.id,
          name: 'Held data slot',
          slug: 'held-data',
          targetJson: {
            installationId,
            volumeId,
            clusterId: fixture.cluster.id,
            kubeSystemUid: fixture.cluster.kubeSystemUid,
            projectId: fixture.project.id,
            environmentId: fixture.environment.id,
            namespace: `ozz-e-${fixture.environment.id.replaceAll('-', '')}`,
          },
          namespace: `ozz-e-${fixture.environment.id.replaceAll('-', '')}`,
          requestedBytes: 1048576n,
          storageClassName: 'local-path',
          pvcName: `pvc-${volumeId}`,
        },
      });
      await tx.deploymentVolumeReference.create({
        data: {
          deploymentId: deployment.id,
          volumeId: volumeId!,
          referenceJson: { fixture: true },
        },
      });
      await tx.volumeMutation.create({
        data: { volumeId: volumeId!, deploymentId: deployment.id },
      });
    });
  }
  const spec = buildSpec({
    installationId,
    deploymentId: deployment.id,
    profile: fixture.remote.profile,
    source: {
      githubRepositoryId: revision.repository.githubRepositoryId,
      commitSha: 'a'.repeat(40),
      recipeHash: revision.recipeHash,
      dockerfilePath: revision.dockerfilePath,
      contextPath: revision.contextPath,
      buildArgs: revision.buildArgs,
      buildSecrets: [],
      platforms: revision.platforms,
    },
    destination: {
      authority: revision.destination.authority,
      repository: revision.destination.repository,
    },
  });
  if (options.prepare !== false) {
    const prepared = await records.prepare(lease, spec, fixture.builder.id);
    if (options.submitted !== false) {
      await records.markSending(lease, prepared.id);
      fixture.remote.observations.set(spec.runId, openObservation(spec));
    }
  }
  return { service, deployment, lease, spec, volumeId, revision };
}
function closed(
  spec: BuildRunSpec,
  options: { artifact?: OciArtifact; pushed?: boolean; epoch?: RunEpoch; revision?: string } = {},
) {
  const artifact = options.artifact ?? null;
  const payload = {
    ...endPayload(spec),
    epoch: options.epoch ?? { generation: 0, ownershipEpoch: 1 },
    ledgerRevision: options.revision ?? '2',
    ...(artifact
      ? {
          disposition: options.pushed
            ? { outcome: 'succeeded' as const }
            : {
                outcome: 'failed' as const,
                phase: 'pushing' as const,
                code: 'BUILD_PUSH_FAILED',
                exitCode: 1,
              },
          processes: {
            checkout: 'terminated' as const,
            solve: 'terminated' as const,
            uploader: 'terminated' as const,
          },
          terminationEvidence: {
            kind: 'cgroup_empty' as const,
            executionGroupId: `fixture-${spec.runId}`,
            bootId: randomUUID(),
          },
          artifactIdentityHash: artifactIdentityHash(artifact),
          pushReceipt: options.pushed
            ? {
                destination: spec.destination,
                rootDigest: artifact.rootDigest,
                confirmedAt: new Date().toISOString(),
              }
            : null,
        }
      : {}),
  };
  const observation: BuildRunObservation = {
    ...openObservation(spec),
    state: 'ended',
    phase: artifact ? 'pushing' : 'checkout',
    epoch: payload.epoch,
    ledgerRevision: payload.ledgerRevision,
    artifact,
    proof: signPayload(payload, fixture.remote.privateKey),
  };
  fixture.remote.observations.set(spec.runId, observation);
  return observation;
}
async function expired(lease: DeploymentLease) {
  await db.deployment.update({
    where: { id: lease.deploymentId },
    data: { leaseExpiresAt: new Date(Date.now() - 1) },
  });
}
function recovery() {
  return new BuildRecovery(tasks, cipher, {
    clientFactory: (connection) => clients.get(connection.origin)!,
  });
}
async function restoreLock() {
  const state = await db.controlPlaneState.update({
    where: { id: 'control-plane' },
    data: { restoreLocked: true },
  });
  await db.auditEvent.create({
    data: {
      action: 'recovery:lock',
      resourceType: 'control-plane',
      resourceId: 'control-plane',
      outcome: 'succeeded',
      metadata: { generation: state.generation, lockedAt: state.updatedAt.toISOString() },
    },
  });
}
async function unlock(recovery: BuildRecovery, plan: BuildRecoveryPlan) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ControlPlaneState" WHERE id='control-plane' FOR UPDATE`;
      await recovery.verifyUnchanged(plan);
      const result = await recovery.apply(tx, plan);
      await tx.controlPlaneState.update({
        where: { id: 'control-plane' },
        data: { restoreLocked: false, generation: result.generation },
      });
      return result;
    },
    { timeout: 60000 },
  );
}
async function held(id: string, volume = false) {
  expect((await db.deployment.findUniqueOrThrow({ where: { id } })).status).toBe('running');
  expect(await db.serviceMutation.count({ where: { deploymentId: id } })).toBe(1);
  if (volume) expect(await db.volumeMutation.count({ where: { deploymentId: id } })).toBe(1);
}

describe('remote closure gates every task transition', () => {
  it.each(['renew-result', 'renew-error', 'grant-result'] as const)(
    'records the original failed run when closure races with %s without requeueing',
    async (mode) => {
      const task = await running({ prepare: false });
      const snapshot = readServiceSnapshot(task.deployment.snapshotJson);
      if (snapshot.version !== 3) throw new Error('Expected Git source snapshot');
      let submitted!: BuildRunSpec;
      const submit = vi.spyOn(fixture.remote, 'submit').mockImplementation(async (request) => {
        submitted = request.spec;
        const observation = openObservation(submitted);
        if (mode === 'grant-result') {
          observation.phase = 'building';
          observation.state = 'awaiting_credentials';
          observation.credentialRequest = { phase: 'building', nonce: randomUUID() };
        }
        return observation;
      });
      const finish = () => {
        const payload = {
          ...endPayload(submitted),
          disposition: {
            outcome: 'failed' as const,
            phase: 'building' as const,
            code: 'BUILD_SOLVE_FAILED',
            exitCode: 1,
          },
          cancelTombstone: false,
          processes: {
            checkout: 'terminated' as const,
            solve: 'terminated' as const,
            uploader: 'never_started' as const,
          },
          terminationEvidence: {
            kind: 'cgroup_empty' as const,
            executionGroupId: 'closed-fixture.slice',
            bootId: randomUUID(),
          },
        };
        return {
          ...openObservation(submitted),
          state: 'ended' as const,
          phase: 'building' as const,
          ledgerRevision: payload.ledgerRevision,
          proof: signPayload(payload, fixture.remote.privateKey),
        };
      };
      const renew = vi.spyOn(fixture.remote, 'renew').mockImplementation(async () => {
        if (mode === 'renew-error') throw new BuilderError('BUILD_ISOLATION_UNAVAILABLE');
        return finish();
      });
      const credentials = vi
        .spyOn(fixture.remote, 'credentials')
        .mockImplementation(async () => finish());
      const get = vi
        .spyOn(fixture.remote, 'get')
        .mockImplementationOnce(async () => openObservation(submitted))
        .mockImplementation(async () => finish());
      const coordinator = new BuildCoordinator(tasks, cipher, undefined, {
        clientFactory: (connection) => clients.get(connection.origin)!,
        pollMs: 1,
      });
      await expect(
        coordinator.ensureArtifact(
          task.lease,
          snapshot.source,
          [{ os: 'linux', architecture: 'arm64' }],
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'BUILD_SOLVE_FAILED', retryable: false });
      const rows = await db.buildRun.findMany({ where: { deploymentId: task.deployment.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.proofVerifiedAt).toBeInstanceOf(Date);
      expect(rows[0]?.executionClosedAt).toBeInstanceOf(Date);
      expect(await tasks.fail(task.lease, 'BUILD_SOLVE_FAILED', 'fixture', false)).toBe(true);
      expect(
        (await db.deployment.findUniqueOrThrow({ where: { id: task.deployment.id } })).status,
      ).toBe('failed');
      expect(await db.serviceMutation.count({ where: { deploymentId: task.deployment.id } })).toBe(
        0,
      );
      expect(submit).toHaveBeenCalledTimes(1);
      expect(renew).toHaveBeenCalledTimes(mode === 'grant-result' ? 0 : 1);
      expect(credentials).toHaveBeenCalledTimes(mode === 'grant-result' ? 1 : 0);
      expect(get).toHaveBeenCalledTimes(mode === 'renew-error' ? 2 : 0);
    },
  );
  it('blocks success, final failure, retry queueing and both slot releases after send intent', async () => {
    const task = await running({ volume: true });
    const outbox = await db.outbox.findUniqueOrThrow({
      where: { deploymentId: task.deployment.id },
    });
    expect(await tasks.complete(task.lease, { result: {} })).toBe(false);
    expect(await tasks.fail(task.lease, 'NETWORK_LOST', 'fixture', false)).toBe(false);
    expect(await tasks.fail(task.lease, 'NETWORK_LOST', 'fixture', true)).toBe(false);
    await held(task.deployment.id, true);
    expect((await db.outbox.findUniqueOrThrow({ where: { id: outbox.id } })).deliverySequence).toBe(
      outbox.deliverySequence,
    );
    expect(
      (await db.buildRun.findUniqueOrThrow({ where: { id: task.spec.runId } })).cancelRequestedAt,
    ).not.toBeNull();
    await expect(
      db.volumeMutation.delete({ where: { volumeId: task.volumeId! } }),
    ).rejects.toThrow();
    await expect(
      db.serviceMutation.delete({ where: { serviceId: task.service.id } }),
    ).rejects.toThrow();
    await expect(
      db.deployment.update({ where: { id: task.deployment.id }, data: { status: 'queued' } }),
    ).rejects.toThrow();
  });
  it('records cancellation proof after the task lease is cancelled and expired, then releases slots', async () => {
    const task = await running({ volume: true });
    await tasks.cancelDeployment(task.deployment.id, actor);
    await expired(task.lease);
    expect(await tasks.checkpoint(task.lease, async () => {})).toBe(false);
    await tasks.recoverTask(task.lease.ref);
    await held(task.deployment.id, true);
    expect(await tasks.claimDeployment(task.deployment.id, 'replacement')).toBeNull();
    expect(await records.observe(task.spec.runId, closed(task.spec))).toBe(true);
    await tasks.recoverTask(task.lease.ref);
    expect((await tasks.getDeployment(task.deployment.id)).status).toBe('cancelled');
    expect(await db.serviceMutation.count()).toBe(0);
    expect(await db.volumeMutation.count()).toBe(0);
  });
  it('keeps expired, exhausted and old-generation tasks running until closure', async () => {
    const task = await running();
    await expired(task.lease);
    expect(await tasks.recoverTask(task.lease.ref)).toBe(false);
    await held(task.deployment.id);
    await db.deployment.update({ where: { id: task.deployment.id }, data: { maxAttempts: 1 } });
    await tasks.claimDeployment(task.deployment.id, 'exhausted');
    await held(task.deployment.id);
    await db.controlPlaneState.update({ where: { id: 'control-plane' }, data: { generation: 1 } });
    await tasks.recoverTask(task.lease.ref);
    await held(task.deployment.id);
    await records.observe(task.spec.runId, closed(task.spec));
    await tasks.recoverTask(task.lease.ref);
    expect((await tasks.getDeployment(task.deployment.id)).status).toBe('failed');
    expect(await db.serviceMutation.count()).toBe(0);
  });
  it('closes only truly unsubmitted prepared runs locally before task failure', async () => {
    const task = await running({ submitted: false });
    expect(await tasks.fail(task.lease, 'PREPARE_REJECTED', 'fixture', false)).toBe(true);
    expect(await db.buildRun.findUniqueOrThrow({ where: { id: task.spec.runId } })).toMatchObject({
      executionState: 'never_submitted',
      submissionAttemptedAt: null,
      endProofJson: null,
    });
    expect(await db.serviceMutation.count()).toBe(0);
  });
  it('rejects stale/tampered proofs while allowing an original remote epoch to win a takeover race', async () => {
    const task = await running();
    await records.observe(task.spec.runId, { ...openObservation(task.spec), ledgerRevision: '4' });
    await expect(
      records.observe(task.spec.runId, closed(task.spec, { revision: '3' })),
    ).rejects.toMatchObject({ code: 'BUILD_PROOF_INVALID' });
    const lease = (await records.acquire(task.spec.runId))!;
    await records.cancellationEpoch(lease, { ...openObservation(task.spec), ledgerRevision: '4' });
    const final = closed(task.spec, { revision: '5' });
    final.proof!.signature.value = 'A'.repeat(86);
    await expect(records.save(lease, final)).rejects.toMatchObject({ code: 'BUILD_PROOF_INVALID' });
    const original = closed(task.spec, { revision: '5' });
    await records.save(lease, original);
    expect(
      (await db.buildRun.findUniqueOrThrow({ where: { id: task.spec.runId } })).endProofJson,
    ).toEqual(original.proof);
    expect(original.proof!.payload.epoch.ownershipEpoch).toBe(1);
  });
  it('persists OCI after push failure and promotes the same identity on push-only retry', async () => {
    const task = await running();
    const artifact = ociArtifact(task.spec);
    await records.observe(task.spec.runId, closed(task.spec, { artifact }));
    expect(await tasks.fail(task.lease, 'BUILD_PUSH_FAILED', 'fixture', true)).toBe(true);
    expect(
      (await db.buildArtifact.findUniqueOrThrow({ where: { id: artifact.id } })).locationState,
    ).toBe('oci');
    await db.deployment.update({
      where: { id: task.deployment.id },
      data: { nextAttemptAt: new Date(Date.now() - 1) },
    });
    const lease = (await tasks.claimDeployment(task.deployment.id, 'push-only-retry'))!;
    const retry: BuildRunSpec = {
      ...task.spec,
      runId: randomUUID(),
      action: 'push_existing',
      artifact,
    };
    await records.prepare(lease, retry, fixture.builder.id);
    await records.markSending(lease, retry.runId);
    await records.observe(retry.runId, closed(retry, { artifact, pushed: true }));
    const stored = await db.buildArtifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(stored).toMatchObject({
      producedByRunId: task.spec.runId,
      locationState: 'registry',
      rootDigest: artifact.rootDigest,
      availability: 'unknown',
    });
    expect(canonicalJson(stored.descriptorJson)).toBe(canonicalJson(artifact));
    expect(await db.buildArtifact.count()).toBe(1);
    await expect(
      db.buildArtifact.update({ where: { id: artifact.id }, data: { locationState: 'oci' } }),
    ).rejects.toThrow();
  });
  it('uses current separated auth from the original immutable registry destination', async () => {
    const task = await running();
    const destination = task.revision.destination;
    const push = await secret('registry', {
      registry: destination.authority,
      username: 'new-uploader',
      password: 'rotated-fixture-push',
    });
    const pull = await secret('registry', {
      registry: destination.authority,
      username: 'new-runtime',
      password: 'rotated-fixture-pull',
    });
    await db.registryConnection.update({
      where: { id: destination.registryConnectionId },
      data: { pushCredentialRefId: push.id, pullCredentialRefId: pull.id },
    });
    const access = await db.$transaction(async (tx) => ({
      push: await fixedRegistryCredential(tx, cipher, destination, 'push'),
      pull: await fixedRegistryCredential(tx, cipher, destination, 'pull'),
    }));
    expect(access.push.payload.username).toBe('new-uploader');
    expect(access.pull.payload.username).toBe('new-runtime');
    await expect(
      db.$transaction((tx) =>
        fixedRegistryCredential(
          tx,
          cipher,
          { ...destination, authority: 'other.fixture.test' },
          'pull',
        ),
      ),
    ).rejects.toMatchObject({ code: 'BUILD_IDENTITY_MISMATCH' });
  });
});

describe('explicit historical Builder recovery', () => {
  async function reviewed() {
    const unknown = buildSpec({ installationId, profile: fixture.remote.profile });
    const observation = closed(unknown);
    await restoreLock();
    const flow = recovery();
    const manifest = await flow.inspect();
    return { flow, manifest, unknown, observation };
  }
  async function locked() {
    expect(
      (await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }))
        .restoreLocked,
    ).toBe(true);
    expect(await db.buildRun.count()).toBe(0);
    expect(await db.deployment.count()).toBe(0);
    expect(fixture.remote.calls).toMatchObject({ submit: 0, cancel: 0, grant: 0 });
  }
  it('exports read-only, explicitly accepts signed closed history, and unlocks without creating business history', async () => {
    const { flow, manifest, unknown, observation } = await reviewed();
    const before = await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
    expect(manifest).toMatchObject({
      historyMetadataRestored: false,
      scope: { installationId, generation: 0 },
      unknownRuns: [
        { runId: unknown.runId, specHash: hashJson(unknown), proof: observation.proof },
      ],
    });
    expect(manifest.scope.recoveryAuditId).toBeTruthy();
    expect(fixture.remote.highGeneration).toBe(0);
    expect(fixture.remote.calls.fence).toBe(0);
    expect(await db.auditEvent.count()).toBe(1);
    await expect(flow.accept(manifest, { acknowledgeMissingHistory: false })).rejects.toMatchObject(
      { issues: [expect.objectContaining({ code: 'MISSING_HISTORY_ACK_REQUIRED' })] },
    );
    const accepted = await flow.accept(manifest, { acknowledgeMissingHistory: true });
    expect(accepted).toMatchObject({
      manifestId: manifest.id,
      acceptedRunCount: 1,
      alreadyAccepted: false,
    });
    const replay = await recovery().accept(manifest, { acknowledgeMissingHistory: true });
    expect(replay).toEqual({ ...accepted, alreadyAccepted: true });
    expect(await db.auditEvent.count()).toBe(2);
    expect(
      await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }),
    ).toEqual(before);
    await locked();
    expect(fixture.remote.calls.fence).toBe(0);
    const plan = await flow.prepare();
    expect(plan).toMatchObject({
      generation: 1,
      historyAcceptanceId: accepted.auditId,
      acceptedUnknownRunCount: 1,
    });
    await unlock(flow, plan);
    expect(
      await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }),
    ).toMatchObject({ generation: 1, restoreLocked: false });
    expect(fixture.remote.highGeneration).toBe(1);
    expect(await db.buildRun.count()).toBe(0);
    expect(await db.deployment.count()).toBe(0);
    expect(fixture.remote.calls).toMatchObject({ fence: 1, submit: 0, cancel: 0, grant: 0 });
  });
  it('requires the actual current recovery lock instance and does not inherit an earlier acceptance', async () => {
    await expect(recovery().inspect()).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'RESTORE_NOT_LOCKED' })],
    });
    const { manifest } = await reviewed();
    await recovery().accept(manifest, { acknowledgeMissingHistory: true });
    await expect(
      recovery().accept(
        { ...manifest, scope: { ...manifest.scope, databaseIdentityHash: 'a'.repeat(64) } },
        { acknowledgeMissingHistory: true },
      ),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'RECOVERY_SCOPE_CHANGED' })],
    });
    await restoreLock();
    const next = await recovery().inspect();
    expect(next.scope.generation).toBe(manifest.scope.generation);
    expect(next.scope.recoveryAuditId).not.toBe(manifest.scope.recoveryAuditId);
    await expect(
      recovery().accept(manifest, { acknowledgeMissingHistory: true }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'RECOVERY_SCOPE_CHANGED' })],
    });
    await expect(recovery().prepare()).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'UNKNOWN_REMOTE_RUN' })],
    });
    await locked();
  });
  it('binds a restored copy to its fresh transactional restore audit instead of carried-forward history', async () => {
    const { manifest } = await reviewed();
    await recovery().accept(manifest, { acknowledgeMissingHistory: true });
    const restoreId = randomUUID();
    await db.$transaction(async (tx) => {
      // These are the same timestamps and action emitted by the official restore transaction.
      await tx.$executeRaw`UPDATE "ControlPlaneState" SET "restoreLocked"=true, generation=generation+1, "updatedAt"=CURRENT_TIMESTAMP WHERE id='control-plane'`;
      await tx.$executeRaw`INSERT INTO "AuditEvent" (id, action, "resourceType", "resourceId", outcome, metadata, "createdAt") VALUES (${restoreId}::uuid, 'recovery.restore', 'control-plane', 'control-plane', 'succeeded', jsonb_build_object('backupId', 'isolated-old-backup'), CURRENT_TIMESTAMP)`;
    });
    const current = await recovery().inspect();
    expect(current.scope.recoveryAuditId).toBe(restoreId);
    expect(current.scope.generation).toBe(manifest.scope.generation + 1);
    await expect(
      recovery().accept(manifest, { acknowledgeMissingHistory: true }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'RECOVERY_SCOPE_CHANGED' })],
    });
    await expect(recovery().prepare()).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'UNKNOWN_REMOTE_RUN' })],
    });
    await locked();
  });
  it('reviews and rechecks every signed inventory page before accepting a complete history list', async () => {
    for (let i = 0; i < 101; i++)
      closed(buildSpec({ installationId, profile: fixture.remote.profile }));
    await restoreLock();
    const flow = recovery();
    const manifest = await flow.inspect();
    expect(manifest.unknownRuns).toHaveLength(101);
    expect(manifest.builders).toEqual([expect.objectContaining({ totalRuns: 101 })]);
    await expect(
      flow.accept(
        { ...manifest, unknownRuns: manifest.unknownRuns.slice(0, 100) },
        { acknowledgeMissingHistory: true },
      ),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'REVIEW_CHANGED' })] });
    await flow.accept(manifest, { acknowledgeMissingHistory: true });
    const plan = await flow.prepare();
    await unlock(flow, plan);
    expect(fixture.remote.calls.inventory).toBeGreaterThanOrEqual(16);
    expect(await db.buildRun.count()).toBe(0);
    expect(await db.deployment.count()).toBe(0);
  });
  it('rejects an unrecorded manual lock, malformed manifests, omissions and changed content under the same review ID', async () => {
    const unknown = buildSpec({ installationId, profile: fixture.remote.profile });
    closed(unknown);
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: true },
    });
    await expect(recovery().inspect()).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'RECOVERY_INSTANCE_UNRECORDED' })],
    });
    await restoreLock();
    const manifest = await recovery().inspect();
    await expect(
      recovery().accept({ ...manifest, skipUnknown: true }, { acknowledgeMissingHistory: true }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'MANIFEST_INVALID' })] });
    await expect(
      recovery().accept({ ...manifest, unknownRuns: [] }, { acknowledgeMissingHistory: true }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'MANIFEST_EMPTY' })] });
    await recovery().accept(manifest, { acknowledgeMissingHistory: true });
    await expect(
      recovery().accept(
        { ...manifest, createdAt: new Date(Date.parse(manifest.createdAt) - 1).toISOString() },
        { acknowledgeMissingHistory: true },
      ),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'MANIFEST_CONFLICT' })] });
    await locked();
  });
  it.each([
    'new_run',
    'changed_proof',
    'open_run',
    'unreachable',
    'invalid_inventory',
    'invalid_proof',
  ] as const)(
    'keeps the lock and writes no acceptance when %s changes before explicit acceptance',
    async (change) => {
      const { flow, manifest, unknown } = await reviewed();
      if (change === 'new_run')
        closed(buildSpec({ installationId, profile: fixture.remote.profile }));
      if (change === 'changed_proof') closed(unknown, { revision: '3' });
      if (change === 'open_run')
        fixture.remote.observations.set(unknown.runId, openObservation(unknown));
      if (change === 'unreachable') fixture.remote.failIdentity = true;
      if (change === 'invalid_inventory') fixture.remote.inventoryFault = 'bad_signature';
      if (change === 'invalid_proof')
        fixture.remote.observations.get(unknown.runId)!.proof!.signature.value = 'A'.repeat(86);
      await expect(
        flow.accept(manifest, { acknowledgeMissingHistory: true }),
      ).rejects.toBeInstanceOf(BuildRecoveryBlocked);
      expect(
        await db.auditEvent.count({ where: { action: 'recovery:accept-builder-history' } }),
      ).toBe(0);
      expect(fixture.remote.highGeneration).toBe(0);
      await locked();
    },
  );
  it.each([
    'new_run',
    'changed_proof',
    'missing_run',
    'open_run',
    'unreachable',
    'invalid_inventory',
    'forged_get',
  ] as const)('still refuses unlock when %s changes after acceptance', async (change) => {
    const { flow, manifest, unknown } = await reviewed();
    await flow.accept(manifest, { acknowledgeMissingHistory: true });
    if (change === 'new_run')
      closed(buildSpec({ installationId, profile: fixture.remote.profile }));
    if (change === 'changed_proof') closed(unknown, { revision: '3' });
    if (change === 'missing_run') fixture.remote.observations.delete(unknown.runId);
    if (change === 'open_run')
      fixture.remote.observations.set(unknown.runId, openObservation(unknown));
    if (change === 'unreachable') fixture.remote.failIdentity = true;
    if (change === 'invalid_inventory') fixture.remote.inventoryFault = 'wrong_identity';
    const spy =
      change === 'forged_get'
        ? vi.spyOn(fixture.remote, 'get').mockImplementation(async (runId) => {
            const value = structuredClone(fixture.remote.observations.get(runId)!);
            value.proof!.signature.value = 'A'.repeat(86);
            return value;
          })
        : null;
    try {
      await expect(flow.prepare()).rejects.toBeInstanceOf(BuildRecoveryBlocked);
      await locked();
    } finally {
      spy?.mockRestore();
    }
  });
  it('rechecks the full inventory and the chosen acceptance record inside the unlock transaction', async () => {
    const { flow, manifest } = await reviewed();
    await flow.accept(manifest, { acknowledgeMissingHistory: true });
    const plan = await flow.prepare();
    const replacement = await recovery().inspect();
    await recovery().accept(replacement, { acknowledgeMissingHistory: true });
    await expect(unlock(flow, plan)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'LOCAL_STATE_CHANGED' })],
    });
    const current = recovery();
    const nextPlan = await current.prepare();
    closed(buildSpec({ installationId, profile: fixture.remote.profile }));
    await expect(unlock(current, nextPlan)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'INVENTORY_CHANGED' })],
    });
    await locked();
  });
  it('runs the inspect, explicit accept and unlock CLI through real mTLS and PostgreSQL', async () => {
    const unknown = buildSpec({ installationId, profile: fixture.remote.profile });
    closed(unknown);
    const server = createServer(
      {
        key: tls.clientPrivateKey,
        cert: tls.clientCertificate,
        ca: tls.caCertificate,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (request, response) => {
        void (async () => {
          const url = new URL(request.url!, 'https://127.0.0.1');
          let value: unknown;
          if (request.method === 'GET' && url.pathname === '/v1/identity')
            value = await fixture.remote.identity(url.searchParams.get('challenge')!);
          else if (request.method === 'GET' && url.pathname === '/v1/installation')
            value = await fixture.remote.inventory(
              url.searchParams.get('challenge')!,
              url.searchParams.get('cursor') ?? undefined,
            );
          else if (request.method === 'GET' && url.pathname.startsWith('/v1/runs/'))
            value = await fixture.remote.get(url.pathname.slice('/v1/runs/'.length));
          else if (request.method === 'POST' && url.pathname === '/v1/installation/fence') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
            value = await fixture.remote.fence(
              JSON.parse(Buffer.concat(chunks).toString()) as BuildInstallationFence,
            );
          } else {
            response.writeHead(400).end('{}');
            return;
          }
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(value));
        })().catch(() => response.writeHead(503).end('{}'));
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const keyFile = join(directory, `cli-master-${randomUUID()}.json`);
    const manifestFile = join(directory, `cli-review-${randomUUID()}.json`);
    await writeFile(
      keyFile,
      JSON.stringify({ activeVersion: 1, keys: { 1: masterKey.toString('base64') } }),
      { mode: 0o600 },
    );
    const cli = (command: string, args: string[] = []) =>
      execute(
        process.execPath,
        [fileURLToPath(new URL('../../apps/api/dist/cli.js', import.meta.url)), command, ...args],
        {
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl.toString(),
            MASTER_KEY_FILE: keyFile,
            RESTORE_MODE: 'false',
            LOG_LEVEL: 'silent',
            NODE_OPTIONS: '--max-old-space-size=1536',
          },
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        },
      );
    try {
      await db.builder.update({
        where: { id: fixture.builder.id },
        data: { endpoint: `https://127.0.0.1:${(server.address() as AddressInfo).port}` },
      });
      await cli('recovery:lock');
      await expect(cli('recovery:unlock', ['--reconciled'])).rejects.toMatchObject({
        stderr: expect.stringContaining('UNKNOWN_REMOTE_RUN'),
      });
      const high = fixture.remote.highGeneration;
      await cli('recovery:inspect', ['--output', manifestFile]);
      expect((await stat(manifestFile)).mode & 0o077).toBe(0);
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
        id: string;
        scope: { recoveryAuditId: string };
      };
      expect(manifest.scope.recoveryAuditId).toBeTruthy();
      expect(fixture.remote.highGeneration).toBe(high);
      await expect(cli('recovery:accept', ['--manifest', manifestFile])).rejects.toMatchObject({
        stderr: expect.stringContaining('--acknowledge-missing-history'),
      });
      const receipt = JSON.parse(
        (
          await cli('recovery:accept', [
            '--manifest',
            manifestFile,
            '--acknowledge-missing-history',
          ])
        ).stdout,
      ) as { auditId: string };
      expect(fixture.remote.highGeneration).toBe(high);
      await locked();
      await cli('recovery:unlock', ['--reconciled']);
      const state = await db.controlPlaneState.findUniqueOrThrow({
        where: { id: 'control-plane' },
      });
      expect(state).toMatchObject({ restoreLocked: false, generation: high + 1 });
      expect(fixture.remote.highGeneration).toBe(state.generation);
      const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'recovery:unlock' } });
      expect(audit.metadata).toMatchObject({
        builderInventoryVerified: true,
        historyAcceptanceId: receipt.auditId,
        acceptedUnknownRunCount: 1,
      });
      expect(await db.buildRun.count()).toBe(0);
      expect(await db.deployment.count()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('complete Builder installation recovery', () => {
  it('fences even disabled Builders with no local runs and never submits, grants or cancels', async () => {
    const other = await registeredBuilder(false);
    await restoreLock();
    const flow = recovery();
    const plan = await flow.prepare();
    expect(fixture.remote.highGeneration).toBe(1);
    expect(other.remote.highGeneration).toBe(1);
    await unlock(flow, plan);
    for (const remote of clients.values())
      expect(remote.calls).toMatchObject({
        fence: 1,
        inventory: 2,
        submit: 0,
        cancel: 0,
        grant: 0,
      });
    expect(
      await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }),
    ).toMatchObject({ generation: 1, restoreLocked: false });
  });
  it('blocks an unknown remote run and an unreachable registered Builder', async () => {
    const unknown = buildSpec({ installationId, profile: fixture.remote.profile });
    closed(unknown);
    await restoreLock();
    await expect(recovery().prepare()).rejects.toMatchObject({
      code: 'BUILD_RECOVERY_BLOCKED',
      issues: [expect.objectContaining({ code: 'UNKNOWN_REMOTE_RUN', runId: unknown.runId })],
    });
    expect(fixture.remote.calls.cancel).toBe(0);
    fixture.remote.observations.clear();
    fixture.remote.failIdentity = true;
    await expect(recovery().prepare()).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'BUILDER_UNREACHABLE' })],
    });
    expect(
      (await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }))
        .restoreLocked,
    ).toBe(true);
  });
  it('blocks both known open execution and a missing submitted run', async () => {
    const task = await running();
    await restoreLock();
    await expect(recovery().prepare()).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'REMOTE_RUN_OPEN', runId: task.spec.runId })],
    });
    fixture.remote.observations.clear();
    await expect(recovery().prepare()).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'LOCAL_RUN_MISSING', runId: task.spec.runId })],
    });
    await held(task.deployment.id);
  });
  it('keeps a partial fence locked and retries above every remote high-water generation', async () => {
    await registeredBuilder();
    const rows = await db.builder.findMany({ orderBy: { id: 'asc' } });
    const first = clients.get(rows[0]!.endpoint)!,
      second = clients.get(rows[1]!.endpoint)!;
    second.failFence = true;
    await restoreLock();
    await expect(recovery().prepare()).rejects.toBeInstanceOf(BuildRecoveryBlocked);
    expect(first.highGeneration).toBe(1);
    expect(second.highGeneration).toBe(0);
    expect(
      (await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } })).generation,
    ).toBe(0);
    second.failFence = false;
    const flow = recovery();
    const plan = await flow.prepare();
    expect(plan.generation).toBe(2);
    await unlock(flow, plan);
  });
  it.each(['expired', 'wrong_identity', 'bad_signature'] as const)(
    'rejects %s signed inventory pages',
    async (fault) => {
      fixture.remote.inventoryFault = fault;
      await restoreLock();
      await expect(recovery().prepare()).rejects.toBeInstanceOf(BuildRecoveryBlocked);
      expect(
        (await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }))
          .restoreLocked,
      ).toBe(true);
    },
  );
  it('rejects fabricated, expired, unverified and changed-inventory recovery plans', async () => {
    await restoreLock();
    const flow = recovery();
    const plan = await flow.prepare();
    await expect(db.$transaction((tx) => flow.apply(tx, { ...plan }))).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'PLAN_INVALID' })],
    });
    await expect(db.$transaction((tx) => flow.apply(tx, plan))).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'PLAN_INVALID' })],
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(plan.expiresAt) + 1);
    try {
      await expect(flow.verifyUnchanged(plan)).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'PLAN_EXPIRED' })],
      });
    } finally {
      clock.mockRestore();
    }
    closed(buildSpec({ installationId, profile: fixture.remote.profile }));
    await expect(unlock(flow, plan)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'INVENTORY_CHANGED' })],
    });
    expect(
      (await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }))
        .restoreLocked,
    ).toBe(true);
  });
  it('records original-epoch closure plus unsent closure before unlock without releasing task slots', async () => {
    const sent = await running({ volume: true });
    const unsent = await running({ submitted: false });
    const proof = closed(sent.spec);
    await restoreLock();
    const flow = recovery();
    const plan = await flow.prepare();
    await unlock(flow, plan);
    expect(
      (await db.buildRun.findUniqueOrThrow({ where: { id: sent.spec.runId } })).endProofJson,
    ).toEqual(proof.proof);
    expect(
      (await db.buildRun.findUniqueOrThrow({ where: { id: unsent.spec.runId } })).executionState,
    ).toBe('never_submitted');
    await held(sent.deployment.id, true);
    await held(unsent.deployment.id);
    await tasks.recoverTask(sent.lease.ref);
    await tasks.recoverTask(unsent.lease.ref);
    expect(await db.serviceMutation.count()).toBe(0);
    expect(await db.volumeMutation.count()).toBe(0);
  });
});
