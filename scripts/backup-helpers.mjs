import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { hrtime } from 'node:process';
import { pipeline } from 'node:stream/promises';
import { clearTimeout } from 'node:timers';
import { parseArgs, parseEnv } from 'node:util';
import { SnapshotObservationError, validateSnapshotObservation } from './backup-snapshot.mjs';

export {
  hashSnapshotObservation,
  validateSnapshotObservation,
  verifyBackupSnapshot,
} from './backup-snapshot.mjs';

export const DEFAULT_TOOLS_IMAGE =
  'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
export const FORMAT_VERSION = 1;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

export class RecoveryToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecoveryToolError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new RecoveryToolError(code, message);
}

export async function runCli(work) {
  try {
    if (Number(process.versions.node.split('.')[0]) !== 24)
      fail('NODE_24_REQUIRED', 'Run this command with the project Node 24 runtime.');
    await work();
  } catch (error) {
    const known = error instanceof RecoveryToolError || error instanceof SnapshotObservationError;
    console.error(
      JSON.stringify({
        code: known ? error.code : 'RECOVERY_TOOL_FAILED',
        message: known
          ? error.message
          : 'Backup or restore could not finish. Check protected files, Docker, database availability and free disk space; no automatic unlock was performed.',
      }),
    );
    process.exitCode = 1;
  }
}

export function options(extra) {
  try {
    return parseArgs({
      options: {
        'env-file': { type: 'string' },
        'compose-file': { type: 'string' },
        project: { type: 'string' },
        'tools-image': { type: 'string' },
        schema: { type: 'string' },
        help: { type: 'boolean', default: false },
        ...extra,
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    fail(
      'INVALID_ARGUMENTS',
      'Invalid arguments. Use --help to see the required paths and connection options.',
    );
  }
}

export function required(value, name) {
  if (typeof value !== 'string' || !value.trim())
    fail('MISSING_ARGUMENT', `A ${name} value is required.`);
  return value;
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value))
    fail(
      'INVALID_SCHEMA',
      'The schema must be a PostgreSQL identifier of at most 63 ASCII characters.',
    );
  return value;
}

export function quoteIdentifier(value) {
  return `"${identifier(value)}"`;
}

export function isWithin(parent, child) {
  const path = relative(parent, child);
  return !path || (!path.startsWith('..') && !isAbsolute(path));
}

export async function protectedFile(file, maximum = 65536) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > maximum || (info.mode & 0o077) !== 0) {
    fail(
      'UNSAFE_FILE',
      'Private inputs must be regular files with owner-only permissions and a bounded size.',
    );
  }
  return readFile(file);
}

export async function writeNew(file, contents, owner) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    if (owner) await handle.chown(owner.uid, owner.gid);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// File-backed Docker secrets retain their Linux owner. Resolve the destination
// identity before importing a database, and only chown a newly created key.
export function restoredKeyOwner(config) {
  if (!config.composeFile || process.platform !== 'linux') return undefined;
  const parse = (value) => {
    if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > 4294967294) {
      fail('INVALID_RUNTIME_OWNER', 'OZZ_RUNTIME_UID and OZZ_RUNTIME_GID must be valid Unix IDs.');
    }
    return Number(value);
  };
  const owner = {
    uid: parse(config.env.OZZ_RUNTIME_UID || '1000'),
    gid: parse(config.env.OZZ_RUNTIME_GID || '1000'),
  };
  if (process.getuid() === 0) return owner;
  if (process.getuid() !== owner.uid) {
    fail(
      'RUNTIME_KEY_OWNER_MISMATCH',
      'Run recovery as the configured runtime UID or as root so the restored 0600 key remains readable by the service.',
    );
  }
  return undefined;
}

export async function ensureAbsent(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(
    'OUTPUT_EXISTS',
    'An output path already exists. Choose a new destination; existing files are never replaced.',
  );
}

