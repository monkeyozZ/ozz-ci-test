import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PodLogSource } from '../../packages/infrastructure/src/kubernetes/logs.js';
import type { WorkloadObservation } from '../../packages/infrastructure/src/workload/contracts.js';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';
import type { ServiceSnapshot } from '../../packages/control-plane/src/services/contracts.js';
import {
  ServiceLogReader,
  type ServiceLogEvent,
  type ServiceLogInput,
  type ServiceLogSession,
} from '../../packages/control-plane/src/services/logs.js';
import { validateServiceConfiguration } from '../../packages/control-plane/src/services/validation.js';
import type { TaskRepository } from '../../packages/control-plane/src/tasks/repository.js';

// These tests exercise the reader, real target selection and real secret decryption.
// TLS and Kubernetes ownership inspection are covered by the infrastructure tests.
// Only connection material resolution is replaced; no live database or cluster is used.
vi.mock('../../packages/control-plane/src/services/persistence.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../packages/control-plane/src/services/persistence.js')
    >();
  const kubeAccess: typeof actual.kubeAccess = async (_tx, _cipher, cluster, target) => ({
    connection: {
      endpoint: cluster.apiEndpoint!,
      caFingerprint: cluster.caFingerprint!,
      credential: {
        authentication: 'token',
        clientCertificate: null,
        caCertificates: [],
        expiresAt: null,
        expirationSource: 'unknown',
        notBefore: null,
      },
    },
    target: { ...target, caFingerprint: cluster.caFingerprint! },
  });
  return { ...actual, kubeAccess };
});

