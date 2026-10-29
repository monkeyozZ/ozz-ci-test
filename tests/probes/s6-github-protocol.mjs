import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// Exercises the controlled GitHub provider over real TLS and git upload-pack.
// It does not certify GitHub authorization, webhook delivery, or a build.
const root = resolve(import.meta.dirname, '../..');
const runId = `s6-github-${new Date()
  .toISOString()
  .replaceAll(/[^0-9TZ]/gu, '')
  .toLowerCase()}-${randomUUID().slice(0, 8)}`;
const directory = resolve(root, '.local/local-lab/s6-github', runId);
const gitRoot = resolve(directory, 'repositories');
const worktree = resolve(directory, 'seed');
const cloneRoot = resolve(directory, 'checkout');
const owner = 'ozz-s6-github-fixture-v1';
const repositoryId = '100001';
const fullName = 'ozz-fixture/application';
const token = `github_pat_${randomBytes(30).toString('hex')}`;
const replacementToken = `github_pat_${randomBytes(30).toString('hex')}`;
const readToken = `github_pat_${randomBytes(30).toString('hex')}`;
const unauthorizedToken = `github_pat_${randomBytes(30).toString('hex')}`;
const hookSecret = randomBytes(32).toString('base64url');
const replacementHookSecret = randomBytes(32).toString('base64url');
const execute = promisify(execFile);
const report = {
  version: 1,
  runId,
  owner,
  status: 'running',
  startedAt: new Date().toISOString(),
  scope:
    'Controlled GitHub HTTPS API and real local bare-Git upload-pack only; no real GitHub authorization/delivery, Builder, Registry, or K3s acceptance.',
  checks: [],
};
const output = [];
let outputBytes = 0;
let child;
let childEnded;
let port;
let origin;
let ca;
let firstCommit;
let secondCommit;
let state;

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

async function replaceState() {
  const temporary = await file(`.state-${randomUUID()}`, JSON.stringify(state));
  await rename(temporary, resolve(directory, 'state.json'));
}