export async function canonicalDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const target = await realpath(path);
  if (!(await lstat(target)).isDirectory())
    fail('INVALID_DIRECTORY', 'A backup destination must be a directory.');
  return target;
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function parseMasterKey(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (
      !Number.isSafeInteger(value.activeVersion) ||
      value.activeVersion < 1 ||
      !value.keys ||
      Array.isArray(value.keys)
    )
      throw new Error();
    const keys = new Map();
    for (const [version, encoded] of Object.entries(value.keys)) {
      if (!/^[1-9]\d*$/.test(version) || typeof encoded !== 'string') throw new Error();
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error();
      keys.set(Number(version), key);
    }
    if (!keys.has(value.activeVersion)) throw new Error();
    return { activeVersion: value.activeVersion, keys };
  } catch {
    fail('INVALID_MASTER_KEY', 'The master key file is invalid. No replacement key was generated.');
  }
}

/** This recovery-format verifier deliberately needs only Node's built-in crypto. */
export function verifySealedRecords(records, keys) {
  try {
    for (const record of records) {
      const key = keys.keys.get(record.keyVersion);
      if (!key) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'base64'));
      decipher.setAAD(Buffer.from(`ozz.secret.v1:${record.kind}`));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(record.encryptedPayload, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      );
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      if (record.kind === 'key-verification' && value.purpose !== 'ozz-key-verification-v1')
        throw new Error();
    }
  } catch {
    fail(
      'MASTER_KEY_MISMATCH',
      'The supplied key cannot authenticate every retained key version. Use the matching key backup.',
    );
  }
}

export async function configuration(values) {
  const envFile = values['env-file'] ? resolve(values['env-file']) : null;
  const env = {
    ...process.env,
    ...(envFile ? parseEnv((await protectedFile(envFile)).toString('utf8')) : {}),
  };
  const composeFile = values['compose-file'] ? resolve(values['compose-file']) : null;
  let database;
  let host;
  let port;
  let username;
  let password;
  let schema;
  let sslmode;
  if (composeFile) {
    database = required(env.POSTGRES_DB, 'POSTGRES_DB');
    username = required(env.POSTGRES_USER, 'POSTGRES_USER');
    password = required(env.POSTGRES_PASSWORD, 'POSTGRES_PASSWORD');
    host = '/var/run/postgresql';
    port = '5432';
    schema = values.schema || env.DATABASE_SCHEMA || 'public';
    sslmode = 'disable';
  } else {
    let url;
    try {
      url = new URL(required(env.DATABASE_URL, 'DATABASE_URL'));
    } catch {
      fail(
        'INVALID_DATABASE_CONFIGURATION',
        'Provide a valid PostgreSQL DATABASE_URL in the protected environment file.',
      );
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol))
      fail('INVALID_DATABASE_CONFIGURATION', 'DATABASE_URL must point to PostgreSQL.');
    database = decodeURIComponent(url.pathname.slice(1));
    host = url.hostname.replace(/^\[|\]$/g, '');
    port = url.port || '5432';
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    schema = values.schema || url.searchParams.get('schema') || 'public';
    sslmode = url.searchParams.get('sslmode') || 'prefer';
    if (!database || !username || !password)
      fail(
        'INVALID_DATABASE_CONFIGURATION',
        'DATABASE_URL must include the target database and credentials.',
      );
  }
  schema = identifier(schema);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const hostNetwork = !composeFile && loopback && process.platform === 'linux';
  if (!composeFile && loopback && !hostNetwork) host = 'host.docker.internal';
  const pg = {
    PGHOST: host,
    PGPORT: port,
    PGUSER: username,
    PGPASSWORD: password,
    PGDATABASE: database,
    PGSSLMODE: sslmode,
    PGCONNECT_TIMEOUT: '5',
    PGAPPNAME: 'ozz-recovery-tool',
    PGOPTIONS: '-c idle_in_transaction_session_timeout=900000',
  };
  const base = composeFile
    ? [
        'compose',
        ...(envFile ? ['--env-file', envFile] : []),
        '-f',
        composeFile,
        ...(values.project ? ['--project-name', values.project] : []),
        'exec',
        '-T',
      ]
    : [
        'run',
        '--rm',
        '--pull=never',
        '-i',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=16m',
        ...(hostNetwork ? ['--network', 'host'] : []),
      ];
  for (const name of Object.keys(pg)) base.push(composeFile ? '-e' : '--env', name);
  base.push(
    composeFile ? 'postgres' : values['tools-image'] || env.POSTGRES_IMAGE || DEFAULT_TOOLS_IMAGE,
  );
  return {
    env,
    envFile,
    schema,
    database,
    composeFile,
    base,
    commandEnv: { ...env, ...pg },
    keyFile: env.MASTER_KEY_FILE
      ? resolve(envFile ? dirname(envFile) : process.cwd(), env.MASTER_KEY_FILE)
      : null,
  };
}

