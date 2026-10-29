import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { proveComposeEgress } from './compose-egress.mjs';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: { 'image-prefix': { type: 'string', default: 'ozz' } } });
const suffix = randomUUID().slice(0, 8);
const project = `ozz-s1-proof-${suffix}`;
const directory = resolve(root, '.local', project);
const evidence = {
  project,
  directory,
  testedAt: new Date().toISOString(),
  checks: {},
  timingsMs: {},
  versions: {},
  resources: {},
};
let env;
let compose;
let started = false;
let certificate;
let cookie;
let csrf;
const reservations = new Set();

async function run(label, program, args, options = {}) {
  const start = performance.now();
  try {
    const result = await execute(program, args, {
      cwd: root,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
    evidence.timingsMs[label] = Math.round(performance.now() - start);
    return result.stdout.trim();
  } catch (error) {
    await mkdir(resolve(directory, 'diagnostics'), { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(directory, 'diagnostics', `${label}.log`),
      `${error.stdout || ''}\n${error.stderr || ''}`,
      { mode: 0o600 },
    );
    throw new Error(`${label} failed; private diagnostics are in ${directory}/diagnostics`);
  }
}

async function reservePort() {
  const server = createServer();
  reservations.add(server);
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port assigned');
  return {
    port: address.port,
    close: () =>
      new Promise((resolveClose) =>
        server.close(() => {
          reservations.delete(server);
          resolveClose();
        }),
      ),
  };
}

async function until(read, matches, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (matches(result)) return result;
    } catch {
      /* startup/restart window */
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function web(method, path, body, extraHeaders = {}, secure = true, chunked = false) {
  return new Promise((resolveResponse, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = (secure ? httpsRequest : httpRequest)(
      {
        hostname: '127.0.0.1',
        servername: 'localhost',
        port: Number(secure ? env.HTTPS_PORT : env.HTTP_PORT),
        method,
        path,
        ...(secure ? { ca: certificate, rejectUnauthorized: true } : {}),
        timeout: 5000,
        headers: {
          host: `localhost:${secure ? env.HTTPS_PORT : env.HTTP_PORT}`,
          origin: env.APP_ORIGIN,
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...(payload
            ? {
                'content-type': 'application/json',
                ...(chunked ? {} : { 'content-length': Buffer.byteLength(payload) }),
              }
            : {}),
          ...extraHeaders,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = undefined;
          }
          resolveResponse({ status: response.statusCode, headers: response.headers, text, data });
        });
      },
    );
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('HTTP proof timed out')));
    if (chunked && payload) {
      request.write(payload.slice(0, 70000));
      request.end(payload.slice(70000));
    } else request.end(payload);
  });
}

const docker = (label, args, options) => run(label, 'docker', [...compose, ...args], options);
const psql = async (sql, database = 'ozz') => {
  const output = await docker('database-check', [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-q',
    '-A',
    '-t',
    '--set=ON_ERROR_STOP=1',
    '--username=ozz',
    `--dbname=${database}`,
    '--command',
    sql,
  ]);
  return output.trim();
};

