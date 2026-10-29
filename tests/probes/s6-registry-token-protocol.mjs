import { execFile } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createTokenFixture, loadTokenFixture } from './support/s6-registry-token-issuer.mjs';

// Real loopback HTTPS and signed-token fixture checks. These do not certify
// Distribution authorization, a Builder, GitHub, or an application deployment.
const root = resolve(import.meta.dirname, '../..');
const runId = `s6-token-${new Date()
  .toISOString()
  .replaceAll(/[^0-9TZ]/gu, '')
  .toLowerCase()}-${randomUUID().slice(0, 8)}`;
const directory = resolve(root, '.local/local-lab/s6-registry-token', runId);
const execute = promisify(execFile);
const repository = 'ozz-s6/application';
const owner = 'ozz-s6-registry-token-fixture-v1';
const report = {
  version: 1,
  runId,
  status: 'running',
  scope:
    'Real local HTTPS/RS256 issuer protocol only; Distribution scope enforcement is not yet tested.',
  startedAt: new Date().toISOString(),
  checks: [],
};
let server;
let configuration;
let port;
let ca;
const events = [];

function requireValue(value, code) {
  if (!value) throw new Error(code);
}

async function check(name, work) {
  await work();
  report.checks.push({ name, passed: true });
  console.log(JSON.stringify({ check: name, passed: true }));
}

async function file(name, contents) {
  const path = resolve(directory, name);
  await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
  return path;
}

async function openssl(args) {
  await execute('openssl', args, { cwd: directory, timeout: 15_000, maxBuffer: 64 * 1024 });
}

function call(path, credential, extra = {}) {
  return new Promise((accept, reject) => {
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: extra.method ?? 'GET',
        ca: extra.defaultTrust ? undefined : ca,
        rejectUnauthorized: true,
        agent: false,
        signal: globalThis.AbortSignal.timeout(5000),
        headers: credential
          ? { authorization: `Basic ${Buffer.from(credential).toString('base64')}` }
          : {},
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024) {
            response.destroy();
            reject(new Error('S6_TOKEN_RESPONSE_TOO_LARGE'));
          } else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            accept({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)) });
          } catch {
            reject(new Error('S6_TOKEN_RESPONSE_INVALID'));
          }
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function claims(result) {
  requireValue(result.status === 200, 'S6_TOKEN_NOT_ISSUED');
  const parts = result.value.token.split('.');
  requireValue(parts.length === 3, 'S6_TOKEN_JWT_INVALID');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
  const publicKey = createPublicKey({ key: configuration.publicJwks.keys[0], format: 'jwk' });
  requireValue(
    header.alg === 'RS256' &&
      header.kid === configuration.publicJwks.keys[0].kid &&
      verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        publicKey,
        Buffer.from(parts[2], 'base64url'),
      ),
    'S6_TOKEN_SIGNATURE_INVALID',
  );
  requireValue(
    payload.iss === configuration.settings.issuer &&
      payload.aud === configuration.settings.service &&
      payload.exp - payload.iat === 60 &&
      payload.nbf <= payload.iat,
    'S6_TOKEN_CLAIMS_INVALID',
  );
  return payload;
}

