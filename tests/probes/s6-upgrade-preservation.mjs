import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { PrismaClient } from '../../packages/database/dist/index.js';

// Read-only fingerprints around the separately executed additive S6 migration.
// Never exports rows, plaintext credentials, environment contents or key bytes.
const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/local-lab/s6-upgrade');
const mode = process.argv[2];
const file =
  mode === 'capture'
    ? resolve(
        directory,
        `before-${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}.json`,
      )
    : resolve(process.argv[3] ?? '');
const expectedMigration = '202610260004_s6_git_build';
const db = new PrismaClient();
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const quote = (value) => {
  requireValue(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value), 'S6_UPGRADE_IDENTIFIER_INVALID');
  return `"${value}"`;
};
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

async function protectedFingerprint(path) {
  const info = await lstat(path);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
    'S6_UPGRADE_PRIVATE_FILE_INVALID',
  );
  return { sha256: sha(await readFile(path)), bytes: info.size, mode: info.mode & 0o777 };
}

async function rowsFingerprint(tx, table, columns, where = '') {
  const values = await tx.$queryRawUnsafe(
    `SELECT to_jsonb(row)::text AS payload FROM (SELECT ${columns.map(quote).join(',')} FROM public.${quote(table)}${where}) row ORDER BY payload`,
  );
  const hash = createHash('sha256');
  for (const value of values) hash.update(value.payload).update('\n');
  return { rows: values.length, sha256: hash.digest('hex') };
}