const marker = '日志-synthetic-runtime-secret.[literal]$';
const readers: ServiceLogReader[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const ids = {
    user: randomUUID(),
    otherUser: randomUUID(),
    session: randomUUID(),
    secondSession: randomUUID(),
    otherSession: randomUUID(),
    service: randomUUID(),
    environment: randomUUID(),
    project: randomUUID(),
    cluster: randomUUID(),
    installation: randomUUID(),
    credential: randomUUID(),
    secret: randomUUID(),
    snapshot: randomUUID(),
    pod: randomUUID(),
    replicaSet: randomUUID(),
  };
  const principal = { userId: ids.user, sessionId: ids.session };
  const sessions = new Map<
    string,
    { id: string; adminId: string; revokedAt: Date | null; expiresAt: Date }
  >(
    [
      [ids.session, ids.user],
      [ids.secondSession, ids.user],
      [ids.otherSession, ids.otherUser],
    ].map(([id, adminId]) => [
      id!,
      {
        id: id!,
        adminId: adminId!,
        revokedAt: null as Date | null,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    ]),
  );
  const state = { installationId: ids.installation, generation: 1 };
  const cluster = {
    id: ids.cluster,
    connectionRevision: 1,
    credentialRefId: ids.credential,
    kubeSystemUid: randomUUID(),
    caFingerprint: 'SHA256:synthetic-fixture-ca',
    apiEndpoint: 'https://127.0.0.1:6443',
  };
  const service = {
    id: ids.service,
    environmentId: ids.environment,
    environment: {
      id: ids.environment,
      projectId: ids.project,
      project: { id: ids.project, cluster },
    },
  };
  const cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, Buffer.alloc(32, 7)]]) });
  const secret = {
    id: ids.secret,
    kind: 'generic',
    revision: 1,
    contentRevision: 1,
    expiresAt: null as Date | null,
    ...cipher.encrypt('generic', { value: marker }),
  };
  const credential = {
    id: ids.credential,
    kind: 'kubeconfig',
    revision: 1,
    contentRevision: 1,
    expiresAt: null as Date | null,
    ...cipher.encrypt('kubeconfig', { kubeconfig: 'synthetic-placeholder-not-parsed' }),
  };
  const secrets = new Map<string, typeof secret>([
    [secret.id, secret],
    [credential.id, credential],
  ]);
  const snapshot: ServiceSnapshot = {
    version: 1,
    serviceId: ids.service,
    serviceName: 'Logs fixture',
    serviceSlug: 'logs-fixture',
    configRevision: 1,
    configuration: validateServiceConfiguration({
      image: 'nginx:alpine',
      environment: [{ name: 'TOKEN', secretRefId: ids.secret }],
    }),
    deployAndStart: false,
    allowConfigurationRepair: false,
  };
  const deployments = new Map<
    string,
    { id: string; serviceId: string; snapshotJson: ServiceSnapshot }
  >([[ids.snapshot, { id: ids.snapshot, serviceId: ids.service, snapshotJson: snapshot }]]);
  const db = {
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)),
    session: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        structuredClone(sessions.get(where.id) ?? null),
      ),
    },
    service: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === service.id ? structuredClone(service) : null,
      ),
    },
    controlPlaneState: {
      findUnique: vi.fn(async () => structuredClone(state)),
      findUniqueOrThrow: vi.fn(async () => structuredClone(state)),
    },
    operation: { count: vi.fn(async () => 0) },
    managedResource: { findMany: vi.fn(async () => []) },
    secretReference: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        structuredClone(secrets.get(where.id) ?? null),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const value = secrets.get(where.id);
        if (!value) throw new Error('Missing synthetic credential');
        return structuredClone(value);
      }),
    },
    deployment: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; serviceId: string } }) => {
        const value = deployments.get(where.id);
        return value?.serviceId === where.serviceId ? structuredClone(value) : null;
      }),
    },
  };
  const pod = {
    uid: ids.pod,
    name: 'fixture-pod',
    namespace: `ozz-e-${ids.environment.replaceAll('-', '')}`,
    snapshotId: ids.snapshot as string | null,
    replicaSetUid: ids.replicaSet as string | null,
    owner: undefined as WorkloadObservation['pods'][number]['owner'],
    containers: [{ name: 'app' }],
  };
  const workloads = {
    observe: vi.fn(async () => ({ pods: [structuredClone(pod)] }) as WorkloadObservation),
  };
  const sources: {
    stream: PassThrough;
    close: ReturnType<typeof vi.fn>;
    signal: AbortSignal;
  }[] = [];
  const upstream = {
    open: vi.fn<NonNullable<ConstructorParameters<typeof ServiceLogReader>[3]>['open']>(
      async (_connection, _selection, options) => {
        const stream = new PassThrough();
        const close = vi.fn(() => stream.destroy());
        stream.on('error', () => {});
        sources.push({ stream, close, signal: options.signal });
        return { stream: stream as unknown as IncomingMessage, close } satisfies PodLogSource;
      },
    ),
  };
  const reader = new ServiceLogReader(
    { db } as unknown as TaskRepository,
    cipher,
    workloads,
    upstream,
  );
  readers.push(reader);
  const open = (
    options: {
      input?: Partial<ServiceLogInput>;
      principal?: typeof principal;
      signal?: AbortSignal;
    } = {},
  ) =>
    reader.open(
      ids.service,
      {
        podUid: ids.pod,
        container: 'app',
        previous: false,
        follow: true,
        tailLines: 200,
        ...options.input,
      },
      options.principal ?? principal,
      options.signal ?? new AbortController().signal,
    );
  return {
    ids,
    principal,
    sessions,
    state,
    cluster,
    service,
    snapshot,
    cipher,
    deployments,
    credential,
    secrets,
    db,
    pod,
    workloads,
    sources,
    upstream,
    reader,
    open,
  };
}

async function collect(session: ServiceLogSession): Promise<ServiceLogEvent[]> {
  const events: ServiceLogEvent[] = [];
  for await (const event of session.events) events.push(event);
  return events;
}

function logText(events: ServiceLogEvent[]) {
  return events.flatMap((event) => (event.type === 'log' ? [event.data.text] : [])).join('');
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
});

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  vi.useRealTimers();
});

