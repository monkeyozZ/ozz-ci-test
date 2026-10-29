import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/dist/app.js';
import { PrismaClient } from '../../packages/database/dist/index.js';
import { createTestSession } from './helpers.js';

const execute = promisify(execFile);
// Resolve the same CJS provider token as createApp, without Vitest creating a
// second transformed constructor identity for dependency lookup.
const { SecretCipherService } = createRequire(import.meta.url)(
  '../../apps/api/dist/common/secret-cipher.service.js',
) as typeof import('../../apps/api/dist/common/secret-cipher.service.js');
const { PrismaService } = createRequire(import.meta.url)(
  '../../packages/database/dist/index.js',
) as typeof import('../../packages/database/dist/index.js');
const argon2 = createRequire(new URL('../../apps/api/package.json', import.meta.url))(
  'argon2',
) as typeof import('../../apps/api/node_modules/argon2');
const baseEnvironment = { ...process.env };
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl || !process.env.REDIS_URL)
  throw new Error('Security integration requires DATABASE_URL and REDIS_URL');
const schema = `security_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set('schema', schema);
const origin = 'https://security.ozz.test';
const username = 'security-admin';
const password = randomBytes(24).toString('base64url');
const marker = `security-secret-${randomUUID()}`;
let directory: string;
let keyFile: string;
let passwordFile: string;
let db: PrismaClient;
let app: Awaited<ReturnType<typeof createApp>>;
const sessions: Awaited<ReturnType<typeof createTestSession>>[] = [];

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const rootFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

async function cli(...args: string[]) {
  return execute(process.execPath, [rootFile('apps/api/dist/cli.js'), ...args], {
    env: process.env,
    timeout: 10000,
  });
}

async function authenticated() {
  const session = await createTestSession(app, db);
  sessions.push(session);
  return session;
}

async function login(overrides: Record<string, string> = {}, cookie?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin, ...(cookie ? { cookie } : {}), ...overrides },
    payload: { username, password },
  });
}

function cookieFrom(response: Awaited<ReturnType<typeof login>>) {
  const value = response.headers['set-cookie'];
  expect(typeof value).toBe('string');
  return String(value).split(';')[0]!;
}

async function restartApp() {
  await app.close();
  app = await createApp({ silent: true });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ozz-security-'));
  keyFile = join(directory, 'master-key.json');
  passwordFile = join(directory, 'password');
  await writeFile(
    keyFile,
    JSON.stringify({ activeVersion: 1, keys: { 1: randomBytes(32).toString('base64') } }),
    { mode: 0o600 },
  );
  await writeFile(passwordFile, password + '\n', { mode: 0o600 });
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    MASTER_KEY_FILE: keyFile,
    APP_ORIGIN: origin,
    NODE_ENV: 'test',
    RESTORE_MODE: 'false',
    TRUSTED_PROXY_CIDRS: '',
    LOG_LEVEL: 'silent',
    // Authentication tests own their configuration, including the production
    // cookie case; a developer's optional local ACME lab is not part of it.
    NETWORK_DNS_SERVERS: '',
    NETWORK_LOCAL_ACME_CONFIG_FILE: '',
  });
  await execute(
    process.execPath,
    [
      rootFile('packages/database/node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      rootFile('packages/database/prisma/schema.prisma'),
    ],
    { env: process.env, timeout: 25000 },
  );
  db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  await db.$connect();
  const initialized = await cli(
    'admin:init',
    '--username',
    username,
    '--password-file',
    passwordFile,
  );
  expect(initialized.stdout + initialized.stderr).not.toContain(password);
  app = await createApp({ silent: true });
});

beforeEach(async () => {
  // This UUID namespace belongs only to this suite; the running console is untouched.
  await db.loginAttempt.deleteMany();
});

afterAll(async () => {
  try {
    for (const session of sessions) await session.cleanup();
    await app?.close();
    await db?.$disconnect();
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in baseEnvironment)) delete process.env[key];
    Object.assign(process.env, baseEnvironment);
    const cleanup = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
    try {
      await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.$disconnect();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('S1 authentication and secret storage with real PostgreSQL', () => {
  it('initializes one administrator without defaults, replacement or public registration', async () => {
    const admin = await db.admin.findUniqueOrThrow({ where: { username } });
    expect(admin.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(admin.passwordHash).not.toContain(password);
    await expect(
      cli('admin:init', '--username', 'replacement', '--password-file', passwordFile),
    ).rejects.toMatchObject({ code: 1 });
    expect(await db.admin.count()).toBe(1);
    expect((await db.admin.findUniqueOrThrow({ where: { username } })).passwordHash).toBe(
      admin.passwordHash,
    );
    await expect(
      db.admin.create({ data: { username: 'second-admin', passwordHash: 'no-default' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.admin.create({
        data: { username: 'bypass-singleton', singleton: 2, passwordHash: 'no-default' },
      }),
    ).rejects.toBeDefined();
    for (const path of ['/api/auth/register', '/api/auth/signup']) {
      expect(
        (await app.inject({ method: 'POST', url: path, headers: { origin }, payload: {} }))
          .statusCode,
      ).toBe(404);
    }
    await chmod(passwordFile, 0o644);
    await expect(
      cli('admin:init', '--username', 'replacement', '--password-file', passwordFile),
    ).rejects.toMatchObject({ code: 1 });
    await chmod(passwordFile, 0o600);
  });

  it('uses opaque hashed sessions and revokes the prior session when logging in again', async () => {
    const first = await login();
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const header = String(first.headers['set-cookie']);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/api');
    const cookie = cookieFrom(first);
    const token = cookie.slice('ozz_session='.length);
    expect(first.body).not.toContain(token);
    expect(first.body).not.toContain(password);
    const stored = await db.session.findUniqueOrThrow({ where: { tokenHash: hash(token) } });
    expect(JSON.stringify(stored)).not.toContain(token);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user).toMatchObject({ username });
    const second = await login({}, cookie);
    expect(second.statusCode).toBe(200);
    expect(cookieFrom(second)).not.toBe(cookie);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
    ).toBe(401);
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: stored.id } })).revokedAt,
    ).not.toBeNull();
  });

  it('requires a valid session on all management surfaces and rejects expired and revoked sessions', async () => {
    for (const path of [
      '/api/auth/me',
      '/api/projects',
      '/api/environments',
      '/api/servers',
      '/api/clusters',
      '/api/secrets',
      '/api/operations',
    ]) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode, path).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
    const session = await authenticated();
    await db.session.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects', headers: session.headers }))
        .statusCode,
    ).toBe(401);
    await db.session.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(Date.now() + 60000), revokedAt: new Date() },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects', headers: session.headers }))
        .statusCode,
    ).toBe(401);
  });

  it('enforces exact Origin and CSRF checks while allowing the unauthenticated login flow', async () => {
    for (const headers of [
      {},
      { origin: 'https://elsewhere.example.test' },
      { origin, 'sec-fetch-site': 'cross-site' },
    ]) {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers,
        payload: { username, password },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('ORIGIN_REJECTED');
    }
    expect(await db.loginAttempt.count()).toBe(0);
    const session = await authenticated();
    const before = await db.cluster.count();
    for (const headers of [
      { cookie: session.headers.cookie, origin },
      { ...session.headers, 'x-csrf-token': 'invalid' },
      { ...session.headers, origin: 'https://elsewhere.example.test' },
      { ...session.headers, 'sec-fetch-site': 'cross-site' },
    ]) {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/clusters',
        headers,
        payload: { name: 'Denied', slug: 'denied' },
      });
      expect(denied.statusCode).toBe(403);
    }
    expect(await db.cluster.count()).toBe(before);
  });

  it.each([username, 'unknown-administrator'])(
    'bounds simultaneous password checks for %s without creating a busy session',
    async (account) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<boolean>();
      const verifier = vi.spyOn(argon2, 'verify').mockImplementationOnce(async () => {
        entered.resolve();
        return release.promise;
      });
      const before = await db.session.count();
      const first = app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: { username: account, password },
      });
      // inject is a lazy thenable; attach a continuation to start the request.
      const firstResponse = Promise.resolve(first);
      try {
        await entered.promise;
        const second = await login();
        expect(second.statusCode).toBe(503);
        expect(second.json().code).toBe('AUTH_BUSY');
        expect(second.headers['set-cookie']).toBeUndefined();
        expect(await db.session.count()).toBe(before);
        expect(verifier).toHaveBeenCalledTimes(1);
        release.resolve(false);
        expect((await firstResponse).statusCode).toBe(401);
      } finally {
        release.resolve(false);
        await firstResponse;
        verifier.mockRestore();
      }
      expect((await login()).statusCode).toBe(200);
    },
  );

  it('releases the password verification slot after a native verifier error', async () => {
    const verifier = vi
      .spyOn(argon2, 'verify')
      .mockRejectedValueOnce(new Error('synthetic verifier failure'));
    try {
      expect((await login()).statusCode).toBe(401);
      expect((await login()).statusCode).toBe(200);
    } finally {
      verifier.mockRestore();
    }
  });

  it('rejects API startup when the dummy password hash cannot be prepared', async () => {
    const hash = vi
      .spyOn(argon2, 'hash')
      .mockRejectedValueOnce(new Error('synthetic hash startup failure'));
    try {
      await expect(createApp({ silent: true })).rejects.toThrow('synthetic hash startup failure');
    } finally {
      hash.mockRestore();
    }
    expect((await login()).statusCode).toBe(200);
  });

  it('persists the login limit across API restarts and ignores forged forwarded addresses', async () => {
    const request = (index: number) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin, 'x-forwarded-for': `203.0.113.${index + 1}` },
        payload: { username: 'missing-admin', password: 'incorrect-but-valid-length' },
      });
    for (let index = 0; index < 10; index++) expect((await request(index)).statusCode).toBe(401);
    const denied = await request(10);
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBe('900');
    expect(
      (await db.loginAttempt.findUniqueOrThrow({ where: { key: hash('ip:127.0.0.1') } })).attempts,
    ).toBe(11);
    await restartApp();
    expect((await request(11)).statusCode).toBe(429);
    await db.loginAttempt.updateMany({
      data: { windowStart: new Date(Date.now() - 16 * 60 * 1000) },
    });
    expect((await request(12)).statusCode).toBe(401);
  });

  it('clears the browser cookie and durably revokes logout, including its audit event', async () => {
    const loggedIn = await login();
    const cookie = cookieFrom(loggedIn);
    const requestId = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        origin,
        cookie,
        'x-csrf-token': loggedIn.json().data.csrfToken,
        'x-request-id': requestId,
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(String(response.headers['set-cookie'])).toContain('ozz_session=;');
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
    ).toBe(401);
    expect(await db.auditEvent.findFirst({ where: { requestId } })).toMatchObject({
      action: 'auth.logout',
      outcome: 'succeeded',
    });
  });

  it('bounds pool exhaustion with a safe 503 and recovers after the occupied connection is released', async () => {
    const originalUrl = process.env.DATABASE_URL;
    const constrained = new URL(originalUrl!);
    constrained.searchParams.set('connection_limit', '1');
    constrained.searchParams.set('pool_timeout', '1');
    process.env.DATABASE_URL = constrained.toString();
    let occupied: Promise<number> | undefined;
    try {
      await restartApp();
      const session = await authenticated();
      const queryMarker = `ozz_pool_${randomUUID().replaceAll('-', '')}`;
      // This generated marker contains only letters/digits; no request input is SQL.
      occupied = app
        .get(PrismaService)
        .$executeRawUnsafe(`SELECT pg_sleep(2.5) /* ${queryMarker} */`);
      const running = occupied.then(() => undefined);
      let observed = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const rows = await db.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity
          WHERE state = 'active' AND pid <> pg_backend_pid()
            AND query LIKE ${`%${queryMarker}%`}
        `;
        observed = Number(rows[0]?.count) === 1;
        if (observed) break;
        await delay(10);
      }
      expect(observed).toBe(true);
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: session.headers,
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json().code).toBe('DATABASE_BUSY');
      expect(response.body.includes(constrained.toString())).toBe(false);
      expect(response.body).not.toContain('Prisma');
      await running;
      expect(
        (await app.inject({ method: 'GET', url: '/api/projects', headers: session.headers }))
          .statusCode,
      ).toBe(200);
    } finally {
      await occupied?.catch(() => undefined);
      process.env.DATABASE_URL = originalUrl;
      await restartApp();
    }
  });

  it('sets Secure cookies in production and preserves safe response and request IDs', async () => {
    process.env.NODE_ENV = 'production';
    try {
      await restartApp();
      const response = await login({ 'x-request-id': 'safe-security-request' });
      expect(response.statusCode).toBe(200);
      expect(String(response.headers['set-cookie'])).toContain('Secure');
      expect(response.headers['x-request-id']).toBe('safe-security-request');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      const invalid = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { 'x-request-id': 'invalid/identifier' },
      });
      expect(invalid.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(invalid.json().requestId).toBe(invalid.headers['x-request-id']);
    } finally {
      process.env.NODE_ENV = 'test';
      await restartApp();
    }
  });

  it('bounds bodies and emits Problem Details for parser and validation errors without payload echoes', async () => {
    for (const [body, contentType, status, code] of [
      ['{"password":"' + marker, 'application/json', 400, 'MALFORMED_REQUEST'],
      [
        JSON.stringify({ password: marker.repeat(5000) }),
        'application/json',
        413,
        'PAYLOAD_TOO_LARGE',
      ],
      [marker, 'application/x-ozz-unsupported', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin, 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ code, status, instance: '/api/auth/login' });
      expect(response.body).not.toContain(marker);
      expect(response.body).not.toContain('stack');
      expect(response.json().requestId).toBe(response.headers['x-request-id']);
    }
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username, password: marker, unexpected: marker },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().errors.unexpected).toBeDefined();
    expect(invalid.body).not.toContain(marker);
  });

  it('stores only authenticated ciphertext and audits the created resource in the same transaction', async () => {
    const session = await authenticated();
    const requestId = randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: '/api/secrets',
      headers: { ...session.headers, 'x-request-id': requestId },
      payload: {
        name: 'Security storage fixture',
        kind: 'ssh',
        payload: { privateKey: marker, passphrase: password },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id: string = created.json().data.id;
    const row = await db.secretReference.findUniqueOrThrow({ where: { id } });
    for (const value of [
      created.body,
      JSON.stringify(row),
      Buffer.from(row.encryptedPayload).toString('utf8'),
    ]) {
      expect(value).not.toContain(marker);
      expect(value).not.toContain(password);
    }
    for (const path of ['/api/secrets', `/api/secrets/${id}`]) {
      const response = await app.inject({ method: 'GET', url: path, headers: session.headers });
      expect(response.statusCode).toBe(200);
      for (const privateField of ['payload', 'encryptedPayload', 'nonce', 'tag', marker])
        expect(response.body).not.toContain(privateField);
    }
    expect(await db.auditEvent.findFirst({ where: { requestId } })).toMatchObject({
      actorId: session.adminId,
      action: 'post:/api/secrets',
      resourceId: id,
      outcome: 'succeeded',
    });
    await restartApp();
    expect(app.get(SecretCipherService).decrypt(row)).toEqual({
      privateKey: marker,
      passphrase: password,
    });
    const originalTag = Buffer.from(row.tag);
    await db.secretReference.update({ where: { id }, data: { tag: randomBytes(16) } });
    // Runtime reads authenticate each secret too; a good version canary is not enough.
    expect(() => app.get(SecretCipherService).decrypt({ ...row, tag: randomBytes(16) })).toThrow(
      'Secret authentication failed',
    );
    await db.secretReference.update({ where: { id }, data: { tag: originalTag } });
  });

  it('rolls a metadata write back if its durable audit cannot be recorded', async () => {
    const session = await authenticated();
    const before = await db.secretReference.count();
    // NOT VALID preserves earlier evidence while enforcing this fault on new rows.
    await db.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ADD CONSTRAINT security_test_audit_failure CHECK ("action" <> 'post:/api/secrets') NOT VALID`,
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/secrets',
        headers: session.headers,
        payload: { name: 'Must roll back', kind: 'generic', payload: { token: marker } },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(marker);
      expect(await db.secretReference.count()).toBe(before);
    } finally {
      await db.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT security_test_audit_failure',
      );
    }
  });

  it('refuses missing and mismatched master keys in both API and Worker without replacement', async () => {
    const wrongKey = join(directory, 'wrong-key.json');
    const original = await readFile(keyFile);
    await writeFile(
      wrongKey,
      JSON.stringify({ activeVersion: 1, keys: { 1: randomBytes(32).toString('base64') } }),
      { mode: 0o600 },
    );
    const checkBefore = await db.keyVerification.findMany();
    for (const file of [join(directory, 'missing.json'), wrongKey]) {
      for (const entry of ['apps/api/dist/main.js', 'apps/worker/dist/main.js']) {
        let failure: { code?: number; stdout?: string; stderr?: string } | undefined;
        try {
          await execute(process.execPath, [rootFile(entry)], {
            env: { ...process.env, MASTER_KEY_FILE: file, LOG_LEVEL: 'info' },
            timeout: 10000,
          });
        } catch (error) {
          failure = error as typeof failure;
        }
        expect(failure?.code, entry).toBe(1);
        const output = (failure?.stdout ?? '') + (failure?.stderr ?? '');
        expect(output).not.toContain(password);
        expect(output.includes(databaseUrl.toString())).toBe(false);
        expect(output).not.toContain(original.toString('utf8'));
      }
    }
    expect(await readFile(keyFile)).toEqual(original);
    expect(await db.keyVerification.findMany()).toEqual(checkBefore);
    await expect(readFile(join(directory, 'missing.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps actual API process output free of passwords, credential bodies and session values', async () => {
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('No local port assigned');
    const port = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    let output = '';
    const child: ChildProcess = spawn(process.execPath, [rootFile('apps/api/dist/main.js')], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const endpoint = `http://127.0.0.1:${port}`;
    let token = '';
    let csrf = '';
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          ready = (await fetch(endpoint + '/api/health/live')).ok;
        } catch {
          /* bounded startup polling */
        }
        if (ready) break;
        if (child.exitCode !== null) throw new Error('API process exited before readiness');
        await delay(50);
      }
      expect(ready).toBe(true);
      const response = await fetch(endpoint + '/api/auth/login', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      token = cookie.slice('ozz_session='.length);
      const value = (await response.json()) as { data: { csrfToken: string } };
      csrf = value.data.csrfToken;
      const secret = await fetch(endpoint + '/api/secrets', {
        method: 'POST',
        headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Log boundary fixture',
          kind: 'generic',
          payload: { token: marker },
        }),
      });
      expect(secret.status).toBe(201);
      await secret.arrayBuffer();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await exit;
      }
    }
    expect(output).toContain('request completed');
    for (const value of [password, marker, token, csrf, databaseUrl.toString()]) {
      expect(value.length).toBeGreaterThan(0);
      expect(output.includes(value)).toBe(false);
    }
  });
});
