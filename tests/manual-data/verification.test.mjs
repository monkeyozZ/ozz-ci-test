import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { writeNew } from '../../scripts/manual-data-core.mjs';
import { temporary } from './archive-fixture.mjs';
import { fixedCommand, postgresProbeSql, probes } from '../../scripts/manual-data-commands.mjs';
import {
  comparePostgres,
  compareRedis,
  expectedProof,
  postgresProof,
  redisProof,
  redisStatus,
} from '../../scripts/manual-data-verification.mjs';

const pgDefinition = { tables: [{ schema: 'public', table: 'markers' }] },
  redisDefinition = { database: 0, keys: ['marker', 'expiring'] };
const pgRaw = () => ({
  version: '17.11 (synthetic)',
  versionNumber: '170011',
  username: 'owner',
  database: 'example',
  transactionStartedAt: '2026-10-25T00:00:00.000Z',
  observedAt: '2026-10-25T00:00:00.010Z',
  tableCount: 1,
  schemaSha256: 'a'.repeat(64),
  tables: [
    {
      schema: 'public',
      table: 'markers',
      rowCount: 2,
      rowsSha256: 'b'.repeat(64),
      columnsSha256: 'c'.repeat(64),
      constraintsSha256: 'd'.repeat(64),
    },
  ],
});
const db = { connection: { username: 'owner', database: 'example' } };
test('PostgreSQL checks actual version, bounded selected rows and structural/constraint digests', () => {
  const expected = postgresProof(pgRaw(), pgDefinition, db);
  comparePostgres(expected, expected);
  for (const field of ['rowCount', 'rowsSha256', 'columnsSha256', 'constraintsSha256']) {
    const raw = pgRaw();
    raw.tables[0][field] = field === 'rowCount' ? 3 : 'e'.repeat(64);
    assert.throws(() => comparePostgres(expected, postgresProof(raw, pgDefinition, db)), {
      code: 'MANUAL_POSTGRES_DATA_MISMATCH',
    });
  }
  const many = pgRaw();
  many.tables[0].rowCount = 10001;
  assert.throws(() => postgresProof(many, pgDefinition, db), { code: 'MANUAL_POSTGRES_PROOF' });
  assert.throws(() => postgresProof({ ...pgRaw(), version: '17.10' }, pgDefinition, db), {
    code: 'MANUAL_POSTGRES_PROOF',
  });
});
test('Redis hashes values without storing bytes and compares absolute expiry across elapsed time', () => {
  const now = Date.now();
  const expected = redisProof(
    {
      observedAtMs: now,
      keys: [
        { key: 'marker', type: 'string', valueHex: 'cafe', expiresAtMs: -1 },
        { key: 'expiring', type: 'string', valueHex: 'beef', expiresAtMs: now + 100 },
      ],
    },
    redisDefinition,
  );
  assert.equal(Object.hasOwn(expected.keys[0], 'valueHex'), false);
  const after = redisProof(
    {
      observedAtMs: now + 200,
      keys: [
        { key: 'marker', type: 'string', valueHex: 'cafe', expiresAtMs: -1 },
        { key: 'expiring', type: 'none', valueHex: false, expiresAtMs: -2 },
      ],
    },
    redisDefinition,
  );
  assert.deepEqual(compareRedis(expected, after).expiredKeys, ['expiring']);
  const shifted = globalThis.structuredClone(expected);
  shifted.keys[1].expiresAtMs += 1000;
  assert.throws(() => compareRedis(expected, shifted), { code: 'MANUAL_REDIS_DATA_MISMATCH' });
  const revived = globalThis.structuredClone(expected);
  revived.observedAtMs = now + 200;
  assert.throws(() => compareRedis(expected, revived), { code: 'MANUAL_REDIS_TTL_MISMATCH' });
  const altered = globalThis.structuredClone(after);
  altered.keys[0].valueSha256 = 'a'.repeat(64);
  assert.throws(() => compareRedis(expected, altered), { code: 'MANUAL_REDIS_DATA_MISMATCH' });
});
test('Redis refuses invalid clocks, malformed proofs, wrong versions and incomplete AOF conversion', () => {
  assert.throws(() => redisProof({ observedAtMs: 0, keys: [] }, redisDefinition), {
    code: 'MANUAL_REDIS_PROOF',
  });
  assert.throws(
    () =>
      expectedProof('redis', {
        kind: 'redis-selected-string-keys-v1',
        definition: redisDefinition,
        observedAtMs: Date.now(),
        keys: [],
      }),
    { code: 'MANUAL_REDIS_PROOF' },
  );
  const status =
    '__SERVER__\nredis_version:7.4.11\n__PERSISTENCE__\nloading:0\naof_enabled:1\naof_last_write_status:ok\naof_last_bgrewrite_status:ok\naof_rewrite_in_progress:0\naof_rewrite_scheduled:0\n__APPENDONLY__\nappendonly\nyes\n__APPENDFSYNC__\nappendfsync\neverysec\n';
  assert.equal(redisStatus({ stdout: Buffer.from(status) }).aofEnabled, true);
  for (const [a, b] of [
    ['redis_version:7.4.11', 'redis_version:7.4.10'],
    ['aof_last_write_status:ok', 'aof_last_write_status:err'],
    ['aof_rewrite_in_progress:0', 'aof_rewrite_in_progress:1'],
    ['everysec', 'no'],
  ])
    assert.throws(() => redisStatus({ stdout: Buffer.from(status.replace(a, b)) }), {
      code: 'MANUAL_REDIS_PERSISTENCE',
    });
});
test('Redis string proofs accept empty bytes and reject internal collection encodings', () => {
  const definition = { database: 0, keys: ['marker'] },
    now = Date.now();
  const empty = redisProof(
    { observedAtMs: now, keys: [{ key: 'marker', type: 'string', valueHex: '', expiresAtMs: -1 }] },
    definition,
  );
  assert.equal(
    empty.keys[0].valueSha256,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.throws(
    () =>
      redisProof(
        {
          observedAtMs: now,
          keys: [{ key: 'marker', type: 'set', valueHex: '00', expiresAtMs: -1 }],
        },
        definition,
      ),
    { code: 'MANUAL_REDIS_PROOF' },
  );
});
test('PostgreSQL snapshot EXIT trap stops the real client on success and dump failure', async (t) => {
  const directory = await temporary(t);
  const stub = async (name, source) => {
    const file = join(directory, name);
    await writeNew(file, '#!/usr/bin/env python3\n' + source);
    await chmod(file, 0o700);
  };
  await stub(
    'psql',
    `import os, sys, time\nif os.environ.get('PGPASSWORD') == 'ozz-deliberately-invalid-auth-probe': sys.exit(1)\nsys.stdin.read()\nwith open(os.environ['MANUAL_STUB_PID'], 'w') as file: file.write(str(os.getpid()))\nprint('00000001-00000002-1', flush=True)\nprint('{}', flush=True)\ntime.sleep(30)\n`,
  );
  await stub(
    'pg_dump',
    `import os, sys\nif os.environ['MANUAL_STUB_DUMP_FAIL'] == '1': sys.exit(1)\nfile = next(item[7:] for item in sys.argv if item.startswith('--file='))\nwith open(file, 'wb') as output: output.write(b'PGDMPsynthetic')\n`,
  );
  await stub('pg_restore', 'import sys\nsys.exit(0)\n');
  for (const shouldFail of [false, true]) {
    const id = shouldFail
        ? 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
        : 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
      pidFile = join(directory, `${id}.pid`),
      scratch = join(directory, id);
    const code = fixedCommand('pg-backup', { operationId: id, probes: pgDefinition })
      .at(-1)
      .replaceAll(`/tmp/ozz-manual-${id}`, scratch);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-ceu', code], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        POSTGRES_USER: 'synthetic',
        POSTGRES_DB: 'synthetic',
        POSTGRES_PASSWORD: 'synthetic-only',
        MANUAL_STUB_PID: pidFile,
        MANUAL_STUB_DUMP_FAIL: shouldFail ? '1' : '0',
      },
    });
    assert.equal(result.status, shouldFail ? 1 : 0);
    const pid = Number(await readFile(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else throw error;
    }
    if (alive) process.kill(pid, 'SIGTERM');
    assert.equal(alive, false, 'the exported-snapshot psql client must be reaped, not orphaned');
  }
});
test('structured probes cannot inject SQL, commands or unsupported system targets', () => {
  for (const name of ['x;DROP TABLE markers', '$(env)', 'a"b', 'a.b', '../markers'])
    assert.throws(() => postgresProbeSql({ tables: [{ schema: 'public', table: name }] }));
  assert.throws(() =>
    probes('postgresql', { tables: [{ schema: 'pg_catalog', table: 'pg_authid' }] }),
  );
  assert.throws(() => probes('redis', { database: 16, keys: ['marker'] }));
  assert.throws(() => probes('redis', { database: 0, keys: ['$(cat /run/secret)'] }));
  assert.throws(() => fixedCommand('arbitrary-exec', { command: ['env'] }), {
    code: 'MANUAL_OPERATION_UNSUPPORTED',
  });
});
test('every fixed shell program parses and engine import commands preserve the required order/flags', () => {
  const operationId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const operations = [
    'pg-backup',
    'pg-backup-metadata',
    'pg-probe',
    'pg-start',
    'pg-import',
    'pg-stop',
    'upload',
    'validate-upload',
    'redis-probe',
    'redis-status',
    'redis-backup',
    'redis-start-empty',
    'redis-stop',
    'redis-preserve-empty',
    'redis-load-rdb',
    'redis-enable-aof',
    'files-version',
    'files-backup',
    'files-probe',
    'files-import',
  ];
  for (const operation of operations) {
    const command = fixedCommand(operation, {
      operationId,
      probes: operation.startsWith('redis') ? redisDefinition : pgDefinition,
      engine: 'postgresql',
      sha256: 'a'.repeat(64),
      sizeBytes: '10',
    });
    const parsed = spawnSync('bash', ['-n'], { input: command.at(-1), encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${operation}: ${parsed.stderr}`);
    assert.equal(command[0], 'timeout');
  }
  const imported = fixedCommand('pg-import', { operationId }).at(-1);
  assert.match(imported, /--single-transaction --exit-on-error --no-owner --no-acl/);
  assert.doesNotMatch(imported, /DROP|--clean/);
  assert.match(fixedCommand('redis-load-rdb', { operationId }).at(-1), /--appendonly no/);
  assert.match(fixedCommand('redis-enable-aof').at(-1), /aof_last_bgrewrite_status:ok/);
  const files = fixedCommand('files-import', { operationId }).at(-1);
  assert.ok(files.indexOf('find /data -mindepth 1') < files.indexOf('tar --extract'));
  assert.match(files, /--keep-old-files/);
});
