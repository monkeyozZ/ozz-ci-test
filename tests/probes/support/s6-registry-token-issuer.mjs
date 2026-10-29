import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:https';
import { isIP } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Local acceptance fixture, never an application auth provider. Distribution
// 3.1.2 verifies these RS256 tokens with its configured public JWKS and enforces
// repository actions itself. Separate push and runtime users cannot acquire
// permissions by adding actions to the requested scope.
// Reference: distribution/distribution v3.1.2 registry/auth/token/{token,
// accesscontroller}.go. The fixture records no passwords, Authorization headers,
// private keys, or issued tokens.
const owner = 'ozz-s6-registry-token-fixture-v1';
const maximumFileBytes = 64 * 1024;
const maximumCredentials = 8;
const maximumScopes = 8;
const actions = new Set(['pull', 'push', 'delete']);
const repositoryPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const usernamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const safeLabel = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function requireValue(condition, code = 'S6_TOKEN_FIXTURE_CONFIG_INVALID') {
  if (!condition) throw new Error(code);
}

function object(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).every((key) => keys.includes(key)));
  return value;
}

async function protectedFile(path, base) {
  const absolute = resolve(base, path);
  const child = relative(base, absolute);
  requireValue(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
  const info = await lstat(absolute);
  requireValue(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0);
  requireValue(info.size > 0 && info.size <= maximumFileBytes);
  requireValue((await realpath(absolute)) === absolute);
  return readFile(absolute);
}

function validRepository(value) {
  return typeof value === 'string' && value.length <= 200 && repositoryPattern.test(value);
}

function credentialRows(value) {
  const list = object(value, ['owner', 'users']);
  requireValue(list.owner === owner && Array.isArray(list.users));
  requireValue(list.users.length >= 2 && list.users.length <= maximumCredentials);
  const users = new Set();
  return list.users.map((entry) => {
    const user = object(entry, ['username', 'password', 'repositories']);
    requireValue(typeof user.username === 'string' && usernamePattern.test(user.username));
    requireValue(!users.has(user.username));
    users.add(user.username);
    requireValue(
      typeof user.password === 'string' &&
        user.password.length >= 32 &&
        user.password.length <= 512 &&
        !/[\p{Cc}]/u.test(user.password),
    );
    requireValue(Array.isArray(user.repositories) && user.repositories.length <= 16);
    const repositories = new Map();
    for (const raw of user.repositories) {
      const item = object(raw, ['name', 'actions']);
      requireValue(validRepository(item.name) && !repositories.has(item.name));
      requireValue(
        Array.isArray(item.actions) &&
          item.actions.length <= 3 &&
          new Set(item.actions).size === item.actions.length &&
          item.actions.every((action) => actions.has(action)),
      );
      repositories.set(item.name, new Set(item.actions));
    }
    return {
      username: user.username,
      digest: createHash('sha256').update(`${user.username}:${user.password}`).digest(),
      repositories,
    };
  });
}

function authenticate(request, users) {
  const names = request.rawHeaders.filter((_, index) => index % 2 === 0);
  if (names.filter((name) => name.toLowerCase() === 'authorization').length !== 1) return null;
  const header = request.headers.authorization;
  if (typeof header !== 'string' || header.length > 2048) return null;
  const value = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(header)?.[1];
  if (!value) return null;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) return null;
  const supplied = createHash('sha256').update(decoded).digest();
  let matched = null;
  for (const user of users) {
    if (timingSafeEqual(supplied, user.digest)) matched = user;
  }
  decoded.fill(0);
  return matched;
}

