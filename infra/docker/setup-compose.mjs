import { randomBytes } from 'node:crypto';
import { chown, mkdir, open, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { domainToASCII } from 'node:url';
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: {
      hostname: { type: 'string' },
      directory: { type: 'string', default: '.local/production' },
      project: { type: 'string', default: 'ozz' },
      'http-port': { type: 'string', default: '80' },
      'https-port': { type: 'string', default: '443' },
      'bind-address': { type: 'string', default: '0.0.0.0' },
      'bootstrap-image': { type: 'string' },
      'image-prefix': { type: 'string', default: 'ozz' },
      'acme-email': { type: 'string', default: '' },
    },
  });
  const hostname = domainToASCII(values.hostname || '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname)) {
    throw new Error('Pass --hostname with a DNS hostname, without a scheme, port or path');
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values.project))
    throw new Error('Invalid Compose project name');
  const httpPort = Number(values['http-port']);
  const httpsPort = Number(values['https-port']);
  if (
    [httpPort, httpsPort].some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
    httpPort === httpsPort
  ) {
    throw new Error('HTTP and HTTPS ports must be distinct integers between 1 and 65535');
  }
  if (!isIP(values['bind-address'])) throw new Error('Bind address must be an IP address');
  for (const value of [values['bootstrap-image'], values['image-prefix']]) {
    if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(value))
      throw new Error('Invalid image reference');
  }
  if (values['acme-email'] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values['acme-email']))
    throw new Error('Invalid ACME email');
  const directory = resolve(values.directory);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  // An existing installation is never changed by this initializer.
  await mkdir(directory, { mode: 0o700 });
  try {
    const secretDirectory = resolve(directory, 'secrets');
    await mkdir(secretDirectory, { mode: 0o700 });
    const writeNew = async (file, contents) => {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const keyFile = resolve(secretDirectory, 'master-key.json');
    const passwordFile = resolve(secretDirectory, 'admin-password');
    await writeNew(
      keyFile,
      JSON.stringify(
        { activeVersion: 1, keys: { 1: randomBytes(32).toString('base64') } },
        null,
        2,
      ) + '\n',
    );
    await writeNew(passwordFile, randomBytes(24).toString('base64url') + '\n');
    const uid = process.platform === 'linux' && process.getuid?.() ? process.getuid() : 1000;
    const gid = process.platform === 'linux' && process.getuid?.() ? process.getgid() : 1000;
    if (process.platform === 'linux' && process.getuid?.() === 0) {
      await chown(keyFile, uid, gid);
      await chown(passwordFile, uid, gid);
    }
    const origin = `https://${hostname}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
    const lines = [
      `COMPOSE_PROJECT_NAME=${values.project}`,
      'NODE_ENV=production',
      `CONSOLE_HOST=${hostname}`,
      `APP_ORIGIN=${origin}`,
      `ACME_EMAIL=${values['acme-email']}`,
      `BIND_ADDRESS=${values['bind-address']}`,
      `HTTP_PORT=${httpPort}`,
      `HTTPS_PORT=${httpsPort}`,
      `OZZ_RUNTIME_UID=${uid}`,
      `OZZ_RUNTIME_GID=${gid}`,
      `OZZ_IMAGE_PREFIX=${values['image-prefix']}`,
      'OZZ_IMAGE_TAG=0.1.0',
      ...(values['bootstrap-image'] ? [`BOOTSTRAP_IMAGE=${values['bootstrap-image']}`] : []),
      'POSTGRES_USER=ozz',
      'POSTGRES_DB=ozz',
      `POSTGRES_PASSWORD=${randomBytes(24).toString('base64url')}`,
      `REDIS_PASSWORD=${randomBytes(24).toString('base64url')}`,
      'DATABASE_SCHEMA=public',
      `MASTER_KEY_FILE=${JSON.stringify(keyFile)}`,
      'RESTORE_MODE=false',
      'LOG_LEVEL=info',
      'SESSION_TTL_SECONDS=28800',
      'TASK_LOG_RETENTION_DAYS=7',
      'TASK_LOG_MAX_BYTES=16384',
    ];
    await writeNew(resolve(directory, '.env'), lines.join('\n') + '\n');
    console.log(
      JSON.stringify({
        envFile: resolve(directory, '.env'),
        masterKeyFile: keyFile,
        adminPasswordFile: passwordFile,
        origin,
        project: values.project,
      }),
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

void main().catch((error) => {
  console.error(
    error?.code === 'EEXIST'
      ? 'The output directory already exists; no configuration or key was replaced.'
      : 'Deployment initialization failed. Check the hostname, ports, output directory and file permissions.',
  );
  process.exitCode = 1;
});