describe('bounded service log reader', () => {
  it('decodes split UTF-8, redacts split secrets, emits eof and releases resources', async () => {
    const f = fixture();
    const session = await f.open();
    const pending = collect(session);
    const raw = Buffer.from(`before ${marker} after 日志\n`, 'utf8');
    for (const byte of raw) {
      f.sources[0]!.stream.write(Buffer.from([byte]));
      await nextTurn();
    }
    f.sources[0]!.stream.end();
    const events = await pending;
    expect(logText(events)).toBe('before [REDACTED] after 日志\n');
    expect(events.at(-1)).toMatchObject({ type: 'end', data: { reason: 'eof' } });
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(f.upstream.open.mock.calls[0]![1]).toEqual({
      namespace: f.pod.namespace,
      name: f.pod.name,
      uid: f.ids.pod,
      owner: { kind: 'ReplicaSet', uid: f.ids.replicaSet },
      container: 'app',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the StatefulSet owner and redacts complete database connection URLs from a v2 snapshot', async () => {
    const f = fixture();
    const databaseSecretId = randomUUID();
    const password = 'SYNTHETIC-db-password:@/with-specials';
    f.secrets.set(databaseSecretId, {
      id: databaseSecretId,
      kind: 'database',
      revision: 1,
      contentRevision: 1,
      expiresAt: new Date('2026-10-20T00:00:00Z'),
      ...f.cipher.encrypt('database', { password }),
    });
    const snapshot: ServiceSnapshot = {
      ...f.snapshot,
      version: 2,
      controller: { kind: 'StatefulSet', strategy: 'RollingUpdate' },
      volumes: [],
      database: null,
      template: null,
      databaseBindings: [
        {
          version: 1,
          bindingId: randomUUID(),
          databaseInstanceId: randomUUID(),
          providerServiceId: randomUUID(),
          providerDeploymentId: randomUUID(),
          providerServiceUid: randomUUID(),
          clusterId: f.ids.cluster,
          environmentId: f.ids.environment,
          namespace: f.pod.namespace,
          host: 'database.svc.cluster.local',
          port: 5432,
          engine: 'postgresql',
          databaseName: 'app',
          redisDatabase: null,
          username: 'app',
          credentialRefId: databaseSecretId,
          credentialContentRevision: 1,
          profile: 'url',
          mapping: { url: 'DATABASE_URL' },
        },
      ],
    };
    f.deployments.get(f.ids.snapshot)!.snapshotJson = snapshot;
    f.pod.replicaSetUid = null;
    f.pod.owner = { kind: 'StatefulSet', uid: randomUUID() };
    const session = await f.open();
    const pending = collect(session);
    const uri = `postgresql://app:${encodeURIComponent(password)}@database.svc.cluster.local:5432/app`;
    const raw = Buffer.from(
      `url=${uri}\npassword=${password}\nencoded=${encodeURIComponent(password)}\n`,
    );
    for (let offset = 0; offset < raw.length; offset += 7)
      f.sources[0]!.stream.write(raw.subarray(offset, offset + 7));
    f.sources[0]!.stream.end();
    expect(logText(await pending)).toBe(
      'url=[REDACTED]\npassword=[REDACTED]\nencoded=[REDACTED]\n',
    );
    expect(f.upstream.open.mock.calls[0]![1]).toMatchObject({ owner: f.pod.owner });
    expect(f.upstream.open.mock.calls[0]![1]).not.toHaveProperty('replicaSetUid');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a Pod without a verified parent before opening any log source', async () => {
    const f = fixture();
    f.pod.replicaSetUid = null;
    await expect(f.open()).rejects.toMatchObject({ code: 'POD_LOGS_TARGET_CHANGED' });
    expect(f.upstream.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cuts an oversized upstream chunk at 1 MiB and emits byte_limit', async () => {
    const f = fixture();
    f.snapshot.configuration.environment = [];
    const session = await f.open();
    const pending = collect(session);
    f.sources[0]!.stream.end(Buffer.alloc(1024 * 1024 + 4096, 120));
    const events = await pending;
    expect(Buffer.byteLength(logText(events), 'utf8')).toBeGreaterThan(1000 * 1024);
    expect(Buffer.byteLength(logText(events), 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    expect(events.at(-1)).toMatchObject({ type: 'end', data: { reason: 'byte_limit' } });
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['redaction', 'json-escaping'] as const)(
    'bounds encoded SSE when %s expands the source',
    async (mode) => {
      const f = fixture();
      if (mode === 'redaction')
        Object.assign(f.secrets.get(f.ids.secret)!, f.cipher.encrypt('generic', { value: 'x' }));
      const pending = collect(await f.open());
      f.sources[0]!.stream.end(Buffer.alloc(1024 * 1024, mode === 'redaction' ? 120 : 0));
      const events = await pending;
      const wire = events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
        .join('');
      expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(1024 * 1024);
      expect(logText(events).length).toBeGreaterThan(0);
      if (mode === 'redaction') {
        expect(logText(events)).toContain('[REDACTED]');
        expect(logText(events)).not.toContain('x');
      }
      expect(events.at(-1)).toMatchObject({ type: 'end', data: { reason: 'byte_limit' } });
      expect(f.sources[0]!.stream.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not emit remaining encoded chunks after the session is revoked', async () => {
    const f = fixture();
    const session = await f.open();
    f.sources[0]!.stream.end(Buffer.alloc(64 * 1024, 120));
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'log' });
    f.sessions.get(f.ids.session)!.revokedAt = new Date();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await iterator.next()).value).toMatchObject({
      type: 'end',
      data: { reason: 'access_changed' },
    });
    expect((await iterator.next()).done).toBe(true);
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a silent follow source at 60 seconds without waiting for another chunk', async () => {
    const f = fixture();
    const pending = collect(await f.open());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.sources[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).at(-1)).toMatchObject({
      type: 'end',
      data: { reason: 'duration_limit' },
    });
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases all four expired slots even when their event iterators never advance', async () => {
    const f = fixture();
    for (let index = 0; index < 4; index++) await f.open();
    await expect(f.open()).rejects.toMatchObject({ status: 429, code: 'LOG_SESSION_LIMIT' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sources.every((source) => source.stream.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const replacement = await f.open();
    replacement.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares four slots across one account’s sessions and isolates another account', async () => {
    const f = fixture();
    for (let index = 0; index < 4; index++)
      await f.open({
        principal: {
          userId: f.ids.user,
          sessionId: index % 2 ? f.ids.session : f.ids.secondSession,
        },
      });
    await expect(f.open()).rejects.toMatchObject({ status: 429, code: 'LOG_SESSION_LIMIT' });
    const other = await f.open({
      principal: { userId: f.ids.otherUser, sessionId: f.ids.otherSession },
    });
    other.close();
    f.reader.close();
    expect(f.sources.every((source) => source.stream.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not consume a slot when Pod or container selection is rejected', async () => {
    const f = fixture();
    for (const input of [
      { podUid: randomUUID() },
      { container: 'foreign-container' },
      { podUid: randomUUID() },
      { container: 'foreign-container' },
    ])
      await expect(f.open({ input })).rejects.toMatchObject({ code: 'POD_LOGS_TARGET_CHANGED' });
    expect(f.upstream.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    for (let index = 0; index < 4; index++) await f.open();
  });

  it('destroys upstream and releases an unconsumed slot when the client disconnects', async () => {
    const f = fixture();
    const abort = new AbortController();
    const session = await f.open({ signal: abort.signal });
    abort.abort();
    session.close();
    expect(f.sources[0]!.signal.aborted).toBe(true);
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    for (let index = 0; index < 4; index++) await f.open();
  });

  it('cleans up when an event consumer stops after a yielded log', async () => {
    const f = fixture();
    f.snapshot.configuration.environment = [];
    const session = await f.open();
    f.sources[0]!.stream.write('first line\n');
    for await (const event of session.events) {
      expect(event).toMatchObject({ type: 'log' });
      break;
    }
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('emits a safe source_error without exposing transport diagnostics', async () => {
    const f = fixture();
    const pending = collect(await f.open());
    f.sources[0]!.stream.destroy(new Error(marker));
    const events = await pending;
    expect(events.at(-1)).toMatchObject({ type: 'end', data: { reason: 'source_error' } });
    expect(JSON.stringify(events)).not.toContain(marker);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['missing', 'expired', 'revoked', 'wrong-account'] as const)(
    'rejects an initially %s session before opening upstream',
    async (mode) => {
      const f = fixture();
      const session = f.sessions.get(f.ids.session)!;
      if (mode === 'missing') f.sessions.delete(session.id);
      if (mode === 'expired') session.expiresAt = new Date(Date.now());
      if (mode === 'revoked') session.revokedAt = new Date();
      if (mode === 'wrong-account') session.adminId = f.ids.otherUser;
      await expect(f.open()).rejects.toMatchObject({ code: 'LOG_ACCESS_CHANGED' });
      expect(f.upstream.open).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    'session-revoked',
    'session-expired',
    'credential-replaced',
    'credential-expired',
    'generation-changed',
    'installation-changed',
    'environment-changed',
    'project-changed',
    'cluster-connection-changed',
  ] as const)('closes the live source on %s at the next access check', async (mode) => {
    const f = fixture();
    const pending = collect(await f.open());
    if (mode === 'session-revoked') f.sessions.get(f.ids.session)!.revokedAt = new Date();
    if (mode === 'session-expired') f.sessions.get(f.ids.session)!.expiresAt = new Date();
    if (mode === 'credential-replaced') f.credential.revision++;
    if (mode === 'credential-expired') f.credential.expiresAt = new Date();
    if (mode === 'generation-changed') f.state.generation++;
    if (mode === 'installation-changed') f.state.installationId = randomUUID();
    if (mode === 'environment-changed') f.service.environmentId = randomUUID();
    if (mode === 'project-changed') f.service.environment.projectId = randomUUID();
    if (mode === 'cluster-connection-changed') f.cluster.connectionRevision++;
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).at(-1)).toMatchObject({
      type: 'end',
      data: { reason: 'access_changed' },
    });
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['no-label', 'unknown-snapshot', 'foreign-service', 'invalid-snapshot-owner'] as const)(
    'fails closed for %s before exposing log bytes',
    async (mode) => {
      const f = fixture();
      if (mode === 'no-label') f.pod.snapshotId = null;
      if (mode === 'unknown-snapshot') f.pod.snapshotId = randomUUID();
      if (mode === 'foreign-service') f.deployments.get(f.ids.snapshot)!.serviceId = randomUUID();
      if (mode === 'invalid-snapshot-owner') f.snapshot.serviceId = randomUUID();
      await expect(f.open()).rejects.toMatchObject({ code: 'LOG_SNAPSHOT_UNAVAILABLE' });
      expect(f.upstream.open).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('fails closed if a referenced runtime secret cannot be loaded', async () => {
    const f = fixture();
    f.secrets.delete(f.ids.secret);
    await expect(f.open()).rejects.toMatchObject({ code: 'LOG_SECRET_UNAVAILABLE' });
    expect(f.upstream.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a source that finishes opening after the client has disconnected', async () => {
    const f = fixture();
    const abort = new AbortController();
    const entered = deferred();
    const release = deferred();
    const original = f.upstream.open.getMockImplementation()!;
    f.upstream.open.mockImplementation(async (...args) => {
      const source = await original(...args);
      entered.resolve();
      await release.promise;
      return source;
    });
    const opening = f.open({ signal: abort.signal });
    await entered.promise;
    abort.abort();
    release.resolve();
    await expect(opening).rejects.toMatchObject({ code: 'LOG_SESSION_CLOSED' });
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not recreate timers if the client disconnects during the final access check', async () => {
    const f = fixture();
    const abort = new AbortController();
    const entered = deferred();
    const release = deferred();
    const original = f.db.session.findUnique.getMockImplementation()!;
    let checks = 0;
    f.db.session.findUnique.mockImplementation(async (...args) => {
      if (++checks === 3) {
        entered.resolve();
        await release.promise;
      }
      return original(...args);
    });
    const opening = f.open({ signal: abort.signal });
    await entered.promise;
    abort.abort();
    release.resolve();
    await expect(opening).rejects.toMatchObject({ code: 'LOG_SESSION_CLOSED' });
    expect(f.sources[0]!.stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