function requestedScopes(url) {
  const values = url.searchParams.getAll('scope');
  requireValue(values.length <= maximumScopes, 'S6_TOKEN_SCOPE_INVALID');
  const requests = [];
  for (const value of values) {
    // Scope is space-delimited in the OAuth request and comma-delimited only
    // within the action list. Empty scope is valid for a Registry /v2/ ping.
    if (value === '') continue;
    requireValue(value.length <= 2048, 'S6_TOKEN_SCOPE_INVALID');
    for (const part of value.split(' ')) {
      const fields = part.split(':');
      requireValue(
        fields.length === 3 && fields[0] === 'repository' && validRepository(fields[1]),
        'S6_TOKEN_SCOPE_INVALID',
      );
      const wanted = fields[2].split(',');
      requireValue(
        wanted.length <= 3 &&
          new Set(wanted).size === wanted.length &&
          wanted.every((action) => actions.has(action)),
        'S6_TOKEN_SCOPE_INVALID',
      );
      requests.push({ type: 'repository', name: fields[1], actions: wanted });
      requireValue(requests.length <= maximumScopes, 'S6_TOKEN_SCOPE_INVALID');
    }
  }
  return requests;
}

function token(key, kid, claims) {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
}

export async function loadTokenFixture(configFile) {
  const absolute = resolve(configFile);
  const base = await realpath(dirname(absolute));
  requireValue(base === dirname(absolute));
  const directory = await lstat(base);
  requireValue(directory.isDirectory() && (directory.mode & 0o077) === 0);
  const settings = object(JSON.parse(await protectedFile(absolute, base)), [
    'owner',
    'fixtureId',
    'issuer',
    'service',
    'listenHost',
    'listenPort',
    'tlsKeyFile',
    'tlsCertificateFile',
    'signingKeyFile',
    'credentialsFile',
  ]);
  requireValue(settings.owner === owner);
  for (const name of ['fixtureId', 'issuer', 'service'])
    requireValue(typeof settings[name] === 'string' && safeLabel.test(settings[name]));
  requireValue(
    isIP(settings.listenHost) !== 0 &&
      Number.isInteger(settings.listenPort) &&
      settings.listenPort >= 1024 &&
      settings.listenPort <= 65535,
  );
  for (const name of ['tlsKeyFile', 'tlsCertificateFile', 'signingKeyFile', 'credentialsFile'])
    requireValue(typeof settings[name] === 'string' && settings[name].length <= 512);
  const keyBytes = await protectedFile(settings.signingKeyFile, base);
  const signingKey = createPrivateKey(keyBytes);
  keyBytes.fill(0);
  requireValue(
    signingKey.asymmetricKeyType === 'rsa' &&
      signingKey.asymmetricKeyDetails?.modulusLength >= 2048,
  );
  const publicKey = createPublicKey(signingKey);
  const kid = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64url');
  const publicJwks = {
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }],
  };
  const currentUsers = async () =>
    credentialRows(JSON.parse(await protectedFile(settings.credentialsFile, base)));
  await currentUsers();
  const [key, cert] = await Promise.all([
    protectedFile(settings.tlsKeyFile, base),
    protectedFile(settings.tlsCertificateFile, base),
  ]);
  return { settings, key, cert, signingKey, kid, publicJwks, currentUsers };
}

