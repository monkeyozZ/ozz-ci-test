import { randomBytes } from 'node:crypto';
import { mkdir, open, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const secrets = resolve(root, '.secrets');
await mkdir(secrets, { recursive: true, mode: 0o700 });
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const writeNew = async (file, contents) => {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
};

const envFile = resolve(root, '.env');
const keyFile = resolve(secrets, 'master-key.json');
if (await exists(envFile)) {
  console.log('Existing .env preserved. Setup never replaces existing credentials or keys.');
  process.exit(0);
}
if (await exists(keyFile)) {
  throw new Error(
    'A master key already exists without .env. Restore the matching environment configuration instead of replacing the key.',
  );
}

await writeNew(
  keyFile,
  JSON.stringify({ activeVersion: 1, keys: { 1: randomBytes(32).toString('base64') } }, null, 2) +
    '\n',
);
await writeNew(resolve(secrets, 'admin-password'), randomBytes(24).toString('base64url') + '\n');
const postgresPassword = randomBytes(24).toString('base64url');
const redisPassword = randomBytes(24).toString('base64url');
const lines = [
  'NODE_ENV=development',
  'APP_ORIGIN=http://127.0.0.1:5173',
  'HOST=127.0.0.1',
  'PORT=3000',
  'WORKER_HEALTH_PORT=3001',
  'POSTGRES_USER=ozz',
  'POSTGRES_DB=ozz',
  `POSTGRES_PASSWORD=${postgresPassword}`,
  `REDIS_PASSWORD=${redisPassword}`,
  `DATABASE_URL=postgresql://ozz:${postgresPassword}@127.0.0.1:54320/ozz?schema=public&connection_limit=5&pool_timeout=5&connect_timeout=5`,
  `REDIS_URL=redis://:${redisPassword}@127.0.0.1:56379/0`,
  `MASTER_KEY_FILE=${JSON.stringify(keyFile)}`,
  'RESTORE_MODE=false',
  'LOG_LEVEL=info',
  'SESSION_TTL_SECONDS=28800',
  'TRUSTED_PROXY_CIDRS=',
  'TASK_LOG_RETENTION_DAYS=7',
  'TASK_LOG_MAX_BYTES=16384',
];
await writeNew(envFile, lines.join('\n') + '\n');
console.log(
  'Created protected .env, .secrets/master-key.json and .secrets/admin-password. No secret values were printed.',
);
console.log(
  'Next: pnpm dev:infra, pnpm db:migrate, pnpm build, then pnpm admin:init --username admin --password-file .secrets/admin-password',
);
