import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  collect,
  configuration,
  emptyTarget,
  emptyTargetCondition,
  ensureAbsent,
  fail,
  FORMAT_VERSION,
  hashFile,
  isWithin,
  options,
  parseMasterKey,
  protectedFile,
  query,
  quoteIdentifier,
  required,
  restoredKeyOwner,
  runCli,
  sealedSql,
  sha256,
  startPg,
  successful,
  verifySealedRecords,
  verifyBackupSnapshot,
  writeNew,
} from './backup-helpers.mjs';

async function manifest(directory, kind) {
  let data;
  try {
    data = JSON.parse(
      (await protectedFile(resolve(directory, 'manifest.json'), 1024 * 1024)).toString('utf8'),
    );
  } catch {
    fail(
      'INVALID_BACKUP_MANIFEST',
      'A complete, protected backup manifest is required in each backup directory.',
    );
  }
  if (
    data.formatVersion !== FORMAT_VERSION ||
    data.kind !== kind ||
    data.status !== 'complete' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/.test(data.backupId)
  ) {
    fail(
      'INVALID_BACKUP_MANIFEST',
      'The backup format is unsupported or the backup is incomplete.',
    );
  }
  return data;
}

async function importLocked(config, dump, backup) {
  const schema = quoteIdentifier(config.schema);
  const archive = startPg(config, 'pg_restore', ['--no-owner', '--no-privileges', '--file=-']);
  const destination = startPg(config, 'psql', ['-X', '-q', '-A', '-t', '--set=ON_ERROR_STOP=1']);
  const output = collect(destination.child.stdout);
  const input = pipeline(createReadStream(dump), archive.child.stdin);
  // Observe failures immediately while preserving the original rejection for
  // the awaited operation. No unhandled stream rejection can bypass rollback.
  void output.catch(() => {});
  void input.catch(() => {});
  try {
    // An explicit transaction deliberately has no EOF auto-commit. Even if this
    // controller is killed, psql exiting before COMMIT rolls back the import.
    destination.child.stdin.write(
      `BEGIN;\nDO $ozz_empty$ BEGIN IF ${emptyTargetCondition} THEN RAISE EXCEPTION 'OZZ_TARGET_NOT_EMPTY'; END IF; END $ozz_empty$;\n`,
    );
    await pipeline(archive.child.stdout, destination.child.stdin, { end: false });
    await input;
    await successful(archive, 'DATABASE_ARCHIVE_INVALID');
    destination.child.stdin.end(`
DO $ozz_state$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM ${schema}."ControlPlaneState" WHERE id = 'control-plane') THEN RAISE EXCEPTION 'OZZ_STATE_MISSING'; END IF;
END $ozz_state$;
UPDATE ${schema}."ControlPlaneState" SET "restoreLocked" = true, generation = generation + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'control-plane';
UPDATE ${schema}."Session" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL;
DELETE FROM ${schema}."WorkerHeartbeat";
INSERT INTO ${schema}."AuditEvent" (id, action, "resourceType", "resourceId", outcome, metadata, "createdAt")
 VALUES ('${randomUUID()}'::uuid, 'recovery.restore', 'control-plane', 'control-plane', 'succeeded', jsonb_build_object('backupId', '${backup.backupId}'), CURRENT_TIMESTAMP);
COMMIT;
SELECT 'OZZ_RESTORE_STATE_V1=' || json_build_object('generation', generation, 'restoreLocked', "restoreLocked")::text FROM ${schema}."ControlPlaneState" WHERE id = 'control-plane';
`);
    const text = await output;
    await successful(destination, 'DATABASE_RESTORE_FAILED');
    const receipt = text.split('\n').findLast((line) => line.startsWith('OZZ_RESTORE_STATE_V1='));
    if (!receipt)
      fail(
        'DATABASE_RESTORE_FAILED',
        'The committed recovery state could not be read. Keep this target offline.',
      );
    return JSON.parse(receipt.slice('OZZ_RESTORE_STATE_V1='.length));
  } catch (error) {
    // No COMMIT has been sent after a failed pg_restore. Closing the target
    // connection rolls back every imported object and record together.
    archive.stop();
    destination.stop();
    await Promise.allSettled([archive.done, destination.done, input, output]);
    throw error;
  }
}