/** Callers persist only publicJwks. Private material stays inside this process. */
export function createTokenFixture(configuration, onEvent = () => {}) {
  const { settings, signingKey, kid, currentUsers } = configuration;
  let accepted = 0;
  let rejected = 0;
  let active = 0;
  let requests = 0;
  let windowStartedAt = Date.now();
  const server = createServer(
    {
      key: configuration.key,
      cert: configuration.cert,
      minVersion: 'TLSv1.2',
      maxHeaderSize: 8192,
      requestTimeout: 5000,
      headersTimeout: 5000,
      keepAliveTimeout: 1000,
    },
    async (request, response) => {
      let complete = false;
      const send = (status, body, extra = {}) => {
        if (complete) return;
        complete = true;
        response.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          ...extra,
        });
        response.end(JSON.stringify(body));
      };
      if (Date.now() - windowStartedAt >= 60_000) {
        windowStartedAt = Date.now();
        requests = 0;
      }
      if (++requests > 600 || active >= 8) {
        send(429, { code: 'S6_TOKEN_RATE_LIMITED' }, { 'retry-after': '1' });
        return;
      }
      active++;
      try {
        if (
          request.method !== 'GET' ||
          typeof request.url !== 'string' ||
          request.url.length > 8192 ||
          request.headers['transfer-encoding'] !== undefined ||
          ![undefined, '0'].includes(request.headers['content-length'])
        ) {
          send(400, { code: 'S6_TOKEN_REQUEST_INVALID' });
          return;
        }
        const url = new URL(request.url, 'https://fixture.invalid');
        if (url.pathname === '/healthz' && !url.search) {
          send(200, { owner, fixtureId: settings.fixtureId, accepted, rejected });
          return;
        }
        if (url.pathname !== '/token') {
          send(404, { code: 'S6_TOKEN_ROUTE_UNKNOWN' });
          return;
        }
        if (
          [...url.searchParams.keys()].some(
            (name) => !['service', 'scope', 'account', 'client_id', 'offline_token'].includes(name),
          ) ||
          url.searchParams.getAll('service').length !== 1 ||
          url.searchParams.get('service') !== settings.service ||
          ['account', 'client_id', 'offline_token'].some(
            (name) => url.searchParams.getAll(name).length > 1,
          ) ||
          ![null, 'false'].includes(url.searchParams.get('offline_token'))
        ) {
          send(400, { code: 'S6_TOKEN_REQUEST_INVALID' });
          return;
        }
        const user = authenticate(request, await currentUsers());
        if (!user) {
          rejected++;
          onEvent({ event: 'authentication_rejected', at: new Date().toISOString() });
          send(
            401,
            { code: 'S6_TOKEN_AUTHENTICATION_REQUIRED' },
            { 'www-authenticate': 'Basic realm="ozz-s6-local-registry"' },
          );
          return;
        }
        if (url.searchParams.has('account') && url.searchParams.get('account') !== user.username) {
          rejected++;
          send(403, { code: 'S6_TOKEN_ACCOUNT_MISMATCH' });
          return;
        }
        let requested;
        try {
          requested = requestedScopes(url);
        } catch {
          rejected++;
          send(400, { code: 'S6_TOKEN_SCOPE_INVALID' });
          return;
        }
        const access = requested.map((item) => ({
          type: item.type,
          name: item.name,
          actions: item.actions.filter((action) => user.repositories.get(item.name)?.has(action)),
        }));
        const now = Math.floor(Date.now() / 1000);
        const issued = token(signingKey, kid, {
          iss: settings.issuer,
          sub: user.username,
          aud: settings.service,
          exp: now + 60,
          nbf: now - 5,
          iat: now,
          jti: randomUUID(),
          access,
        });
        accepted++;
        onEvent({
          event: 'token_issued',
          at: new Date().toISOString(),
          user: user.username,
          requested,
          granted: access,
        });
        send(200, { token: issued, expires_in: 60, issued_at: new Date(now * 1000).toISOString() });
      } catch {
        rejected++;
        send(503, { code: 'S6_TOKEN_FIXTURE_UNAVAILABLE' });
      } finally {
        active--;
        request.resume();
      }
    },
  );
  server.maxConnections = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

async function main() {
  requireValue(process.argv.length === 4 && process.argv[2] === 'serve');
  const configuration = await loadTokenFixture(process.argv[3]);
  let events = 0;
  const server = createTokenFixture(configuration, (event) => {
    if (events++ < 10_000) console.log(JSON.stringify(event));
  });
  const { listenHost, listenPort, fixtureId } = configuration.settings;
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolveReady);
  });
  console.log(JSON.stringify({ event: 'listening', owner, fixtureId, listenHost, listenPort }));
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(JSON.stringify({ error: 'S6_TOKEN_FIXTURE_START_FAILED' }));
    process.exitCode = 1;
  });
}