try {
  const http = await reservePort();
  const https = await reservePort();
  const setup = JSON.parse(
    await run('fixture-setup', process.execPath, [
      'infra/docker/setup-compose.mjs',
      '--hostname',
      'localhost',
      '--directory',
      directory,
      '--project',
      project,
      '--bind-address',
      '127.0.0.1',
      '--http-port',
      String(http.port),
      '--https-port',
      String(https.port),
      '--image-prefix',
      values['image-prefix'],
    ]),
  );
  env = parseEnv(await readFile(setup.envFile, 'utf8'));
  compose = [
    'compose',
    '--env-file',
    setup.envFile,
    '-f',
    'compose.yaml',
    '--project-name',
    project,
  ];
  await docker('compose-config', ['config', '--quiet']);
  evidence.linuxKeyPermissions = JSON.parse(
    await run('linux-key-permissions', 'docker', [
      'run',
      '--rm=false',
      '--pull=never',
      '--name',
      `${project}-key-permissions`,
      '--user',
      '0:0',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=16m',
      '--cap-drop=ALL',
      '--cap-add=CHOWN',
      '--cap-add=SETUID',
      '--cap-add=SETGID',
      '--security-opt=no-new-privileges:true',
      '--volume',
      `${root}/scripts:/proof/scripts:ro`,
      '--volume',
      `${root}/tests/deployment:/proof/tests/deployment:ro`,
      '--entrypoint',
      'node',
      `${values['image-prefix']}/api:0.1.0`,
      '/proof/tests/deployment/linux-key-permissions.mjs',
    ]),
  );
  assert.equal(evidence.linuxKeyPermissions.status, 'passed');
  evidence.checks.linuxRootRestoreKeyReadableByRuntimeUser = true;
  await http.close();
  await https.close();
  console.log(
    `Starting isolated ${project}; only 127.0.0.1:${env.HTTP_PORT}/${env.HTTPS_PORT} will be published.`,
  );
  started = true;
  await docker('compose-start', [
    'up',
    '-d',
    '--no-build',
    '--pull',
    'never',
    '--wait',
    '--wait-timeout',
    '120',
  ]);
  evidence.databaseMigrations = JSON.parse(
    await psql(
      `SELECT json_build_object('applied', count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), 'unfinished', count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)) FROM public."_prisma_migrations";`,
    ),
  );
  assert.ok(evidence.databaseMigrations.applied > 0);
  assert.equal(evidence.databaseMigrations.unfinished, 0);
  evidence.checks.migrationsActuallyApplied = true;
  const rootCertificate = resolve(directory, 'caddy-root.crt');
  await docker('copy-public-ca', [
    'cp',
    'console:/data/caddy/pki/authorities/local/root.crt',
    rootCertificate,
  ]);
  certificate = await readFile(rootCertificate);
  const home = await web('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<html/i);
  assert.equal((await web('GET', '/projects/fixture-deep-link')).status, 200);
  assert.equal((await web('GET', '/api/projects')).status, 401);
  const redirect = await web('GET', '/projects', undefined, {}, false);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `${env.APP_ORIGIN}/projects`);
  evidence.checks.httpsVerifiedWithLocalCa = true;
  evidence.checks.sameOriginApiAndSpa = true;
  evidence.checks.httpRedirectPreservesExternalOrigin = true;

  await docker('admin-init', [
    'run',
    '--rm=false',
    '--no-deps',
    '-v',
    `${setup.adminPasswordFile}:/run/secrets/bootstrap_password:ro`,
    'api',
    '/app/dist/cli.js',
    'admin:init',
    '--username',
    'admin',
    '--password-file',
    '/run/secrets/bootstrap_password',
  ]);
  const password = (await readFile(setup.adminPasswordFile, 'utf8')).trim();
  const login = await web('POST', '/api/auth/login', { username: 'admin', password });
  assert.equal(login.status, 200);
  const sessionCookie = login.headers['set-cookie']?.[0];
  assert.ok(sessionCookie?.includes('HttpOnly'));
  assert.ok(sessionCookie?.includes('Secure'));
  assert.ok(sessionCookie?.includes('SameSite=Strict'));
  cookie = sessionCookie.split(';')[0];
  csrf = login.data.data.csrfToken;
  assert.ok(csrf);
  const clusterResponse = await web('POST', '/api/clusters', {
    name: `容器验收 ${suffix}`,
    slug: `proof-${suffix}`,
  });
  assert.equal(clusterResponse.status, 201);
  const cluster = clusterResponse.data.data;
  assert.equal(cluster.connectionStatus, 'unverified');
  const createdProject = await web('POST', '/api/projects', {
    name: `持久化验收 ${suffix}`,
    slug: `proof-${suffix}`,
    clusterId: cluster.id,
  });
  assert.equal(createdProject.status, 201);
  const projectId = createdProject.data.data.id;
  const environments = await web('GET', `/api/environments?projectId=${projectId}`);
  assert.equal(environments.data.data.filter((entry) => entry.slug === 'production').length, 1);
  const marker = `fixture-${randomUUID()}`;
  const secret = await web('POST', '/api/secrets', {
    name: '容器凭证验收',
    kind: 'generic',
    payload: { token: marker },
  });
  assert.equal(secret.status, 201);
  assert.ok(!secret.text.includes(marker));
  evidence.checks.authCrudAndDefaultEnvironment = true;
  const unsupported = await web(
    'POST',
    '/api/projects',
    { name: marker },
    { 'content-type': 'application/octet-stream' },
  );
  assert.equal(unsupported.status, 415);
  assert.equal(unsupported.data.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.ok(!unsupported.text.includes(marker));
  // Repeat both framing modes: closing during the proxy's upload can race with
  // the API's 413 and surface as a 502 even when an isolated request succeeds.
  for (const chunked of [false, true]) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const oversized = await web(
        'POST',
        '/api/projects',
        { name: marker, description: 'x'.repeat(110000) },
        {},
        true,
        chunked,
      );
      assert.equal(oversized.status, 413);
      assert.equal(oversized.data.code, 'PAYLOAD_TOO_LARGE');
      assert.ok(!oversized.text.includes(marker));
    }
  }
  evidence.checks.safeParserErrors = true;

  const heartbeatCount = await psql('SELECT count(*) FROM public."WorkerHeartbeat";');
  const wrongKey = resolve(directory, 'secrets', 'wrong-key.json');
  await writeFile(
    wrongKey,
    JSON.stringify({ activeVersion: 1, keys: { 1: randomBytes(32).toString('base64') } }),
    { mode: 0o600 },
  );
  for (const kind of ['missing', 'wrong']) {
    const result = await execute(
      'docker',
      [
        ...compose,
        'run',
        '--rm=false',
        '--no-deps',
        '--name',
        `${project}-worker-key-${kind}`,
        '-e',
        `MASTER_KEY_FILE=/run/secrets/${kind}_key`,
        ...(kind === 'wrong' ? ['-v', `${wrongKey}:/run/secrets/wrong_key:ro`] : []),
        'worker',
        '/app/dist/main.js',
      ],
      { cwd: root, timeout: 15000 },
    ).then(
      (output) => ({ code: 0, text: output.stdout + output.stderr }),
      (error) => ({ code: error.code, text: (error.stdout || '') + (error.stderr || '') }),
    );
    assert.equal(result.code, 1);
    assert.match(result.text, /"code"\s*:\s*"WORKER_STARTUP_FAILED"/);
  }
  assert.equal(await psql('SELECT count(*) FROM public."WorkerHeartbeat";'), heartbeatCount);
  evidence.checks.workerRejectsMissingAndWrongKeyBeforeDispatch = true;

  const diagnostic = await web(
    'POST',
    '/api/operations/diagnostics',
    { durationMs: 250 },
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(diagnostic.status, 202);
  const operationId = diagnostic.data.data.id;
  const finished = await until(
    () => web('GET', `/api/operations/${operationId}`),
    (response) => response.data?.data.status === 'succeeded',
    'container diagnostic',
  );
  assert.equal(finished.data.data.attempts, 1);
  const worker = await until(
    () => web('GET', '/api/operations/worker-status'),
    (response) => response.data?.data.status === 'ready',
    'worker readiness',
  );
  assert.equal(worker.data.data.queue, 'connected');
  evidence.checks.separateWorkerExecutesDurableTask = true;

  console.log('Testing Redis outage and production backup transport.');
  await docker('redis-stop', ['stop', 'redis']);
  const duringOutage = await web(
    'POST',
    '/api/operations/diagnostics',
    { durationMs: 100 },
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(duringOutage.status, 202);
  const queuedId = duringOutage.data.data.id;
  assert.equal((await web('GET', '/api/health/ready')).status, 200);
  await until(
    () => web('GET', '/api/operations/worker-status'),
    (response) => response.data?.data.status === 'degraded',
    'queue degradation',
  );
  assert.equal((await web('GET', `/api/operations/${queuedId}`)).data.data.status, 'queued');
  const backup = JSON.parse(
    await run('compose-backup', process.execPath, [
      'scripts/backup-control-plane.mjs',
      '--env-file',
      setup.envFile,
      '--compose-file',
      'compose.yaml',
      '--project',
      project,
      '--database-dir',
      resolve(directory, 'database-backups'),
      '--key-dir',
      resolve(directory, 'key-backups'),
      '--label',
      `s1-${suffix}`,
    ]),
  );
  await docker('redis-start', ['start', 'redis']);
  const recovered = await until(
    () => web('GET', `/api/operations/${queuedId}`),
    (response) => response.data?.data.status === 'succeeded',
    'outbox recovery',
  );
  assert.equal(recovered.data.data.attempts, 1);
  evidence.checks.redisOutageAcceptedAndRecovered = true;

  const restoredDatabase = `restore_${suffix}`;
  await psql(`CREATE DATABASE "${restoredDatabase}";`);
  const targetEnv = resolve(directory, 'restore.env');
  const targetKey = resolve(directory, 'restored-secrets', 'master-key.json');
  await writeFile(
    targetEnv,
    (await readFile(setup.envFile, 'utf8'))
      .replace(/^POSTGRES_DB=.*$/m, `POSTGRES_DB=${restoredDatabase}`)
      .replace(/^RESTORE_MODE=.*$/m, 'RESTORE_MODE=true'),
    { mode: 0o600 },
  );
  const receipt = JSON.parse(
    await run('compose-restore', process.execPath, [
      'scripts/restore-control-plane.mjs',
      '--env-file',
      targetEnv,
      '--compose-file',
      'compose.yaml',
      '--project',
      project,
      '--database-backup',
      backup.databaseDirectory,
      '--key-backup',
      backup.keyDirectory,
      '--target-key-file',
      targetKey,
    ]),
  );
  assert.equal(receipt.restoreLocked, true);
  assert.equal(receipt.generation, 1);
  assert.equal(
    await psql(
      `SELECT "restoreLocked"::text || ':' || generation FROM public."ControlPlaneState";`,
      restoredDatabase,
    ),
    'true:1',
  );
  assert.equal(
    await psql(
      `SELECT status::text || ':' || generation FROM public."Operation" WHERE id = '${queuedId}'::uuid;`,
      restoredDatabase,
    ),
    'queued:0',
  );
  assert.equal(
    await psql(
      'SELECT count(*) FROM public."Session" WHERE "revokedAt" IS NULL;',
      restoredDatabase,
    ),
    '0',
  );
  assert.deepEqual(await readFile(targetKey), await readFile(setup.masterKeyFile));
  assert.equal((await web('GET', '/api/health/ready')).data.mode, 'read_write');
  evidence.checks.composeBackupRestoreLocksNewGeneration = true;

  console.log('Testing container restart and persistent state.');
  await docker('storage-restart', ['restart', 'postgres', 'redis']);
  await until(
    () => web('GET', '/api/health/ready'),
    (response) => response.status === 200,
    'database after restart',
  );
  await docker('application-restart', ['restart', 'api', 'worker', 'console']);
  await until(
    () => web('GET', '/api/health/ready'),
    (response) => response.status === 200,
    'API after restart',
  );
  assert.equal((await web('GET', `/api/projects/${projectId}`)).data.data.id, projectId);
  const restartedOperation = (await web('GET', `/api/operations/${queuedId}`)).data.data;
  assert.equal(restartedOperation.status, 'succeeded');
  assert.equal(restartedOperation.attempts, 1);
  assert.equal(
    (await web('GET', '/api/secrets')).data.data.some((entry) => entry.id === secret.data.data.id),
    true,
  );
  await until(
    () => web('GET', '/api/operations/worker-status'),
    (response) => response.data?.data.status === 'ready',
    'worker after restart',
  );
  evidence.checks.restartPreservesDatabaseKeyAndTls = true;

  // Change both the account and the claimed address so only the actual client
  // address can reach the shared limit. The successful login already used one.
  for (let index = 0; index < 10; index += 1) {
    const attempt = await web(
      'POST',
      '/api/auth/login',
      { username: `unknown-${suffix}-${index}`, password: `incorrect-${marker}` },
      { 'x-forwarded-for': `203.0.113.${index + 1}` },
    );
    assert.equal(attempt.status, index < 9 ? 401 : 429);
    assert.equal(attempt.data.code, index < 9 ? 'INVALID_CREDENTIALS' : 'LOGIN_RATE_LIMITED');
  }
  evidence.checks.forgedForwardedAddressesCannotBypassLoginLimit = true;

  for (const service of ['api', 'worker']) {
    evidence.versions[`${service}Node`] = await docker(`${service}-node-version`, [
      'exec',
      '-T',
      service,
      'node',
      '--version',
    ]);
    evidence.versions[`${service}Pnpm`] = await docker(`${service}-pnpm-version`, [
      'exec',
      '-T',
      service,
      'pnpm',
      '--version',
    ]);
    assert.equal(evidence.versions[`${service}Node`], 'v24.22.1');
    assert.equal(evidence.versions[`${service}Pnpm`], '12.14.0');
  }
  evidence.versions.caddy = await docker('caddy-version', [
    'exec',
    '-T',
    'console',
    'caddy',
    'version',
  ]);
  assert.match(evidence.versions.caddy, /^v2\.11\.7/);
  evidence.versions.fastify = await docker('fastify-version', [
    'exec',
    '-T',
    'api',
    'node',
    '-p',
    'require("fastify/package.json").version',
  ]);
  assert.equal(evidence.versions.fastify, '5.12.7');
  for (const service of ['postgres', 'redis', 'api', 'worker', 'console']) {
    const id = await docker(`${service}-container-id`, ['ps', '-q', service]);
    const config = JSON.parse(
      await run(`${service}-runtime-config`, 'docker', [
        'inspect',
        '--format',
        '{{json .HostConfig}}',
        id,
      ]),
    );
    assert.ok(config.Memory > 0);
    assert.equal(config.LogConfig.Type, 'json-file');
    assert.equal(config.LogConfig.Config['max-size'], '10m');
    assert.equal(config.LogConfig.Config['max-file'], '3');
    if (service !== 'console') assert.equal(Object.keys(config.PortBindings || {}).length, 0);
    evidence.resources[service] = {
      imageId: await run(`${service}-image-id`, 'docker', [
        'inspect',
        '--format',
        '{{.Image}}',
        id,
      ]),
      memoryLimitBytes: config.Memory,
      cpuLimit: config.NanoCpus / 1e9,
      publishedPorts: Object.keys(config.PortBindings || {}),
    };
  }
  const backend = JSON.parse(
    await run('backend-network', 'docker', [
      'network',
      'inspect',
      `${project}_backend`,
      '--format',
      '{{json .}}',
    ]),
  );
  assert.equal(backend.Internal, true);
  evidence.checks.backendPrivateAndResourcesBounded = true;
  evidence.egress = await proveComposeEgress({
    root,
    directory,
    project,
    imagePrefix: values['image-prefix'],
    compose,
    run,
  });
  evidence.checks.apiAndWorkerReachExternalSshKubernetesAndRegistryProtocols = true;
  evidence.checks.databaseAndRedisCannotReachTheSameExternalProtocols = true;
  const ids = (await docker('stats-container-ids', ['ps', '-q'])).split(/\s+/).filter(Boolean);
  evidence.resources.sample = (
    await run('docker-stats', 'docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids])
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  evidence.status = 'passed';
  console.log(`All deployment checks passed. Evidence: ${directory}/evidence.json`);
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = error instanceof Error ? error.message : 'Deployment proof failed';
  console.error(evidence.failure);
  process.exitCode = 1;
} finally {
  for (const server of reservations) {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  }
  if (started) {
    try {
      await docker('fixture-stop', ['stop']);
      evidence.containers = 'stopped-and-retained';
    } catch {
      evidence.containers = 'inspect-before-reuse';
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`Fixture data, keys and volumes retained for review; project ${project}.`);
}
