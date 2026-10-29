import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  apiOrigin,
  checkFixtureHealth,
  cloneOrigin,
  fixtureOwner,
  privateFile,
  productDirectory,
  productRoot,
  publicAppOrigin,
  readProductConfiguration,
  validateUpstream,
} from './support/s6-github-product.mjs';

// Persistent local provider only. Actual checkout/solve must start through product API tasks.
const execute = promisify(execFile);
const command = process.argv[2] ?? 'status';
const fixtureScript = resolve(productRoot, 'tests/probes/support/s6-github-fixture.py');
const configurationPath = resolve(productDirectory, 'config.json');
const runtimePath = resolve(productDirectory, 'runtime.json');
const repositoryId = '100001';
const fullName = 'ozz-fixture/application';
const baseImage = 'nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236';
const gitEnvironment = {
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

async function prepare() {
  try {
    await lstat(productDirectory);
    // Repeated preparation preserves the PAT, Git history, registered hooks and TLS identity.
    return await readProductConfiguration();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const upstream = process.env.REGISTRY_HTTP_PROXY || undefined;
  validateUpstream(upstream);
  const parent = resolve(productDirectory, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(resolve(parent, '.product-prepare-'));
  try {
    const fixtureId = `ozz-s6-product-${randomUUID()}`;
    const token = `github_pat_${randomBytes(30).toString('hex')}`;
    const seed = resolve(staging, 'seed');
    const gitRoot = resolve(staging, 'repositories');
    for (const directory of [seed, gitRoot, resolve(seed, 'public')])
      await mkdir(directory, { mode: 0o700 });
    const file = (name, contents) =>
      writeFile(resolve(staging, name), contents, { mode: 0o600, flag: 'wx' });
    await file(
      'ca.cnf',
      '[req]\ndistinguished_name=dn\nx509_extensions=ca_ext\nprompt=no\n[dn]\nCN=Ozz S6 Product Fixture CA\n[ca_ext]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
    );
    await file(
      'server.cnf',
      '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=host.lima.internal\n[server_ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:host.lima.internal\n',
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
        '30',
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
        '30',
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
    ])
      await execute('/usr/bin/openssl', args, {
        cwd: staging,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    const git = (args) =>
      execute('/usr/bin/git', args, {
        cwd: seed,
        env: gitEnvironment,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    await git(['init', '--bare', '--initial-branch=main', resolve(gitRoot, `${repositoryId}.git`)]);
    await git(['init', '--initial-branch=main']);
    await file(
      'seed/Dockerfile',
      `FROM ${baseImage}\nCOPY public/index.html /usr/share/nginx/html/index.html\n`,
    );
    await file('seed/.dockerignore', '.git\n');
    await file(
      'seed/public/index.html',
      `<!doctype html>\n<html lang="en"><meta charset="utf-8"><title>Ozz S6 Git deployment</title><body><main><h1>Ozz S6 Git deployment</h1><p id="deployment-marker">${fixtureId}</p></main></body></html>\n`,
    );
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
      'fixture: nginx product application',
    ]);
    const initialSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(initialSha)) throw new Error('S6_PRODUCT_COMMIT_INVALID');
    // The relative remote survives moving the completed staging directory into place.
    await git(['remote', 'add', 'origin', `../repositories/${repositoryId}.git`]);
    await git(['push', '--all', 'origin']);
    await file('pat.json', JSON.stringify({ token }) + '\n');
    await file(
      'state.json',
      JSON.stringify({
        owner: fixtureOwner,
        account: { id: 10001, login: 'ozz-fixture' },
        repositories: [{ id: repositoryId, fullName, defaultBranch: 'main', hooks: [] }],
        accessTokens: [{ token, repositoryIds: [repositoryId], webhookWrite: true }],
        nextHookId: '200001',
      }) + '\n',
    );
    await file(
      'config.json',
      JSON.stringify(
        {
          owner: fixtureOwner,
          fixtureId,
          stateFile: 'state.json',
          gitRoot: 'repositories',
          gitExecutable: '/usr/bin/git',
          listenHost: '0.0.0.0',
          listenPort: 51446,
          apiOrigin,
          tlsCertificateFile: 'server.crt',
          tlsKeyFile: 'server.key',
        },
        null,
        2,
      ) + '\n',
    );
    await file(
      'registry-proxy.json',
      JSON.stringify(
        {
          owner: 'ozz-s6-registry-proxy-v1',
          listenHost: '127.0.0.1',
          listenPort: 51447,
          ...(upstream ? { upstream } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    await file(
      'metadata.json',
      JSON.stringify(
        {
          owner: fixtureOwner,
          fixtureId,
          repositoryId,
          fullName,
          branch: 'main',
          initialSha,
          marker: fixtureId,
          apiOrigin,
          cloneOrigin,
          publicAppOrigin,
          preparedAt: new Date().toISOString(),
          baseImage,
        },
        null,
        2,
      ) + '\n',
    );
    await rename(staging, productDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return readProductConfiguration();
}

function live(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function assertOwned(pid) {
  const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (
    !args.endsWith(`${fixtureScript} serve ${configurationPath}`) ||
    !cwd.split('\n').includes(`n${productDirectory}`)
  )
    throw new Error('S6_PRODUCT_PROCESS_NOT_OWNED');
}

async function readRuntime(configuration) {
  try {
    const runtime = JSON.parse(await privateFile(productDirectory, 'runtime.json'));
    if (
      runtime.owner !== fixtureOwner ||
      runtime.fixtureId !== configuration.fixture.fixtureId ||
      !Number.isInteger(runtime.pid) ||
      runtime.pid < 2
    )
      throw new Error('S6_PRODUCT_RUNTIME_INVALID');
    if (live(runtime.pid)) assertOwned(runtime.pid);
    return runtime;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function saveRuntime(runtime) {
  const temporary = resolve(productDirectory, `.runtime-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(runtime) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, runtimePath);
}

async function start(configuration, runtime) {
  if (live(runtime?.pid)) {
    await checkFixtureHealth(configuration);
    return runtime;
  }
  const portCheck = createServer();
  await new Promise((accept, reject) => {
    portCheck.once('error', () => reject(new Error('S6_PRODUCT_PORT_IN_USE')));
    portCheck.listen(51446, '0.0.0.0', accept);
  });
  await new Promise((accept) => portCheck.close(accept));
  const log = await open(resolve(productDirectory, 'fixture.log'), 'a', 0o600);
  let child;
  try {
    child = spawn('python3', [fixtureScript, 'serve', configurationPath], {
      cwd: productDirectory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((accept, reject) => {
      child.once('spawn', accept);
      child.once('error', () => reject(new Error('S6_PRODUCT_START_FAILED')));
    });
    child.unref();
    runtime = {
      owner: fixtureOwner,
      fixtureId: configuration.fixture.fixtureId,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
    await saveRuntime(runtime);
  } finally {
    await log.close();
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      await checkFixtureHealth(configuration);
      return runtime;
    } catch {
      await delay(150);
    }
  }
  if (live(runtime.pid)) {
    assertOwned(runtime.pid);
    process.kill(runtime.pid, 'SIGTERM');
  }
  throw new Error('S6_PRODUCT_READINESS_TIMEOUT');
}

async function stop(runtime) {
  if (!live(runtime?.pid)) return;
  try {
    const productRuntime = JSON.parse(
      await readFile(resolve(productRoot, '.local/s3-runtime.json'), 'utf8'),
    );
    if (
      productRuntime.profile === 's6-github' &&
      [productRuntime.api, productRuntime.worker].some(live)
    )
      throw new Error('S6_PRODUCT_RUNTIME_STILL_ACTIVE');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assertOwned(runtime.pid);
  process.kill(runtime.pid, 'SIGTERM');
  const deadline = Date.now() + 15_000;
  while (live(runtime.pid) && Date.now() < deadline) await delay(100);
  if (live(runtime.pid)) throw new Error('S6_PRODUCT_STOP_TIMEOUT');
}

async function main() {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('S6_PRODUCT_NODE_24_REQUIRED');
  if (process.argv.length > 3 || !['prepare', 'start', 'stop', 'status'].includes(command))
    throw new Error('S6_PRODUCT_COMMAND_INVALID');
  process.umask(0o077);
  const configuration = command === 'prepare' ? await prepare() : await readProductConfiguration();
  let runtime = await readRuntime(configuration);
  if (command === 'start') runtime = await start(configuration, runtime);
  if (command === 'stop') await stop(runtime);
  let ready = false;
  if (live(runtime?.pid)) {
    await checkFixtureHealth(configuration);
    ready = true;
  }
  console.log(
    JSON.stringify({
      command,
      directory: productDirectory,
      pid: runtime?.pid ?? null,
      running: live(runtime?.pid),
      ready,
      metadata: configuration.metadata,
      privatePaths: {
        token: resolve(productDirectory, 'pat.json'),
        ca: resolve(productDirectory, 'ca.crt'),
        configuration: configurationPath,
        registryProxy: resolve(productDirectory, 'registry-proxy.json'),
      },
    }),
  );
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      code: /^S6_PRODUCT_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'S6_PRODUCT_COMMAND_FAILED',
    }),
  );
  process.exitCode = 1;
});