await runCli(async () => {
  const values = options({
    'database-backup': { type: 'string' },
    'key-backup': { type: 'string' },
    'target-key-file': { type: 'string' },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/restore-control-plane.mjs --env-file EMPTY_TARGET.env [--compose-file compose.yaml --project NAME] --database-backup DIR/ID --key-backup SEPARATE_DIR/ID --target-key-file NEW_FILE',
    );
    return;
  }
  const config = await configuration(values);
  const keyOwner = restoredKeyOwner(config);
  const databaseDirectory = await realpath(
    resolve(required(values['database-backup'], 'database backup directory')),
  );
  const keyDirectory = await realpath(
    resolve(required(values['key-backup'], 'key backup directory')),
  );
  if (isWithin(databaseDirectory, keyDirectory) || isWithin(keyDirectory, databaseDirectory))
    fail(
      'BACKUP_DIRECTORIES_NOT_SEPARATE',
      'Database and key backup directories must be separate.',
    );
  const backup = await manifest(databaseDirectory, 'ozz-control-plane');
  const keyManifest = await manifest(keyDirectory, 'ozz-master-key');
  if (
    backup.backupId !== keyManifest.backupId ||
    backup.databaseSha256 !== keyManifest.databaseSha256 ||
    backup.masterKeySha256 !== keyManifest.masterKeySha256
  ) {
    fail(
      'BACKUP_PAIR_MISMATCH',
      'The database and key backups do not belong to the same completed backup.',
    );
  }
  const snapshotObservation = verifyBackupSnapshot(backup, keyManifest);
  if (config.schema !== backup.schema)
    fail(
      'SCHEMA_MISMATCH',
      'Use the source schema in the target configuration; this tool does not rename database schemas.',
    );
  if (config.database === backup.sourceDatabase)
    fail(
      'SOURCE_DATABASE_REFUSED',
      'Choose a new database name for recovery. The source database is never a restore target.',
    );
  const dump = resolve(databaseDirectory, 'database.dump');
  const dumpInfo = await lstat(dump);
  if (!dumpInfo.isFile() || (dumpInfo.mode & 0o077) !== 0)
    fail('UNSAFE_FILE', 'The database archive must be a regular owner-only file.');
  const keyBytes = await protectedFile(resolve(keyDirectory, 'master-key.json'));
  const masterKeys = parseMasterKey(keyBytes);
  if (
    sha256(keyBytes) !== backup.masterKeySha256 ||
    (await hashFile(dump)) !== backup.databaseSha256
  )
    fail(
      'BACKUP_CHECKSUM_MISMATCH',
      'Backup bytes do not match the recorded checksums. Nothing was imported.',
    );
  if (
    !Array.isArray(backup.requiredKeyVersions) ||
    backup.requiredKeyVersions.some((version) => !masterKeys.keys.has(version))
  )
    fail('MASTER_KEY_MISMATCH', 'The key backup is missing a retained key version.');
  const requestedKeyFile = resolve(required(values['target-key-file'], 'new target key file'));
  await mkdir(dirname(requestedKeyFile), { recursive: true, mode: 0o700 });
  const targetKeyFile = resolve(
    await realpath(dirname(requestedKeyFile)),
    basename(requestedKeyFile),
  );
  if (isWithin(databaseDirectory, targetKeyFile))
    fail('KEY_DESTINATION_NOT_SEPARATE', 'Restore the key outside the database backup directory.');
  await ensureAbsent(targetKeyFile);
  await ensureAbsent(`${targetKeyFile}.restore.json`);
  await emptyTarget(config);
  const state = await importLocked(config, dump, backup);
  if (!state.restoreLocked || state.generation !== backup.generation + 1)
    fail(
      'RESTORE_STATE_INVALID',
      'The imported recovery fence could not be verified. Keep this target offline.',
    );
  // A damaged/mismatched canary leaves the committed target locked, without a
  // published key file. Applications must not run against an unverified target.
  const sealed = await query(config, `SELECT ${sealedSql(config.schema)};`);
  verifySealedRecords(sealed, masterKeys);
  await writeNew(targetKeyFile, keyBytes, keyOwner);
  const receipt = {
    formatVersion: FORMAT_VERSION,
    backupId: backup.backupId,
    restoredAt: new Date().toISOString(),
    database: config.database,
    schema: config.schema,
    generation: state.generation,
    restoreLocked: true,
    requiredRestoreMode: 'true',
    ...(snapshotObservation ? { snapshotObservationSha256: backup.snapshotObservationSha256 } : {}),
  };
  await writeNew(`${targetKeyFile}.restore.json`, JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    JSON.stringify({
      ...receipt,
      targetKeyFile,
      nextStep:
        'Start with RESTORE_MODE=true, verify the restored state, then use recovery:unlock --reconciled with RESTORE_MODE=false. Old generation tasks remain fenced.',
    }),
  );
});