export function startPg(config, program, args = []) {
  if (!['psql', 'pg_dump', 'pg_restore'].includes(program))
    throw new Error('Invalid PostgreSQL client');
  const child = spawn('docker', [...config.base, program, ...args], {
    env: config.commandEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // stderr can include connection details. Consume it without forwarding it.
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
  timer.unref();
  const done = new Promise((resolve) => {
    child.once('error', () => resolve({ code: -1, signal: null }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  return { child, done, stop: () => child.kill('SIGKILL') };
}

export async function successful(process, code = 'POSTGRES_CLIENT_FAILED') {
  const result = await process.done;
  if (result.code !== 0)
    fail(
      code,
      'The PostgreSQL client did not complete. Check Docker, database access, version compatibility and available disk space.',
    );
}

export async function collect(stream) {
  const buffers = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > MAX_METADATA_BYTES)
      fail('METADATA_LIMIT', 'Recovery metadata exceeded its supported size.');
    buffers.push(chunk);
  }
  return Buffer.concat(buffers).toString('utf8');
}

export async function query(config, sql) {
  const process = startPg(config, 'psql', ['-X', '-q', '-A', '-t', '--set=ON_ERROR_STOP=1']);
  try {
    process.child.stdin.end(sql);
    const output = await collect(process.child.stdout);
    await successful(process);
    return JSON.parse(output.trim());
  } catch (error) {
    process.stop();
    await process.done;
    throw error;
  }
}

export function sealedSql(schema) {
  const name = quoteIdentifier(schema);
  return `(WITH records AS (
    SELECT "keyVersion", "encryptedPayload", "nonce", "tag", 'key-verification'::text AS kind FROM ${name}."KeyVerification"
    UNION ALL
    (SELECT DISTINCT ON ("keyVersion") "keyVersion", "encryptedPayload", "nonce", "tag", "kind"::text AS kind
     FROM ${name}."SecretReference" ORDER BY "keyVersion", "createdAt" DESC)
  ) SELECT COALESCE(json_agg(json_build_object('keyVersion', "keyVersion", 'encryptedPayload', encode("encryptedPayload", 'base64'), 'nonce', encode("nonce", 'base64'), 'tag', encode("tag", 'base64'), 'kind', kind)), '[]'::json) FROM records)`;
}

export async function exportedSnapshot(config) {
  const name = quoteIdentifier(config.schema);
  const process = startPg(config, 'psql', ['-X', '-q', '-A', '-t', '--set=ON_ERROR_STOP=1']);
  let content = '';
  let settled = false;
  let received;
  const metadata = new Promise((resolve, reject) => {
    process.child.stdout.on('data', (chunk) => {
      if (settled) return;
      content += chunk.toString('utf8');
      if (content.length > MAX_METADATA_BYTES) {
        settled = true;
        reject(
          new RecoveryToolError('METADATA_LIMIT', 'Recovery metadata exceeded its supported size.'),
        );
        return;
      }
      if (content.includes('\n')) {
        settled = true;
        received = { at: new Date().toISOString(), nanoseconds: hrtime.bigint() };
        try {
          resolve(JSON.parse(content.slice(0, content.indexOf('\n'))));
        } catch {
          reject(
            new RecoveryToolError(
              'SNAPSHOT_FAILED',
              'Could not establish a consistent database snapshot.',
            ),
          );
        }
      }
    });
    void process.done.then(() => {
      if (!settled) {
        settled = true;
        reject(
          new RecoveryToolError(
            'SNAPSHOT_FAILED',
            'Could not establish a consistent database snapshot.',
          ),
        );
      }
    });
  });
  const requested = { at: new Date().toISOString(), nanoseconds: hrtime.bigint() };
  const clockId = randomUUID();
  // This first clock query is outside the repeatable-read transaction. A clock
  // query inside that transaction would itself acquire the snapshot, making it
  // an invalid lower bound. The exported snapshot is acquired by the next SELECT.
  process.child.stdin
    .write(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ozz_snapshot_before \\gset
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object(
 'snapshot', pg_export_snapshot(), 'database', current_database(), 'serverVersion', current_setting('server_version_num')::int,
 'pgSnapshot', pg_current_snapshot()::text,
 'snapshotBefore', :'ozz_snapshot_before',
 'snapshotAfter', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'state', (SELECT row_to_json(state) FROM ${name}."ControlPlaneState" state WHERE id = 'control-plane'),
 'migrations', (SELECT COALESCE(json_agg(json_build_object('name', migration_name, 'checksum', checksum) ORDER BY started_at), '[]'::json) FROM ${name}."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
 'incompleteMigrations', (SELECT count(*) FROM ${name}."_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL),
 'sealed', ${sealedSql(config.schema)}
);\n`);
  try {
    const data = await metadata;
    if (
      !/^[0-9a-f-]+$/i.test(data.snapshot) ||
      !data.state ||
      !Number.isInteger(data.state.generation) ||
      data.incompleteMigrations > 0
    ) {
      fail(
        'UNSTABLE_DATABASE',
        'The control-plane schema is not initialized or a migration is unfinished.',
      );
    }
    if (Math.floor(data.serverVersion / 10000) !== 17)
      fail(
        'POSTGRES_VERSION_MISMATCH',
        'These S1 recovery tools require PostgreSQL 17 and its matching client tools.',
      );
    return {
      data,
      observation: validateSnapshotObservation({
        formatVersion: 1,
        isolationLevel: 'repeatable-read',
        readOnly: true,
        exportId: data.snapshot,
        pgSnapshot: data.pgSnapshot,
        databaseTimeBounds: {
          before: data.snapshotBefore,
          after: data.snapshotAfter,
          ordered: data.snapshotBefore <= data.snapshotAfter,
        },
        clientObservation: {
          clockId,
          requestStartedAt: requested.at,
          metadataReceivedAt: received.at,
          elapsedNanoseconds: String(received.nanoseconds - requested.nanoseconds),
        },
        exactAcquisitionTimeKnown: false,
      }),
      async close() {
        process.child.stdin.end('ROLLBACK;\n');
        await successful(process);
      },
    };
  } catch (error) {
    process.stop();
    await process.done;
    throw error;
  }
}

export async function dumpSnapshot(config, snapshot, file) {
  const process = startPg(config, 'pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--snapshot',
    snapshot,
  ]);
  try {
    process.child.stdin.end();
    await pipeline(process.child.stdout, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    await successful(process, 'DATABASE_BACKUP_FAILED');
    const handle = await open(file, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    process.stop();
    await process.done;
    throw error;
  }
}

export const emptyTargetCondition = `
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public', 'information_schema'))
  OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
  OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
  OR EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')`;

export async function emptyTarget(config) {
  const result = await query(
    config,
    `SELECT json_build_object('empty', NOT (${emptyTargetCondition}), 'database', current_database(), 'serverVersion', current_setting('server_version_num')::int);`,
  );
  if (!result.empty)
    fail(
      'TARGET_NOT_EMPTY',
      'Restore requires an empty, separate PostgreSQL database. Existing objects are never overwritten.',
    );
  if (Math.floor(result.serverVersion / 10000) !== 17)
    fail('POSTGRES_VERSION_MISMATCH', 'The restore target must run PostgreSQL 17.');
  return result;
}
