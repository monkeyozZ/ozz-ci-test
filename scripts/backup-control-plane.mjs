import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  canonicalDirectory,
  configuration,
  dumpSnapshot,
  ensureAbsent,
  exportedSnapshot,
  fail,
  FORMAT_VERSION,
  hashFile,
  hashSnapshotObservation,
  isWithin,
  options,
  parseMasterKey,
  protectedFile,
  required,
  runCli,
  sha256,
  verifySealedRecords,
  writeNew,
} from './backup-helpers.mjs';

await runCli(async () => {
  const values = options({
    'database-dir': { type: 'string' },
    'key-dir': { type: 'string' },
    label: { type: 'string' },
    'master-key-file': { type: 'string' },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/backup-control-plane.mjs --env-file FILE [--compose-file compose.yaml --project NAME] --database-dir DIR --key-dir SEPARATE_DIR [--label ID] [--master-key-file FILE]',
    );
    return;
  }
  const config = await configuration(values);
  const masterKeyFile = resolve(
    required(values['master-key-file'] || config.keyFile, 'master key file'),
  );
  const keyBytes = await protectedFile(masterKeyFile);
  const masterKeys = parseMasterKey(keyBytes);
  const databaseRoot = await canonicalDirectory(
    resolve(required(values['database-dir'], 'database backup directory')),
  );
  const keyRoot = await canonicalDirectory(
    resolve(required(values['key-dir'], 'key backup directory')),
  );
  if (isWithin(databaseRoot, keyRoot) || isWithin(keyRoot, databaseRoot))
    fail(
      'BACKUP_DIRECTORIES_NOT_SEPARATE',
      'Database backups and key backups must be in separate, non-nested directories.',
    );
  const backupId =
    values.label || `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/.test(backupId))
    fail(
      'INVALID_BACKUP_ID',
      'The label must contain 6–80 ASCII letters, numbers, underscores or hyphens.',
    );
  const databaseDirectory = resolve(databaseRoot, backupId);
  const keyDirectory = resolve(keyRoot, backupId);
  await ensureAbsent(databaseDirectory);
  await ensureAbsent(keyDirectory);
  let databaseCreated = false;
  let keyCreated = false;
  let snapshot;
  let complete = false;
  try {
    await mkdir(databaseDirectory, { mode: 0o700 });
    databaseCreated = true;
    await mkdir(keyDirectory, { mode: 0o700 });
    keyCreated = true;
    snapshot = await exportedSnapshot(config);
    const metadata = snapshot.data;
    const snapshotObservation = snapshot.observation;
    verifySealedRecords(metadata.sealed, masterKeys);
    const dump = resolve(databaseDirectory, 'database.dump');
    await dumpSnapshot(config, metadata.snapshot, dump);
    await snapshot.close();
    snapshot = undefined;
    // The canaries, credential key versions and pg_dump share one exported
    // PostgreSQL snapshot; concurrent metadata writes do not split this backup.
    const databaseSha256 = await hashFile(dump);
    const masterKeySha256 = sha256(keyBytes);
    const createdAt = new Date().toISOString();
    const pair = {
      formatVersion: FORMAT_VERSION,
      status: 'complete',
      backupId,
      createdAt,
      databaseSha256,
      masterKeySha256,
      snapshotObservationSha256: hashSnapshotObservation(snapshotObservation, databaseSha256),
    };
    await writeNew(resolve(keyDirectory, 'master-key.json'), keyBytes);
    await writeNew(
      resolve(keyDirectory, 'manifest.json'),
      JSON.stringify({ ...pair, kind: 'ozz-master-key' }, null, 2) + '\n',
    );
    await writeNew(
      resolve(databaseDirectory, 'manifest.json'),
      JSON.stringify(
        {
          ...pair,
          kind: 'ozz-control-plane',
          snapshotObservation,
          schema: config.schema,
          sourceDatabase: metadata.database,
          postgresVersion: metadata.serverVersion,
          generation: metadata.state.generation,
          requiredKeyVersions: [...new Set(metadata.sealed.map((row) => row.keyVersion))].sort(
            (a, b) => a - b,
          ),
          migrations: metadata.migrations,
        },
        null,
        2,
      ) + '\n',
    );
    complete = true;
    console.log(JSON.stringify({ backupId, databaseDirectory, keyDirectory, status: 'complete' }));
  } finally {
    try {
      await snapshot?.close();
    } finally {
      if (!complete) {
        if (databaseCreated) await rm(databaseDirectory, { recursive: true, force: true });
        if (keyCreated) await rm(keyDirectory, { recursive: true, force: true });
      }
    }
  }
});
