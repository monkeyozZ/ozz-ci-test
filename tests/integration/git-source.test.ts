import { execFile } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type SecretKind } from '../../packages/database/dist/index.js';
import { createApp } from '../../apps/api/dist/app.js';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';
import {
  TaskRepository,
  type OperationActor,
} from '../../packages/control-plane/src/tasks/repository.js';
import { ServiceCommands } from '../../packages/control-plane/src/services/commands.js';
import { json } from '../../packages/control-plane/src/services/persistence.js';
import { validateServiceConfiguration } from '../../packages/control-plane/src/services/validation.js';
import {
  readServiceSnapshot,
  snapshotConfiguration,
} from '../../packages/control-plane/src/services/snapshots.js';
import type {
  CreateServiceInput,
  ServiceSnapshotV3,
  ServiceView,
} from '../../packages/control-plane/src/services/contracts.js';
import { GitCommands } from '../../packages/control-plane/src/git/commands.js';
import {
  GitWebhookDispatcher,
  GitWebhookQueries,
  GitWebhookReceiver,
} from '../../packages/control-plane/src/git/webhooks.js';
import { validateGitSourceInput } from '../../packages/control-plane/src/git/persistence.js';
import type { GitSourceInput } from '../../packages/control-plane/src/git/contracts.js';
import { IntegrationCommands } from '../../packages/control-plane/src/integrations/commands.js';
import { IntegrationExecutor } from '../../packages/control-plane/src/integrations/executor.js';
import {
  GitHubAdapter,
  GitHubError,
  type GitHubHttpRequest,
} from '../../packages/infrastructure/dist/github.js';
import { hashJson, type BuildRunSpec } from '../../packages/infrastructure/dist/build.js';
import { RegistryAdapterError } from '../../packages/infrastructure/dist/registry.js';
import { createTestSession } from './helpers.js';

// Production admission, HTTP guards and SQL invariants use an isolated schema.
// GitHub HTTP responses and already verified integration rows are test fixtures;
// this suite does not claim real GitHub, Builder or Kubernetes execution.
const execute = promisify(execFile);
const schema = `s6git_${randomUUID().replaceAll('-', '')}`;
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl) throw new Error('S6 Git tests require PostgreSQL.');
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-git-integration-'));
const masterKey = randomBytes(32);
const masterKeyFile = join(directory, 'master-key.json');
const oldEnvironment = Object.fromEntries(
  ['DATABASE_URL', 'MASTER_KEY_FILE', 'APP_ORIGIN', 'RESTORE_MODE', 'NODE_ENV'].map((key) => [
    key,
    process.env[key],
  ]),
);
const sha = 'a'.repeat(40),
  nextSha = 'b'.repeat(40);
const requests: GitHubHttpRequest[] = [];
let headSha = sha;
let loseNextHookResponse = false;
let remoteHook: {
  id: number;
  name: 'web';
  active: true;
  events: string[];
  config: { url: string };
} | null = null;
let sequence = 0;
let db: PrismaClient;
let app: Awaited<ReturnType<typeof createApp>>;
let session: Awaited<ReturnType<typeof createTestSession>>;
let tasks: TaskRepository;
let services: ServiceCommands;
let git: GitCommands;
let integrations: IntegrationCommands;
let receiver: GitWebhookReceiver;
let dispatcher: GitWebhookDispatcher;
let actor: OperationActor;
let fixture: Awaited<ReturnType<typeof createContext>>;
const cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, masterKey]]) });
const github = new GitHubAdapter({
  apiOrigin: 'https://github-api.fixture.test',
  cloneOrigin: 'https://git.fixture.test',
  transport: {
    async request(input) {
      requests.push(input);
      const url = new URL(input.url);
      const repo = {
        id: Number(fixture.repository.githubRepositoryId),
        full_name: fixture.repository.fullName,
        default_branch: 'main',
        private: true,
        archived: false,
      };
      let data: unknown;
      if (url.pathname.startsWith('/repositories/')) data = repo;
      else if (url.pathname.includes('/commits/')) {
        const ref = decodeURIComponent(url.pathname.split('/commits/')[1]!);
        const commitSha = /^[0-9a-f]{40}$/.test(ref) ? ref : headSha;
        data = {
          sha: commitSha,
          commit: {
            tree: { sha: 'c'.repeat(40) },
            message: 'Fixed fixture commit',
            committer: { date: '2026-10-26T00:00:00Z' },
          },
        };
      } else if (url.pathname.includes('/contents/'))
        data = url.pathname.endsWith('/contents/') ? [] : { type: 'file', size: 42 };
      else if (/\/hooks(?:\/88)?$/.test(url.pathname)) {
        if (input.method === 'GET') data = remoteHook ? [remoteHook] : [];
        else {
          const body = JSON.parse(input.body!.toString('utf8')) as { config: { url: string } };
          remoteHook = {
            id: 88,
            name: 'web',
            active: true,
            events: ['push'],
            config: { url: body.config.url },
          };
          if (loseNextHookResponse) {
            loseNextHookResponse = false;
            throw new GitHubError('GITHUB_UNAVAILABLE', true);
          }
          data = remoteHook;
        }
      } else if (url.pathname === '/user') data = { id: 1, login: 'fixture-owner' };
      else if (url.pathname === '/user/repos') data = [repo];
      else throw new Error('Unexpected GitHub fixture request');
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(data)),
      };
    },
  },
});

async function secret(kind: SecretKind, payload: Record<string, unknown>) {
  return db.secretReference.create({
    data: { name: `S6 fixture ${++sequence}`, kind, ...cipher.encrypt(kind, payload) },
  });
}

