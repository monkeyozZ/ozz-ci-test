import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  Connection,
  ParsedKey,
  ServerChannel,
} from '../../packages/infrastructure/node_modules/@types/ssh2/index.js';
import { createApp } from '../../apps/api/dist/app.js';
import { PrismaClient } from '../../packages/database/dist/index.js';
import { SecretCipher, readMasterKeys } from '../../packages/control-plane/dist/secrets.js';
import { InfrastructureExecutor } from '../../packages/control-plane/dist/infrastructure/index.js';
import {
  TaskRepository,
  TaskRuntime,
  type InfrastructureInput,
  type OperationView,
} from '../../packages/control-plane/dist/tasks/index.js';
import { K3S_VERSION } from '../../packages/infrastructure/dist/ssh.js';
import { createTestSession } from './helpers.js';

const taskRequire = createRequire(
  new URL('../../packages/control-plane/package.json', import.meta.url),
);
const sshRequire = createRequire(
  new URL('../../packages/infrastructure/package.json', import.meta.url),
);
const { Queue } = taskRequire(
  'bullmq',
) as typeof import('../../packages/control-plane/node_modules/bullmq');
const { Redis } = taskRequire(
  'ioredis',
) as typeof import('../../packages/control-plane/node_modules/ioredis');
const { Server: SshServer, utils } = sshRequire(
  'ssh2',
) as typeof import('../../packages/infrastructure/node_modules/@types/ssh2/index.js');
const execute = promisify(execFile);
const schema = `s2infra_${randomUUID().replaceAll('-', '')}`;
const queueName = `s2-infra-${randomUUID()}`;
const baseDatabaseUrl = process.env.DATABASE_URL;
const baseRedisUrl = process.env.REDIS_URL;
if (!baseDatabaseUrl || !baseRedisUrl)
  throw new Error('S2 integration requires DATABASE_URL and REDIS_URL.');
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-s2-integration-'));
const hostKeyFile = join(directory, 'ssh-host-key');
// Avoid ssh2 1.17's generator stripping an actual zero-prefixed Ed25519 byte.
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKeyFile], {
  stdio: 'ignore',
  timeout: 5000,
});
const hostKey = { private: readFileSync(hostKeyFile, 'utf8') };
const parsedHostKey = utils.parseKey(hostKey.private) as ParsedKey;
const hostFingerprint =
  'SHA256:' +
  createHash('sha256').update(parsedHostKey.getPublicSSH()).digest('base64').replace(/=+$/, '');

interface Resource {
  id: string;
  revision: number;
  name: string;
}
interface ServerResource extends Resource {
  credentialRefId: string | null;
  host: string;
  sshPort: number;
  connectionStatus: string;
  machineId: string | null;
  preflight: { machineId: string; blockers: string[] } | null;
  hostKey: {
    trustedFingerprint: string | null;
    observedFingerprint: string | null;
    discoveryOperationId: string | null;
    trustSource: string | null;
  };
}
interface ClusterResource extends Resource {
  credentialRefId: string | null;
  apiEndpoint: string | null;
  connectionStatus: string;
  identity: { kubeSystemUid: string; caFingerprint: string } | null;
  nodeCount: number;
  lastObservedAt: string | null;
  lastErrorCode: string | null;
}
interface NodeResource {
  id: string;
  uid: string;
  name: string;
  clusterId: string;
  serverId: string | null;
  present: boolean;
}
interface Pki {
  ca: string;
  cert: string;
  key: string;
  clientCert: string;
  clientKey: string;
}
interface KubeFixture {
  endpoint: string;
  identity: string;
  nodeUid: string;
  nodeName: string;
  machineId: string;
  acceptedToken: string;
  apiAvailable: boolean;
  requests: string[];
  material: Pki;
  server: HttpsServer;
  sockets: Set<Socket>;
}
interface SshFixture {
  port: number;
  machineId: string;
  acceptedPassword: string;
  authenticationCount: number;
  commands: string[];
  initializationIntents: Record<string, unknown>[];
  failInitialization: boolean;
  holdPreflight: boolean;
  installedId: string | null;
  kube: KubeFixture | null;
}

let app: Awaited<ReturnType<typeof createApp>>;
let session: Awaited<ReturnType<typeof createTestSession>>;
let db: PrismaClient;
let repository: TaskRepository;
let cipher: SecretCipher;
let queue: InstanceType<typeof Queue>;
let redis: InstanceType<typeof Redis>;
let alpha: Pki;
let beta: Pki;
let sequence = 0;
const runtimes: TaskRuntime[] = [];
const fixtures: (() => Promise<void>)[] = [];
const processLogs: unknown[] = [];
const logger = {
  info(fields: Record<string, unknown>, message: string) {
    processLogs.push({ fields, message });
  },
  warn(fields: Record<string, unknown>, message: string) {
    processLogs.push({ fields, message });
  },
  error(fields: Record<string, unknown>, message: string) {
    processLogs.push({ fields, message });
  },
};
const unique = (label: string) => `s2-${label}-${++sequence}`;

