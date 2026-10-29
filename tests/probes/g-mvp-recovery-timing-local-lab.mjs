import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { cp, mkdir, open, readFile, statfs, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { createServer as netServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { protectedFile } from '../../scripts/backup-helpers.mjs';
import { summarizeRecoveryTiming } from './support/g-mvp-recovery-timing.mjs';

const root = resolve(import.meta.dirname, '../..');
const owner = 'ozz-g-mvp-recovery-timing-v1';
const redisImage = 'redis@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99';
const postgresImage =
  'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const execute = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) => JSON.stringify(value, null, 2) + '\n';

function requireValue(value, code) {
  if (!value) throw new Error(`GMVP_TIMING_${code}`);
}

async function port() {
  const server = netServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const selected = server.address().port;
  await new Promise((accept) => server.close(accept));
  return selected;
}

async function response(url, { body, headers = {}, method = 'GET', ca } = {}) {
  const content = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((accept, reject) => {
    const request = (url.startsWith('https:') ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        method,
        ca,
        rejectUnauthorized: true,
        signal: globalThis.AbortSignal.timeout(5000),
        headers: {
          ...headers,
          ...(content
            ? { 'content-type': 'application/json', 'content-length': content.length }
            : {}),
        },
      },
      (reply) => {
        const chunks = [];
        let bytes = 0;
        reply.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) reply.destroy(new Error('GMVP_TIMING_HTTP_SIZE_LIMIT'));
          else chunks.push(chunk);
        });
        reply.once('error', reject);
        reply.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let value;
          try {
            value = JSON.parse(text);
          } catch {
            value = null;
          }
          accept({ status: reply.statusCode, headers: reply.headers, value, text });
        });
      },
    );
    request.once('error', reject);
    request.end(content);
  });
}