async function git(args, options = {}) {
  const environment = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'http.sslVerify',
    GIT_CONFIG_VALUE_2: 'true',
  };
  if (options.credential) {
    Object.assign(environment, {
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_3: 'http.sslCAInfo',
      GIT_CONFIG_VALUE_3: resolve(directory, 'ca.crt'),
      GIT_CONFIG_KEY_4: 'http.extraHeader',
      GIT_CONFIG_VALUE_4: `Authorization: Basic ${Buffer.from(
        `x-access-token:${options.credential}`,
      ).toString('base64')}`,
    });
  }
  return execute('/usr/bin/git', args, {
    cwd: options.cwd ?? worktree,
    env: environment,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function call(path, credential, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((accept, reject) => {
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        ca: options.defaultTrust ? undefined : ca,
        rejectUnauthorized: true,
        agent: false,
        signal: globalThis.AbortSignal.timeout(5000),
        headers: {
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(body
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 256 * 1024) response.destroy(new Error('S6_GITHUB_RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            accept({
              status: response.statusCode,
              headers: response.headers,
              value: JSON.parse(Buffer.concat(chunks)),
            });
          } catch {
            reject(new Error('S6_GITHUB_RESPONSE_INVALID'));
          }
        });
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const selected = server.address().port;
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return selected;
}

function retainOutput(chunk) {
  outputBytes += chunk.length;
  if (outputBytes <= 512 * 1024) output.push(Buffer.from(chunk));
  else child?.kill('SIGTERM');
}

async function commit(message) {
  await git(['add', '--all']);
  await git([
    '-c',
    'user.name=Ozz fixture',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    message,
  ]);
  const result = await git(['rev-parse', 'HEAD']);
  const sha = result.stdout.trim();
  requireValue(/^[a-f0-9]{40}$/u.test(sha), 'S6_GITHUB_COMMIT_INVALID');
  return sha;
}

try {
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(gitRoot, { mode: 0o700 });
  await mkdir(worktree, { mode: 0o700 });
  await mkdir(cloneRoot, { mode: 0o700 });
  await file(
    'ca.cnf',
    '[req]\ndistinguished_name=dn\nx509_extensions=ca_ext\nprompt=no\n[dn]\nCN=Ozz S6 Git Protocol CA\n[ca_ext]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  await file(
    'server.cnf',
    '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=127.0.0.1\n[server_ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
  );
  for (const args of [
    [
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
    ],
    [
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
    ],
    [
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
    ],
  ]) {
    await execute('openssl', args, { cwd: directory, timeout: 15_000, maxBuffer: 64 * 1024 });
  }
  ca = await readFile(resolve(directory, 'ca.crt'));
  await git(['init', '--bare', '--initial-branch=main', resolve(gitRoot, `${repositoryId}.git`)]);
  await git(['init', '--initial-branch=main']);
  await file('seed/Dockerfile', 'FROM scratch\nCOPY public /public\n');
  await mkdir(resolve(worktree, 'public'), { mode: 0o700 });
  await file('seed/public/index.html', '<!doctype html><title>Ozz S6</title><p>commit one</p>\n');
  await symlink('public', resolve(worktree, 'linked-public'));
  firstCommit = await commit('fixture: initial application');
  await git(['branch', 'feature/second']);
  await git(['remote', 'add', 'origin', resolve(gitRoot, `${repositoryId}.git`)]);
  await git(['push', '--all', 'origin']);
  state = {
    owner,
    account: { id: 10001, login: 'ozz-fixture' },
    accessTokens: [
      { token, repositoryIds: [repositoryId], webhookWrite: true },
      { token: readToken, repositoryIds: [repositoryId], webhookWrite: false },
      { token: unauthorizedToken, repositoryIds: [], webhookWrite: false },
    ],
    repositories: [{ id: repositoryId, fullName, defaultBranch: 'main', hooks: [] }],
    nextHookId: '200001',
  };
  await file('state.json', JSON.stringify(state));
  port = await unusedPort();
  origin = `https://127.0.0.1:${port}`;
  const configFile = await file(
    'config.json',
    JSON.stringify({
      owner,
      fixtureId: runId,
      stateFile: 'state.json',
      gitRoot: 'repositories',
      gitExecutable: '/usr/bin/git',
      listenHost: '127.0.0.1',
      listenPort: port,
      apiOrigin: origin,
      tlsCertificateFile: 'server.crt',
      tlsKeyFile: 'server.key',
    }),
  );
  child = spawn(
    'python3',
    [resolve(import.meta.dirname, 'support/s6-github-fixture.py'), 'serve', configFile],
    {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', retainOutput);
  child.stderr.on('data', retainOutput);
  childEnded = new Promise((accept) => {
    child.once('error', () => accept({ code: 'SPAWN_FAILED' }));
    child.once('close', (code, signal) => accept({ code, signal }));
  });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const health = await call('/healthz');
      ready =
        health.status === 200 && health.value.owner === owner && health.value.fixtureId === runId;
    } catch {
      // The fixture may still be binding its local TLS listener.
    }
    if (ready) break;
    await delay(100);
  }
  requireValue(ready, 'S6_GITHUB_FIXTURE_NOT_READY');

  await check('real_tls_and_explicit_private_ca', async () => {
    let rejected = false;
    try {
      await call('/healthz', undefined, { defaultTrust: true });
    } catch (error) {
      rejected = [
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ].includes(error.code);
    }
    requireValue(rejected, 'S6_GITHUB_DEFAULT_TRUST_DID_NOT_REJECT');
    const account = await call('/user', token);
    requireValue(
      account.status === 200 && account.value.id === 10001,
      'S6_GITHUB_ACCOUNT_MISMATCH',
    );
  });

  await check('authentication_and_repository_authorization', async () => {
    const anonymous = await call('/user');
    const wrong = await call('/user', 'github_pat_invalid');
    const hidden = await call(`/repositories/${repositoryId}`, unauthorizedToken);
    const allowed = await call('/user/repos', readToken);
    requireValue(
      anonymous.status === 401 && wrong.status === 401 && hidden.status === 404,
      'S6_GITHUB_AUTHORIZATION_FAILED',
    );
    requireValue(
      allowed.status === 200 && allowed.value.length === 1 && allowed.value[0].id === repositoryId,
      'S6_GITHUB_REPOSITORY_LIST_INVALID',
    );
  });

  await check('real_git_branches_commit_and_contents', async () => {
    const page = await call(`/repos/${fullName}/branches?per_page=1&page=1`, token);
    requireValue(
      page.status === 200 && page.value.length === 1 && typeof page.headers.link === 'string',
      'S6_GITHUB_BRANCH_PAGE_INVALID',
    );
    const following = new URL(page.headers.link.match(/^<([^>]+)>/u)?.[1]);
    requireValue(following.origin === origin, 'S6_GITHUB_PAGINATION_ORIGIN_INVALID');
    const next = await call(`${following.pathname}${following.search}`, token);
    requireValue(
      next.status === 200 && next.value.length === 1 && next.value[0].name !== page.value[0].name,
      'S6_GITHUB_BRANCH_NEXT_INVALID',
    );
    const head = await call(`/repos/${fullName}/commits/main`, token);
    const explicit = await call(`/repos/${fullName}/commits/${firstCommit}`, token);
    requireValue(
      head.status === 200 && head.value.sha === firstCommit && explicit.value.sha === firstCommit,
      'S6_GITHUB_COMMIT_RESOLUTION_FAILED',
    );
    const dockerfile = await call(
      `/repos/${fullName}/contents/Dockerfile?ref=${firstCommit}`,
      token,
    );
    const contents = await call(`/repos/${fullName}/contents/public?ref=${firstCommit}`, token);
    const linked = await call(
      `/repos/${fullName}/contents/linked-public?ref=${firstCommit}`,
      token,
    );
    requireValue(
      dockerfile.status === 200 && dockerfile.value.type === 'file' && dockerfile.value.size > 0,
      'S6_GITHUB_DOCKERFILE_INVALID',
    );
    requireValue(
      contents.status === 200 &&
        contents.value[0]?.path === 'public/index.html' &&
        linked.value.type === 'symlink',
      'S6_GITHUB_CONTENTS_INVALID',
    );
  });

  await check('native_git_fetches_exact_commit_over_verified_tls', async () => {
    await git(['init'], { cwd: cloneRoot });
    await git(['remote', 'add', 'origin', `${origin}/${fullName}.git`], { cwd: cloneRoot });
    await git(['fetch', '--depth=1', '--no-tags', 'origin', firstCommit], {
      cwd: cloneRoot,
      credential: token,
    });
    await git(['checkout', '--detach', 'FETCH_HEAD'], { cwd: cloneRoot });
    const actual = await git(['rev-parse', 'HEAD'], { cwd: cloneRoot });
    const content = await readFile(resolve(cloneRoot, 'public/index.html'), 'utf8');
    requireValue(
      actual.stdout.trim() === firstCommit && content.includes('commit one'),
      'S6_GITHUB_NATIVE_FETCH_INVALID',
    );
  });

  await check('branch_advance_does_not_change_pinned_checkout', async () => {
    await writeFile(
      resolve(worktree, 'public/index.html'),
      '<!doctype html><title>Ozz S6</title><p>commit two</p>\n',
    );
    secondCommit = await commit('fixture: second application');
    await git(['push', 'origin', 'main']);
    const head = await call(`/repos/${fullName}/commits/main`, token);
    const pinned = await call(`/repos/${fullName}/commits/${firstCommit}`, token);
    const actual = await git(['rev-parse', 'HEAD'], { cwd: cloneRoot });
    requireValue(
      head.value.sha === secondCommit &&
        pinned.value.sha === firstCommit &&
        actual.stdout.trim() === firstCommit,
      'S6_GITHUB_PINNING_FAILED',
    );
    await git(['fetch', '--depth=1', '--no-tags', 'origin', secondCommit], {
      cwd: cloneRoot,
      credential: token,
    });
    await git(['checkout', '--detach', 'FETCH_HEAD'], { cwd: cloneRoot });
    requireValue(
      (await readFile(resolve(cloneRoot, 'public/index.html'), 'utf8')).includes('commit two'),
      'S6_GITHUB_SECOND_FETCH_FAILED',
    );
  });

  await check('native_git_rejects_unauthorized_read_and_all_pushes', async () => {
    let deniedRead = false;
    let deniedPush = false;
    try {
      await git(['ls-remote', 'origin'], { cwd: cloneRoot, credential: unauthorizedToken });
    } catch {
      deniedRead = true;
    }
    try {
      await git(['push', 'origin', 'HEAD:refs/heads/from-fixture'], {
        cwd: cloneRoot,
        credential: token,
      });
    } catch {
      deniedPush = true;
    }
    const branch = await call(`/repos/${fullName}/commits/from-fixture`, token);
    requireValue(
      deniedRead && deniedPush && branch.status === 404,
      'S6_GITHUB_READ_ONLY_TRANSPORT_FAILED',
    );
  });

  await check('explicit_hook_write_is_persisted_and_secret_is_omitted', async () => {
    const callback = `https://control.example.test/api/webhooks/github/${randomUUID()}/${randomUUID()}`;
    const input = {
      name: 'web',
      active: true,
      events: ['push'],
      config: { url: callback, content_type: 'json', insecure_ssl: '0', secret: hookSecret },
    };
    const denied = await call(`/repos/${fullName}/hooks`, readToken, {
      method: 'POST',
      body: input,
    });
    const created = await call(`/repos/${fullName}/hooks`, token, { method: 'POST', body: input });
    requireValue(
      denied.status === 403 && created.status === 201 && created.value.id === '200001',
      'S6_GITHUB_HOOK_CREATE_FAILED',
    );
    input.config.secret = replacementHookSecret;
    const updated = await call(`/repos/${fullName}/hooks/${created.value.id}`, token, {
      method: 'PATCH',
      body: input,
    });
    const list = await call(`/repos/${fullName}/hooks`, token);
    const stored = JSON.parse(await readFile(resolve(directory, 'state.json'), 'utf8'));
    requireValue(
      updated.status === 200 &&
        list.value.length === 1 &&
        stored.repositories[0].hooks[0].secret === replacementHookSecret,
      'S6_GITHUB_HOOK_PERSISTENCE_FAILED',
    );
    const replies = JSON.stringify([created.value, updated.value, list.value]);
    requireValue(
      !replies.includes(hookSecret) && !replies.includes(replacementHookSecret),
      'S6_GITHUB_HOOK_SECRET_EXPOSED',
    );
    state = stored;
  });

  await check('current_credentials_rotate_without_fixture_restart', async () => {
    state.accessTokens[0].token = replacementToken;
    await replaceState();
    requireValue(
      (await call('/user', token)).status === 401 &&
        (await call('/user', replacementToken)).status === 200,
      'S6_GITHUB_API_ROTATION_FAILED',
    );
    let oldDenied = false;
    try {
      await git(['ls-remote', 'origin'], { cwd: cloneRoot, credential: token });
    } catch {
      oldDenied = true;
    }
    const current = await git(['ls-remote', 'origin', 'refs/heads/main'], {
      cwd: cloneRoot,
      credential: replacementToken,
    });
    requireValue(
      oldDenied && current.stdout.startsWith(secondCommit),
      'S6_GITHUB_GIT_ROTATION_FAILED',
    );
  });

  await check('stable_repository_id_survives_name_change', async () => {
    state.repositories[0].fullName = 'ozz-fixture/renamed-application';
    await replaceState();
    const repository = await call(`/repositories/${repositoryId}`, replacementToken);
    requireValue(
      repository.status === 200 &&
        repository.value.id === repositoryId &&
        repository.value.full_name === state.repositories[0].fullName,
      'S6_GITHUB_RENAME_IDENTITY_FAILED',
    );
    const current = await git(
      ['ls-remote', `${origin}/${repository.value.full_name}.git`, 'refs/heads/main'],
      { cwd: cloneRoot, credential: replacementToken },
    );
    requireValue(current.stdout.startsWith(secondCommit), 'S6_GITHUB_RENAMED_FETCH_FAILED');
  });

  await check('fixture_events_do_not_expose_credentials_or_hook_secrets', async () => {
    const logs = Buffer.concat(output).toString('utf8');
    for (const secret of [
      token,
      replacementToken,
      readToken,
      unauthorizedToken,
      hookSecret,
      replacementHookSecret,
    ]) {
      requireValue(
        !logs.includes(secret) &&
          !logs.includes(Buffer.from(`x-access-token:${secret}`).toString('base64')),
        'S6_GITHUB_EVENT_SECRET_EXPOSED',
      );
    }
    requireValue(
      logs.includes('git_upload_pack') && logs.includes('hook_saved') && outputBytes <= 512 * 1024,
      'S6_GITHUB_EXPECTED_EVENTS_MISSING',
    );
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errorCode = /^S6_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : 'S6_GITHUB_PROTOCOL_UNEXPECTED_FAILURE';
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  if (childEnded) {
    const ended = await Promise.race([childEnded, delay(5000).then(() => null)]);
    if (ended === null) {
      child.kill('SIGKILL');
      await childEnded;
      report.forcedFixtureStop = true;
    }
    report.fixtureStopped = true;
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter((item) => item.passed).length;
  report.repository = { id: repositoryId, firstCommit, secondCommit };
  report.fixtureSourceSha256 = createHash('sha256')
    .update(await readFile(resolve(import.meta.dirname, 'support/s6-github-fixture.py')))
    .digest('hex');
  await writeFile(resolve(directory, 'fixture.log'), Buffer.concat(output), {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(resolve(directory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      status: report.status,
      passed: report.passed,
      report: resolve(directory, 'results.json'),
      errorCode: report.errorCode,
    }),
  );
}