function certificateAuthority(label: string): Pki {
  const file = (name: string) => join(directory, `${label}-${name}`);
  const openssl = (args: string[]) =>
    execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('ca.key'),
    '-out',
    file('ca.pem'),
    '-days',
    '2',
    '-subj',
    `/CN=ozz-s2-${label}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  const issue = (name: string, extensions: string) => {
    writeFileSync(file(`${name}.ext`), extensions, { mode: 0o600 });
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file(`${name}.key`),
      '-out',
      file(`${name}.csr`),
      '-subj',
      `/CN=ozz-s2-${name}`,
    ]);
    openssl([
      'x509',
      '-req',
      '-in',
      file(`${name}.csr`),
      '-CA',
      file('ca.pem'),
      '-CAkey',
      file('ca.key'),
      '-CAcreateserial',
      '-out',
      file(`${name}.pem`),
      '-days',
      '1',
      '-extfile',
      file(`${name}.ext`),
    ]);
    chmodSync(file(`${name}.key`), 0o600);
  };
  issue(
    'server',
    'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n',
  );
  issue('client', 'basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n');
  return {
    ca: readFileSync(file('ca.pem'), 'utf8'),
    cert: readFileSync(file('server.pem'), 'utf8'),
    key: readFileSync(file('server.key'), 'utf8'),
    clientCert: readFileSync(file('client.pem'), 'utf8'),
    clientKey: readFileSync(file('client.key'), 'utf8'),
  };
}

async function kubeFixture(material = alpha): Promise<KubeFixture> {
  const state = {
    endpoint: '',
    identity: randomUUID(),
    nodeUid: randomUUID(),
    nodeName: 'same-node',
    machineId: randomUUID().replaceAll('-', ''),
    acceptedToken: `synthetic-kube-token-${randomUUID()}`,
    apiAvailable: true,
    requests: [],
    material,
    sockets: new Set<Socket>(),
  } as unknown as KubeFixture;
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  state.server = createHttpsServer(
    {
      key: material.key,
      cert: material.cert,
      ca: material.ca,
      requestCert: true,
      rejectUnauthorized: false,
    },
    (request, response) => {
      request.resume();
      const path = new URL(request.url!, 'https://127.0.0.1').pathname;
      state.requests.push(path);
      if (!state.apiAvailable) {
        json(response, { kind: 'Status', message: 'synthetic-remote-secret' }, 503);
        return;
      }
      if (
        request.headers.authorization !== `Bearer ${state.acceptedToken}` &&
        !(request.socket as TLSSocket).authorized
      ) {
        json(response, { kind: 'Status', message: 'synthetic-remote-secret' }, 401);
        return;
      }
      if (path === '/version') json(response, { gitVersion: K3S_VERSION });
      else if (path === '/api/v1/namespaces/kube-system')
        json(response, {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: { name: 'kube-system', uid: state.identity },
        });
      else if (path === '/api/v1/nodes')
        json(response, {
          apiVersion: 'v1',
          kind: 'NodeList',
          metadata: { resourceVersion: '42' },
          items: [
            {
              metadata: { name: state.nodeName, uid: state.nodeUid, resourceVersion: '42' },
              status: {
                nodeInfo: {
                  architecture: 'arm64',
                  operatingSystem: 'linux',
                  osImage: 'Ubuntu 24.04',
                  machineID: state.machineId,
                  kubeletVersion: K3S_VERSION,
                },
                capacity: { cpu: '2', memory: '8Gi', 'ephemeral-storage': '20Gi', pods: '110' },
                allocatable: {
                  cpu: '1900m',
                  memory: '7Gi',
                  'ephemeral-storage': '18Gi',
                  pods: '110',
                },
                conditions: [
                  { type: 'Ready', status: 'True' },
                  { type: 'DiskPressure', status: 'False' },
                ],
              },
            },
          ],
        });
      else if (path === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews')
        json(
          response,
          {
            apiVersion: 'authorization.k8s.io/v1',
            kind: 'SelfSubjectAccessReview',
            status: { allowed: true },
          },
          201,
        );
      else if (path === '/apis/metrics.k8s.io/v1beta1/nodes')
        json(response, {
          apiVersion: 'metrics.k8s.io/v1beta1',
          kind: 'NodeMetricsList',
          items: [
            {
              metadata: { name: state.nodeName, uid: state.nodeUid },
              timestamp: new Date().toISOString(),
              window: '30s',
              usage: { cpu: '125000000n', memory: '128Mi' },
            },
          ],
        });
      else if (
        [
          '/apis/apps/v1/deployments',
          '/apis/apps/v1/statefulsets',
          '/apis/apps/v1/daemonsets',
          '/apis/batch/v1/jobs',
          '/apis/batch/v1/cronjobs',
          '/api/v1/pods',
        ].includes(path)
      )
        json(response, { kind: 'List', metadata: { resourceVersion: '42' }, items: [] });
      else json(response, { kind: 'Status', message: 'optional API unavailable' }, 404);
    },
  );
  state.server.on('connection', (socket: Socket) => {
    state.sockets.add(socket);
    socket.once('close', () => state.sockets.delete(socket));
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const address = state.server.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind.');
  state.endpoint = `https://127.0.0.1:${address.port}`;
  fixtures.push(async () => {
    for (const socket of state.sockets) socket.destroy();
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
  });
  return state;
}

function kubeconfig(target: KubeFixture, clientCertificate = false): string {
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': 'fixture',
    clusters: [
      {
        name: 'fixture',
        cluster: { server: target.endpoint, 'certificate-authority-data': b64(target.material.ca) },
      },
    ],
    contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } }],
    users: [
      {
        name: 'fixture',
        user: clientCertificate
          ? {
              'client-certificate-data': b64(target.material.clientCert),
              'client-key-data': b64(target.material.clientKey),
            }
          : { token: target.acceptedToken },
      },
    ],
  });
}