try {
  process.umask(0o077);
  requireValue(['capture', 'verify'].includes(mode), 'S6_UPGRADE_MODE_INVALID');
  requireValue(
    file.startsWith(`${directory}/before-`) && file.endsWith('.json'),
    'S6_UPGRADE_BASELINE_PATH_INVALID',
  );
  const runtime = JSON.parse(await readFile(resolve(root, '.local/s3-runtime.json'), 'utf8'));
  requireValue(!alive(runtime.api) && !alive(runtime.worker), 'S6_UPGRADE_RUNTIME_MUST_BE_STOPPED');
  const baselineSource = JSON.parse(
    await readFile(resolve(root, 'docs/acceptance/s6-source-baseline.json'), 'utf8'),
  );
  for (const historical of baselineSource.historicalMigrations)
    requireValue(
      sha(await readFile(resolve(root, historical.path))) === historical.sha256,
      'S6_UPGRADE_HISTORICAL_MIGRATION_CHANGED',
    );
  const keyPath = process.env.MASTER_KEY_FILE;
  requireValue(
    typeof keyPath === 'string' && keyPath.length > 0,
    'S6_UPGRADE_MASTER_KEY_PATH_REQUIRED',
  );
  const privateFiles = {
    environment: await protectedFingerprint(resolve(root, '.env')),
    masterKey: await protectedFingerprint(isAbsolute(keyPath) ? keyPath : resolve(root, keyPath)),
  };
  const newMigrationSha256 = sha(
    await readFile(
      resolve(root, 'packages/database/prisma/migrations', expectedMigration, 'migration.sql'),
    ),
  );
  const before = mode === 'verify' ? JSON.parse(await readFile(file, 'utf8')) : null;
  const result = await db.$transaction(
    async (tx) => {
      const schema = await tx.$queryRawUnsafe('SELECT current_schema() AS name');
      requireValue(schema[0]?.name === 'public', 'S6_UPGRADE_PUBLIC_SCHEMA_REQUIRED');
      const active = await tx.$queryRawUnsafe(
        `SELECT (SELECT count(*)::int FROM public."Deployment" WHERE status IN ('queued','running')) AS deployments, (SELECT count(*)::int FROM public."Operation" WHERE status IN ('queued','running')) AS operations`,
      );
      requireValue(
        active[0]?.deployments === 0 && active[0]?.operations === 0,
        'S6_UPGRADE_TASKS_ACTIVE',
      );
      const migrations = await tx.$queryRawUnsafe(
        'SELECT migration_name AS name, checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      );
      const allMigrations = await tx.$queryRawUnsafe(
        'SELECT count(*)::int AS count FROM public._prisma_migrations',
      );
      requireValue(allMigrations[0].count === migrations.length, 'S6_UPGRADE_INCOMPLETE_MIGRATION');
      if (mode === 'capture') {
        requireValue(
          !migrations.some((entry) => entry.name === expectedMigration),
          'S6_UPGRADE_ALREADY_APPLIED',
        );
        const tables = await tx.$queryRawUnsafe(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name",
        );
        const fingerprints = [];
        for (const table of tables) {
          const columns = (
            await tx.$queryRawUnsafe(
              'SELECT column_name AS name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',
              'public',
              table.name,
            )
          ).map((entry) => entry.name);
          fingerprints.push({
            table: table.name,
            columns,
            ...(await rowsFingerprint(tx, table.name, columns)),
          });
        }
        return {
          version: 1,
          capturedAt: new Date().toISOString(),
          expectedMigration,
          newMigrationSha256,
          historicalMigrationCount: baselineSource.historicalMigrations.length,
          migrations,
          privateFiles,
          tables: fingerprints,
        };
      }
      requireValue(
        before.newMigrationSha256 === newMigrationSha256,
        'S6_UPGRADE_MIGRATION_CHANGED_AFTER_CAPTURE',
      );
      requireValue(
        JSON.stringify(before.privateFiles) === JSON.stringify(privateFiles),
        'S6_UPGRADE_PRIVATE_FILES_CHANGED',
      );
      requireValue(
        migrations.length === before.migrations.length + 1 &&
          migrations.some(
            (entry) => entry.name === expectedMigration && entry.checksum === newMigrationSha256,
          ),
        'S6_UPGRADE_MIGRATION_SET_INVALID',
      );
      for (const previous of before.migrations)
        requireValue(
          migrations.some(
            (entry) => entry.name === previous.name && entry.checksum === previous.checksum,
          ),
          'S6_UPGRADE_HISTORY_CHANGED',
        );
      const checks = [];
      for (const table of before.tables) {
        const actual = await rowsFingerprint(tx, table.table, table.columns);
        requireValue(
          actual.rows === table.rows && actual.sha256 === table.sha256,
          'S6_UPGRADE_OLD_ROWS_CHANGED',
        );
        checks.push({ table: table.table, rows: actual.rows, status: 'passed' });
      }
      const defaults = await tx.$queryRawUnsafe(
        `SELECT (SELECT count(*)::int FROM public."Service" WHERE "sourceKind" <> 'image') AS non_image, (SELECT count(*)::int FROM public."Deployment" WHERE "initiatorKind" <> 'admin' OR "artifactId" IS NOT NULL OR "reuseArtifactId" IS NOT NULL OR "sourceRevisionId" IS NOT NULL OR "webhookDeliveryId" IS NOT NULL OR "webhookTargetId" IS NOT NULL) AS changed_deployments`,
      );
      requireValue(
        defaults[0].non_image === 0 && defaults[0].changed_deployments === 0,
        'S6_UPGRADE_NEW_COLUMN_DEFAULT_INVALID',
      );
      return {
        version: 1,
        status: 'passed',
        checkedAt: new Date().toISOString(),
        baseline: file.slice(root.length + 1),
        migration: expectedMigration,
        migrationSha256: newMigrationSha256,
        unchangedHistoricalMigrations: before.migrations.length,
        unchangedEnvironmentAndMasterKey: true,
        preservedTables: checks,
        oldSourceDefaultsValid: true,
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 60_000 },
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = mode === 'capture' ? file : file.replace('/before-', '/verified-');
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      mode,
      status: 'passed',
      tables: (result.tables ?? result.preservedTables).length,
      report: output,
    }),
  );
} catch (error) {
  console.error(
    /^S6_UPGRADE_[A-Z0-9_]+$/u.test(error.message ?? '')
      ? error.message
      : 'S6_UPGRADE_PRESERVATION_FAILED',
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