try {
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await file(
    'ca.cnf',
    '[req]\ndistinguished_name=dn\nx509_extensions=ca_ext\nprompt=no\n[dn]\nCN=Ozz S6 Token Protocol CA\n[ca_ext]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  await file(
    'server.cnf',
    '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=127.0.0.1\n[server_ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
  );
  await openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '2',
    '-config',
    'ca.cnf',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
  ]);
  await openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-config',
    'server.cnf',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
  ]);
  await openssl([
    'x509',
    '-req',
    '-sha256',
    '-days',
    '2',
    '-in',
    'server.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-extfile',
    'server.cnf',
    '-extensions',
    'server_ext',
    '-out',
    'server.crt',
  ]);
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await file('signing.key', key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const passwords = {
    push: randomBytes(32).toString('hex'),
    pull: randomBytes(32).toString('hex'),
  };
  const users = {
    owner,
    users: [
      {
        username: 's6-push',
        password: passwords.push,
        repositories: [{ name: repository, actions: ['pull', 'push'] }],
      },
      {
        username: 's6-pull',
        password: passwords.pull,
        repositories: [{ name: repository, actions: ['pull'] }],
      },
    ],
  };
  await file('credentials.json', JSON.stringify(users));
  const path = await file(
    'config.json',
    JSON.stringify({
      owner,
      fixtureId: runId,
      issuer: 'ozz-s6-token-protocol',
      service: 'ozz-s6-registry',
      listenHost: '127.0.0.1',
      listenPort: 51445,
      tlsKeyFile: 'server.key',
      tlsCertificateFile: 'server.crt',
      signingKeyFile: 'signing.key',
      credentialsFile: 'credentials.json',
    }),
  );
  configuration = await loadTokenFixture(path);
  await file('public-jwks.json', JSON.stringify(configuration.publicJwks));
  ca = await readFile(resolve(directory, 'ca.crt'));
  server = createTokenFixture(configuration, (event) => events.push(event));
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  port = server.address().port;
  const query = (scope = `repository:${repository}:pull,push`) =>
    `/token?service=ozz-s6-registry&scope=${encodeURIComponent(scope)}`;
  await check('loopback_https_with_scoped_ca', async () => {
    const response = await call('/healthz');
    requireValue(
      response.status === 200 && response.value.fixtureId === runId,
      'S6_TOKEN_HEALTH_FAILED',
    );
  });
  await check('system_trust_rejects_fixture_ca', async () => {
    let rejected = false;
    try {
      await call('/healthz', null, { defaultTrust: true });
    } catch (error) {
      rejected = [
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ].includes(error.code);
    }
    requireValue(rejected, 'S6_TOKEN_UNSCOPED_TRUST');
  });
  await check('invalid_authentication_cannot_obtain_token', async () => {
    const response = await call(query(), `s6-pull:${randomBytes(32).toString('hex')}`);
    requireValue(response.status === 401 && !response.value.token, 'S6_TOKEN_AUTH_FAILED');
  });
  await check('runtime_user_requested_push_is_reduced_to_pull', async () => {
    const payload = claims(await call(query(), `s6-pull:${passwords.pull}`));
    requireValue(
      payload.access.length === 1 &&
        payload.access[0].name === repository &&
        JSON.stringify(payload.access[0].actions) === '["pull"]',
      'S6_TOKEN_PULL_SCOPE_FAILED',
    );
  });
  await check('uploader_gets_only_its_authorized_repository_actions', async () => {
    const payload = claims(await call(query(), `s6-push:${passwords.push}`));
    requireValue(
      JSON.stringify(payload.access[0].actions) === '["pull","push"]',
      'S6_TOKEN_PUSH_SCOPE_FAILED',
    );
    const other = claims(
      await call(query('repository:ozz-s6/foreign:pull,push'), `s6-push:${passwords.push}`),
    );
    requireValue(other.access[0].actions.length === 0, 'S6_TOKEN_FOREIGN_SCOPE_FAILED');
  });
  await check('duplicate_service_and_unrequested_token_methods_rejected', async () => {
    const duplicate = await call(
      `${query()}&service=another-registry`,
      `s6-push:${passwords.push}`,
    );
    const post = await call(query(), `s6-push:${passwords.push}`, { method: 'POST' });
    requireValue(duplicate.status === 400 && post.status === 400, 'S6_TOKEN_REQUEST_GUARD_FAILED');
  });
  await check('password_rotation_changes_auth_without_changing_repository_identity', async () => {
    const replacement = randomBytes(32).toString('hex');
    users.users[1].password = replacement;
    await writeFile(resolve(directory, 'credentials.json'), JSON.stringify(users), { mode: 0o600 });
    const previous = await call(query(), `s6-pull:${passwords.pull}`);
    const current = claims(await call(query(), `s6-pull:${replacement}`));
    requireValue(
      previous.status === 401 &&
        current.sub === 's6-pull' &&
        JSON.stringify(current.access[0].actions) === '["pull"]',
      'S6_TOKEN_ROTATION_FAILED',
    );
  });
  await check('events_contain_no_credentials_or_issued_tokens', async () => {
    const serialized = JSON.stringify(events);
    requireValue(
      !serialized.includes(passwords.push) &&
        !serialized.includes(passwords.pull) &&
        !serialized.includes(users.users[1].password) &&
        !serialized.includes('eyJ'),
      'S6_TOKEN_EVENT_SECRET_FOUND',
    );
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errorCode = /^S6_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : 'S6_TOKEN_PROTOCOL_INTERRUPTED';
  process.exitCode = 1;
} finally {
  if (server) {
    await new Promise((accept) => {
      server.close(accept);
      server.closeAllConnections();
    });
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      passed: report.checks.length,
      report: `${relativePath(directory)}/results.json`,
    }),
  );
}

function relativePath(path) {
  return path.slice(root.length + 1);
}