async function createContext() {
  const suffix = ++sequence;
  const credential = await secret('kubeconfig', {
    kubeconfig: 'fixture-only-not-used-for-network',
  });
  const cluster = await db.cluster.create({
    data: {
      name: `Git cluster ${suffix}`,
      slug: `git-cluster-${suffix}`,
      kubeSystemUid: randomUUID(),
      caFingerprint: `sha256:${'d'.repeat(64)}`,
      apiEndpoint: 'https://127.0.0.1:65534',
      credentialRefId: credential.id,
      connectionStatus: 'connected',
      lastObservedAt: new Date(),
    },
  });
  const project = await db.project.create({
    data: { clusterId: cluster.id, name: 'Git applications', slug: `git-project-${suffix}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: 'Production', slug: 'production' },
  });
  const gitToken = `github_pat_${randomBytes(24).toString('hex')}`;
  const gitCredential = await secret('git', { token: gitToken });
  const connection = await db.gitHubConnection.create({
    data: {
      name: 'Git fixture',
      credentialRefId: gitCredential.id,
      verificationState: 'verified',
      verifiedCredentialRefId: gitCredential.id,
      verifiedAt: new Date(),
    },
  });
  const hookSecret = randomBytes(32).toString('base64url');
  const hookCredential = await secret('webhook', { secret: hookSecret });
  const repository = await db.gitRepository.create({
    data: {
      githubConnectionId: connection.id,
      githubRepositoryId: String(1000 + suffix),
      fullName: `fixture/application-${suffix}`,
      defaultBranch: 'main',
      private: true,
      lastVerifiedAt: new Date(),
      hookSecretRefId: hookCredential.id,
      hookCallbackId: randomUUID(),
      hookState: 'registered',
    },
  });
  const authority = 'registry.fixture.test',
    namespace = `project-${suffix}`;
  const push = await secret('registry', {
    registry: authority,
    username: `push-${suffix}`,
    password: randomBytes(24).toString('hex'),
  });
  const pull = await secret('registry', {
    registry: authority,
    username: `pull-${suffix}`,
    password: randomBytes(24).toString('hex'),
  });
  const registry = await db.registryConnection.create({
    data: {
      name: 'Registry fixture',
      authority,
      namespace,
      pushCredentialRefId: push.id,
      pullCredentialRefId: pull.id,
      pushVerificationState: 'verified',
      pullVerificationState: 'verified',
      pushVerifiedAt: new Date(),
      pullVerifiedAt: new Date(),
    },
  });
  const builderCredential = await secret('builder', { fixture: 'no-network-builder-credential' });
  const instanceId = randomUUID();
  const profile = {
    instanceId,
    profileRevision: 1,
    buildkitVersion: 'v0.25.1',
    frontendDigest: `sha256:${'e'.repeat(64)}`,
  };
  const publicKey = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
  const builder = await db.builder.create({
    data: {
      name: 'Builder fixture',
      instanceId,
      identityPublicKey: publicKey,
      endpoint: 'https://builder.fixture.test',
      credentialRefId: builderCredential.id,
      profileJson: profile,
      verificationState: 'verified',
      verifiedAt: new Date(),
    },
  });
  return {
    cluster,
    project,
    environment,
    connection,
    repository,
    registry,
    builder,
    profile,
    hookSecret,
    hookCredential,
    gitToken,
    gitCredential,
  };
}

function source(overrides: Partial<GitSourceInput> = {}): GitSourceInput {
  return {
    kind: 'github',
    repositoryId: fixture.repository.id,
    branchRef: 'refs/heads/main',
    dockerfilePath: 'Dockerfile',
    contextPath: '.',
    platforms: [{ os: 'linux', architecture: 'amd64' }],
    builderId: fixture.builder.id,
    registryConnectionId: fixture.registry.id,
    imageRepository: 'application',
    autoDeploy: true,
    ...overrides,
  };
}
async function service(overrides: Partial<GitSourceInput> = {}, configuration = {}) {
  const suffix = ++sequence;
  return services.create({
    environmentId: fixture.environment.id,
    name: `Git service ${suffix}`,
    slug: `git-service-${suffix}`,
    configuration,
    source: source(overrides),
  });
}
function currentSource(value: ServiceView) {
  if (value.source.kind !== 'github') throw new Error('Expected Git fixture source');
  return value.source;
}
function payload(overrides: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      repository: { id: Number(fixture.repository.githubRepositoryId) },
      ref: 'refs/heads/main',
      after: sha,
      deleted: false,
      ...overrides,
    }),
  );
}
function signed(body: Buffer, deliveryId = randomUUID(), hookSecret = fixture.hookSecret) {
  return {
    repositoryId: fixture.repository.id,
    callbackId: fixture.repository.hookCallbackId!,
    deliveryId,
    event: 'push',
    body,
    signature: `sha256=${createHmac('sha256', hookSecret).update(body).digest('hex')}`,
  };
}
async function receive(overrides: Record<string, unknown> = {}) {
  const receipt = await receiver.receive(signed(payload(overrides)));
  return db.webhookTarget.findMany({
    where: { webhookDeliveryId: receipt.deliveryId },
    orderBy: { receiptSequence: 'asc' },
  });
}
async function deploy(value: ServiceView) {
  const preview = await git.preview(value.id, {
    revision: value.revision,
    selection: { kind: 'branch_head' },
  });
  return git.deploy(
    value.id,
    { revision: value.revision, previewId: preview.id },
    actor,
    randomUUID(),
  );
}
async function run(deploymentId: string) {
  const lease = await tasks.claimDeployment(deploymentId, `s6-fixture-${randomUUID()}`);
  if (!lease) throw new Error('Expected fixture deployment lease');
  const deployment = await db.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  const snapshot = deployment.snapshotJson as unknown as ServiceSnapshotV3;
  const runId = randomUUID();
  const spec: BuildRunSpec = {
    version: 1,
    action: 'build_and_push',
    installationId: (deployment.targetJson as { installationId: string }).installationId,
    runId,
    deploymentId,
    source: {
      githubRepositoryId: snapshot.source.revision.repository.githubRepositoryId,
      commitSha: snapshot.source.commitSha,
      recipeHash: snapshot.source.revision.recipeHash,
      dockerfilePath: snapshot.source.revision.dockerfilePath,
      contextPath: snapshot.source.revision.contextPath,
      buildArgs: {},
      buildSecrets: [],
      platforms: snapshot.source.revision.platforms,
    },
    profile: fixture.profile,
    destination: {
      authority: fixture.registry.authority,
      repository: `${fixture.registry.namespace}/application`,
    },
    limits: {
      cpuMillis: 1000,
      memoryMiB: 1024,
      pids: 256,
      diskBytes: String(1024 ** 3),
      timeoutSeconds: 300,
    },
    deadlineAt: new Date(Date.now() + 300_000).toISOString(),
  };
  const stored = await db.buildRun.create({
    data: {
      id: runId,
      deploymentId,
      runNumber: 1,
      builderId: fixture.builder.id,
      builderInstanceId: fixture.builder.instanceId,
      generation: lease.generation,
      specJson: json(spec),
      specHash: hashJson(spec),
    },
  });
  return { lease, stored, deployment, spec };
}

beforeAll(async () => {
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
    { env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, timeout: 60_000 },
  );
  writeFileSync(
    masterKeyFile,
    JSON.stringify({ activeVersion: 1, keys: { 1: masterKey.toString('base64') } }),
    { mode: 0o600 },
  );
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    MASTER_KEY_FILE: masterKeyFile,
    APP_ORIGIN: 'https://control.fixture.test',
    RESTORE_MODE: 'false',
    NODE_ENV: 'test',
  });
  db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  await db.$connect();
  app = await createApp({ silent: true, githubAdapter: github });
  session = await createTestSession(app, db);
  actor = { id: session.adminId };
  tasks = new TaskRepository(db);
  services = new ServiceCommands(tasks, cipher);
  git = new GitCommands(tasks, cipher, github, services);
  integrations = new IntegrationCommands(tasks, cipher, github, 'https://control.fixture.test');
  receiver = new GitWebhookReceiver(tasks, cipher);
  dispatcher = new GitWebhookDispatcher(tasks, cipher, services);
}, 90_000);

beforeEach(async () => {
  fixture = await createContext();
  requests.length = 0;
  headSha = sha;
  remoteHook = null;
  loseNextHookResponse = false;
});

afterAll(async () => {
  await dispatcher?.stop();
  await session?.cleanup();
  await app?.close();
  if (db) {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
  for (const [key, value] of Object.entries(oldEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('S6 Git sources and persistent admission', () => {
  it.each(['image', 'github'] as const)(
    'replays concurrent %s service creation without duplicating the service or encrypted variables',
    async (kind) => {
      const key = randomUUID();
      const secretValue = `synthetic-retry-secret-${randomUUID()}`;
      const configuration = {
        ...(kind === 'image' ? { image: 'nginx:1.27' } : {}),
        replicas: 1,
        environment: [{ name: 'API_TOKEN', value: secretValue, secret: true }],
      };
      const input = {
        environmentId: fixture.environment.id,
        projectId: fixture.project.id,
        name: 'Retry the same service',
        slug: 'same-service',
        configuration,
        source: kind === 'github' ? source() : { kind: 'image' as const },
      };
      const headers = { ...session.headers, 'idempotency-key': key };
      const secretsBefore = await db.secretReference.count();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({ method: 'POST', url: '/api/services', headers, payload: input }),
        ),
      );
      const original = responses[0]!.json<{ data: ServiceView }>();
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(201);
        expect(response.json()).toEqual(original);
        expect(response.body).not.toContain(secretValue);
      }
      expect(await db.service.count({ where: { environmentId: fixture.environment.id } })).toBe(1);
      expect(await db.secretReference.count()).toBe(secretsBefore + 1);
      expect(
        await db.serviceSecretReference.count({ where: { serviceId: original.data.id } }),
      ).toBe(1);
      expect(await db.gitSource.count({ where: { serviceId: original.data.id } })).toBe(
        kind === 'github' ? 1 : 0,
      );
      expect(
        await db.gitSourceRevision.count({ where: { source: { serviceId: original.data.id } } }),
      ).toBe(kind === 'github' ? 1 : 0);
      const receipts = await db.commandReceipt.findMany({
        where: { idempotencyScope: `service-create:${session.adminId}`, idempotencyKey: key },
      });
      expect(receipts).toHaveLength(1);
      expect(JSON.stringify(receipts)).not.toContain(secretValue);

      // JSON object order is not a change to the user's deployment configuration.
      const replay = await app.inject({
        method: 'POST',
        url: '/api/services',
        headers,
        payload: {
          ...input,
          configuration: Object.fromEntries(Object.entries(configuration).reverse()),
          source: Object.fromEntries(Object.entries(input.source).reverse()),
        },
      });
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(original);

      const conflicts = [
        { ...input, name: 'Different name' },
        { ...input, configuration: { ...configuration, replicas: 2 } },
        {
          ...input,
          configuration: {
            ...configuration,
            environment: [{ name: 'API_TOKEN', value: 'changed-secret', secret: true }],
          },
        },
        kind === 'github'
          ? { ...input, source: source({ branchRef: 'refs/heads/other' }) }
          : { ...input, configuration: { ...configuration, image: 'nginx:1.28' } },
        {
          ...input,
          configuration: kind === 'github' ? { image: 'nginx:1.27' } : {},
          source: kind === 'github' ? { kind: 'image' } : source(),
        },
      ];
      for (const payload of conflicts) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/services',
          headers,
          payload,
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      }
      expect(await db.service.count({ where: { environmentId: fixture.environment.id } })).toBe(1);
      expect(await db.secretReference.count()).toBe(secretsBefore + 1);

      await db.controlPlaneState.update({
        where: { id: 'control-plane' },
        data: { restoreLocked: true },
      });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/services',
          headers,
          payload: input,
        });
        expect(response.statusCode, response.body).toBe(503);
        expect(response.json()).toMatchObject({ code: 'RESTORE_READ_ONLY' });
      } finally {
        await db.controlPlaneState.update({
          where: { id: 'control-plane' },
          data: { restoreLocked: false },
        });
      }
    },
  );

  it.each(['image', 'github'] as const)(
    'replays %s creation across retained master-key rotation and fingerprints new requests with the active key',
    async (kind) => {
      const key = randomUUID();
      const input: CreateServiceInput = {
        environmentId: fixture.environment.id,
        name: 'Service before key rotation',
        slug: 'before-key-rotation',
        configuration: {
          ...(kind === 'image' ? { image: 'nginx:1.27' } : {}),
          environment: [{ name: 'API_TOKEN', value: 'fixture-pin-1234', secret: true }],
        },
        source: kind === 'github' ? source() : { kind: 'image' },
      };
      const initial = await app.inject({
        method: 'POST',
        url: '/api/services',
        headers: { ...session.headers, 'idempotency-key': key },
        payload: input,
      });
      expect(initial.statusCode, initial.body).toBe(201);
      const original = initial.json<{ data: ServiceView }>().data;
      const originalReceipt = await db.commandReceipt.findUniqueOrThrow({
        where: {
          idempotencyScope_idempotencyKey: {
            idempotencyScope: `service-create:${actor.id}`,
            idempotencyKey: key,
          },
        },
      });
      const secretsBeforeReplay = await db.secretReference.count();
      const rotatedKey = randomBytes(32);
      const rotatedCommands = new ServiceCommands(
        tasks,
        new SecretCipher({
          activeVersion: 2,
          keys: new Map([
            [1, masterKey],
            [2, rotatedKey],
          ]),
        }),
      );
      expect(await rotatedCommands.create(input, actor, key)).toEqual(original);
      await expect(
        rotatedCommands.create(
          {
            ...input,
            configuration: {
              ...input.configuration,
              environment: [{ name: 'API_TOKEN', value: 'changed-fixture-pin', secret: true }],
            },
          },
          actor,
          key,
        ),
      ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      expect(await db.service.count({ where: { environmentId: fixture.environment.id } })).toBe(1);
      expect(await db.secretReference.count()).toBe(secretsBeforeReplay);
      expect(
        await db.commandReceipt.findUniqueOrThrow({ where: { id: originalReceipt.id } }),
      ).toEqual(originalReceipt);

      const nextInput = {
        ...input,
        name: 'Service after key rotation',
        slug: 'after-key-rotation',
      };
      const nextKey = randomUUID();
      const created = await rotatedCommands.create(nextInput, actor, nextKey);
      const storedSecret = await db.secretReference.findUniqueOrThrow({
        where: { id: created.configuration.environment[0]!.secretRefId! },
      });
      expect(storedSecret.keyVersion).toBe(2);
      const activeKeyOnly = new ServiceCommands(
        tasks,
        new SecretCipher({ activeVersion: 2, keys: new Map([[2, rotatedKey]]) }),
      );
      expect(await activeKeyOnly.create(nextInput, actor, nextKey)).toEqual(created);
      await expect(services.create(nextInput, actor, nextKey)).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(await db.service.count({ where: { environmentId: fixture.environment.id } })).toBe(2);
      expect(await db.secretReference.count()).toBe(secretsBeforeReplay + 1);
    },
  );

  it('rejects malformed service creation keys and keeps invalid requests retryable', async () => {
    const input = {
      environmentId: fixture.environment.id,
      name: 'Invalid creation key',
      slug: 'invalid-creation-key',
      configuration: { image: 'nginx:1.27' },
    };
    for (const key of ['', 'short', 'invalid key', 'x'.repeat(129)]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/services',
        headers: { ...session.headers, 'idempotency-key': key },
        payload: input,
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const key = randomUUID();
    const headers = { ...session.headers, 'idempotency-key': key };
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/services',
      headers,
      payload: { ...input, configuration: { image: 'nginx:1.27', replicas: 0 } },
    });
    expect(invalid.statusCode).toBe(422);
    expect(await db.service.count({ where: { environmentId: fixture.environment.id } })).toBe(0);
    expect(await db.commandReceipt.count({ where: { idempotencyKey: key } })).toBe(0);
    const corrected = await app.inject({
      method: 'POST',
      url: '/api/services',
      headers,
      payload: input,
    });
    expect(corrected.statusCode, corrected.body).toBe(201);
  });

  it('offers applied V3 HTTP ports for domains while keeping unpublished draft ports separate', async () => {
    const http = { name: 'http', protocol: 'http', containerPort: 80, servicePort: 80 };
    const value = await service({}, { ports: [http] });
    const publication = await deploy(value);
    const lease = await tasks.claimDeployment(publication.id, 'fixture-published-v3-network');
    expect(lease).not.toBeNull();
    // Seed an applied V3 publication; this test verifies real HTTP/SQL admission,
    // while the local-lab probe separately executes BuildKit/K3s and HTTPS.
    expect(
      await tasks.complete(lease!, {
        commit: async (tx) => {
          await tx.deployment.update({
            where: { id: publication.id },
            data: { appliedAt: new Date() },
          });
          await tx.service.update({
            where: { id: value.id },
            data: {
              publishedDeploymentId: publication.id,
              lastSuccessfulDeploymentId: publication.id,
              configurationState: 'consistent',
            },
          });
        },
      }),
    ).toBe(true);
    const stable = await db.servicePort.findUniqueOrThrow({
      where: { serviceId_name: { serviceId: value.id, name: 'http' } },
    });
    const current = await services.get(value.id);
    await services.update(value.id, {
      revision: current.revision,
      configuration: {
        ports: [
          { ...http, containerPort: 8080, servicePort: 8080 },
          { name: 'draft-admin', protocol: 'http', containerPort: 9090, servicePort: 9090 },
        ],
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/services/${value.id}/networking`,
      headers: session.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.eligiblePorts).toEqual([
      { ...http, id: stable.id, publishedConfigRevision: value.configRevision },
    ]);
    const stored = await db.deployment.findUniqueOrThrow({ where: { id: publication.id } });
    expect(stored.snapshotJson).toMatchObject({ version: 3, configuration: { ports: [http] } });
    expect(readServiceSnapshot(stored.snapshotJson).configuration).not.toHaveProperty('image');
  });

  it('accepts an HTTP image deployment without a Git preview field', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/services',
      headers: session.headers,
      payload: {
        environmentId: fixture.environment.id,
        name: 'API image without preview',
        slug: 'api-image-without-preview',
        configuration: { image: 'nginx:1.27', replicas: 1 },
      },
    });
    expect(created.statusCode).toBe(201);
    const value = created.json<{ data: ServiceView }>().data;
    const publication = await app.inject({
      method: 'POST',
      url: `/api/services/${value.id}/deployments`,
      headers: { ...session.headers, 'idempotency-key': randomUUID() },
      payload: { revision: value.revision },
    });
    expect(publication.statusCode).toBe(202);
    expect(publication.json()).toMatchObject({
      data: {
        kind: 'image_deploy',
        snapshot: { version: 2, configuration: { image: 'nginx:1.27' } },
      },
    });
  });

  it('accepts an HTTP failed Git retry without a preview field and keeps the original V3 snapshot', async () => {
    const value = await service({}, { replicas: 2 });
    const publication = await deploy(value);
    const prepared = await run(publication.id);
    expect(
      await tasks.fail(prepared.lease, 'CHECKOUT_FAILED', 'Fixture checkout failed', false),
    ).toBe(true);
    const original = await db.deployment.findUniqueOrThrow({ where: { id: publication.id } });
    expect(original).toMatchObject({ status: 'failed', artifactId: null, resolvedImageJson: null });
    const closed = await db.buildRun.findUniqueOrThrow({ where: { id: prepared.stored.id } });
    expect(closed).toMatchObject({
      executionState: 'never_submitted',
      executionClosedAt: expect.any(Date),
    });
    const current = await app.inject({
      method: 'GET',
      url: `/api/services/${value.id}`,
      headers: session.headers,
    });
    expect(current.statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: `/api/deployments/${publication.id}/retry`,
      headers: { ...session.headers, 'idempotency-key': randomUUID() },
      payload: { revision: current.json<{ data: ServiceView }>().data.revision },
    });
    expect(response.statusCode).toBe(202);
    const retry = await db.deployment.findUniqueOrThrow({
      where: { id: response.json<{ data: { id: string } }>().data.id },
    });
    expect(retry).toMatchObject({
      status: 'queued',
      kind: 'git_deploy',
      retryOfId: publication.id,
      sourceRevisionId: original.sourceRevisionId,
      snapshotJson: original.snapshotJson,
      artifactId: null,
      resolvedImageJson: null,
    });
    expect(readServiceSnapshot(retry.snapshotJson).configuration).not.toHaveProperty('image');
    expect(await db.buildRun.findUniqueOrThrow({ where: { id: closed.id } })).toEqual(closed);
    expect(await db.deployment.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      status: 'failed',
      snapshotJson: original.snapshotJson,
      errorCode: 'CHECKOUT_FAILED',
    });
  });

  it('accepts runtime-only Git input through the real API and persists V3 without a placeholder image', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/services',
      headers: session.headers,
      payload: {
        environmentId: fixture.environment.id,
        name: 'API Git service',
        slug: 'api-git-service',
        configuration: { replicas: 2 },
        source: source(),
      },
    });
    expect(created.statusCode).toBe(201);
    const value = created.json<{ data: ServiceView }>().data;
    expect(value.configuration).not.toHaveProperty('image');
    const preview = await app.inject({
      method: 'POST',
      url: `/api/services/${value.id}/git-source/preview`,
      headers: session.headers,
      payload: { revision: value.revision, selection: { kind: 'branch_head' } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ data: { source: { commitSha: sha } } });
    const publication = await app.inject({
      method: 'POST',
      url: `/api/services/${value.id}/deployments`,
      headers: { ...session.headers, 'idempotency-key': randomUUID() },
      payload: {
        revision: value.revision,
        previewId: preview.json<{ data: { id: string } }>().data.id,
      },
    });
    expect(publication.statusCode).toBe(202);
    const stored = await db.deployment.findUniqueOrThrow({
      where: { id: publication.json<{ data: { id: string } }>().data.id },
    });
    expect(stored.snapshotJson).toMatchObject({
      version: 3,
      source: { kind: 'github', commitSha: sha },
      configuration: { replicas: 2 },
    });
    const snapshot = readServiceSnapshot(stored.snapshotJson);
    expect(snapshot.configuration).not.toHaveProperty('image');
    expect(() => snapshotConfiguration(snapshot)).toThrowError();
    expect(
      snapshotConfiguration(snapshot, `registry.fixture.test/team/app@sha256:${'f'.repeat(64)}`)
        .image,
    ).toContain('@sha256:');
    expect(
      (await db.service.findUniqueOrThrow({ where: { id: value.id } })).configJson,
    ).not.toHaveProperty('image');
  });

  it('cannot create a Git draft against a cluster without its verified immutable identity', async () => {
    await db.cluster.update({ where: { id: fixture.cluster.id }, data: { kubeSystemUid: null } });
    await expect(service()).rejects.toMatchObject({ code: 'CLUSTER_NOT_CONNECTED' });
    expect(await db.service.count({ where: { environmentId: fixture.environment.id } })).toBe(0);
  });

  it('does not reinterpret historical V1/V2 snapshot bytes when reading them', () => {
    const configuration = validateServiceConfiguration({
      image: 'registry.fixture.test/team/app:old',
      replicas: 1,
      healthTimeoutSeconds: 60,
    });
    const common = {
      serviceId: randomUUID(),
      serviceName: 'Old image service',
      serviceSlug: 'old-image-service',
      configRevision: 3,
      configuration,
      deployAndStart: false,
      allowConfigurationRepair: false,
    };
    for (const value of [
      { ...common, version: 1 },
      {
        ...common,
        version: 2,
        controller: { kind: 'Deployment', strategy: 'RollingUpdate' },
        volumes: [],
        database: null,
        databaseBindings: [],
        template: null,
      },
    ]) {
      const before = JSON.stringify(value);
      expect(readServiceSnapshot(value)).toBe(value);
      expect(JSON.stringify(value)).toBe(before);
      expect(value).not.toHaveProperty('source');
    }
  });

  it('rejects prototype keys and Builder control arguments before saving a source', () => {
    for (const name of [
      '__proto__',
      'constructor',
      'prototype',
      'BUILDKIT_HOST',
      'BUILDX_BUILDER',
    ]) {
      const buildArgs = JSON.parse(`{"${name}":"forbidden"}`) as Record<string, string>;
      expect(() => validateGitSourceInput(source({ buildArgs }))).toThrowError();
    }
  });

  it('keeps the reviewed SHA after HEAD advances and rejects a stale service CAS', async () => {
    const value = await service();
    const preview = await git.preview(value.id, {
      revision: value.revision,
      selection: { kind: 'branch_head' },
    });
    headSha = nextSha;
    const count = requests.length;
    const publication = await git.deploy(
      value.id,
      { revision: value.revision, previewId: preview.id },
      actor,
      randomUUID(),
    );
    expect(requests).toHaveLength(count);
    expect(
      (await db.deployment.findUniqueOrThrow({ where: { id: publication.id } })).snapshotJson,
    ).toMatchObject({ source: { commitSha: sha } });
    const other = await service();
    const stale = await git.preview(other.id, {
      revision: other.revision,
      selection: { kind: 'branch_head' },
    });
    await services.update(other.id, { revision: other.revision, configuration: { replicas: 2 } });
    await expect(
      git.deploy(other.id, { revision: other.revision, previewId: stale.id }, actor, randomUUID()),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await db.deployment.count({ where: { serviceId: other.id } })).toBe(0);
  });

  it('retains actual historical build secret bytes and fixed FK references', async () => {
    const old = await secret('generic', { value: 'fixture-old-build-secret' });
    const value = await service({
      buildSecrets: [{ mountId: 'package-token', secretRefId: old.id }],
    });
    const first = currentSource(value).currentRevision;
    const fresh = await secret('generic', { value: 'fixture-new-build-secret' });
    const updated = await git.updateSource(value.id, {
      revision: value.revision,
      source: source({ buildSecrets: [{ mountId: 'package-token', secretRefId: fresh.id }] }),
    });
    expect(currentSource(updated).currentRevision.id).not.toBe(first.id);
    expect(
      await db.gitSourceSecretReference.findUnique({
        where: {
          sourceRevisionId_mountId: { sourceRevisionId: first.id, mountId: 'package-token' },
        },
      }),
    ).toMatchObject({ secretRefId: old.id, contentRevision: old.contentRevision });
    await expect(
      db.secretReference.update({
        where: { id: old.id },
        data: {
          ...cipher.encrypt('generic', { value: 'illegal-overwrite' }),
          contentRevision: { increment: 1 },
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.gitSourceRevision.update({ where: { id: first.id }, data: { snapshotJson: {} } }),
    ).rejects.toThrow();
    await expect(
      db.gitSourceSecretReference.delete({
        where: {
          sourceRevisionId_mountId: { sourceRevisionId: first.id, mountId: 'package-token' },
        },
      }),
    ).rejects.toThrow();
    await expect(db.secretReference.delete({ where: { id: old.id } })).rejects.toThrow();
    expect(
      cipher.decrypt(await db.secretReference.findUniqueOrThrow({ where: { id: old.id } })),
    ).toEqual({ value: 'fixture-old-build-secret' });
  });

  it('uses rotated Git credentials without changing the retained source identity', async () => {
    const value = await service();
    const original = currentSource(value).currentRevision;
    const token = `github_pat_${randomBytes(24).toString('hex')}`;
    const credential = await secret('git', { token });
    await integrations.updateGithub(fixture.connection.id, {
      revision: fixture.connection.revision,
      credentialRefId: credential.id,
    });
    const preview = await git.preview(value.id, {
      revision: value.revision,
      selection: { kind: 'commit', commitSha: sha },
    });
    expect(preview.source.revision).toEqual(original);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.headers.authorization === `Bearer ${token}`)).toBe(
      true,
    );
    const audit = await db.auditEvent.findFirst({
      where: { action: 'integration.credential_used', resourceId: fixture.connection.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({
      credentialRefId: credential.id,
      purpose: 'publication_preview',
    });
    expect(JSON.stringify(audit)).not.toContain(token);
  });
});

describe('S6 Webhook authentication, fanout and FIFO', () => {
  it('retains the current hook key through a lost rotation response and bounds the old-key grace after reconciliation', async () => {
    await service();
    const nextSecret = randomBytes(32).toString('base64url');
    const candidate = await secret('webhook', { secret: nextSecret });
    const request = { revision: fixture.repository.revision, secretRefId: candidate.id };
    const operation = await integrations.registerWebhook(
      fixture.connection.id,
      fixture.repository.id,
      request,
      actor,
      randomUUID(),
    );
    const executor = new IntegrationExecutor(tasks, cipher, github);
    const lease = await tasks.claim(operation.id, 'fixture-hook-response-lost');
    expect(lease).not.toBeNull();
    loseNextHookResponse = true;
    await expect(executor.execute(lease!, new AbortController().signal)).rejects.toMatchObject({
      code: 'GITHUB_UNAVAILABLE',
    });
    await tasks.fail(
      lease!,
      'GITHUB_UNAVAILABLE',
      'Fixture lost the creation response.',
      false,
      (tx) => executor.failed(lease!, tx, 'GITHUB_UNAVAILABLE'),
    );
    expect(
      await db.gitRepository.findUniqueOrThrow({ where: { id: fixture.repository.id } }),
    ).toMatchObject({
      hookSecretRefId: fixture.hookCredential.id,
      candidateHookSecretRefId: candidate.id,
    });
    await expect(receiver.receive(signed(payload()))).resolves.toMatchObject({ duplicate: false });
    await expect(
      receiver.receive(signed(payload(), randomUUID(), nextSecret)),
    ).resolves.toMatchObject({ duplicate: false });
    const retry = await integrations.registerWebhook(
      fixture.connection.id,
      fixture.repository.id,
      request,
      actor,
      randomUUID(),
    );
    const retryLease = await tasks.claim(retry.id, 'fixture-hook-reconcile');
    const result = await executor.execute(retryLease!, new AbortController().signal);
    expect(await tasks.complete(retryLease!, result)).toBe(true);
    expect(
      await db.gitRepository.findUniqueOrThrow({ where: { id: fixture.repository.id } }),
    ).toMatchObject({
      hookId: '88',
      hookSecretRefId: candidate.id,
      previousHookSecretRefId: fixture.hookCredential.id,
      candidateHookSecretRefId: null,
    });
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    await expect(receiver.receive(signed(payload()))).resolves.toMatchObject({ duplicate: false });
    await db.gitRepository.update({
      where: { id: fixture.repository.id },
      data: { previousHookSecretUntil: new Date(Date.now() - 1) },
    });
    await expect(receiver.receive(signed(payload()))).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    await expect(
      receiver.receive(signed(payload(), randomUUID(), nextSecret)),
    ).resolves.toMatchObject({ duplicate: false });
  });

  it('verifies exact raw bytes before reserving delivery IDs and accepts a valid replay once', async () => {
    await service();
    const body = payload(),
      deliveryId = randomUUID();
    const path = `/api/webhooks/github/${fixture.repository.id}/${fixture.repository.hookCallbackId}`;
    const input = signed(body, deliveryId);
    const headers = {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': input.signature,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { ...headers, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    expect(await db.webhookDelivery.count({ where: { externalDeliveryId: deliveryId } })).toBe(0);
    const accepted = await app.inject({ method: 'POST', url: path, headers, payload: body });
    expect(accepted.statusCode).toBe(202);
    const replay = await app.inject({ method: 'POST', url: path, headers, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true, targetCount: 1 });
    const changed = payload({ after: nextSha });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { ...headers, 'x-hub-signature-256': signed(changed, deliveryId).signature },
          payload: changed,
        })
      ).statusCode,
    ).toBe(409);
    expect(await db.webhookDelivery.count({ where: { externalDeliveryId: deliveryId } })).toBe(1);
    expect(
      await db.webhookTarget.count({
        where: { webhookDeliveryId: accepted.json<{ deliveryId: string }>().deliveryId },
      }),
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/services',
          headers: { 'content-type': 'application/json' },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });

  it('fans out each service independently for branch, policy and stopped-state decisions', async () => {
    const active = await service(),
      wrongBranch = await service({ branchRef: 'refs/heads/release' }),
      disabled = await service({ autoDeploy: false }),
      stopped = await service();
    await db.service.update({ where: { id: stopped.id }, data: { desiredState: 'stopped' } });
    const targets = await receive();
    expect(targets).toHaveLength(4);
    const byService = new Map(targets.map((row) => [row.serviceId, row]));
    expect(byService.get(active.id)).toMatchObject({ state: 'waiting', manualRequired: false });
    expect(byService.get(wrongBranch.id)).toMatchObject({
      state: 'ignored',
      reason: 'branch_mismatch',
    });
    expect(byService.get(disabled.id)).toMatchObject({
      state: 'ignored',
      reason: 'auto_deploy_disabled',
    });
    expect(byService.get(stopped.id)).toMatchObject({
      state: 'pending',
      reason: 'service_stopped',
      manualRequired: true,
    });
    expect((await receive({ ref: 'refs/tags/v1' })).every((row) => row.state === 'ignored')).toBe(
      true,
    );
    expect(
      (await receive({ deleted: true, after: '0'.repeat(40) })).every(
        (row) => row.reason === 'branch_deleted',
      ),
    ).toBe(true);
  });

  it('admits the oldest target exactly once under concurrent dispatch and retains queue/slot linkage', async () => {
    const value = await service();
    const [first] = await receive(),
      [second] = await receive({ after: nextSha });
    expect(await dispatcher.dispatch(second!.id)).toBe(false);
    await Promise.all([dispatcher.dispatch(first!.id), dispatcher.dispatch(first!.id)]);
    const target = await db.webhookTarget.findUniqueOrThrow({ where: { id: first!.id } });
    expect(target).toMatchObject({ state: 'enqueued', reason: 'automatic_publication' });
    const publication = await db.deployment.findUniqueOrThrow({
      where: { id: target.deploymentId! },
      include: { outbox: true, mutationSlot: true },
    });
    expect(publication).toMatchObject({
      serviceId: value.id,
      kind: 'git_deploy',
      initiatorKind: 'webhook',
      webhookDeliveryId: first!.webhookDeliveryId,
      webhookTargetId: first!.id,
    });
    expect(publication.outbox?.deploymentId).toBe(publication.id);
    expect(publication.mutationSlot?.deploymentId).toBe(publication.id);
    expect(await db.deployment.count({ where: { serviceId: value.id } })).toBe(1);
    expect(await dispatcher.dispatch(second!.id)).toBe(false);
    await tasks.cancelDeployment(publication.id, actor);
    expect(await dispatcher.dispatch(second!.id)).toBe(true);
    expect((await db.webhookTarget.findUniqueOrThrow({ where: { id: second!.id } })).state).toBe(
      'enqueued',
    );
  });

  it('rolls back target consumption, service revision, queue and slot if admission fails late', async () => {
    const value = await service(),
      [target] = await receive();
    const failingServices = new ServiceCommands(tasks, cipher);
    const original = failingServices.prepareDeployment.bind(failingServices);
    vi.spyOn(failingServices, 'prepareDeployment').mockImplementation(async (...args) => {
      const prepared = await original(...args),
        accepted = prepared.onAccepted;
      prepared.onAccepted = async (...input) => {
        await accepted?.(...input);
        throw new Error('fixture admission rollback');
      };
      return prepared;
    });
    const failingDispatcher = new GitWebhookDispatcher(tasks, cipher, failingServices);
    await expect(failingDispatcher.dispatch(target!.id)).rejects.toThrow(
      'fixture admission rollback',
    );
    expect(await db.service.findUniqueOrThrow({ where: { id: value.id } })).toMatchObject({
      revision: value.revision,
      mutationRevision: 0,
    });
    expect(await db.webhookTarget.findUniqueOrThrow({ where: { id: target!.id } })).toMatchObject({
      state: 'waiting',
      deploymentId: null,
      admittedAt: null,
    });
    expect(await db.deployment.count({ where: { serviceId: value.id } })).toBe(0);
    expect(await db.serviceMutation.findUnique({ where: { serviceId: value.id } })).toBeNull();
  });

  it.each(['configuration', 'source', 'policy'] as const)(
    'latches a waiting target for manual review when %s changes',
    async (change) => {
      const value = await service(),
        [target] = await receive();
      if (change === 'configuration')
        await services.update(value.id, {
          revision: value.revision,
          configuration: { replicas: 2 },
        });
      if (change === 'source')
        await git.updateSource(value.id, {
          revision: value.revision,
          source: source({ dockerfilePath: 'other/Dockerfile' }),
        });
      if (change === 'policy')
        await git.updatePolicy(value.id, {
          revision: value.revision,
          policyRevision: currentSource(value).policyRevision,
          autoDeploy: false,
        });
      expect(await dispatcher.dispatch(target!.id)).toBe(false);
      expect(await db.webhookTarget.findUniqueOrThrow({ where: { id: target!.id } })).toMatchObject(
        { state: 'pending', reason: `${change}_changed`, manualRequired: true, deploymentId: null },
      );
    },
  );

  it('manually reviews a retained target with its original source/SHA and current runtime', async () => {
    const value = await service(),
      oldSource = currentSource(value).currentRevision,
      [target] = await receive();
    const sourceChanged = await git.updateSource(value.id, {
      revision: value.revision,
      source: source({ dockerfilePath: 'next/Dockerfile' }),
    });
    const updated = await services.update(value.id, {
      revision: sourceChanged.revision,
      configuration: { replicas: 3 },
    });
    headSha = nextSha;
    const preview = await git.preview(value.id, {
      revision: updated.revision,
      selection: { kind: 'pending_target', webhookTargetId: target!.id },
    });
    expect(preview).toMatchObject({
      source: { revision: { id: oldSource.id }, commitSha: sha },
      configuration: { replicas: 3 },
      target: target!.targetJson,
    });
    expect(preview.issues.map((issue) => issue.code)).toContain('REVIEWING_RETAINED_SOURCE');
    const publication = await git.deploy(
      value.id,
      { revision: updated.revision, previewId: preview.id },
      actor,
      randomUUID(),
    );
    expect(await db.deployment.findUniqueOrThrow({ where: { id: publication.id } })).toMatchObject({
      initiatorKind: 'admin',
      createdById: actor.id,
      webhookDeliveryId: target!.webhookDeliveryId,
      webhookTargetId: target!.id,
      sourceRevisionId: oldSource.id,
    });
    expect(await db.webhookTarget.findUniqueOrThrow({ where: { id: target!.id } })).toMatchObject({
      deploymentId: publication.id,
      manualRequired: true,
      state: 'enqueued',
    });
    await tasks.cancelDeployment(publication.id, actor);
    const current = await services.get(value.id);
    const retry = await services.retryDeployment(
      publication.id,
      { revision: current.revision },
      actor,
      randomUUID(),
    );
    expect(
      await db.deployment.findUniqueOrThrow({
        where: { id: retry.id },
        include: { retryOf: true },
      }),
    ).toMatchObject({
      retryOfId: publication.id,
      sourceRevisionId: oldSource.id,
      webhookTargetId: null,
      retryOf: { webhookTargetId: target!.id, webhookDeliveryId: target!.webhookDeliveryId },
    });
    expect(
      (await db.webhookTarget.findUniqueOrThrow({ where: { id: target!.id } })).deploymentId,
    ).toBe(publication.id);
  });

  it('preserves pending targets on resume and does not create another build or deployment', async () => {
    const value = await service(),
      publication = await deploy(value);
    const lease = await tasks.claimDeployment(publication.id, 'fixture-published');
    expect(lease).not.toBeNull();
    await tasks.complete(lease!);
    // Seed a previously verified publication; this test only exercises resume admission.
    await db.service.update({
      where: { id: value.id },
      data: {
        publishedDeploymentId: publication.id,
        configurationState: 'consistent',
        desiredState: 'stopped',
      },
    });
    const [pending] = await receive();
    const stored = await db.service.findUniqueOrThrow({ where: { id: value.id } });
    const before = JSON.stringify(
      (await db.deployment.findUniqueOrThrow({ where: { id: publication.id } })).snapshotJson,
    );
    const operation = await services.action(
      value.id,
      'resume',
      { revision: stored.revision },
      actor,
      randomUUID(),
    );
    expect(operation).toMatchObject({
      kind: 'service_resume',
      input: { snapshotId: publication.id },
    });
    expect(await db.deployment.count({ where: { serviceId: value.id } })).toBe(1);
    expect(await db.buildRun.count({ where: { deployment: { serviceId: value.id } } })).toBe(0);
    expect(await db.webhookTarget.findUniqueOrThrow({ where: { id: pending!.id } })).toMatchObject({
      state: 'pending',
      manualRequired: true,
      deploymentId: null,
    });
    expect(
      JSON.stringify(
        (await db.deployment.findUniqueOrThrow({ where: { id: publication.id } })).snapshotJson,
      ),
    ).toBe(before);
  });

  it('retains the original service dedup identity after deletion and rejects oversized cursors', async () => {
    const value = await service(),
      [target] = await receive();
    await db.service.delete({ where: { id: value.id } });
    expect(await dispatcher.dispatch(target!.id)).toBe(false);
    expect(await db.webhookTarget.findUniqueOrThrow({ where: { id: target!.id } })).toMatchObject({
      serviceId: value.id,
      currentServiceId: null,
      state: 'orphaned',
      manualRequired: true,
    });
    const queries = new GitWebhookQueries(tasks);
    expect((await queries.targets({ serviceId: value.id })).data).toHaveLength(1);
    await expect(queries.targets({ cursor: '9999999999999999999' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });
});

describe('S6 immutable execution gates and integration facts', () => {
  it('blocks terminal, retry-to-queued and slot release while any remote execution is unclosed', async () => {
    const value = await service(),
      publication = await deploy(value);
    const { stored, lease } = await run(publication.id);
    const target = (await db.deployment.findUniqueOrThrow({ where: { id: publication.id } }))
      .targetJson as { namespace: string };
    const volume = await db.volume.create({
      data: {
        environmentId: fixture.environment.id,
        clusterId: fixture.cluster.id,
        name: 'Execution gate fixture',
        slug: 'execution-gate-fixture',
        targetJson: json(target),
        namespace: target.namespace,
        requestedBytes: BigInt(1024 ** 3),
        storageClassName: 'local-path',
        pvcName: `ozz-volume-${randomUUID()}`,
      },
    });
    await db.$transaction(async (tx) => {
      await tx.deploymentVolumeReference.create({
        data: {
          deploymentId: publication.id,
          volumeId: volume.id,
          referenceJson: { volumeId: volume.id },
        },
      });
      await tx.volumeMutation.create({
        data: { volumeId: volume.id, deploymentId: publication.id },
      });
    });
    await db.buildRun.update({
      where: { id: stored.id },
      data: { submissionAttemptedAt: new Date(), executionState: 'open' },
    });
    for (const status of ['succeeded', 'failed', 'cancelled', 'queued'] as const)
      await expect(
        db.deployment.update({ where: { id: publication.id }, data: { status } }),
      ).rejects.toThrow();
    for (const status of ['succeeded', 'failed', 'cancelled'] as const)
      await expect(
        db.$transaction(async (tx) => {
          await tx.deployment.update({ where: { id: publication.id }, data: { status } });
          await tx.serviceMutation.delete({ where: { serviceId: value.id } });
          await tx.volumeMutation.delete({ where: { volumeId: volume.id } });
        }),
      ).rejects.toThrow();
    await expect(db.serviceMutation.delete({ where: { serviceId: value.id } })).rejects.toThrow();
    await expect(db.volumeMutation.delete({ where: { volumeId: volume.id } })).rejects.toThrow();
    expect(
      await tasks.fail(
        lease,
        'FIXTURE_LOST_CONNECTION',
        'Fixture remote execution remains unresolved.',
        true,
      ),
    ).toBe(false);
    const original = await db.buildRun.findUniqueOrThrow({ where: { id: stored.id } });
    await db.buildRun.update({
      where: { id: stored.id },
      data: { generation: original.generation + 1, ownershipEpoch: 1 },
    });
    await expect(
      db.buildRun.update({
        where: { id: stored.id },
        data: { generation: original.generation, ownershipEpoch: 100 },
      }),
    ).rejects.toThrow();
    await expect(
      db.buildRun.update({
        where: { id: stored.id },
        data: {
          submissionAttemptedAt: null,
          executionState: 'never_submitted',
          executionClosedAt: new Date(),
          closureReason: 'cancelled_before_submission',
        },
      }),
    ).rejects.toThrow();
    expect((await db.deployment.findUniqueOrThrow({ where: { id: publication.id } })).status).toBe(
      'running',
    );
  });

  it('closes only genuinely unsent runs before releasing the service slot and never reopens them', async () => {
    const value = await service(),
      publication = await deploy(value);
    const { stored, lease } = await run(publication.id);
    expect(
      await tasks.fail(
        lease,
        'FIXTURE_PREFLIGHT_FAILURE',
        'Fixture failed before external submission.',
        false,
      ),
    ).toBe(true);
    expect(await db.buildRun.findUniqueOrThrow({ where: { id: stored.id } })).toMatchObject({
      executionState: 'never_submitted',
      closureReason: 'rejected_before_submission',
      submissionAttemptedAt: null,
      endProofJson: null,
      proofVerifiedAt: null,
    });
    expect(await db.serviceMutation.findUnique({ where: { serviceId: value.id } })).toBeNull();
    await expect(
      db.buildRun.update({
        where: { id: stored.id },
        data: {
          submissionAttemptedAt: new Date(),
          executionState: 'open',
          executionClosedAt: null,
          closureReason: null,
        },
      }),
    ).rejects.toThrow();
    await expect(db.buildRun.delete({ where: { id: stored.id } })).rejects.toThrow();
  });

  it('retains a successful push check when the pull identity later fails its push-denial check', async () => {
    const operation = await integrations.verifyRegistry(
      fixture.registry.id,
      fixture.registry.revision,
      actor,
      randomUUID(),
    );
    const lease = await tasks.claim(operation.id, 'fixture-registry-probe');
    expect(lease).not.toBeNull();
    const executor = new IntegrationExecutor(tasks, cipher, github, {
      async verify(input) {
        const probeReference = `${input.authority}/${input.repository}@sha256:${'f'.repeat(64)}`,
          checkedAt = new Date().toISOString();
        await input.onChecked?.({ kind: 'push', probeReference, checkedAt });
        await input.onChecked?.({ kind: 'pull', probeReference, checkedAt });
        throw new RegistryAdapterError('REGISTRY_PULL_CREDENTIAL_CAN_PUSH');
      },
    });
    await expect(executor.execute(lease!, new AbortController().signal)).rejects.toMatchObject({
      code: 'REGISTRY_PULL_CREDENTIAL_CAN_PUSH',
    });
    expect(
      await tasks.fail(
        lease!,
        'REGISTRY_PULL_CREDENTIAL_CAN_PUSH',
        'Fixture pull identity can push.',
        false,
        (tx) => executor.failed(lease!, tx, 'REGISTRY_PULL_CREDENTIAL_CAN_PUSH'),
      ),
    ).toBe(true);
    const checked = await db.registryConnection.findUniqueOrThrow({
      where: { id: fixture.registry.id },
    });
    expect(checked).toMatchObject({
      pushVerificationState: 'verified',
      pushErrorCode: null,
      pullVerificationState: 'failed',
      pullErrorCode: 'REGISTRY_PULL_CREDENTIAL_CAN_PUSH',
    });
    expect(checked.pushVerificationJson).toMatchObject({
      push: true,
      credentialRefId: fixture.registry.pushCredentialRefId,
    });
    expect(checked.pullVerificationJson).toMatchObject({
      pull: true,
      credentialRefId: fixture.registry.pullCredentialRefId,
    });
    expect(checked.pullVerificationJson).not.toHaveProperty('pullCannotPush', true);
  });
});