function sshObservation(target: SshFixture) {
  return {
    machineId: target.machineId,
    hostname: 'ozz-fixture-node',
    os: 'ubuntu',
    osVersion: '24.04',
    architecture: 'arm64',
    kernel: '6.8.0-fixture',
    init: 'systemd',
    cpuCount: 2,
    memoryBytes: 4 * 1024 ** 3,
    memoryAvailableBytes: 3 * 1024 ** 3,
    rootDiskBytes: 80 * 1024 ** 3,
    rootDiskAvailableBytes: 60 * 1024 ** 3,
    dataDiskBytes: 80 * 1024 ** 3,
    dataDiskAvailableBytes: 60 * 1024 ** 3,
    privileged: true,
    memoryCgroupAvailable: true,
    systemdAvailable: true,
    firewall: 'unknown',
    ports: [
      ...[22, 80, 443, 6443, 10250].map((port) => ({
        protocol: 'tcp',
        port,
        listening: port === 22,
      })),
      { protocol: 'udp', port: 8472, listening: false },
    ],
    k3s: {
      installed: target.installedId !== null,
      version: target.installedId ? K3S_VERSION : null,
      installationId: target.installedId,
      installationPhase: target.installedId ? 'ready' : null,
      secretsEncryption: target.installedId ? 'enabled' : 'unknown',
    },
    blockers: [],
    warnings: ['cloud_firewall_unknown'],
  };
}