export async function runRecoveryTiming(sourceEnvFile = '.env') {
  requireValue(process.versions.node.startsWith('24.'), 'NODE_24_REQUIRED');
  process.umask(0o077);
  const id = randomUUID();
  const attempt = `${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${id.slice(0, 8)}`;
  const directory = resolve(root, '.local/local-lab/g-mvp-recovery-timing', attempt);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const events = await open(resolve(directory, 'events.jsonl'), 'wx', 0o600);
  const report = {
    version: 1,
    owner,
    id,
    attempt,
    startedAt: new Date().toISOString(),
    status: 'running',
    scope:
      'Isolated local metadata recovery using production API/Worker, public backup/restore CLI and one HTTPS origin. No existing Builder or Kubernetes connection is registered in this sample.',
    marks: {},
    checks: [],
    commands: [],
    resources: [],
    limits: [
      'The source and target databases share the existing local PostgreSQL server; this is not loss of the physical database host.',
      'Node artifacts, cached Docker images, the TLS entry and database administrator credentials are prepared before the incident. Target database creation, local backup copy, restore, Redis creation, application startup, reconciliation and HTTPS verification are timed.',
      'Recovery is automated against a fixed procedure. Human detection, public DNS changes, remote backup download, physical host provisioning and a target VPS are not measured.',
      'This fresh metadata sample has no Builder or connected Kubernetes cluster. Existing L06 evidence covers their real reconciliation separately; its timings cannot be combined with this run.',
      'An acknowledgement is an observable data checkpoint, not the exact SQL commit or exported snapshot instant. RPO bounds and the observed checkpoint interval are reported explicitly.',
    ],
  };
  const originNs = process.hrtime.bigint();
  const abort = new globalThis.AbortController();
  const stopSignal = () => abort.abort();
  process.once('SIGINT', stopSignal);
  process.once('SIGTERM', stopSignal);
  const nodeEnvironment = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    NODE_OPTIONS: '--max-old-space-size=512',
  };
  let stage = 'preflight',
    administration,
    server,
    eventFailure;
  let apiPort, origin, ca, session;
  const clients = [],
    samples = [];
  const confidential = [];
  const time = () => ({
    at: new Date().toISOString(),
    clockId: id,
    elapsedMs: Number(process.hrtime.bigint() - originNs) / 1_000_000,
  });
  async function event(kind, details = {}) {
    const entry = { ...time(), kind, ...details };
    try {
      await events.writeFile(JSON.stringify(entry) + '\n');
      await events.sync();
    } catch (error) {
      eventFailure = true;
      throw error;
    }
    return entry;
  }
  async function mark(name) {
    report.marks[name] = await event(name);
  }
  async function check(name, details = {}) {
    const result = { name, ...details, passed: true };
    report.checks.push(result);
    await event('check', result);
  }
  async function phase(name) {
    stage = name;
    console.log(JSON.stringify({ stage, attempt }));
    await event('stage', { stage });
  }
  async function command(label, binary, args, options = {}) {
    const before = time();
    try {
      const result = await execute(binary, args, {
        cwd: root,
        env: options.env ?? nodeEnvironment,
        signal: options.cleanup ? undefined : abort.signal,
        timeout: options.timeout ?? 30000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const record = {
        label,
        startedAt: before.at,
        durationMs: time().elapsedMs - before.elapsedMs,
        exitCode: 0,
      };
      report.commands.push(record);
      await event('command', record);
      return result.stdout.trim();
    } catch (error) {
      let code = 'SUBPROCESS_FAILED';
      try {
        const parsed = JSON.parse(error.stderr);
        if (/^[A-Z][A-Z0-9_]{0,79}$/u.test(parsed.code ?? '')) code = parsed.code;
      } catch {
        /* Command output may contain credentials and is never copied. */
      }
      const record = {
        label,
        startedAt: before.at,
        durationMs: time().elapsedMs - before.elapsedMs,
        exitCode: Number.isInteger(error.code) ? error.code : null,
        code,
      };
      report.commands.push(record);
      await event('command', record);
      throw new Error(`GMVP_TIMING_${code}`);
    }
  }
  async function wait(read, accept, timeout = 45000) {
    const started = process.hrtime.bigint();
    while (Number(process.hrtime.bigint() - started) / 1_000_000 < timeout) {
      abort.signal.throwIfAborted();
      const value = await read();
      if (accept(value)) return value;
      await delay(250, undefined, { signal: abort.signal });
    }
    throw new Error('GMVP_TIMING_OBSERVATION_TIMEOUT');
  }
  async function api(path, options = {}) {
    return response(origin + '/api' + path, {
      ca,
      ...options,
      headers: {
        origin,
        ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
        ...options.headers,
      },
    });
  }
  async function login(password) {
    session = undefined;
    const result = await api('/auth/login', {
      method: 'POST',
      body: { username: 'timing-admin', password },
    });
    requireValue(result.status === 200, 'LOGIN_FAILED');
    const cookie = result.headers['set-cookie']?.find((value) => value.startsWith('ozz_session='));
    requireValue(
      cookie &&
        /;\s*Secure(?:;|$)/iu.test(cookie) &&
        /;\s*HttpOnly(?:;|$)/iu.test(cookie) &&
        /;\s*SameSite=Strict(?:;|$)/iu.test(cookie),
      'PRODUCTION_COOKIE_INVALID',
    );
    requireValue(typeof result.value?.data?.csrfToken === 'string', 'CSRF_MISSING');
    session = { cookie: cookie.split(';')[0], csrf: result.value.data.csrfToken };
    confidential.push(session.cookie.slice('ozz_session='.length), session.csrf);
    return { ...session };
  }
  async function jsonWrite(path, body, status = 201, method = 'POST') {
    const result = await api(path, { method, body, headers: { 'idempotency-key': randomUUID() } });
    requireValue(result.status === status && result.value?.data?.id, 'METADATA_WRITE_FAILED');
    return result.value.data;
  }
  const checkpoint = (value) => ({
    id: value.id,
    revision: value.revision,
    contentSha256: hash(value.description ?? ''),
  });
  const writePrivate = (file, contents) => writeFile(file, contents, { flag: 'wx', mode: 0o600 });
  async function database(name, base) {
    requireValue(/^ozz_timing_[a-f0-9]{12}_(source|target)$/u.test(name), 'DATABASE_NAME_INVALID');
    const url = new URL(base);
    requireValue(url.pathname !== '/' + name, 'SOURCE_DATABASE_REFUSED');
    url.pathname = '/' + name;
    url.searchParams.set('schema', 'public');
    url.searchParams.set('connection_limit', '3');
    url.searchParams.set('connect_timeout', '5');
    url.searchParams.set('pool_timeout', '5');
    await administration.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const { PrismaClient } = await import('../../packages/database/dist/index.js');
    const db = new PrismaClient({ datasourceUrl: url.href });
    clients.push(db);
    report.resources.push({ kind: 'database', name, retained: true });
    await event('database-created', { name });
    return { db, url: url.href };
  }
  async function createSample(name, baseUrl, password) {
    const sample = {
      name,
      directory: resolve(directory, name),
      children: [],
      containers: [],
      database: `ozz_timing_${id.replaceAll('-', '').slice(0, 12)}_${name}`,
      ports: { api: await port(), worker: await port(), redis: await port() },
      redisName: `ozz-timing-${id.slice(0, 8)}-${name}`,
      redisPassword: randomBytes(24).toString('base64url'),
    };
    samples.push(sample);
    confidential.push(sample.redisPassword);
    await mkdir(sample.directory, { mode: 0o700 });
    sample.keyFile = resolve(sample.directory, 'master-key.json');
    const url = new URL(baseUrl);
    url.pathname = '/' + sample.database;
    url.searchParams.set('schema', 'public');
    url.searchParams.set('connection_limit', '3');
    url.searchParams.set('connect_timeout', '5');
    url.searchParams.set('pool_timeout', '5');
    sample.url = url.href;
    const values = {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      APP_ORIGIN: origin,
      PORT: sample.ports.api,
      WORKER_HEALTH_PORT: sample.ports.worker,
      DATABASE_URL: sample.url,
      MASTER_KEY_FILE: sample.keyFile,
      REDIS_URL: `redis://:${sample.redisPassword}@127.0.0.1:${sample.ports.redis}/0`,
      LOG_LEVEL: 'silent',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      POSTGRES_IMAGE: postgresImage,
    };
    for (const locked of [false, true]) {
      const envFile = resolve(sample.directory, locked ? 'locked.env' : 'writable.env');
      await writePrivate(
        envFile,
        Object.entries({ ...values, RESTORE_MODE: String(locked) })
          .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
          .join('\n') + '\n',
      );
      sample[locked ? 'lockedEnv' : 'writableEnv'] = envFile;
    }
    if (name === 'source') {
      await writePrivate(
        sample.keyFile,
        encode({ activeVersion: 1, keys: { 1: randomBytes(32).toString('base64') } }),
      );
      sample.passwordFile = resolve(sample.directory, 'admin-password');
      await writePrivate(sample.passwordFile, password + '\n');
    }
    return sample;
  }
  async function startRedis(sample) {
    const label = ['--label', `ozz.timing.owner=${owner}`, '--label', `ozz.timing.id=${id}`];
    const volume = sample.redisName + '-data';
    await command('redis-volume-create-' + sample.name, 'docker', [
      'volume',
      'create',
      ...label,
      volume,
    ]);
    report.resources.push({ kind: 'volume', name: volume, retained: true });
    const result = await command(
      'redis-create-' + sample.name,
      'docker',
      [
        'container',
        'create',
        '--pull=never',
        '--name',
        sample.redisName,
        ...label,
        '--memory=128m',
        '--cpus=0.25',
        '--read-only',
        '--user',
        'redis:redis',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=16m',
        '--mount',
        `type=volume,src=${volume},dst=/data`,
        '--publish',
        `127.0.0.1:${sample.ports.redis}:6379`,
        '--env',
        'REDIS_PASSWORD',
        '--env',
        'REDISCLI_AUTH',
        redisImage,
        'sh',
        '-c',
        'exec redis-server --appendonly yes --save "" --maxmemory 64mb --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD"',
      ],
      {
        env: {
          ...nodeEnvironment,
          REDIS_PASSWORD: sample.redisPassword,
          REDISCLI_AUTH: sample.redisPassword,
        },
      },
    );
    requireValue(/^[0-9a-f]{64}$/u.test(result), 'REDIS_CONTAINER_ID_INVALID');
    sample.containers.push(result);
    report.resources.push({
      kind: 'container',
      name: sample.redisName,
      id: result,
      retained: true,
    });
    await command('redis-start-' + sample.name, 'docker', ['container', 'start', result]);
    await wait(
      async () => {
        try {
          return (
            (
              await execute('docker', ['exec', result, 'redis-cli', 'ping'], {
                env: nodeEnvironment,
                timeout: 3000,
                maxBuffer: 4096,
              })
            ).stdout.trim() === 'PONG'
          );
        } catch {
          return false;
        }
      },
      Boolean,
      20000,
    );
  }
  async function startNodes(sample, locked) {
    const envFile = sample[locked ? 'lockedEnv' : 'writableEnv'];
    for (const name of ['api', 'worker']) {
      const logFile = resolve(sample.directory, `${name}-${locked ? 'locked' : 'writable'}.log`);
      const log = await open(logFile, 'wx', 0o600);
      try {
        const child = spawn(
          process.execPath,
          [`--env-file=${envFile}`, `apps/${name}/dist/main.js`],
          {
            cwd: root,
            env: nodeEnvironment,
            stdio: ['ignore', log.fd, log.fd],
          },
        );
        const record = { child, name, logFile, exited: false, exitCode: null, signal: null };
        record.ended = new Promise((accept) => {
          child.once('error', () => {
            record.exited = true;
            accept();
          });
          child.once('exit', (code, signal) => {
            record.exited = true;
            record.exitCode = code;
            record.signal = signal;
            accept();
          });
        });
        sample.children.push(record);
        await new Promise((accept, reject) => {
          child.once('spawn', accept);
          child.once('error', reject);
        });
        await event('runtime-started', {
          sample: sample.name,
          process: name,
          pid: child.pid,
          locked,
        });
      } finally {
        await log.close();
      }
    }
  }
  async function stopNodes(sample, cleanup = false) {
    const selected = sample.children.filter((record) => !record.exited);
    for (const record of selected) record.child.kill('SIGTERM');
    if (selected.length)
      await Promise.race([Promise.all(selected.map((record) => record.ended)), delay(15000)]);
    const pending = selected.filter((record) => !record.exited);
    if (pending.length && cleanup) {
      for (const record of pending) record.child.kill('SIGKILL');
      await Promise.race([Promise.all(pending.map((record) => record.ended)), delay(5000)]);
    }
    requireValue(
      selected.every((record) => record.exited),
      'RUNTIME_STOP_TIMEOUT',
    );
    for (const record of selected)
      await event('runtime-stopped', {
        sample: sample.name,
        process: record.name,
        pid: record.child.pid,
        exitCode: record.exitCode,
        signal: record.signal,
      });
  }
  async function stopRedis(sample) {
    for (const containerId of sample.containers) {
      const text = await command(
        'redis-inspect-before-stop-' + sample.name,
        'docker',
        ['inspect', '--format', '{{json .Config.Labels}}', containerId],
        { cleanup: true },
      );
      const labels = JSON.parse(text);
      requireValue(
        labels['ozz.timing.owner'] === owner && labels['ozz.timing.id'] === id,
        'REDIS_OWNER_CHANGED',
      );
      await command(
        'redis-stop-' + sample.name,
        'docker',
        ['container', 'stop', '--time', '10', containerId],
        { cleanup: true },
      );
    }
  }
  async function ready(sample, readOnly) {
    await wait(async () => {
      requireValue(
        sample.children.filter((record) => !record.exited).length === 2,
        'RUNTIME_EXITED',
      );
      try {
        const apiHealth = await api('/health/ready');
        const worker = await response(`http://127.0.0.1:${sample.ports.worker}/health/live`);
        const age = Date.now() - Date.parse(worker.value?.lastHeartbeatAt);
        return (
          apiHealth.status === 200 &&
          apiHealth.value?.mode === (readOnly ? 'read_only' : 'read_write') &&
          worker.status === 200 &&
          worker.value?.status === (readOnly ? 'paused' : 'ready') &&
          worker.value.database === true &&
          Number.isFinite(age) &&
          age >= 0 &&
          age < 20000
        );
      } catch {
        return false;
      }
    }, Boolean);
  }
  async function runtimeCli(sample, commandName) {
    return command(commandName, process.execPath, [
      `--env-file=${sample.writableEnv}`,
      'apps/api/dist/cli.js',
      commandName,
      ...(commandName === 'recovery:unlock'
        ? ['--reconciled']
        : ['--username', 'timing-admin', '--password-file', sample.passwordFile]),
    ]);
  }
  try {
    await phase('preflight');
    const disk = await statfs(root);
    report.availableHostDiskBytes = disk.bavail * disk.bsize;
    requireValue(report.availableHostDiskBytes >= 8 * 1024 ** 3, 'LOCAL_DISK_RESERVE_REQUIRED');
    const baseBytes = await protectedFile(resolve(root, sourceEnvFile));
    const base = parseEnv(baseBytes.toString('utf8'));
    const baseUrl = new URL(base.DATABASE_URL);
    requireValue(['127.0.0.1', 'localhost'].includes(baseUrl.hostname), 'LOCAL_POSTGRES_REQUIRED');
    report.inputEnvironmentSha256 = hash(baseBytes);
    report.sourceFiles = [];
    for (const path of [
      'tests/probes/g-mvp-recovery-timing-local-lab.mjs',
      'tests/probes/support/g-mvp-recovery-timing.mjs',
      'scripts/backup-control-plane.mjs',
      'scripts/restore-control-plane.mjs',
      'scripts/backup-helpers.mjs',
      'apps/api/dist/main.js',
      'apps/api/dist/cli.js',
      'apps/worker/dist/main.js',
    ]) {
      report.sourceFiles.push({ path, sha256: hash(await readFile(resolve(root, path))) });
    }
    for (const image of [redisImage, postgresImage])
      await command('cached-image-check', 'docker', [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        image,
      ]);
    const { PrismaClient } = await import('../../packages/database/dist/index.js');
    administration = new PrismaClient({ datasourceUrl: base.DATABASE_URL });
    await administration.$connect();
    const password = randomBytes(24).toString('base64url');
    const secretMarker = randomBytes(32).toString('base64url');
    confidential.push(password, secretMarker);
    const httpsPort = await port();
    origin = `https://127.0.0.1:${httpsPort}`;
    report.origin = origin;
    const tls = resolve(directory, 'tls');
    await mkdir(tls, { mode: 0o700 });
    await writePrivate(
      resolve(tls, 'ca.cnf'),
      '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Ozz isolated recovery timing CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',
    );
    await writePrivate(
      resolve(tls, 'leaf.cnf'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
    );
    await command('local-ca', 'openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-config',
      resolve(tls, 'ca.cnf'),
      '-keyout',
      resolve(tls, 'ca.key'),
      '-out',
      resolve(tls, 'ca.crt'),
    ]);
    await command('local-leaf-request', 'openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=127.0.0.1',
      '-keyout',
      resolve(tls, 'server.key'),
      '-out',
      resolve(tls, 'server.csr'),
    ]);
    await command('local-leaf-sign', 'openssl', [
      'x509',
      '-req',
      '-in',
      resolve(tls, 'server.csr'),
      '-CA',
      resolve(tls, 'ca.crt'),
      '-CAkey',
      resolve(tls, 'ca.key'),
      '-CAcreateserial',
      '-out',
      resolve(tls, 'server.crt'),
      '-days',
      '2',
      '-sha256',
      '-extfile',
      resolve(tls, 'leaf.cnf'),
    ]);
    ca = await readFile(resolve(tls, 'ca.crt'));
    report.tls = {
      caSha256: hash(ca),
      certificateFingerprint256: new X509Certificate(await readFile(resolve(tls, 'server.crt')))
        .fingerprint256,
      hostnameVerified: '127.0.0.1',
      trustedPublicly: false,
    };
    const consoleHtml = await readFile(resolve(root, 'apps/console/dist/index.html'));
    server = httpsServer(
      {
        cert: await readFile(resolve(tls, 'server.crt')),
        key: await protectedFile(resolve(tls, 'server.key')),
      },
      (request, reply) => {
        if (request.method === 'GET' && request.url === '/') {
          reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(consoleHtml);
          return;
        }
        if (!request.url?.startsWith('/api/') || !apiPort) {
          reply
            .writeHead(503, { 'content-type': 'application/json' })
            .end('{"code":"TIMING_UPSTREAM_UNAVAILABLE"}');
          return;
        }
        const upstream = httpRequest(
          {
            hostname: '127.0.0.1',
            port: apiPort,
            path: request.url,
            method: request.method,
            agent: false,
            headers: {
              ...request.headers,
              host: `127.0.0.1:${apiPort}`,
              connection: 'close',
              'x-forwarded-proto': 'https',
            },
          },
          (result) => {
            reply.writeHead(result.statusCode ?? 502, result.headers);
            result.pipe(reply);
            result.once('error', () => reply.destroy());
          },
        );
        upstream.setTimeout(5000, () => upstream.destroy());
        upstream.once('error', () => {
          if (!reply.headersSent)
            reply
              .writeHead(502, { 'content-type': 'application/json' })
              .end('{"code":"TIMING_UPSTREAM_UNAVAILABLE"}');
          else reply.destroy();
        });
        request.once('aborted', () => upstream.destroy());
        request.once('error', () => upstream.destroy());
        reply.once('close', () => upstream.destroy());
        request.pipe(upstream);
      },
    );
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(httpsPort, '127.0.0.1', accept);
    });
    const source = await createSample('source', base.DATABASE_URL, password);
    const target = await createSample('target', base.DATABASE_URL, password);
    const sourceDatabase = await database(source.database, base.DATABASE_URL);
    source.db = sourceDatabase.db;
    await command(
      'migrate-isolated-source',
      process.execPath,
      [
        `--env-file=${source.writableEnv}`,
        'packages/database/node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
        '--schema',
        'packages/database/prisma/schema.prisma',
      ],
      { timeout: 60000 },
    );
    await runtimeCli(source, 'admin:init');
    await startRedis(source);
    await startNodes(source, false);
    apiPort = source.ports.api;
    await ready(source, false);
    const oldSession = await login(password);
    const cluster = await jsonWrite('/clusters', {
      name: 'Recovery timing source',
      slug: `timing-${id.slice(0, 8)}`,
    });
    const project = await jsonWrite('/projects', {
      name: 'Recovery timing project',
      slug: `timing-${id.slice(0, 8)}`,
      clusterId: cluster.id,
    });
    const secret = await jsonWrite('/secrets', {
      name: 'Recovery timing credential',
      kind: 'generic',
      payload: { marker: secretMarker },
    });
    requireValue(
      (await source.db.builder.count()) === 0 &&
        (await source.db.buildRun.count()) === 0 &&
        (await source.db.deployment.count()) === 0 &&
        (await source.db.operation.count()) === 0,
      'SOURCE_MUST_HAVE_NO_REMOTE_EXECUTION',
    );
    await check('fresh-production-control-plane-with-no-remote-targets', {
      database: source.database,
      projectId: project.id,
      clusterId: cluster.id,
      secretId: secret.id,
    });
    await phase('capture-recoverable-checkpoint');
    await mark('checkpointRequested');
    const saved = await jsonWrite(
      `/clusters/${cluster.id}`,
      { revision: cluster.revision, description: `saved-${id}` },
      200,
      'PATCH',
    );
    await mark('checkpointAcknowledged');
    report.checkpoint = checkpoint(saved);
    await mark('backupStarted');
    const backup = JSON.parse(
      await command(
        'public-backup-cli',
        process.execPath,
        [
          'scripts/backup-control-plane.mjs',
          '--env-file',
          source.writableEnv,
          '--database-dir',
          resolve(directory, 'database-backups'),
          '--key-dir',
          resolve(directory, 'key-backups'),
          '--label',
          `timing-${id}`,
        ],
        { timeout: 60000 },
      ),
    );
    await mark('backupCompleted');
    requireValue(backup.status === 'complete', 'BACKUP_INCOMPLETE');
    const databaseManifest = JSON.parse(
      await protectedFile(resolve(backup.databaseDirectory, 'manifest.json')),
    );
    report.backup = {
      backupId: backup.backupId,
      archiveCreatedAt: databaseManifest.createdAt,
      databaseSha256: databaseManifest.databaseSha256,
      masterKeySha256: databaseManifest.masterKeySha256,
    };
    await mark('omittedRequested');
    const omitted = await jsonWrite(
      `/clusters/${cluster.id}`,
      { revision: saved.revision, description: `omitted-${id}` },
      200,
      'PATCH',
    );
    await mark('omittedAcknowledged');
    report.omittedCheckpoint = checkpoint(omitted);
    await phase('incident-and-target-provisioning');
    await mark('incident');
    await stopNodes(source);
    await stopRedis(source);
    const unavailable = await api('/auth/me');
    requireValue(unavailable.status === 502, 'INCIDENT_NOT_OBSERVED');
    await mark('failureDetected');
    const targetDatabase = await database(target.database, base.DATABASE_URL);
    target.db = targetDatabase.db;
    await mark('targetCreated');
    const retrievalDatabase = resolve(directory, 'retrieved-database');
    const retrievalKeys = resolve(directory, 'retrieved-keys');
    await cp(backup.databaseDirectory, retrievalDatabase, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await cp(backup.keyDirectory, retrievalKeys, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await mark('backupRetrieved');
    await mark('importStarted');
    const imported = JSON.parse(
      await command(
        'public-restore-cli',
        process.execPath,
        [
          'scripts/restore-control-plane.mjs',
          '--env-file',
          target.lockedEnv,
          '--database-backup',
          retrievalDatabase,
          '--key-backup',
          retrievalKeys,
          '--target-key-file',
          target.keyFile,
        ],
        { timeout: 60000 },
      ),
    );
    await mark('importCompleted');
    requireValue(
      imported.restoreLocked === true && imported.database === target.database,
      'RESTORE_RECEIPT_INVALID',
    );
    requireValue(
      hash(await protectedFile(target.keyFile)) === report.backup.masterKeySha256,
      'RESTORED_KEY_MISMATCH',
    );
    await phase('authenticated-read-only-recovery');
    await startRedis(target);
    await startNodes(target, true);
    apiPort = target.ports.api;
    await ready(target, true);
    session = oldSession;
    requireValue((await api('/auth/me')).status === 401, 'OLD_SESSION_NOT_REVOKED');
    await login(password);
    const read = await api(`/clusters/${cluster.id}`);
    requireValue(read.status === 200, 'RESTORED_RESOURCE_MISSING');
    report.restoredCheckpoint = checkpoint(read.value.data);
    requireValue(
      read.value.data.revision === saved.revision &&
        read.value.data.description === saved.description,
      'RESTORED_CHECKPOINT_MISMATCH',
    );
    const restoredProject = await api(`/projects/${project.id}`);
    requireValue(
      restoredProject.status === 200 && restoredProject.value.data.clusterId === cluster.id,
      'RESTORED_PROJECT_MISMATCH',
    );
    const credentialMetadata = await api(`/secrets/${secret.id}`);
    requireValue(
      credentialMetadata.status === 200 && !credentialMetadata.text.includes(secretMarker),
      'CREDENTIAL_METADATA_INVALID',
    );
    const { SecretCipher, readMasterKeys } =
      await import('../../packages/control-plane/dist/secrets.js');
    const cipher = new SecretCipher(readMasterKeys(target.keyFile));
    const credential = await target.db.secretReference.findUniqueOrThrow({
      where: { id: secret.id },
    });
    requireValue(
      cipher.decrypt(credential).marker === secretMarker,
      'RESTORED_CREDENTIAL_DECRYPTION_FAILED',
    );
    const lockedWrite = await api('/operations/diagnostics', {
      method: 'POST',
      body: { durationMs: 25 },
      headers: { 'idempotency-key': randomUUID() },
    });
    requireValue(
      lockedWrite.status === 503 && lockedWrite.value?.code === 'RESTORE_READ_ONLY',
      'RESTORE_WRITE_NOT_REJECTED',
    );
    requireValue(
      (await target.db.builder.count()) === 0 &&
        (await target.db.buildRun.count()) === 0 &&
        (await target.db.deployment.count()) === 0 &&
        (await target.db.operation.count()) === 0,
      'RESTORED_EXECUTION_NOT_EMPTY',
    );
    await mark('readOnlyAvailable');
    await check(
      'read-only-recovery-preserves-data-and-credentials-revokes-session-and-blocks-writes',
      {
        sameOrigin: true,
        originalSessionRevoked: true,
        credentialDecryptionVerified: true,
        workerPaused: true,
        restoredCheckpoint: report.restoredCheckpoint,
      },
    );
    await phase('reconcile-and-resume-writes');
    await stopNodes(target);
    await startNodes(target, false);
    await ready(target, true);
    await runtimeCli(target, 'recovery:unlock');
    const control = await target.db.controlPlaneState.findUniqueOrThrow({
      where: { id: 'control-plane' },
    });
    requireValue(
      !control.restoreLocked && control.generation >= imported.generation,
      'UNLOCK_NOT_VERIFIED',
    );
    const unlockAudit = await target.db.auditEvent.findFirst({
      where: { action: 'recovery:unlock', outcome: 'succeeded' },
      orderBy: { createdAt: 'desc' },
    });
    requireValue(unlockAudit, 'UNLOCK_AUDIT_MISSING');
    await mark('unlockCompleted');
    await ready(target, false);
    await mark('writeReady');
    const task = await jsonWrite('/operations/diagnostics', { durationMs: 25 }, 202);
    const completed = await wait(
      async () => {
        const result = await api(`/operations/${task.id}`);
        requireValue(result.status === 200, 'DIAGNOSTIC_LOOKUP_FAILED');
        requireValue(
          !['failed', 'cancelled'].includes(result.value.data.status),
          'NEW_DIAGNOSTIC_FAILED',
        );
        return result.value.data;
      },
      (value) => value.status === 'succeeded',
    );
    const taskRow = await target.db.operation.findUniqueOrThrow({ where: { id: task.id } });
    requireValue(
      taskRow.generation === control.generation && completed.result?.database === 'ok',
      'NEW_DIAGNOSTIC_GENERATION_MISMATCH',
    );
    const finalRead = await api(`/clusters/${cluster.id}`);
    requireValue(
      finalRead.status === 200 &&
        finalRead.value.data.revision === saved.revision &&
        finalRead.value.data.description === saved.description,
      'POST_RECOVERY_READ_FAILED',
    );
    requireValue((await api('/auth/me')).status === 200, 'POST_RECOVERY_AUTH_FAILED');
    await mark('recovered');
    await check('formal-unlock-and-new-generation-task-complete-through-the-same-https-origin', {
      generation: control.generation,
      auditId: unlockAudit.id,
      diagnosticId: task.id,
    });
    const retainedSource = await source.db.cluster.findUniqueOrThrow({ where: { id: cluster.id } });
    requireValue(
      retainedSource.revision === omitted.revision &&
        retainedSource.description === omitted.description,
      'ISOLATED_SOURCE_CHANGED',
    );
    requireValue(
      hash(await protectedFile(resolve(root, sourceEnvFile))) === report.inputEnvironmentSha256,
      'ORIGINAL_ENV_CHANGED',
    );
    await check('later-acknowledged-write-remains-only-in-retained-source', {
      sourceRevision: omitted.revision,
      restoredRevision: saved.revision,
    });
    report.timing = summarizeRecoveryTiming({
      clockId: id,
      marks: report.marks,
      checkpoint: report.checkpoint,
      restored: report.restoredCheckpoint,
      omitted: report.omittedCheckpoint,
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = {
      stage,
      code: /^GMVP_TIMING_[A-Z0-9_]+$/u.test(error?.message ?? '')
        ? error.message
        : abort.signal.aborted
          ? 'GMVP_TIMING_INTERRUPTED'
          : 'GMVP_TIMING_UNEXPECTED_FAILURE',
      errorType: ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(error?.name)
        ? error.name
        : 'Error',
      sourceFrames: String(error?.stack ?? '')
        .split('\n')
        .flatMap((line) => {
          const match = line.match(/(tests\/probes\/[a-z0-9/-]+\.mjs):(\d+):(\d+)/u);
          return match
            ? [{ path: match[1], line: Number(match[2]), column: Number(match[3]) }]
            : [];
        })
        .slice(0, 4),
    };
  } finally {
    const cleanup = [];
    for (const sample of samples) {
      try {
        await stopNodes(sample, true);
        await stopRedis(sample);
        cleanup.push({ sample: sample.name, stopped: true });
      } catch {
        cleanup.push({ sample: sample.name, stopped: false });
      }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((accept) => server.close(accept));
    }
    for (const client of clients) await client.$disconnect().catch(() => {});
    await administration?.$disconnect().catch(() => {});
    report.cleanup = {
      processesAndContainers: cleanup,
      databasesBackupsKeysAndVolumesRetained: true,
    };
    if (cleanup.some((item) => !item.stopped) || eventFailure) {
      report.status = 'failed';
      report.failure ??= { stage: 'cleanup', code: 'GMVP_TIMING_CLEANUP_OR_JOURNAL_FAILED' };
    }
    for (const sample of samples)
      for (const record of sample.children) {
        try {
          const bytes = await readFile(record.logFile, 'utf8');
          requireValue(
            confidential.every((value) => !bytes.includes(value)),
            'RUNTIME_LOG_SECRET_FOUND',
          );
        } catch {
          report.status = 'failed';
          report.failure ??= { stage: 'log-check', code: 'GMVP_TIMING_LOG_CHECK_FAILED' };
        }
      }
    report.completedAt = new Date().toISOString();
    const serialized = encode(report);
    if (confidential.some((value) => serialized.includes(value))) {
      await writePrivate(
        resolve(directory, 'report.json'),
        encode({
          version: 1,
          owner,
          id,
          status: 'failed',
          failure: { code: 'GMVP_TIMING_REPORT_SECRET_FOUND' },
        }),
      );
      report.status = 'failed';
    } else await writePrivate(resolve(directory, 'report.json'), serialized);
    await events.close();
    process.off('SIGINT', stopSignal);
    process.off('SIGTERM', stopSignal);
  }
  const result = {
    status: report.status,
    report: resolve(directory, 'report.json'),
    ...(report.failure ? { failure: report.failure } : {}),
    ...(report.status === 'passed' ? { timing: report.timing } : {}),
  };
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({
    options: { 'source-env': { type: 'string', default: '.env' } },
    allowPositionals: true,
  });
  if (positionals.length === 1 && positionals[0] === 'run') {
    try {
      if ((await runRecoveryTiming(values['source-env'])).status !== 'passed') process.exitCode = 1;
    } catch {
      console.error(JSON.stringify({ status: 'failed', code: 'GMVP_TIMING_SETUP_FAILED' }));
      process.exitCode = 1;
    }
  } else {
    console.log(
      'Usage: pnpm exec node tests/probes/g-mvp-recovery-timing-local-lab.mjs run [--source-env .env]',
    );
    if (positionals.length > 0) process.exitCode = 1;
  }
}
