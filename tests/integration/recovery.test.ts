import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../packages/database/dist/index.js';
import { SecretCipher, readMasterKeys } from '../../packages/control-plane/dist/secrets.js';
import { TaskRepository, type TaskLease } from '../../packages/control-plane/dist/tasks/index.js';
import {
  configuration,
  dumpSnapshot,
  exportedSnapshot,
  hashSnapshotObservation,
  verifyBackupSnapshot,
} from '../../scripts/backup-helpers.mjs';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('Recovery integration tests require DATABASE_URL');
const administration = new PrismaClient({ datasourceUrl: baseUrl });
const databases = new Set<string>();
const clients: PrismaClient[] = [];
const prefix = `recovery_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let directory: string;
let source: PrismaClient;
let sourceName: string;
let sourceEnv: string;
let sourceKey: string;
let sourceCipher: SecretCipher;
let actorId: string;
let queuedId: string;
let runningId: string;
let runningLease: TaskLease;
let secretId: string;
let oldSecretId: string;
let secretMarker: string;
let databaseBackup: string;
let keyBackup: string;

type CliResult = { code: number; stdout: string; stderr: string };
type BackupManifest = {
  backupId: string;
  databaseSha256: string;
  masterKeySha256: string;
  generation: number;
  requiredKeyVersions: number[];
  [key: string]: unknown;
};

async function cli(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  try {
    const result = await execute(process.execPath, [resolve(root, script), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      timeout: 25000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : -1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

function urlFor(name: string): string {
  const url = new URL(baseUrl!);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

async function newDatabase(label: string): Promise<{ name: string; db: PrismaClient }> {
  const name = `${prefix}_${label}`;
  await administration.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  databases.add(name);
  const db = new PrismaClient({ datasourceUrl: urlFor(name) });
  await db.$connect();
  clients.push(db);
  return { name, db };
}

async function environment(name: string, key: string, suffix: string): Promise<string> {
  const file = join(directory, `${suffix}.env`);
  const values = {
    DATABASE_URL: urlFor(name),
    MASTER_KEY_FILE: key,
    RESTORE_MODE: 'false',
    NODE_ENV: 'development',
    APP_ORIGIN: 'http://127.0.0.1:5173',
    REDIS_URL: process.env.REDIS_URL!,
    LOG_LEVEL: 'silent',
  };
  await writeFile(
    file,
    Object.entries(values)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  return file;
}

const objectCount = (db: PrismaClient) =>
  db.$queryRaw<Array<{ count: bigint }>>`
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
`.then((rows) => Number(rows[0]!.count));

async function restore(
  label: string,
  overrides: { databaseBackup?: string; keyBackup?: string; keyFile?: string } = {},
) {
  const target = await newDatabase(label);
  const key = overrides.keyFile ?? join(directory, label, 'master-key.json');
  const env = await environment(target.name, key, label);
  const result = await cli('scripts/restore-control-plane.mjs', [
    '--env-file',
    env,
    '--database-backup',
    overrides.databaseBackup ?? databaseBackup,
    '--key-backup',
    overrides.keyBackup ?? keyBackup,
    '--target-key-file',
    key,
  ]);
  return { ...target, result, key, env };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ozz-recovery-'));
  const original = await newDatabase('source');
  source = original.db;
  sourceName = original.name;
  sourceKey = join(directory, 'source-master-key.json');
  const key1 = randomBytes(32);
  const key2 = randomBytes(32);
  await writeFile(
    sourceKey,
    JSON.stringify({
      activeVersion: 2,
      keys: { 1: key1.toString('base64'), 2: key2.toString('base64') },
    }),
    { mode: 0o600 },
  );
  sourceEnv = await environment(sourceName, sourceKey, 'source');
  await execute(
    process.execPath,
    [
      resolve(root, 'packages/database/node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      resolve(root, 'packages/database/prisma/schema.prisma'),
    ],
    { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(sourceName) }, timeout: 20000 },
  );
  sourceCipher = new SecretCipher(readMasterKeys(sourceKey));
  const oldCipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, key1]]) });
  for (const cipher of [oldCipher, sourceCipher]) {
    await source.keyVerification.create({
      data: cipher.encrypt('key-verification', { purpose: 'ozz-key-verification-v1' }),
    });
  }
  secretMarker = `recovery-secret-${randomUUID()}`;
  const retained = await source.secretReference.create({
    data: {
      name: 'retained-old-key',
      kind: 'generic',
      ...oldCipher.encrypt('generic', { token: `${secretMarker}-old` }),
    },
  });
  oldSecretId = retained.id;
  const credential = await source.secretReference.create({
    data: {
      name: 'current-credential',
      kind: 'generic',
      ...sourceCipher.encrypt('generic', {
        token: secretMarker,
        incompressible: randomBytes(96 * 1024).toString('base64'),
      }),
    },
  });
  secretId = credential.id;
  const admin = await source.admin.create({
    data: { username: 'recovery-fixture', passwordHash: 'fixture-login-disabled' },
  });
  actorId = admin.id;
  await source.session.create({
    data: {
      adminId: actorId,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  await source.controlPlaneState.update({
    where: { id: 'control-plane' },
    data: { generation: 7 },
  });
  const repository = new TaskRepository(source);
  queuedId = (await repository.createDiagnostic({ id: actorId }, randomUUID(), { durationMs: 25 }))
    .id;
  runningId = (await repository.createDiagnostic({ id: actorId }, randomUUID(), { durationMs: 25 }))
    .id;
  runningLease = (await repository.claim(runningId, 'source-worker'))!;
  await source.workerHeartbeat.create({
    data: { id: 'source-worker', queueConnected: true, activeOperations: 1 },
  });
  const target = await source.cluster.create({
    data: { name: 'retained cluster', slug: 'retained-cluster' },
  });
  const project = await source.project.create({
    data: {
      name: 'retained project',
      slug: 'retained-project',
      clusterId: target.id,
      environments: { create: { name: 'Production', slug: 'production' } },
    },
  });
  expect(project.id).toBeTruthy();
  // A test-only COPY check lets the crash test stop a real restore mid-import.
  // Padding after this table creates backpressure, so COMMIT cannot be queued
  // before the controller is killed. No existing database is touched.
  await source.$executeRawUnsafe(
    'CREATE FUNCTION public.ozz_test_restore_gate() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(657096110); RETURN true; END $$',
  );
  await source.$executeRawUnsafe(
    'CREATE TABLE public."RestoreInterruptFixture" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (public.ozz_test_restore_gate()))',
  );
  await source.$executeRawUnsafe('INSERT INTO public."RestoreInterruptFixture" DEFAULT VALUES');
  await source.$executeRawUnsafe('CREATE TABLE public."ZRestorePadding" (value text NOT NULL)');
  await source.$executeRawUnsafe(
    'INSERT INTO public."ZRestorePadding" VALUES (repeat(\'x\', 8388608))',
  );
  const result = await cli('scripts/backup-control-plane.mjs', [
    '--env-file',
    sourceEnv,
    '--database-dir',
    join(directory, 'database-backups'),
    '--key-dir',
    join(directory, 'key-backups'),
    '--label',
    'verified-backup',
  ]);
  expect(result.code, result.stderr).toBe(0);
  const backup = JSON.parse(result.stdout) as { databaseDirectory: string; keyDirectory: string };
  databaseBackup = backup.databaseDirectory;
  keyBackup = backup.keyDirectory;
});

afterAll(async () => {
  try {
    for (const client of clients) await client.$disconnect();
    for (const name of databases)
      await administration.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    if (directory) await rm(directory, { recursive: true, force: true });
  } finally {
    await administration.$disconnect();
  }
});

describe('S1 database and matching-key backup / isolated restore', () => {
  it('backs up a consistent snapshot with separate protected key and database bundles', async () => {
    const manifest = JSON.parse(
      await readFile(join(databaseBackup, 'manifest.json'), 'utf8'),
    ) as BackupManifest;
    expect(manifest).toMatchObject({
      generation: 7,
      requiredKeyVersions: [1, 2],
      status: 'complete',
      schema: 'public',
      snapshotObservation: {
        formatVersion: 1,
        isolationLevel: 'repeatable-read',
        readOnly: true,
        exactAcquisitionTimeKnown: false,
      },
    });
    const keyManifest = JSON.parse(await readFile(join(keyBackup, 'manifest.json'), 'utf8'));
    const observation = verifyBackupSnapshot(manifest, keyManifest);
    expect(observation.exportId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-\d+$/i);
    expect(observation.pgSnapshot).toMatch(/^\d+:\d+:(\d+(,\d+)*)?$/);
    expect(observation.databaseTimeBounds.ordered).toBe(true);
    expect(BigInt(observation.clientObservation.elapsedNanoseconds)).toBeGreaterThan(0n);
    expect(
      new Date(observation.clientObservation.metadataReceivedAt).getTime(),
    ).toBeLessThanOrEqual(new Date(manifest.createdAt as string).getTime());
    for (const path of [databaseBackup, keyBackup])
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    for (const path of [
      join(databaseBackup, 'database.dump'),
      join(databaseBackup, 'manifest.json'),
      join(keyBackup, 'master-key.json'),
      join(keyBackup, 'manifest.json'),
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(keyBackup, 'master-key.json'))).toEqual(await readFile(sourceKey));
    expect(await exists(join(databaseBackup, 'master-key.json'))).toBe(false);
    const text = await readFile(join(databaseBackup, 'manifest.json'), 'utf8');
    expect(text).not.toContain(secretMarker);
    expect(text).not.toContain(new URL(urlFor(sourceName)).password);
    expect(
      await source.controlPlaneState.findUnique({ where: { id: 'control-plane' } }),
    ).toMatchObject({ restoreLocked: false, generation: 7 });
  });

  it('restores data, constraints and both key versions while revoking sessions and fencing old tasks', async () => {
    const target = await restore('valid');
    expect(target.result.code, target.result.stderr).toBe(0);
    expect(target.result.stdout).not.toContain(secretMarker);
    const sourceManifest = JSON.parse(
      await readFile(join(databaseBackup, 'manifest.json'), 'utf8'),
    );
    expect(JSON.parse(target.result.stdout).snapshotObservationSha256).toBe(
      sourceManifest.snapshotObservationSha256,
    );
    expect(await target.db.project.count()).toBe(1);
    expect(await target.db.environment.count()).toBe(1);
    expect(await target.db.outbox.count()).toBe(2);
    expect(await target.db.workerHeartbeat.count()).toBe(0);
    expect(await target.db.session.count({ where: { revokedAt: null } })).toBe(0);
    expect(
      await target.db.controlPlaneState.findUnique({ where: { id: 'control-plane' } }),
    ).toMatchObject({ restoreLocked: true, generation: 8 });
    const cipher = new SecretCipher(readMasterKeys(target.key));
    expect(
      cipher.decrypt(
        await target.db.secretReference.findUniqueOrThrow({ where: { id: secretId } }),
      ),
    ).toMatchObject({ token: secretMarker });
    expect(
      cipher.decrypt(
        await target.db.secretReference.findUniqueOrThrow({ where: { id: oldSecretId } }),
      ),
    ).toMatchObject({ token: `${secretMarker}-old` });
    const repository = new TaskRepository(target.db);
    await expect(
      repository.createDiagnostic({ id: actorId }, randomUUID(), {}),
    ).rejects.toMatchObject({ code: 'RESTORE_READ_ONLY' });
    await expect(repository.claim(queuedId, 'restore-worker')).rejects.toMatchObject({
      code: 'RESTORE_READ_ONLY',
    });
    const refused = await cli('apps/api/dist/cli.js', ['recovery:unlock'], {
      DATABASE_URL: urlFor(target.name),
      MASTER_KEY_FILE: target.key,
      RESTORE_MODE: 'false',
      LOG_LEVEL: 'silent',
    });
    expect(refused.code).toBe(1);
    const unlocked = await cli('apps/api/dist/cli.js', ['recovery:unlock', '--reconciled'], {
      DATABASE_URL: urlFor(target.name),
      MASTER_KEY_FILE: target.key,
      RESTORE_MODE: 'false',
      LOG_LEVEL: 'silent',
    });
    expect(unlocked.code, unlocked.stderr).toBe(0);
    expect(await repository.complete(runningLease)).toBe(false);
    for (const id of [queuedId, runningId]) {
      expect(await repository.claim(id, 'restored-worker')).toBeNull();
      expect(await repository.get(id)).toMatchObject({
        status: 'failed',
        errorCode: 'RECOVERY_GENERATION_CHANGED',
        result: null,
      });
    }
    const next = await repository.createDiagnostic({ id: actorId }, randomUUID(), {});
    const nextLease = await repository.claim(next.id, 'restored-worker');
    expect(await repository.complete(nextLease!)).toBe(true);
    const project = await target.db.project.findFirstOrThrow();
    const other = await target.db.cluster.create({
      data: { name: 'other target', slug: 'other-target' },
    });
    await expect(
      target.db.project.update({ where: { id: project.id }, data: { clusterId: other.id } }),
    ).rejects.toBeDefined();
    expect(await source.operation.findUnique({ where: { id: queuedId } })).toMatchObject({
      status: 'queued',
      generation: 7,
    });
    expect(await source.session.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('keeps the exported visibility boundary when pending and later transactions commit before pg_dump', async () => {
    await source.$executeRawUnsafe(
      'CREATE TABLE public."SnapshotVisibilityFixture" (name text PRIMARY KEY)',
    );
    await source.$executeRawUnsafe(
      'INSERT INTO public."SnapshotVisibilityFixture" VALUES (\'committed-before\')',
    );
    let release!: () => void;
    let held!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      held = resolve;
    });
    let pendingXid = '';
    const pending = source.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO public."SnapshotVisibilityFixture" VALUES (\'pending-at-snapshot\')',
        );
        pendingXid = (
          await tx.$queryRaw<Array<{ xid: string }>>`SELECT pg_current_xact_id()::text AS xid`
        )[0]!.xid;
        held();
        await wait;
      },
      { timeout: 20000 },
    );
    void pending.catch(() => {});
    let snapshot;
    try {
      await Promise.race([entered, pending]);
      const config = await configuration({ 'env-file': sourceEnv });
      snapshot = await exportedSnapshot(config);
      const metadata = snapshot.data;
      const observation = snapshot.observation;
      expect(observation.exportId).toBe(snapshot.data.snapshot);
      expect(observation.pgSnapshot).toBe(snapshot.data.pgSnapshot);
      const visible = await source.$queryRaw<Array<{ visible: boolean }>>`
        SELECT pg_visible_in_snapshot(${pendingXid}::xid8, ${observation.pgSnapshot}::pg_snapshot) AS visible
      `;
      expect(visible[0]!.visible).toBe(false);
      release();
      await pending;
      await source.$executeRawUnsafe(
        'INSERT INTO public."SnapshotVisibilityFixture" VALUES (\'committed-after\')',
      );
      const databaseDirectory = join(directory, 'concurrent-database');
      const keyDirectory = join(directory, 'concurrent-key');
      await mkdir(databaseDirectory, { mode: 0o700 });
      await cp(keyBackup, keyDirectory, { recursive: true });
      const dump = join(databaseDirectory, 'database.dump');
      await dumpSnapshot(config, snapshot.data.snapshot, dump);
      await snapshot.close();
      snapshot = undefined;
      const databaseSha256 = createHash('sha256')
        .update(await readFile(dump))
        .digest('hex');
      const snapshotObservationSha256 = hashSnapshotObservation(observation, databaseSha256);
      const manifest = JSON.parse(await readFile(join(databaseBackup, 'manifest.json'), 'utf8'));
      const keyManifest = JSON.parse(await readFile(join(keyDirectory, 'manifest.json'), 'utf8'));
      // Test-only assembly exercises the production exporter/dumper with a
      // controlled concurrent transaction. The normal CLI pair is tested above.
      const pair = {
        backupId: 'concurrent-snapshot',
        createdAt: new Date().toISOString(),
        databaseSha256,
        snapshotObservationSha256,
      };
      await writeFile(
        join(databaseDirectory, 'manifest.json'),
        JSON.stringify({
          ...manifest,
          ...pair,
          sourceDatabase: metadata.database,
          postgresVersion: metadata.serverVersion,
          generation: metadata.state.generation,
          migrations: metadata.migrations,
          snapshotObservation: observation,
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(keyDirectory, 'manifest.json'),
        JSON.stringify({
          ...keyManifest,
          ...pair,
        }),
        { mode: 0o600 },
      );
      const target = await restore('concurrent_snapshot', {
        databaseBackup: databaseDirectory,
        keyBackup: keyDirectory,
      });
      expect(target.result.code, target.result.stderr).toBe(0);
      expect(
        await target.db.$queryRawUnsafe(
          'SELECT name FROM public."SnapshotVisibilityFixture" ORDER BY name',
        ),
      ).toEqual([{ name: 'committed-before' }]);
      expect(
        await source.$queryRawUnsafe(
          'SELECT name FROM public."SnapshotVisibilityFixture" ORDER BY name',
        ),
      ).toHaveLength(3);
    } finally {
      release();
      try {
        await pending;
      } finally {
        await snapshot?.close();
      }
    }
  });

  it('restores legacy format-1 pairs without inventing missing snapshot evidence', async () => {
    const legacyDatabase = join(directory, 'legacy-database');
    const legacyKey = join(directory, 'legacy-key');
    await cp(databaseBackup, legacyDatabase, { recursive: true });
    await cp(keyBackup, legacyKey, { recursive: true });
    for (const path of [legacyDatabase, legacyKey]) {
      const file = join(path, 'manifest.json');
      const value = JSON.parse(await readFile(file, 'utf8'));
      delete value.snapshotObservation;
      delete value.snapshotObservationSha256;
      await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    }
    const target = await restore('legacy', {
      databaseBackup: legacyDatabase,
      keyBackup: legacyKey,
    });
    expect(target.result.code, target.result.stderr).toBe(0);
    expect(await target.db.project.count()).toBe(1);
    expect(JSON.parse(target.result.stdout)).not.toHaveProperty('snapshotObservationSha256');
  });

  it('rejects incomplete, malformed and changed snapshot evidence before importing anything', async () => {
    for (const kind of ['incomplete', 'malformed', 'changed']) {
      const dbPath = join(directory, `${kind}-snapshot-database`);
      const keyPath = join(directory, `${kind}-snapshot-key`);
      await cp(databaseBackup, dbPath, { recursive: true });
      await cp(keyBackup, keyPath, { recursive: true });
      const dbFile = join(dbPath, 'manifest.json');
      const keyFile = join(keyPath, 'manifest.json');
      const dbManifest = JSON.parse(await readFile(dbFile, 'utf8'));
      const keyManifest = JSON.parse(await readFile(keyFile, 'utf8'));
      if (kind === 'incomplete') delete keyManifest.snapshotObservationSha256;
      else if (kind === 'malformed') dbManifest.snapshotObservation.pgSnapshot = secretMarker;
      else dbManifest.snapshotObservation.clientObservation.elapsedNanoseconds = '0';
      await writeFile(dbFile, JSON.stringify(dbManifest), { mode: 0o600 });
      await writeFile(keyFile, JSON.stringify(keyManifest), { mode: 0o600 });
      const target = await restore(`snapshot_${kind}`, {
        databaseBackup: dbPath,
        keyBackup: keyPath,
      });
      expect(target.result.code).toBe(1);
      expect(target.result.stderr).toContain(
        kind === 'malformed' ? 'INVALID_SNAPSHOT_OBSERVATION' : 'BACKUP_SNAPSHOT_MISMATCH',
      );
      expect(target.result.stderr).not.toContain(secretMarker);
      expect(await objectCount(target.db)).toBe(0);
      expect(await exists(target.key)).toBe(false);
    }
  });

  it('refuses an occupied target or existing key path without altering them', async () => {
    const occupied = await newDatabase('occupied');
    await occupied.db.$executeRawUnsafe('CREATE TABLE public.keep_this (value text NOT NULL)');
    await occupied.db.$executeRawUnsafe("INSERT INTO public.keep_this VALUES ('untouched')");
    const key = join(directory, 'occupied-key.json');
    const env = await environment(occupied.name, key, 'occupied');
    const failed = await cli('scripts/restore-control-plane.mjs', [
      '--env-file',
      env,
      '--database-backup',
      databaseBackup,
      '--key-backup',
      keyBackup,
      '--target-key-file',
      key,
    ]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('TARGET_NOT_EMPTY');
    expect(await occupied.db.$queryRawUnsafe('SELECT value FROM public.keep_this')).toEqual([
      { value: 'untouched' },
    ]);
    expect(await exists(key)).toBe(false);
    const sentinel = join(directory, 'keep-existing-key');
    await writeFile(sentinel, 'unchanged', { mode: 0o600 });
    const keyTarget = await restore('existing_key', { keyFile: sentinel });
    expect(keyTarget.result.code).toBe(1);
    expect(keyTarget.result.stderr).toContain('OUTPUT_EXISTS');
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
    expect(await objectCount(keyTarget.db)).toBe(0);
    const link = join(directory, 'database-directory-link');
    await symlink(databaseBackup, link);
    const unsafe = await restore('linked_key', {
      keyFile: join(link, 'do-not-store-key-here.json'),
    });
    expect(unsafe.result.code).toBe(1);
    expect(unsafe.result.stderr).toContain('KEY_DESTINATION_NOT_SEPARATE');
    expect(await objectCount(unsafe.db)).toBe(0);
    expect(await exists(join(databaseBackup, 'do-not-store-key-here.json'))).toBe(false);
  });

  it('refuses wrong key bytes before import and cannot overwrite the source database', async () => {
    const wrongKey = join(directory, 'wrong-key-backup');
    await cp(keyBackup, wrongKey, { recursive: true });
    await writeFile(
      join(wrongKey, 'master-key.json'),
      JSON.stringify({ activeVersion: 1, keys: { 1: randomBytes(32).toString('base64') } }),
      { mode: 0o600 },
    );
    const target = await restore('wrong_key', { keyBackup: wrongKey });
    expect(target.result.code).toBe(1);
    expect(target.result.stderr).toContain('BACKUP_CHECKSUM_MISMATCH');
    expect(await objectCount(target.db)).toBe(0);
    expect(await exists(target.key)).toBe(false);
    const sourceAttempt = await cli('scripts/restore-control-plane.mjs', [
      '--env-file',
      sourceEnv,
      '--database-backup',
      databaseBackup,
      '--key-backup',
      keyBackup,
      '--target-key-file',
      join(directory, 'source-replacement-key'),
    ]);
    expect(sourceAttempt.code).toBe(1);
    expect(sourceAttempt.stderr).toContain('SOURCE_DATABASE_REFUSED');
    expect(await source.project.count()).toBe(1);
  });

  it('does not produce a completed backup with a missing retained key version or nested destinations', async () => {
    const key = JSON.parse(await readFile(sourceKey, 'utf8')) as {
      activeVersion: number;
      keys: Record<string, string>;
    };
    delete key.keys['1'];
    const missingVersion = join(directory, 'missing-version.json');
    await writeFile(missingVersion, JSON.stringify(key), { mode: 0o600 });
    const failed = await cli('scripts/backup-control-plane.mjs', [
      '--env-file',
      sourceEnv,
      '--master-key-file',
      missingVersion,
      '--database-dir',
      join(directory, 'bad-database'),
      '--key-dir',
      join(directory, 'bad-key'),
      '--label',
      'missing-version',
    ]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('MASTER_KEY_MISMATCH');
    expect(await exists(join(directory, 'bad-database', 'missing-version'))).toBe(false);
    expect(await exists(join(directory, 'bad-key', 'missing-version'))).toBe(false);
    const nested = await cli('scripts/backup-control-plane.mjs', [
      '--env-file',
      sourceEnv,
      '--database-dir',
      join(directory, 'nested'),
      '--key-dir',
      join(directory, 'nested', 'keys'),
    ]);
    expect(nested.code).toBe(1);
    expect(nested.stderr).toContain('BACKUP_DIRECTORIES_NOT_SEPARATE');
  });

  it('rolls back the complete restore transaction when a truncated archive fails after import begins', async () => {
    const brokenDatabase = join(directory, 'truncated-database');
    const brokenKey = join(directory, 'truncated-key');
    await cp(databaseBackup, brokenDatabase, { recursive: true });
    await cp(keyBackup, brokenKey, { recursive: true });
    const file = join(brokenDatabase, 'database.dump');
    const bytes = await readFile(file);
    const truncated = bytes.subarray(0, Math.floor(bytes.length * 0.75));
    await writeFile(file, truncated, { mode: 0o600 });
    // Refresh checksums to exercise pg_restore's own failure, beyond the
    // independent checksum rejection for accidental file damage.
    for (const directory of [brokenDatabase, brokenKey]) {
      const path = join(directory, 'manifest.json');
      const value = JSON.parse(await readFile(path, 'utf8')) as BackupManifest;
      value.databaseSha256 = createHash('sha256').update(truncated).digest('hex');
      const observed = JSON.parse(await readFile(join(databaseBackup, 'manifest.json'), 'utf8'));
      value.snapshotObservationSha256 = hashSnapshotObservation(
        observed.snapshotObservation,
        value.databaseSha256,
      );
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    }
    const target = await restore('truncated', {
      databaseBackup: brokenDatabase,
      keyBackup: brokenKey,
    });
    expect(target.result.code).toBe(1);
    expect(target.result.stderr).toContain('DATABASE_ARCHIVE_INVALID');
    expect(await objectCount(target.db)).toBe(0);
    expect(await exists(target.key)).toBe(false);
    expect(target.result.stderr).not.toContain(secretMarker);
  });

  it('keeps an imported target locked and withholds the key if cryptographic verification fails', async () => {
    const mismatchedDatabase = join(directory, 'canary-database');
    const mismatchedKey = join(directory, 'canary-key');
    await cp(databaseBackup, mismatchedDatabase, { recursive: true });
    await cp(keyBackup, mismatchedKey, { recursive: true });
    const wrong = Buffer.from(
      JSON.stringify({
        activeVersion: 2,
        keys: { 1: randomBytes(32).toString('base64'), 2: randomBytes(32).toString('base64') },
      }),
    );
    await writeFile(join(mismatchedKey, 'master-key.json'), wrong, { mode: 0o600 });
    for (const directory of [mismatchedDatabase, mismatchedKey]) {
      const path = join(directory, 'manifest.json');
      const value = JSON.parse(await readFile(path, 'utf8')) as BackupManifest;
      value.masterKeySha256 = createHash('sha256').update(wrong).digest('hex');
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    }
    const target = await restore('canary_mismatch', {
      databaseBackup: mismatchedDatabase,
      keyBackup: mismatchedKey,
    });
    expect(target.result.code).toBe(1);
    expect(target.result.stderr).toContain('MASTER_KEY_MISMATCH');
    expect(
      await target.db.controlPlaneState.findUnique({ where: { id: 'control-plane' } }),
    ).toMatchObject({ restoreLocked: true, generation: 8 });
    expect(await exists(target.key)).toBe(false);
  });

  it('rolls back a partially imported database when the restore controller is killed', async () => {
    const target = await newDatabase('interrupted');
    const key = join(directory, 'interrupted', 'master-key.json');
    const env = await environment(target.name, key, 'interrupted');
    let releaseGate!: () => void;
    let announceGate!: () => void;
    const held = new Promise<void>((resolve) => {
      announceGate = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gate = target.db.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(657096110)`;
        announceGate();
        await release;
      },
      { timeout: 20000 },
    );
    await held;
    const child = spawn(
      process.execPath,
      [
        resolve(root, 'scripts/restore-control-plane.mjs'),
        '--env-file',
        env,
        '--database-backup',
        databaseBackup,
        '--key-backup',
        keyBackup,
        '--target-key-file',
        key,
      ],
      { cwd: root, env: process.env, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      let waiting = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const rows = await administration.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity WHERE datname = ${target.name}
          AND application_name = 'ozz-recovery-tool' AND wait_event = 'advisory'
        `;
        if (Number(rows[0]!.count) > 0) {
          waiting = true;
          break;
        }
        await delay(25);
      }
      expect(waiting, 'restore must reach the controlled COPY lock before interruption').toBe(true);
      child.kill('SIGKILL');
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      releaseGate();
      await gate;
    }
    const deadline = Date.now() + 5000;
    let active = 1;
    while (Date.now() < deadline && active > 0) {
      const rows = await administration.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM pg_stat_activity WHERE datname = ${target.name} AND application_name = 'ozz-recovery-tool'
      `;
      active = Number(rows[0]!.count);
      if (active > 0) await delay(25);
    }
    expect(active).toBe(0);
    expect(await objectCount(target.db)).toBe(0);
    expect(await exists(key)).toBe(false);
  });
});
