import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/dist/app.js';
import { readMasterKeys, SecretCipher } from '../../packages/control-plane/dist/secrets.js';
import { PrismaClient } from '../../packages/database/dist/index.js';
import { createTestSession } from './helpers.js';

type Resource = { id: string; name: string; revision: number; [key: string]: unknown };
type ResourceList = { data: Resource[]; page: { nextCursor: string | null; hasMore: boolean } };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const prefix = `metadata-${randomUUID().slice(0, 8)}`;
const tracked = {
  projects: new Set<string>(),
  environments: new Set<string>(),
  clusters: new Set<string>(),
  servers: new Set<string>(),
  secrets: new Set<string>(),
};
let sequence = 0;
let app: Awaited<ReturnType<typeof createApp>>;
let session: Awaited<ReturnType<typeof createTestSession>>;
const execute = promisify(execFile);
const schema = `metadata_${randomUUID().replaceAll('-', '')}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalMasterKeyFile = process.env.MASTER_KEY_FILE;
if (!originalDatabaseUrl) throw new Error('Metadata integration requires PostgreSQL.');
const url = new URL(originalDatabaseUrl);
url.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-metadata-integration-'));
const masterKeyFile = join(directory, 'fixture-master-key.json');
const db = new PrismaClient({ datasourceUrl: url.toString() });

const unique = (label: string) => `${prefix}-${label}-${++sequence}`;
async function request(
  method: Method,
  url: string,
  payload?: Record<string, unknown>,
  key?: string,
) {
  const response = await app.inject({
    method,
    url: `/api${url}`,
    headers: { ...session.headers, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    ...(payload ? { payload } : {}),
  });
  const kind = url.slice(1) as keyof typeof tracked;
  if (method === 'POST' && response.statusCode === 201 && Object.hasOwn(tracked, kind)) {
    tracked[kind].add(response.json<{ data: Resource }>().data.id);
  }
  return response;
}

async function create(
  kind: keyof typeof tracked,
  payload: Record<string, unknown>,
): Promise<Resource> {
  const response = await request('POST', `/${kind}`, payload);
  expect(response.statusCode, response.body).toBe(201);
  const resource = response.json<{ data: Resource }>().data;
  tracked[kind].add(resource.id);
  return resource;
}

async function cluster(label: string) {
  const name = unique(label);
  return create('clusters', { name, slug: name });
}

async function project(clusterId: string, label: string) {
  const name = unique(label);
  return create('projects', { name, slug: name, clusterId });
}

async function getResource(path: string): Promise<Resource> {
  const response = await request('GET', path);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ data: Resource }>().data;
}

beforeAll(async () => {
  // Exercise the real HTTP modules against all current migrations, independently
  // of the operator's local schema version and retained application resources.
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
    { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 25_000 },
  );
  writeFileSync(
    masterKeyFile,
    JSON.stringify({ activeVersion: 1, keys: { '1': randomBytes(32).toString('base64') } }),
    { mode: 0o600 },
  );
  process.env.DATABASE_URL = url.toString();
  process.env.MASTER_KEY_FILE = masterKeyFile;
  await db.$connect();
  app = await createApp({ silent: true });
  session = await createTestSession(app, db);
});

afterAll(async () => {
  try {
    await app?.close();
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await db.$disconnect();
    process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalMasterKeyFile === undefined) delete process.env.MASTER_KEY_FILE;
    else process.env.MASTER_KEY_FILE = originalMasterKeyFile;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('S1 metadata API with PostgreSQL', () => {
  it('replays concurrent project creation without allocating another default environment', async () => {
    const target = await cluster('creation-retry');
    const key = randomUUID();
    const input = {
      name: unique('retry-project'),
      slug: unique('retry-project'),
      description: 'One project and one default environment',
      clusterId: target.id,
    };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request('POST', '/projects', input, key)),
    );
    const original = responses[0]!.json<{ data: Resource }>();
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toEqual(original);
    }
    expect(await db.project.count({ where: { clusterId: target.id } })).toBe(1);
    expect(await db.environment.findMany({ where: { projectId: original.data.id } })).toMatchObject(
      [{ slug: 'production', revision: 1 }],
    );
    expect(
      await db.commandReceipt.count({
        where: { idempotencyScope: `project-create:${session.adminId}`, idempotencyKey: key },
      }),
    ).toBe(1);

    // A lost response may be retried after the newly created project was edited.
    const updated = await request('PATCH', `/projects/${original.data.id}`, {
      name: unique('renamed'),
      revision: original.data.revision,
    });
    expect(updated.statusCode).toBe(200);
    const replay = await request('POST', '/projects', { ...input }, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(original);
    expect(await getResource(`/projects/${original.data.id}`)).toMatchObject({ revision: 2 });

    for (const change of [
      { name: unique('different-name') },
      { slug: unique('different-slug') },
      { description: 'Changed request' },
      { clusterId: randomUUID() },
    ]) {
      const conflict = await request('POST', '/projects', { ...input, ...change }, key);
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    expect(await db.project.count({ where: { clusterId: target.id } })).toBe(1);
    expect(await db.environment.count({ where: { projectId: original.data.id } })).toBe(1);

    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: true },
    });
    try {
      const locked = await request('POST', '/projects', input, key);
      expect(locked.statusCode, locked.body).toBe(503);
      expect(locked.json()).toMatchObject({ code: 'RESTORE_READ_ONLY' });
    } finally {
      await db.controlPlaneState.update({
        where: { id: 'control-plane' },
        data: { restoreLocked: false },
      });
    }
  });

  it('rejects malformed project creation keys before creating metadata', async () => {
    const target = await cluster('invalid-creation-key');
    for (const key of ['', 'short', 'invalid key', 'x'.repeat(129)]) {
      const response = await request(
        'POST',
        '/projects',
        { name: unique('invalid-key'), slug: unique('invalid-key'), clusterId: target.id },
        key,
      );
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    expect(await db.project.count({ where: { clusterId: target.id } })).toBe(0);
  });

  it('creates project and production atomically, sharing an unverified registered target', async () => {
    const target = await cluster('target');
    expect(target).toMatchObject({
      connectionStatus: 'unverified',
      lastObservedAt: null,
      projectCount: 0,
    });
    const first = await project(target.id, 'first');
    const second = await project(target.id, 'second');
    expect(first).toMatchObject({
      clusterId: target.id,
      cluster: { id: target.id, connectionStatus: 'unverified' },
    });
    for (const item of [first, second]) {
      const environments = await db.environment.findMany({ where: { projectId: item.id } });
      expect(environments).toHaveLength(1);
      expect(environments[0]).toMatchObject({ slug: 'production', revision: 1 });
      const response = await request('GET', `/environments?projectId=${item.id}`);
      expect(response.json<ResourceList>().data).toMatchObject([
        { projectId: item.id, clusterId: target.id, isDefault: true },
      ]);
    }
    const duplicate = await request('POST', '/projects', {
      name: unique('duplicate'),
      slug: first.slug,
      clusterId: target.id,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(await db.environment.count({ where: { projectId: first.id } })).toBe(1);
    expect(await db.project.count({ where: { clusterId: target.id } })).toBe(2);
    const listed = await request('GET', `/projects?clusterId=${target.id}`);
    expect(new Set(listed.json<ResourceList>().data.map((item) => item.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(await getResource(`/clusters/${target.id}`)).toMatchObject({
      projectCount: 2,
      connectionStatus: 'unverified',
    });
  });

  it('rejects absent, invalid and independently overridden ownership', async () => {
    const target = await cluster('ownership');
    const item = await project(target.id, 'owned');
    const missing = await request('POST', '/projects', {
      name: unique('missing'),
      slug: unique('missing'),
    });
    expect(missing.statusCode).toBe(422);
    const nonexistent = await request('POST', '/projects', {
      name: unique('absent'),
      slug: unique('absent'),
      clusterId: randomUUID(),
    });
    expect(nonexistent.statusCode).toBe(404);
    expect(
      (
        await request('POST', '/projects', {
          name: 'invalid',
          slug: unique('invalid'),
          clusterId: 'not-a-uuid',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await request('PATCH', `/projects/${item.id}`, { revision: 1, clusterId: randomUUID() }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await request('POST', '/environments', {
          name: 'Staging',
          slug: 'staging',
          projectId: item.id,
          clusterId: target.id,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await request('POST', '/environments', {
          name: 'Staging',
          slug: 'staging',
          projectId: randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    expect(await getResource(`/projects/${item.id}`)).toMatchObject({
      clusterId: target.id,
      revision: 1,
    });
  });

  it('protects production identity and keeps environment names unique within each project', async () => {
    const target = await cluster('environments');
    const first = await project(target.id, 'env-first');
    const second = await project(target.id, 'env-second');
    const staging = await create('environments', {
      name: 'Staging',
      slug: 'staging',
      projectId: first.id,
    });
    await create('environments', { name: 'Staging', slug: 'staging', projectId: second.id });
    expect(
      (
        await request('POST', '/environments', {
          name: 'Duplicate',
          slug: 'staging',
          projectId: first.id,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('PATCH', `/environments/${staging.id}`, { revision: 1, projectId: second.id }))
        .statusCode,
    ).toBe(422);
    const production = await db.environment.findUniqueOrThrow({
      where: { projectId_slug: { projectId: first.id, slug: 'production' } },
    });
    const renamed = await request('PATCH', `/environments/${production.id}`, {
      revision: 1,
      name: '生产环境',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ data: Resource }>().data).toMatchObject({
      name: '生产环境',
      slug: 'production',
      revision: 2,
      clusterId: target.id,
    });
    expect(
      (await request('PATCH', `/environments/${production.id}`, { revision: 2, slug: 'main' }))
        .statusCode,
    ).toBe(422);
    const deleted = await request('DELETE', `/environments/${production.id}?revision=2`);
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toMatchObject({ code: 'DEFAULT_ENVIRONMENT_REQUIRED' });
  });

  it('uses PostgreSQL revision conditions to reject concurrent edits and stale deletes', async () => {
    const target = await cluster('revision');
    const item = await project(target.id, 'revision');
    expect(
      (await request('PATCH', `/projects/${item.id}`, { name: 'No revision' })).statusCode,
    ).toBe(422);
    expect(
      (await request('PATCH', `/projects/${item.id}`, { revision: 1, name: null })).statusCode,
    ).toBe(422);
    expect(
      (
        await request('PATCH', `/projects/${item.id}`, {
          revision: 2147483648,
          name: 'Invalid revision',
        })
      ).statusCode,
    ).toBe(422);
    const results = await Promise.all([
      request('PATCH', `/projects/${item.id}`, { revision: 1, name: 'Edit A' }),
      request('PATCH', `/projects/${item.id}`, { revision: 1, name: 'Edit B' }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.statusCode === 409)?.json()).toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(await getResource(`/projects/${item.id}`)).toMatchObject({ revision: 2 });
    expect((await request('DELETE', `/projects/${item.id}`)).statusCode).toBe(422);
    expect((await request('DELETE', `/projects/${item.id}?revision=0`)).statusCode).toBe(422);
    expect((await request('DELETE', `/projects/${item.id}?revision=1`)).statusCode).toBe(409);
    expect(await db.project.findUnique({ where: { id: item.id } })).not.toBeNull();
  });

  it('retains referenced clusters and removes only an explicitly deleted empty project', async () => {
    const target = await cluster('retained');
    const server = await create('servers', {
      name: unique('host'),
      host: '192.0.2.41',
      sshUser: 'root',
    });
    const item = await project(target.id, 'empty');
    await create('environments', { name: 'Staging', slug: 'staging', projectId: item.id });
    expect((await request('DELETE', `/clusters/${target.id}?revision=1`)).statusCode).toBe(409);
    expect(
      (
        await request('PATCH', `/clusters/${target.id}`, {
          revision: 1,
          apiEndpoint: 'https://192.0.2.41:6443',
        })
      ).statusCode,
    ).toBe(409);
    const renamed = await request('PATCH', `/clusters/${target.id}`, {
      revision: 1,
      name: 'Renamed target',
    });
    expect(renamed.statusCode).toBe(200);
    expect((await request('DELETE', `/projects/${item.id}?revision=1`)).statusCode).toBe(204);
    expect(await db.project.findUnique({ where: { id: item.id } })).toBeNull();
    expect(await db.environment.count({ where: { projectId: item.id } })).toBe(0);
    expect(await db.cluster.findUnique({ where: { id: target.id } })).not.toBeNull();
    expect(await db.server.findUnique({ where: { id: server.id } })).not.toBeNull();
    expect((await request('DELETE', `/clusters/${target.id}?revision=1`)).statusCode).toBe(409);
    expect((await request('DELETE', `/clusters/${target.id}?revision=2`)).statusCode).toBe(204);
  });

  it('paginates tied timestamps without duplicates and validates cursor and limits', async () => {
    const label = unique('pagination');
    const resources = await Promise.all(
      [0, 1, 2].map((index) =>
        create('clusters', { name: `${label}-${index}`, slug: `${label}-${index}` }),
      ),
    );
    const ids = resources.map((item) => item.id);
    await db.cluster.updateMany({
      where: { id: { in: ids } },
      data: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await request(
        'GET',
        `/clusters?search=${label}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(response.statusCode).toBe(200);
      const page = response.json<ResourceList>();
      expect(page.data).toHaveLength(1);
      seen.push(page.data[0]!.id);
      cursor = page.page.nextCursor;
      expect(page.page.hasMore).toBe(cursor !== null);
      expect(seen.length).toBeLessThanOrEqual(3);
    } while (cursor);
    expect(seen).toEqual(ids.sort().reverse());
    expect((await request('GET', '/clusters?cursor=broken')).statusCode).toBe(422);
    expect((await request('GET', '/clusters?limit=101')).statusCode).toBe(422);
    expect((await request('GET', '/clusters?limit=1.5')).statusCode).toBe(422);
  });

  it('persists encrypted credentials, returns only metadata and enforces typed references', async () => {
    const marker = `credential-${randomUUID()}`;
    const secret = await create('secrets', {
      name: unique('ssh'),
      kind: 'ssh',
      payload: { privateKey: marker },
    });
    expect(secret.revision).toBe(1);
    for (const forbidden of [marker, 'encryptedPayload', 'nonce', '"tag"', 'privateKey'])
      expect(JSON.stringify(secret)).not.toContain(forbidden);
    const stored = await db.secretReference.findUniqueOrThrow({ where: { id: secret.id } });
    expect(Buffer.from(stored.encryptedPayload).toString('utf8')).not.toContain(marker);
    const restartedCipher = new SecretCipher(readMasterKeys(process.env.MASTER_KEY_FILE!));
    expect(restartedCipher.decrypt(stored)).toEqual({ privateKey: marker });
    for (const path of [`/secrets/${secret.id}`, `/secrets?search=${prefix}`]) {
      const response = await request('GET', path);
      expect(response.statusCode).toBe(200);
      for (const forbidden of [marker, 'encryptedPayload', 'nonce', '"tag"', 'privateKey'])
        expect(response.body).not.toContain(forbidden);
    }
    const invalidKind = await request('POST', '/clusters', {
      name: unique('wrong-kind'),
      slug: unique('wrong-kind'),
      credentialRefId: secret.id,
    });
    expect(invalidKind.statusCode).toBe(422);
    expect(invalidKind.json()).toMatchObject({ code: 'CREDENTIAL_KIND_MISMATCH' });
    expect(
      (
        await request('POST', '/servers', {
          name: unique('missing-secret'),
          host: '192.0.2.42',
          sshUser: 'root',
          credentialRefId: randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    const server = await create('servers', {
      name: unique('credential-host'),
      host: '2001:db8::42',
      sshUser: 'root',
      credentialRefId: secret.id,
    });
    expect(server).toMatchObject({
      sshPort: 22,
      connectionStatus: 'unverified',
      lastObservedAt: null,
      credentialRefId: secret.id,
    });
    expect((await request('DELETE', `/secrets/${secret.id}?revision=1`)).statusCode).toBe(409);
    expect(
      (await request('PATCH', `/servers/${server.id}`, { revision: 1, credentialRefId: null }))
        .statusCode,
    ).toBe(200);
    expect((await request('DELETE', `/secrets/${secret.id}?revision=1`)).statusCode).toBe(204);
    const expired = await create('secrets', {
      name: unique('expired'),
      kind: 'ssh',
      payload: { password: marker },
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(
      (
        await request('POST', '/servers', {
          name: unique('expired-host'),
          host: '192.0.2.43',
          sshUser: 'root',
          credentialRefId: expired.id,
        })
      ).statusCode,
    ).toBe(422);
  });

  it('validates server endpoints and never accepts client-provided connection observations', async () => {
    const base = { name: unique('invalid-host'), host: '192.0.2.44', sshUser: 'root' };
    expect((await request('POST', '/servers', { ...base, sshPort: 65536 })).statusCode).toBe(422);
    expect((await request('POST', '/servers', { ...base, sshPort: 0 })).statusCode).toBe(422);
    expect(
      (await request('POST', '/servers', { ...base, host: 'https://192.0.2.44:22' })).statusCode,
    ).toBe(422);
    expect(
      (await request('POST', '/servers', { ...base, connectionStatus: 'connected' })).statusCode,
    ).toBe(422);
    expect(
      (
        await request('POST', '/clusters', {
          name: unique('forged'),
          slug: unique('forged'),
          connectionStatus: 'connected',
        })
      ).statusCode,
    ).toBe(422);
    const marker = `token-${randomUUID()}`;
    const unsafeEndpoint = await request('POST', '/clusters', {
      name: unique('url-secret'),
      slug: unique('url-secret'),
      apiEndpoint: `https://192.0.2.44:6443/?token=${marker}`,
    });
    expect(unsafeEndpoint.statusCode).toBe(422);
    expect(unsafeEndpoint.body).not.toContain(marker);
  });

  it('keeps every metadata module read-only during control-plane recovery', async () => {
    const target = await cluster('recovery');
    const item = await project(target.id, 'recovery');
    const environment = await db.environment.findUniqueOrThrow({
      where: { projectId_slug: { projectId: item.id, slug: 'production' } },
    });
    const server = await create('servers', {
      name: unique('recovery-host'),
      host: '192.0.2.45',
      sshUser: 'root',
    });
    const secret = await create('secrets', {
      name: unique('recovery-secret'),
      kind: 'generic',
      payload: { token: randomUUID() },
    });
    const original = process.env.RESTORE_MODE;
    const blockedName = unique('blocked');
    const attempts: Array<[Method, string, Record<string, unknown>?]> = [
      ['POST', '/clusters', { name: blockedName, slug: blockedName }],
      ['POST', '/projects', { name: blockedName, slug: blockedName, clusterId: target.id }],
      ['POST', '/environments', { name: blockedName, slug: blockedName, projectId: item.id }],
      ['POST', '/servers', { name: blockedName, host: '192.0.2.46', sshUser: 'root' }],
      ['POST', '/secrets', { name: blockedName, kind: 'generic', payload: { value: 'test-only' } }],
      ...[
        `/clusters/${target.id}`,
        `/projects/${item.id}`,
        `/environments/${environment.id}`,
        `/servers/${server.id}`,
      ].map((path): [Method, string, Record<string, unknown>] => [
        'PATCH',
        path,
        { revision: 1, name: blockedName },
      ]),
      ...[
        `/clusters/${target.id}`,
        `/projects/${item.id}`,
        `/environments/${environment.id}`,
        `/servers/${server.id}`,
        `/secrets/${secret.id}`,
      ].map((path): [Method, string] => ['DELETE', `${path}?revision=1`]),
    ];
    try {
      process.env.RESTORE_MODE = 'true';
      for (const [method, path, payload] of attempts) {
        const response = await request(method, path, payload);
        expect(response.statusCode, `${method} ${path}: ${response.body}`).toBe(503);
        expect(response.json()).toMatchObject({ code: 'RESTORE_READ_ONLY' });
      }
      expect(await getResource(`/projects/${item.id}`)).toMatchObject({
        name: item.name,
        revision: 1,
      });
      expect(await getResource(`/secrets/${secret.id}`)).toMatchObject({ revision: 1 });
    } finally {
      if (original === undefined) delete process.env.RESTORE_MODE;
      else process.env.RESTORE_MODE = original;
    }
    expect(await db.cluster.count({ where: { name: blockedName } })).toBe(0);
    expect(await db.project.count({ where: { name: blockedName } })).toBe(0);
  });
});