async function sshFixture(): Promise<SshFixture> {
  const state: SshFixture = {
    port: 0,
    machineId: randomUUID().replaceAll('-', ''),
    acceptedPassword: `synthetic-ssh-password-${randomUUID()}`,
    authenticationCount: 0,
    commands: [],
    initializationIntents: [],
    failInitialization: false,
    holdPreflight: false,
    installedId: null,
    kube: null,
  };
  const connections = new Set<Connection>();
  const reply = (channel: ServerChannel, values: unknown[], code = 0) => {
    channel.write(values.map((value) => JSON.stringify(value)).join('\n') + '\n');
    channel.exit(code);
    channel.end();
  };
  const server = new SshServer({ hostKeys: [hostKey.private] }, (connection) => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', (context) => {
      state.authenticationCount++;
      if (
        context.method === 'password' &&
        context.username === 'ozz' &&
        context.password === state.acceptedPassword
      )
        context.accept();
      else context.reject(['password']);
    });
    connection.on('ready', () =>
      connection.on('session', (accept) => {
        const session = accept();
        session.on('exec', (accept, _reject, info) => {
          const channel = accept();
          channel.on('error', () => {});
          let uploaded = Buffer.alloc(0);
          let started = false;
          channel.on('data', (chunk: Buffer) => {
            if (started) return;
            uploaded = Buffer.concat([uploaded, chunk]);
            const newline = uploaded.indexOf(10);
            if (newline < 0) return;
            const size = Number(uploaded.subarray(0, newline).toString('ascii'));
            if (uploaded.length < newline + 1 + size) return;
            started = true;
            const script = uploaded.subarray(newline + 1, newline + 1 + size).toString('utf8');
            state.commands.push(info.command);
            const match = /\nINTENT = json\.loads\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)/.exec(
              script,
            );
            if (!match) {
              if (state.holdPreflight) return;
              reply(channel, [{ type: 'preflight', data: sshObservation(state) }]);
              return;
            }
            const intent = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8')) as Record<
              string,
              unknown
            >;
            state.initializationIntents.push(intent);
            if (state.failInitialization) {
              reply(channel, [{ type: 'error', code: 'SSH_NOT_READY' }], 1);
              return;
            }
            if (!state.kube) {
              reply(channel, [{ type: 'error', code: 'SSH_INSTALL_VERIFY_FAILED' }], 1);
              return;
            }
            const resumed = state.installedId !== null;
            state.installedId = intent.installationId as string;
            state.kube.nodeName = intent.nodeName as string;
            state.kube.machineId = state.machineId;
            reply(channel, [
              ...[
                'downloading',
                'installing',
                'starting',
                'waiting_ready',
                'verifying_encryption',
              ].map((stage) => ({ type: 'progress', stage })),
              { type: 'credential', kubeconfig: JSON.parse(kubeconfig(state.kube, true)) },
              {
                type: 'initialized',
                data: {
                  installationId: intent.installationId,
                  machineId: state.machineId,
                  architecture: 'arm64',
                  version: K3S_VERSION,
                  nodeName: intent.nodeName,
                  apiEndpoint: intent.apiEndpoint,
                  secretsEncryption: 'enabled',
                  resumed,
                },
              },
            ]);
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SSH fixture did not bind.');
  state.port = address.port;
  fixtures.push(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return state;
}

async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: Record<string, unknown>,
  key?: string,
) {
  return app.inject({
    method,
    url: `/api${path}`,
    headers: { ...session.headers, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function resource<T extends Resource>(path: string): Promise<T> {
  const response = await request('GET', path);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ data: T }>().data;
}

async function create<T extends Resource>(
  kind: 'servers' | 'clusters' | 'secrets' | 'projects',
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await request('POST', `/${kind}`, payload);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ data: T }>().data;
}

async function command(
  path: string,
  payload: Record<string, unknown>,
  key = randomUUID(),
): Promise<OperationView> {
  const response = await request('POST', path, payload, key);
  expect(response.statusCode, response.body).toBe(202);
  return response.json<{ data: OperationView }>().data;
}

async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${description}.`);
}

async function terminal(
  id: string,
  expected: 'succeeded' | 'failed' | 'cancelled' = 'succeeded',
): Promise<OperationView> {
  const result = await until(
    () => repository.get(id),
    (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
    'durable infrastructure task',
  );
  expect({ status: result.status, errorCode: result.errorCode }).toMatchObject({
    status: expected,
  });
  return result;
}

function startRuntime(): TaskRuntime {
  const executor = new InfrastructureExecutor(repository, cipher);
  const runtime = new TaskRuntime(repository, {
    redisUrl: baseRedisUrl!,
    queueName,
    logger,
    executor,
    relayIntervalMs: 25,
    recoveryIntervalMs: 100,
    heartbeatIntervalMs: 100,
  });
  runtimes.push(runtime);
  runtime.start();
  return runtime;
}

async function registerServer(
  target: SshFixture,
  password = target.acceptedPassword,
): Promise<ServerResource> {
  const secret = await create('secrets', {
    name: unique('ssh'),
    kind: 'ssh',
    payload: { password },
  });
  return create('servers', {
    name: unique('server'),
    host: '127.0.0.1',
    sshPort: target.port,
    sshUser: 'ozz',
    credentialRefId: secret.id,
  });
}

async function trustServer(server: ServerResource): Promise<ServerResource> {
  const discovered = await command(`/servers/${server.id}/discover-host-key`, {
    revision: server.revision,
  });
  await terminal(discovered.id);
  const current = await resource<ServerResource>(`/servers/${server.id}`);
  const response = await request('POST', `/servers/${server.id}/trust-host-key`, {
    revision: current.revision,
    discoveryOperationId: discovered.id,
    fingerprint: hostFingerprint,
    source: '测试 SSH 服务生成的独立主机公钥',
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ data: ServerResource }>().data;
}

async function preflightServer(server: ServerResource): Promise<ServerResource> {
  const current = await resource<ServerResource>(`/servers/${server.id}`);
  const operation = await command(`/servers/${server.id}/preflight`, {
    revision: current.revision,
  });
  await terminal(operation.id);
  return resource(`/servers/${server.id}`);
}

async function registerCluster(target: KubeFixture): Promise<ClusterResource> {
  const secret = await create('secrets', {
    name: unique('kubeconfig'),
    kind: 'kubeconfig',
    payload: { kubeconfig: kubeconfig(target) },
  });
  const name = unique('cluster');
  return create('clusters', {
    name,
    slug: name,
    apiEndpoint: target.endpoint,
    credentialRefId: secret.id,
  });
}

async function connectCluster(cluster: ClusterResource): Promise<ClusterResource> {
  const current = await resource<ClusterResource>(`/clusters/${cluster.id}`);
  await terminal(
    (await command(`/clusters/${cluster.id}/connect`, { revision: current.revision })).id,
  );
  return resource(`/clusters/${cluster.id}`);
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
    { env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, timeout: 25_000 },
  );
  process.env.DATABASE_URL = databaseUrl.toString();
  db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  await db.$connect();
  app = await createApp({ silent: true });
  session = await createTestSession(app, db);
  cipher = new SecretCipher(readMasterKeys(process.env.MASTER_KEY_FILE!));
  repository = new TaskRepository(db, {
    leaseMs: 2500,
    leaseRenewMs: 300,
    retryBaseMs: 100,
    retryMaxMs: 400,
    recoveryAfterMs: 300,
    heartbeatTtlMs: 1500,
  });
  redis = new Redis(baseRedisUrl!, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    commandTimeout: 2000,
  });
  redis.on('error', () => {});
  await redis.ping();
  queue = new Queue(queueName, { connection: redis });
  queue.on('error', () => {});
  await queue.waitUntilReady();
  alpha = certificateAuthority('alpha');
  beta = certificateAuthority('beta');
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const close of fixtures.splice(0).reverse()) await close();
  if (queue) await queue.obliterate({ force: true });
  if (db) {
    await db.outbox.deleteMany();
    await db.operation.deleteMany();
    await db.environment.deleteMany();
    await db.project.deleteMany();
    await db.node.deleteMany();
    await db.cluster.deleteMany();
    await db.server.deleteMany();
    await db.secretReference.deleteMany();
    await db.auditEvent.deleteMany();
    await db.workerHeartbeat.deleteMany();
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: false },
    });
  }
  processLogs.length = 0;
});

afterAll(async () => {
  try {
    await queue?.close();
    redis?.disconnect();
    await session?.cleanup();
    await app?.close();
    await db?.$disconnect();
  } finally {
    process.env.DATABASE_URL = baseDatabaseUrl;
    const cleanup = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
    try {
      await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('S2 infrastructure API admission and durable execution', () => {
  it('requires a session, CSRF, current revision and an idempotency key before admission', async () => {
    const target = await sshFixture();
    const server = await registerServer(target);
    const url = `/api/servers/${server.id}/discover-host-key`;
    expect(
      (await app.inject({ method: 'POST', url, payload: { revision: server.revision } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: {
            cookie: session.headers.cookie,
            origin: session.headers.origin,
            'idempotency-key': randomUUID(),
          },
          payload: { revision: server.revision },
        })
      ).statusCode,
    ).toBe(403);
    expect((await request('POST', url.slice(4), {}, randomUUID())).statusCode).toBe(422);
    expect(
      (await request('POST', url.slice(4), { revision: server.revision + 1 }, randomUUID()))
        .statusCode,
    ).toBe(409);
    expect((await request('POST', url.slice(4), { revision: server.revision })).statusCode).toBe(
      422,
    );
    expect(
      (
        await request(
          'POST',
          url.slice(4),
          { revision: server.revision, command: 'never-execute' },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(422);
    expect(await db.operation.count()).toBe(0);
    expect(target.authenticationCount).toBe(0);
  });

  it('discovers without authentication and requires independent trust before real SSH preflight', async () => {
    const target = await sshFixture();
    const server = await registerServer(target);
    expect(
      (
        await request(
          'POST',
          `/servers/${server.id}/preflight`,
          { revision: server.revision },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(409);
    startRuntime();
    const discovered = await command(`/servers/${server.id}/discover-host-key`, {
      revision: server.revision,
    });
    await terminal(discovered.id);
    let current = await resource<ServerResource>(`/servers/${server.id}`);
    expect(target.authenticationCount).toBe(0);
    expect(target.commands).toHaveLength(0);
    expect(current.hostKey).toMatchObject({
      observedFingerprint: hostFingerprint,
      trustedFingerprint: null,
      discoveryOperationId: discovered.id,
    });
    expect(
      (
        await request('POST', `/servers/${server.id}/trust-host-key`, {
          revision: current.revision,
          discoveryOperationId: discovered.id,
          fingerprint: hostFingerprint,
          source: '',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await request('POST', `/servers/${server.id}/trust-host-key`, {
          revision: current.revision,
          discoveryOperationId: discovered.id,
          fingerprint: 'SHA256:' + 'a'.repeat(43),
          source: '测试独立主机公钥',
        })
      ).statusCode,
    ).toBe(409);
    const trusted = await request('POST', `/servers/${server.id}/trust-host-key`, {
      revision: current.revision,
      discoveryOperationId: discovered.id,
      fingerprint: hostFingerprint,
      source: '测试 SSH 服务生成的独立主机公钥',
    });
    expect(trusted.statusCode, trusted.body).toBe(200);
    current = await preflightServer(trusted.json<{ data: ServerResource }>().data);
    expect(current).toMatchObject({
      connectionStatus: 'connected',
      machineId: target.machineId,
      preflight: { machineId: target.machineId, blockers: [] },
      hostKey: { trustedFingerprint: hostFingerprint },
    });
    expect(target.authenticationCount).toBeGreaterThan(0);
    expect(
      await db.auditEvent.count({
        where: { action: 'server.trust_host_key', resourceId: server.id },
      }),
    ).toBe(1);
  });

  it('admits one concurrent discovery and rejects another operation or a changed request', async () => {
    const target = await sshFixture();
    const server = await registerServer(target);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(
          'POST',
          `/servers/${server.id}/discover-host-key`,
          { revision: server.revision },
          key,
        ),
      ),
    );
    for (const response of responses) expect(response.statusCode, response.body).toBe(202);
    const ids = responses.map((response) => response.json<{ data: OperationView }>().data.id);
    expect(new Set(ids).size).toBe(1);
    expect(await db.operation.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'operation.create' } })).toBe(1);
    expect(
      (
        await request(
          'POST',
          `/servers/${server.id}/discover-host-key`,
          { revision: server.revision + 1 },
          key,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(
          'POST',
          `/servers/${server.id}/discover-host-key`,
          { revision: server.revision },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(409);
    startRuntime();
    await terminal(ids[0]!);
    const replay = await command(
      `/servers/${server.id}/discover-host-key`,
      { revision: server.revision },
      key,
    );
    expect(replay.id).toBe(ids[0]);
    expect(await db.operation.count()).toBe(1);
  });

  it('blocks target edits and deletion while queued, then permits removal of a terminal registration', async () => {
    const target = await sshFixture();
    const server = await registerServer(target);
    const pending = await command(`/servers/${server.id}/discover-host-key`, {
      revision: server.revision,
    });
    expect(
      (
        await request('PATCH', `/servers/${server.id}`, {
          revision: server.revision,
          sshPort: target.port + 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('DELETE', `/servers/${server.id}?revision=${server.revision}`)).statusCode,
    ).toBe(409);
    const cancellation = await request('POST', `/operations/${pending.id}/cancel`);
    expect(cancellation.statusCode, cancellation.body).toBe(202);
    startRuntime();
    await terminal(pending.id, 'cancelled');
    const current = await resource<ServerResource>(`/servers/${server.id}`);
    expect(
      (await request('DELETE', `/servers/${server.id}?revision=${current.revision}`)).statusCode,
    ).toBe(204);
    expect((await repository.get(pending.id)).serverId).toBeNull();
    expect(target.commands).toHaveLength(0);
  });

  it('keeps a running SSH task isolated from target edits and records acknowledged cancellation', async () => {
    const target = await sshFixture();
    startRuntime();
    const server = await trustServer(await registerServer(target));
    target.holdPreflight = true;
    const operation = await command(`/servers/${server.id}/preflight`, {
      revision: server.revision,
    });
    await until(
      () => repository.get(operation.id),
      (value) => value.status === 'running',
      'running SSH task',
    );
    await until(
      async () => target.commands.length,
      (value) => value > 0,
      'SSH command to begin',
    );
    const current = await resource<ServerResource>(`/servers/${server.id}`);
    expect(
      (
        await request('PATCH', `/servers/${server.id}`, {
          revision: current.revision,
          sshPort: target.port + 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('DELETE', `/servers/${server.id}?revision=${current.revision}`)).statusCode,
    ).toBe(409);
    expect((await request('POST', `/operations/${operation.id}/cancel`)).statusCode).toBe(202);
    await terminal(operation.id, 'cancelled');
    const cancelledServer = await resource<ServerResource>(`/servers/${server.id}`);
    expect(cancelledServer.machineId).toBeNull();
    expect(cancelledServer.preflight).toBeNull();
    expect(cancelledServer.hostKey.trustedFingerprint).toBe(hostFingerprint);
  });

  it('does not reuse another server discovery or an expired observation as trusted identity', async () => {
    const target = await sshFixture();
    const first = await registerServer(target);
    const second = await registerServer(target);
    startRuntime();
    const discovered = await command(`/servers/${first.id}/discover-host-key`, {
      revision: first.revision,
    });
    await terminal(discovered.id);
    const payload = {
      discoveryOperationId: discovered.id,
      fingerprint: hostFingerprint,
      source: '测试 SSH 服务独立主机公钥',
    };
    expect(
      (
        await request('POST', `/servers/${second.id}/trust-host-key`, {
          ...payload,
          revision: second.revision,
        })
      ).statusCode,
    ).toBe(409);
    await db.server.update({
      where: { id: first.id },
      data: { observedHostKeyAt: new Date(Date.now() - 16 * 60_000) },
    });
    const current = await resource<ServerResource>(`/servers/${first.id}`);
    expect(
      (
        await request('POST', `/servers/${first.id}/trust-host-key`, {
          ...payload,
          revision: current.revision,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await resource<ServerResource>(`/servers/${first.id}`)).hostKey.trustedFingerprint,
    ).toBeNull();
    expect(
      (await resource<ServerResource>(`/servers/${second.id}`)).hostKey.trustedFingerprint,
    ).toBeNull();
    expect(target.authenticationCount).toBe(0);
  });

  it('parses connection previews without network requests and rejects implicit kubeconfig execution', async () => {
    const target = await kubeFixture();
    const cluster = await registerCluster(target);
    const preview = await request('POST', `/clusters/${cluster.id}/connection-preview`, {
      revision: cluster.revision,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      data: {
        apiEndpoint: target.endpoint,
        currentCaFingerprint: null,
        requiresCaConfirmation: false,
      },
    });
    expect(preview.body).not.toContain(target.acceptedToken);
    expect(target.requests).toHaveLength(0);
    const malicious = JSON.parse(kubeconfig(target));
    malicious.users[0].user.exec = { command: 'never-execute' };
    const candidate = await create('secrets', {
      name: unique('invalid-kubeconfig'),
      kind: 'kubeconfig',
      payload: { kubeconfig: JSON.stringify(malicious) },
    });
    const refused = await request('POST', `/clusters/${cluster.id}/connection-preview`, {
      revision: cluster.revision,
      credentialRefId: candidate.id,
    });
    expect(refused.statusCode).toBe(422);
    expect(target.requests).toHaveLength(0);
    expect(await db.operation.count()).toBe(0);
  });

  it('protects a cluster and its candidate credential for an active connection operation', async () => {
    const target = await kubeFixture();
    const cluster = await registerCluster(target);
    const candidate = await create('secrets', {
      name: unique('candidate'),
      kind: 'kubeconfig',
      payload: { kubeconfig: kubeconfig(target) },
    });
    const connection = await command(`/clusters/${cluster.id}/connect`, {
      revision: cluster.revision,
      credentialRefId: candidate.id,
    });
    expect(
      (
        await request('PATCH', `/clusters/${cluster.id}`, {
          revision: cluster.revision,
          apiEndpoint: 'https://127.0.0.1:65530',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('DELETE', `/clusters/${cluster.id}?revision=${cluster.revision}`)).statusCode,
    ).toBe(409);
    expect((await request('DELETE', `/secrets/${candidate.id}?revision=1`)).statusCode).toBe(409);
    expect(
      (
        await request(
          'POST',
          `/clusters/${cluster.id}/connect`,
          { revision: cluster.revision },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(409);
    startRuntime();
    await terminal(connection.id);
    const current = await resource<ClusterResource>(`/clusters/${cluster.id}`);
    expect(current.identity?.kubeSystemUid).toBe(target.identity);
    expect(current.connectionStatus).toBe('connected');
    expect(current.nodeCount).toBe(1);
  });

  it('rotates SSH authentication and retries the same trusted machine without changing its intent', async () => {
    const target = await sshFixture();
    startRuntime();
    let server = await preflightServer(await trustServer(await registerServer(target)));
    const wrong = await create('secrets', {
      name: unique('wrong-ssh'),
      kind: 'ssh',
      payload: { password: 'synthetic-invalid-password' },
    });
    const changed = await request('PATCH', `/servers/${server.id}`, {
      revision: server.revision,
      credentialRefId: wrong.id,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    server = changed.json<{ data: ServerResource }>().data;
    expect(server).toMatchObject({
      machineId: target.machineId,
      hostKey: { trustedFingerprint: hostFingerprint },
    });
    const failed = await command(`/servers/${server.id}/preflight`, { revision: server.revision });
    await terminal(failed.id, 'failed');
    const replacement = await create('secrets', {
      name: unique('replacement-ssh'),
      kind: 'ssh',
      payload: { password: target.acceptedPassword },
    });
    server = await resource<ServerResource>(`/servers/${server.id}`);
    const replaced = await request('PATCH', `/servers/${server.id}`, {
      revision: server.revision,
      credentialRefId: replacement.id,
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const retried = await request(
      'POST',
      `/operations/${failed.id}/retry`,
      undefined,
      randomUUID(),
    );
    expect(retried.statusCode, retried.body).toBe(202);
    const retry = retried.json<{ data: OperationView }>().data;
    expect(retry.input).toEqual(failed.input);
    expect(retry.retryOfId).toBe(failed.id);
    await terminal(retry.id);
    server = await resource<ServerResource>(`/servers/${server.id}`);
    expect(server).toMatchObject({
      machineId: target.machineId,
      credentialRefId: replacement.id,
      connectionStatus: 'connected',
      hostKey: { trustedFingerprint: hostFingerprint },
    });
  });

  it('keeps the effective cluster credential and project target when a candidate fails identity checks', async () => {
    const target = await kubeFixture();
    startRuntime();
    let cluster = await connectCluster(await registerCluster(target));
    const project = await create('projects', {
      name: unique('owned-project'),
      slug: unique('owned-project'),
      clusterId: cluster.id,
    });
    const originalCredential = cluster.credentialRefId;
    const originalIdentity = cluster.identity;
    const unauthorizedConfig = JSON.parse(kubeconfig(target));
    unauthorizedConfig.users[0].user.token = 'synthetic-invalid-token';
    const unauthorized = await create('secrets', {
      name: unique('unauthorized'),
      kind: 'kubeconfig',
      payload: { kubeconfig: JSON.stringify(unauthorizedConfig) },
    });
    await terminal(
      (
        await command(`/clusters/${cluster.id}/connect`, {
          revision: cluster.revision,
          credentialRefId: unauthorized.id,
        })
      ).id,
      'failed',
    );
    cluster = await resource<ClusterResource>(`/clusters/${cluster.id}`);
    expect(cluster.credentialRefId).toBe(originalCredential);
    expect(cluster.identity).toEqual(originalIdentity);

    const wrongCluster = await kubeFixture();
    const wrongIdentityCredential = await create('secrets', {
      name: unique('different-identity'),
      kind: 'kubeconfig',
      payload: { kubeconfig: kubeconfig(wrongCluster) },
    });
    await terminal(
      (
        await command(`/clusters/${cluster.id}/connect`, {
          revision: cluster.revision,
          credentialRefId: wrongIdentityCredential.id,
          apiEndpoint: wrongCluster.endpoint,
        })
      ).id,
      'failed',
    );
    cluster = await resource<ClusterResource>(`/clusters/${cluster.id}`);
    expect(cluster.credentialRefId).toBe(originalCredential);
    expect(cluster.apiEndpoint).toBe(target.endpoint);
    expect(cluster.identity).toEqual(originalIdentity);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).clusterId).toBe(
      cluster.id,
    );

    target.acceptedToken = `synthetic-rotated-token-${randomUUID()}`;
    const replacement = await create('secrets', {
      name: unique('valid-rotation'),
      kind: 'kubeconfig',
      payload: { kubeconfig: kubeconfig(target) },
    });
    await terminal(
      (
        await command(`/clusters/${cluster.id}/connect`, {
          revision: cluster.revision,
          credentialRefId: replacement.id,
        })
      ).id,
    );
    cluster = await resource<ClusterResource>(`/clusters/${cluster.id}`);
    expect(cluster).toMatchObject({
      credentialRefId: replacement.id,
      connectionStatus: 'connected',
      identity: originalIdentity,
    });
    expect(await db.node.count({ where: { clusterId: cluster.id } })).toBe(1);
    expect(
      (await request('DELETE', `/clusters/${cluster.id}?revision=${cluster.revision}`)).statusCode,
    ).toBe(409);
  });

  it('requires the exact candidate CA confirmation and still preserves Kubernetes identity', async () => {
    const target = await kubeFixture(alpha);
    startRuntime();
    let cluster = await connectCluster(await registerCluster(target));
    const rotated = await kubeFixture(beta);
    rotated.identity = target.identity;
    rotated.nodeUid = target.nodeUid;
    rotated.machineId = target.machineId;
    const credential = await create('secrets', {
      name: unique('ca-rotation'),
      kind: 'kubeconfig',
      payload: { kubeconfig: kubeconfig(rotated) },
    });
    const input = {
      revision: cluster.revision,
      credentialRefId: credential.id,
      apiEndpoint: rotated.endpoint,
    };
    const preview = await request('POST', `/clusters/${cluster.id}/connection-preview`, input);
    expect(preview.statusCode, preview.body).toBe(200);
    const data = preview.json<{
      data: {
        caFingerprint: string;
        currentCaFingerprint: string;
        requiresCaConfirmation: boolean;
      };
    }>().data;
    expect(data.requiresCaConfirmation).toBe(true);
    expect(data.currentCaFingerprint).toBe(cluster.identity?.caFingerprint);
    expect(data.caFingerprint).not.toBe(data.currentCaFingerprint);
    expect(rotated.requests).toHaveLength(0);
    expect(
      (await request('POST', `/clusters/${cluster.id}/connect`, input, randomUUID())).statusCode,
    ).toBe(409);
    expect(
      (
        await request(
          'POST',
          `/clusters/${cluster.id}/connect`,
          { ...input, acceptedCaFingerprint: data.currentCaFingerprint },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(409);
    await terminal(
      (
        await command(`/clusters/${cluster.id}/connect`, {
          ...input,
          acceptedCaFingerprint: data.caFingerprint,
        })
      ).id,
    );
    cluster = await resource<ClusterResource>(`/clusters/${cluster.id}`);
    expect(cluster).toMatchObject({
      apiEndpoint: rotated.endpoint,
      credentialRefId: credential.id,
      identity: { kubeSystemUid: target.identity, caFingerprint: data.caFingerprint },
    });
    expect(await db.node.count({ where: { clusterId: cluster.id } })).toBe(1);
  });

  it('isolates same-name nodes and preserves the last observation during one cluster outage', async () => {
    const firstApi = await kubeFixture();
    const secondApi = await kubeFixture();
    startRuntime();
    const first = await connectCluster(await registerCluster(firstApi));
    const second = await connectCluster(await registerCluster(secondApi));
    const nodes = async (id: string) => {
      const response = await request('GET', `/clusters/${id}/nodes`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ data: NodeResource[] }>().data;
    };
    const [firstNodes, secondNodes] = await Promise.all([nodes(first.id), nodes(second.id)]);
    expect(firstNodes).toHaveLength(1);
    expect(secondNodes).toHaveLength(1);
    expect(firstNodes[0]).toMatchObject({
      name: 'same-node',
      uid: firstApi.nodeUid,
      clusterId: first.id,
      serverId: null,
    });
    expect(secondNodes[0]).toMatchObject({
      name: 'same-node',
      uid: secondApi.nodeUid,
      clusterId: second.id,
      serverId: null,
    });
    expect(firstNodes[0]!.id).not.toBe(secondNodes[0]!.id);
    const observedAt = first.lastObservedAt;
    firstApi.apiAvailable = false;
    await terminal(
      (await command(`/clusters/${first.id}/sync`, { revision: first.revision })).id,
      'failed',
    );
    const unavailable = await resource<ClusterResource>(`/clusters/${first.id}`);
    expect(unavailable.lastObservedAt).toBe(observedAt);
    expect(unavailable.connectionStatus).toBe('unreachable');
    expect(unavailable.identity?.kubeSystemUid).toBe(firstApi.identity);
    await terminal(
      (await command(`/clusters/${second.id}/sync`, { revision: second.revision })).id,
    );
    expect((await resource<ClusterResource>(`/clusters/${second.id}`)).connectionStatus).toBe(
      'connected',
    );
    expect((await nodes(first.id))[0]!.id).toBe(firstNodes[0]!.id);
    expect((await nodes(second.id))[0]!.id).toBe(secondNodes[0]!.id);
  });

  it('retries a fixed initialization intent and stores bootstrap credentials only in encrypted storage', async () => {
    // The SSH fixture exercises the complete protocol, API and Worker; actual Linux installation
    // is separately accepted through VM C. No fixture executes an installation script locally.
    const target = await sshFixture();
    const api = await kubeFixture();
    target.kube = api;
    target.failInitialization = true;
    startRuntime();
    let server = await preflightServer(await trustServer(await registerServer(target)));
    const name = unique('bootstrap');
    const cluster = await create<ClusterResource>('clusters', { name, slug: name });
    const input = {
      revision: server.revision,
      clusterId: cluster.id,
      nodeName: 'ozz-product-node',
      apiEndpoint: api.endpoint,
    };
    const operation = await command(`/servers/${server.id}/initialize`, input);
    const immutable = operation.input as InfrastructureInput;
    expect(immutable).toMatchObject({
      targetId: server.id,
      host: '127.0.0.1',
      port: target.port,
      expectedMachineId: target.machineId,
      clusterId: cluster.id,
      nodeName: input.nodeName,
      apiEndpoint: input.apiEndpoint,
    });
    expect(immutable.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(immutable.bootstrapCredentialRefId).toMatch(/^[0-9a-f-]{36}$/);
    await terminal(operation.id, 'failed');
    server = await resource<ServerResource>(`/servers/${server.id}`);
    const refused = await request(
      'POST',
      `/servers/${server.id}/initialize`,
      { ...input, revision: server.revision, nodeName: 'different-node' },
      randomUUID(),
    );
    expect(refused.statusCode, refused.body).toBe(409);
    target.failInitialization = false;
    const retried = await request(
      'POST',
      `/operations/${operation.id}/retry`,
      undefined,
      randomUUID(),
    );
    expect(retried.statusCode, retried.body).toBe(202);
    const retry = retried.json<{ data: OperationView }>().data;
    expect(retry.input).toEqual(operation.input);
    expect(retry.retryOfId).toBe(operation.id);
    await terminal(retry.id);
    expect(new Set(target.initializationIntents.map((intent) => intent.installationId)).size).toBe(
      1,
    );
    expect(new Set(target.initializationIntents.map((intent) => intent.apiEndpoint)).size).toBe(1);
    const connected = await resource<ClusterResource>(`/clusters/${cluster.id}`);
    expect(connected).toMatchObject({
      connectionStatus: 'connected',
      identity: { kubeSystemUid: api.identity },
      credentialRefId: immutable.bootstrapCredentialRefId,
      nodeCount: 1,
    });
    const linked = await request('GET', `/servers/${server.id}/nodes`);
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json<{ data: NodeResource[] }>().data).toMatchObject([
      { clusterId: cluster.id, serverId: server.id, uid: api.nodeUid },
    ]);
    const encrypted = await db.secretReference.findUniqueOrThrow({
      where: { id: immutable.bootstrapCredentialRefId },
    });
    expect(encrypted.kind).toBe('kubeconfig');
    const plaintext = cipher.decrypt(encrypted);
    expect(typeof plaintext.kubeconfig).toBe('string');
    const decoded = JSON.parse(plaintext.kubeconfig as string);
    expect(decoded.clusters[0].cluster.server).toBe(api.endpoint);
    const publicValues: unknown[] = [
      await db.operation.findMany(),
      await db.auditEvent.findMany(),
      processLogs,
      connected,
    ];
    for (const row of await db.operation.findMany())
      publicValues.push((await request('GET', `/operations/${row.id}/logs`)).json());
    publicValues.push(
      await queue
        .getJobs(['waiting', 'active', 'completed', 'failed'])
        .then((jobs) => jobs.map((job) => job.data)),
    );
    const serialized = JSON.stringify(publicValues);
    for (const secret of [
      target.acceptedPassword,
      api.acceptedToken,
      api.material.clientKey,
      Buffer.from(api.material.clientKey).toString('base64'),
    ])
      expect(serialized.includes(secret)).toBe(false);
    expect(serialized.includes('BEGIN PRIVATE KEY')).toBe(false);
    expect(
      Buffer.from(encrypted.encryptedPayload).includes(Buffer.from(api.material.clientKey)),
    ).toBe(false);
    expect(await db.cluster.count()).toBe(1);
    expect(await db.node.count()).toBe(1);
    expect(await db.secretReference.count({ where: { kind: 'kubeconfig' } })).toBe(1);

    const currentServer = await resource<ServerResource>(`/servers/${server.id}`);
    const repeated = await command(`/servers/${server.id}/initialize`, {
      ...input,
      revision: currentServer.revision,
    });
    expect((repeated.input as InfrastructureInput).installationId).toBe(immutable.installationId);
    await terminal(repeated.id);
    expect(await db.cluster.count()).toBe(1);
    expect(await db.node.count()).toBe(1);
    expect(await db.secretReference.count({ where: { kind: 'kubeconfig' } })).toBe(1);
  });
});
