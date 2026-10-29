import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import {
  canonicalJson,
  parseEndProof,
  verifySigned,
} from '../../packages/infrastructure/dist/build.js';
import {
  checkFixtureHealth,
  checkProductHttpsHealth,
  privateFile,
  productDirectory,
  productRoot,
  publicAppOrigin,
  readProductConfiguration,
} from './support/s6-github-product.mjs';

// This is an executable acceptance procedure, not evidence that faults passed.
// Every build starts through the product HTTP preview/deployment command.
const owner = 'ozz-s6-builder-faults-v1';
const cases = ['cancel', 'timeout', 'pids', 'disk', 'memory', 'disconnect', 'artifact'];
const modes = [
  'prepare',
  'status',
  'start',
  'observe',
  'observe-saved',
  'cancel',
  'run-cancel',
  'retry-artifact',
  'retry-observe',
  'limits-begin',
  'timeout-retest-begin',
  'limits-restore',
  'disconnect',
  'registry-allow',
  'registry-restore',
  'stop-artifact',
  'report',
];
const [mode, selected, savedKernelReport] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const directory = resolve(productRoot, '.local/local-lab/s6-builder-faults');
const parentDirectory = resolve(productRoot, '.local/local-lab/s6-product');
const webhookDirectory = resolve(productRoot, '.local/local-lab/s6-webhook');
const registryDirectory = resolve(productRoot, '.local/local-lab/s6-registry');
const statePath = resolve(directory, 'state.json');
const execute = promisify(execFile);
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let configuration,
  parent,
  state,
  cookie,
  csrf,
  canarySha256,
  sensitive = [];
const locks = [];
const gibibyte = 1024 ** 3;

function requireValue(value, code) {
  if (!value) throw new Error('S6_FAULT_' + code);
}

async function availableDisk() {
  const value = await statfs(productRoot);
  return value.bavail * value.bsize;
}

async function requireDisk(gibibytes) {
  const availableBytes = await availableDisk();
  requireValue(availableBytes >= gibibytes * gibibyte, 'LOCAL_DISK_RESERVE_REQUIRED');
  return availableBytes;
}

async function protectDiskDuring(task) {
  const availableBytes = await availableDisk();
  if (availableBytes >= 9 * gibibyte) return;
  requireValue(
    Object.values(state.cases).some(
      (item) => item.deploymentId === task.id || item.retryDeploymentId === task.id,
    ),
    'UNKNOWN_FAULT_DEPLOYMENT',
  );
  await api(`/deployments/${task.id}/cancel`, { method: 'POST', expected: 202 });
  await evidence(
    'disk-reserve-stop',
    'local filesystem observation and product cancellation receipt',
    { deploymentId: task.id, availableBytes, minimumRemainingBytes: 8 * gibibyte },
  );
  throw new Error('S6_FAULT_LOCAL_DISK_RESERVE_REACHED');
}

async function atomic(path, text) {
  const temporary = path + '.' + randomUUID();
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
const save = () => atomic(statePath, JSON.stringify(state, null, 2) + '\n');

function safe(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  requireValue(
    !sensitive.some((secret) => secret && text.includes(secret)) &&
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text),
    'PLAINTEXT_DETECTED',
  );
  return value;
}

async function evidence(label, source, value) {
  requireValue(/^[a-z0-9-]+$/u.test(label), 'EVIDENCE_LABEL_INVALID');
  const path = resolve(directory, `${label}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(
    path,
    JSON.stringify(safe({ recordedAt: new Date().toISOString(), source, ...value }), null, 2) +
      '\n',
    { mode: 0o600, flag: 'wx' },
  );
  return path;
}

async function api(path, { method = 'GET', body, key, expected } = {}) {
  requireValue(path.startsWith('/') && !path.startsWith('//'), 'API_PATH_INVALID');
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const response = await new Promise((accept, reject) => {
    const request = httpsRequest(
      publicAppOrigin + '/api' + path,
      {
        method,
        ca: configuration.ca,
        rejectUnauthorized: true,
        agent: false,
        signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(20_000)]),
        headers: {
          origin: publicAppOrigin,
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
          ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
        },
      },
      (result) => {
        const chunks = [];
        let size = 0;
        result.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) result.destroy(new Error('S6_FAULT_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        result.once('error', reject);
        result.once('end', () => {
          try {
            accept({
              status: result.statusCode,
              headers: result.headers,
              value: result.statusCode === 204 ? null : JSON.parse(Buffer.concat(chunks)),
            });
          } catch {
            reject(new Error('S6_FAULT_RESPONSE_INVALID'));
          }
        });
      },
    );
    request.once('error', reject);
    request.end(bytes);
  });
  requireValue(
    expected ? response.status === expected : response.status >= 200 && response.status < 300,
    'API_FAILED_' + response.status,
  );
  return response;
}
const data = async (path) => (await api(path)).value.data;

async function list(path, provider = false) {
  const items = [],
    seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const query = [
      ...(provider ? [] : ['limit=100']),
      ...(cursor ? ['cursor=' + encodeURIComponent(cursor)] : []),
    ];
    const result = (
      await api(path + (query.length ? (path.includes('?') ? '&' : '?') + query.join('&') : ''))
    ).value;
    requireValue(Array.isArray(result.data), 'PAGE_INVALID');
    items.push(...result.data);
    if (!result.page?.hasMore) return items;
    cursor = result.page.nextCursor;
    requireValue(typeof cursor === 'string' && cursor && !seen.has(cursor), 'CURSOR_INVALID');
    seen.add(cursor);
  }
  throw new Error('S6_FAULT_PAGE_LIMIT');
}

async function command(label, path, body, expected = 202) {
  state.commands[label] ??= { path, body, key: randomUUID() };
  const intent = state.commands[label];
  requireValue(intent.path === path && isDeepStrictEqual(intent.body, body), 'COMMAND_CHANGED');
  await save();
  const result = (await api(path, { method: 'POST', body, key: intent.key, expected })).value.data;
  requireValue(
    uuid.test(result.id) && (!intent.id || intent.id === result.id),
    'IDEMPOTENCY_CHANGED',
  );
  intent.id = result.id;
  await save();
  await evidence('accepted-' + label, 'product HTTP command receipt', { result });
  return result;
}

const gitEnvironment = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'credential.helper',
  GIT_CONFIG_VALUE_1: '',
};
async function git(args, cwd = productRoot) {
  return (
    await execute('/usr/bin/git', args, {
      cwd,
      env: gitEnvironment,
      timeout: 20_000,
      maxBuffer: 256 * 1024,
      signal: abort.signal,
    })
  ).stdout.trimEnd();
}
const bare = () =>
  resolve(productDirectory, `repositories/${configuration.metadata.repositoryId}.git`);

async function protectedState() {
  const files = [
    resolve(parentDirectory, 'state.json'),
    resolve(webhookDirectory, 'state.json'),
    resolve(productDirectory, 'metadata.json'),
    resolve(productDirectory, 'state.json'),
  ];
  return {
    hashes: Object.fromEntries(
      await Promise.all(files.map(async (path) => [path, sha(await readFile(path))])),
    ),
    mainHead: await git([
      '--git-dir',
      bare(),
      'rev-parse',
      '--verify',
      `refs/heads/${configuration.metadata.branch}`,
    ]),
    seedHead: await git(['rev-parse', 'HEAD'], resolve(productDirectory, 'seed')),
    seedStatus: await git(['status', '--porcelain'], resolve(productDirectory, 'seed')),
  };
}
async function unchanged() {
  requireValue(
    isDeepStrictEqual(await protectedState(), state.protected),
    'PROTECTED_FIXTURE_CHANGED',
  );
}

async function host(action, additional = {}) {
  const source = await readFile(
    resolve(productRoot, 'tests/probes/support/s6-builder-fault-host.py'),
    'utf8',
  );
  const parameters = { action, sessionId: state.limitsWindowId ?? state.id, ...additional };
  const job = execute(
    'ssh',
    [
      '-F',
      resolve(productRoot, '.local/local-lab/builder/credentials/ssh_config'),
      '-o',
      'BatchMode=yes',
      'ozz-build',
      'sudo -n /usr/bin/python3 -I -B -',
    ],
    { cwd: productRoot, timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  // Arguments are data on stdin, never interpolated into a shell command.
  job.child.stdin.end(
    `import json\nparameters = json.loads(${JSON.stringify(JSON.stringify(parameters))})\n${source}`,
  );
  return safe(JSON.parse((await job).stdout));
}

async function prepareCase(name, binary) {
  state.cases[name] ??= {
    branch: `s6-fault-${state.id}-${name}`,
    slug: `s6-fault-${name}-${state.id.slice(0, 8)}`,
  };
  const item = state.cases[name];
  if (!item.commitSha) {
    const work = resolve(directory, 'sources', name);
    await mkdir(work, { recursive: true, mode: 0o700 });
    await git(['init', '--template=', '--initial-branch=s6-fault-work', work]);
    await git(['fetch', '--no-tags', '--depth=1', bare(), state.protected.mainHead], work);
    await git(['checkout', '--detach', 'FETCH_HEAD'], work);
    await copyFile(binary, resolve(work, 's6-workload'));
    await chmod(resolve(work, 's6-workload'), 0o755);
    await writeFile(resolve(work, 's6-marker'), `s6-fault-${state.id}-${name}\n`);
    const mount =
      name === 'cancel'
        ? ' --mount=type=secret,id=probe,target=/run/secrets/probe,required=true'
        : '';
    await writeFile(
      resolve(work, 'Dockerfile'),
      'FROM scratch\nCOPY s6-workload /s6-workload\nCOPY s6-marker /s6-marker\n' +
        `RUN${mount} ["/s6-workload", "${name}"]\nUSER 10000:10000\nEXPOSE 8080\nCMD ["/s6-workload", "serve"]\n`,
    );
    await git(['add', '--', 'Dockerfile', 's6-workload', 's6-marker'], work);
    await git(
      [
        '-c',
        'user.name=S6 controlled fault fixture',
        '-c',
        'user.email=s6-fixture@invalid.example',
        'commit',
        '--no-gpg-sign',
        '-m',
        `S6 isolated ${name} fixture ${state.id}`,
      ],
      work,
    );
    item.commitSha = await git(['rev-parse', 'HEAD'], work);
    await save();
  }
  let previous;
  try {
    previous = await git([
      '--git-dir',
      bare(),
      'rev-parse',
      '--verify',
      `refs/heads/${item.branch}`,
    ]);
  } catch {
    /* A new private branch has no ref yet. */
  }
  requireValue(!previous || previous === item.commitSha, 'FAULT_BRANCH_CHANGED');
  if (!previous)
    await git(
      ['push', '--porcelain', bare(), `${item.commitSha}:refs/heads/${item.branch}`],
      resolve(directory, 'sources', name),
    );
  if (!item.serviceId) {
    const matches = (await list(`/services?environmentId=${state.resources.environment}`)).filter(
      (row) => row.slug === item.slug,
    );
    requireValue(matches.length <= 1, 'SERVICE_AMBIGUOUS');
    const service =
      matches[0] ??
      (await command(
        'create-' + name,
        '/services',
        {
          projectId: state.resources.project,
          environmentId: state.resources.environment,
          name: `S6 isolated ${name}`,
          slug: item.slug,
          configuration: {
            replicas: 1,
            command: [],
            args: [],
            ports: [{ name: 'http', protocol: 'http', containerPort: 8080, servicePort: 80 }],
            resources: {
              requests: { cpuMillis: 50, memoryMiB: 64 },
              limits: { cpuMillis: 250, memoryMiB: 256 },
            },
            readiness: {
              type: 'http',
              port: 'http',
              path: '/',
              initialDelaySeconds: 0,
              periodSeconds: 3,
              timeoutSeconds: 2,
              failureThreshold: 5,
            },
            startup: null,
            healthTimeoutSeconds: 60,
            environment: [],
          },
          source: {
            kind: 'github',
            repositoryId: state.resources.repository,
            branchRef: `refs/heads/${item.branch}`,
            dockerfilePath: 'Dockerfile',
            contextPath: '.',
            buildArgs: {},
            buildSecrets:
              name === 'cancel' ? [{ mountId: 'probe', secretRefId: state.canarySecretId }] : [],
            platforms: [{ os: 'linux', architecture: 'arm64' }],
            builderId: state.resources.builder,
            registryConnectionId: state.resources.registry,
            imageRepository: state.imageRepository,
            autoDeploy: false,
          },
        },
        201,
      ));
    requireValue(
      service.projectId === state.resources.project &&
        service.source?.kind === 'github' &&
        service.source.currentRevision.branchRef === `refs/heads/${item.branch}` &&
        service.source.autoDeploy === false,
      'SERVICE_IDENTITY_CHANGED',
    );
    item.serviceId = service.id;
    await save();
  }
}

async function prepare() {
  await requireDisk(9);
  state ??= {
    version: 1,
    owner,
    id: randomUUID(),
    parentId: parent.id,
    fixtureId: configuration.fixture.fixtureId,
    resources: { ...parent.resources },
    cases: {},
    commands: {},
    protected: await protectedState(),
  };
  requireValue(state.protected.seedStatus === '', 'SEED_DIRTY');
  await unchanged();
  state.imageRepository ??= 'fault-' + state.id;
  state.hostBaseline ??= await host('inspect');
  requireValue(state.hostBaseline.openRuns.length === 0, 'BUILDER_NOT_IDLE');
  const registryText = await privateFile(registryDirectory, 'users.json');
  const users = JSON.parse(registryText);
  state.registryBeforeSha256 ??= sha(registryText);
  requireValue(
    state.registryBeforeSha256 === sha(registryText) &&
      users.users.every((user) =>
        user.repositories.every((repo) => repo.name !== 'ozz-s6/' + state.imageRepository),
      ),
    'FAULT_REPOSITORY_ALREADY_AUTHORIZED',
  );
  await save();
  let canary;
  try {
    canary = await privateFile(directory, 'canary.txt');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    canary = randomBytes(32).toString('hex');
    await writeFile(resolve(directory, 'canary.txt'), canary, { mode: 0o600, flag: 'wx' });
  }
  if (!state.canarySecretId) {
    const name = 'S6 fault canary ' + state.id;
    const matches = (await list('/secrets?kind=generic')).filter((row) => row.name === name);
    requireValue(matches.length <= 1, 'CANARY_AMBIGUOUS');
    state.canarySecretId = (
      matches[0] ??
      (
        await api('/secrets', {
          method: 'POST',
          expected: 201,
          body: { name, kind: 'generic', payload: { value: canary } },
        })
      ).value.data
    ).id;
    await save();
  }
  const source = resolve(productRoot, 'tests/probes/support/s6-builder-fault-workload.go');
  const binary = resolve(directory, 's6-workload-linux-arm64');
  const sourceHash = sha(await readFile(source));
  requireValue(
    !state.workload || state.workload.sourceSha256 === sourceHash,
    'WORKLOAD_SOURCE_CHANGED',
  );
  await execute(
    'go',
    ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', binary, source],
    {
      cwd: productRoot,
      timeout: 120_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        CGO_ENABLED: '0',
        GOOS: 'linux',
        GOARCH: 'arm64',
        GOTOOLCHAIN: 'local',
        GO111MODULE: 'off',
        GOCACHE: resolve(directory, 'go-cache'),
      },
    },
  );
  const binaryHash = sha(await readFile(binary));
  requireValue(
    !state.workload || state.workload.binarySha256 === binaryHash,
    'WORKLOAD_BINARY_CHANGED',
  );
  state.workload = { sourceSha256: sourceHash, binarySha256: binaryHash };
  await save();
  for (const name of cases) await prepareCase(name, binary);
  const branches = await list(
    `/integrations/github/${state.resources.github}/repositories/${state.resources.repository}/branches`,
    true,
  );
  requireValue(
    cases.every((name) =>
      branches.some(
        (branch) =>
          branch.name === state.cases[name].branch &&
          (branch.commitSha ?? branch.commit?.sha) === state.cases[name].commitSha,
      ),
    ),
    'PROVIDER_BRANCHES_NOT_OBSERVED',
  );
  const report = await evidence(
    'prepared',
    'controlled fixture configuration; no build run started',
    {
      owner,
      sessionId: state.id,
      workload: state.workload,
      cases: state.cases,
      hostBaseline: state.hostBaseline,
    },
  );
  console.log(JSON.stringify({ status: 'prepared', report }));
}

async function start(name) {
  const item = state.cases[name];
  requireValue(uuid.test(item?.serviceId), 'CASE_NOT_PREPARED');
  if (item.deploymentId) {
    console.log(
      JSON.stringify({ status: 'already-registered', case: name, deploymentId: item.deploymentId }),
    );
    return;
  }
  await requireDisk(10);
  const actual = await host('inspect');
  requireValue(
    actual.openRuns.length === 0 &&
      actual.limits.cpuMillis === 1000 &&
      actual.limits.memoryMiB === 1024 &&
      actual.limits.pids === 256 &&
      actual.limits.diskBytes === '1073741824' &&
      actual.builderFilesystemAvailableBytes >= 1.5 * gibibyte,
    'HOST_LIMITS_OR_IDLE_STATE_CHANGED',
  );
  requireValue(
    name === 'timeout' ? actual.limits.timeoutSeconds === 40 : actual.limits.timeoutSeconds > 60,
    'WRONG_DEADLINE_WINDOW',
  );
  requireValue(
    actual.launcherSha256 === state.hostBaseline.launcherSha256 &&
      actual.helperSha256 === state.hostBaseline.helperSha256,
    'HOST_CODE_CHANGED',
  );
  const service = await data(`/services/${item.serviceId}`);
  requireValue(
    !service.activeTask &&
      service.source.autoDeploy === false &&
      service.source.currentRevision.branchRef === `refs/heads/${item.branch}`,
    'CASE_SERVICE_CHANGED',
  );
  item.preview ??= (
    await api(`/services/${item.serviceId}/git-source/preview`, {
      method: 'POST',
      expected: 200,
      body: {
        revision: service.revision,
        selection: { kind: 'commit', commitSha: item.commitSha },
      },
    })
  ).value.data;
  requireValue(
    item.preview.issues.length === 0 && item.preview.source.commitSha === item.commitSha,
    'PREVIEW_NOT_READY',
  );
  await save();
  const task = await command('start-' + name, `/services/${item.serviceId}/deployments`, {
    revision: item.preview.serviceRevision,
    previewId: item.preview.id,
  });
  item.deploymentId = task.id;
  await save();
  console.log(JSON.stringify({ status: 'registered', case: name, deploymentId: task.id }));
}

async function logs(task) {
  const records = [];
  for (const run of task.build?.runs ?? []) {
    let cursor,
      content = '',
      available = false;
    for (let page = 0; page < 128; page++) {
      const value = (
        await api(
          `/deployments/${task.id}/build-logs?limit=100&runId=${run.id}` +
            (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        )
      ).value;
      available ||= value.available;
      content += value.items.map((item) => item.content).join('');
      requireValue(content.length <= 1024 * 1024, 'FIXTURE_LOG_LIMIT');
      if (!value.pageInfo?.hasMore) break;
      requireValue(
        value.pageInfo.nextCursor && cursor !== value.pageInfo.nextCursor,
        'LOG_CURSOR_INVALID',
      );
      cursor = value.pageInfo.nextCursor;
      if (page === 127) throw new Error('S6_FAULT_LOG_PAGE_LIMIT');
    }
    safe(content);
    const markers = [...content.matchAll(/S6_FAULT (\{[^\r\n]*\})/gu)].map((match) =>
      JSON.parse(match[1]),
    );
    records.push({ runId: run.id, available, content, markers });
  }
  return records;
}

async function waitTask(id, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  let previous;
  while (Date.now() < deadline) {
    const task = await data(`/deployments/${id}`);
    const fingerprint = `${task.status}:${task.phase}:${task.build?.runs.length}`;
    if (fingerprint !== previous) {
      console.log(
        JSON.stringify({
          deploymentId: id,
          status: task.status,
          phase: task.phase,
          runCount: task.build?.runs.length ?? 0,
        }),
      );
      previous = fingerprint;
    }
    if (['failed', 'cancelled', 'succeeded'].includes(task.status)) {
      await requireDisk(8);
      return task;
    }
    await protectDiskDuring(task);
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('S6_FAULT_OBSERVATION_TIMEOUT');
}

function kernelCounter(kernel, name, key) {
  return Number(
    kernel?.[name]
      ?.split('\n')
      .find((line) => line.startsWith(key + ' '))
      ?.split(' ')[1] ?? 0,
  );
}

async function observe(name, existingKernelReport) {
  const item = state.cases[name];
  const id = item?.retryDeploymentId ?? item?.deploymentId;
  requireValue(uuid.test(id), 'CASE_NOT_REGISTERED');
  let existing = null;
  if (existingKernelReport) {
    const path = resolve(existingKernelReport);
    const evidenceDirectory = resolve(productRoot, '.local/local-lab/builder/b-evidence');
    requireValue(
      path.startsWith(evidenceDirectory + '/') &&
        path.slice(evidenceDirectory.length + 1).startsWith(`kernel-deployment-${id}-`) &&
        !path.slice(evidenceDirectory.length + 1).includes('/'),
      'SAVED_KERNEL_REPORT_PATH_INVALID',
    );
    const raw = JSON.parse(
      await privateFile(evidenceDirectory, path.slice(evidenceDirectory.length + 1)),
    );
    requireValue(
      raw.selector?.kind === 'deployment' &&
        raw.selector.id === id &&
        raw.deploymentId === id &&
        raw.samplerSha256 ===
          sha(
            await readFile(
              resolve(productRoot, 'tests/probes/support/s6-builder-kernel-sample.py'),
            ),
          ),
      'SAVED_KERNEL_REPORT_IDENTITY_INVALID',
    );
    existing = { report: path, raw };
  }
  const sampling = existing
    ? Promise.resolve(existing)
    : name === 'artifact'
      ? null
      : execute(
          process.execPath,
          [
            resolve(productRoot, 'tests/probes/s6-builder-kernel-sample.mjs'),
            'deployment',
            id,
            '--timeline-seconds=120',
          ],
          { cwd: productRoot, timeout: 255_000, maxBuffer: 64 * 1024, signal: abort.signal },
        ).then(
          async ({ stdout }) => {
            const summary = JSON.parse(stdout);
            return {
              report: summary.report,
              raw: JSON.parse(await readFile(summary.report, 'utf8')),
            };
          },
          () => ({ report: null, raw: { status: 'sampler_failed' } }),
        );
  const task = await waitTask(id);
  const controlledLogs = await logs(task);
  await evidence('product-' + name, 'product API terminal task and checked fixture logs', {
    task,
    controlledWorkloadLogs: controlledLogs,
  });
  const linux = sampling ? await sampling : null;
  if (existing)
    requireValue(
      task.build.runs.some((run) => run.id === existing.raw.runId),
      'SAVED_KERNEL_RUN_CHANGED',
    );
  const hostRuns = [];
  for (const run of task.build?.runs ?? [])
    hostRuns.push(await host('run-inspect', { deploymentId: id, runId: run.id }));
  const checks = {};
  checks.allRunsHaveVerifiedClosure =
    Boolean(task.build?.runs.length) &&
    task.build.runs.every(
      (run) => run.executionState === 'ended' && run.executionClosedAt && run.proofVerifiedAt,
    );
  checks.hostRunsClosed = hostRuns.every(
    (run) =>
      run.closed &&
      run.terminationConfirmed &&
      (!run.cgroupExists || run.cgroupEvents?.includes('populated 0')),
  );
  const samples = linux?.raw.cgroupTimeline?.samples ?? [];
  const markers = controlledLogs.flatMap((row) => row.markers);
  if (name !== 'artifact') {
    checks.liveKernelSample = linux?.raw.status === 'live_sample';
    const sourceProcesses = linux?.raw.cgroupTimeline?.sourceProcesses ?? [];
    const daemon = linux?.raw.processes?.find((process) => process.name === 'buildkitd');
    checks.controlledSourceObservedByKernel = sourceProcesses.length > 0;
    checks.sourceRootless =
      sourceProcesses.length > 0 &&
      sourceProcesses.every(
        (process) =>
          process.uid[0] !== '0' &&
          process.namespaces.user !== linux.raw.hostNamespaces.user &&
          process.uidMap.split('\n').every((line) => Number(line.trim().split(/\s+/u)[1]) !== 0),
      );
    checks.sourceProcessSandbox =
      Boolean(daemon) &&
      sourceProcesses.length > 0 &&
      sourceProcesses.every(
        (process) =>
          process.namespaces.pid !== daemon.namespaces.pid &&
          process.namespaces.mnt !== daemon.namespaces.mnt,
      );
    checks.actualKernelLimits =
      linux?.raw.parentCgroup?.values['cpu.max'] === '100000 100000' &&
      linux?.raw.parentCgroup?.values['memory.max'] === '1073741824' &&
      linux?.raw.parentCgroup?.values['memory.swap.max'] === '0' &&
      linux?.raw.parentCgroup?.values['pids.max'] === '256';
  }
  if (name === 'cancel') {
    checks.cancelled = task.status === 'cancelled';
    const cpuStart = Date.parse(markers.find((entry) => entry.event === 'cpu-start')?.at);
    const cpuEnd = Date.parse(markers.find((entry) => entry.event === 'cpu-complete')?.at);
    const cpuSamples = samples.filter(
      (sample) => Date.parse(sample.at) >= cpuStart && Date.parse(sample.at) <= cpuEnd,
    );
    const first = cpuSamples[0],
      last = cpuSamples.at(-1);
    const elapsed = Date.parse(last?.at) - Date.parse(first?.at);
    const usedMicros =
      kernelCounter(last?.kernel, 'cpu.stat', 'usage_usec') -
      kernelCounter(first?.kernel, 'cpu.stat', 'usage_usec');
    checks.cpuQuotaThrottled =
      elapsed >= 3000 &&
      kernelCounter(last?.kernel, 'cpu.stat', 'nr_throttled') >
        kernelCounter(first?.kernel, 'cpu.stat', 'nr_throttled');
    checks.cpuWithinQuota = elapsed >= 3000 && usedMicros > 0 && usedMicros <= elapsed * 1200;
    checks.explicitSecretOnly = markers.some(
      (entry) =>
        entry.event === 'explicit-secret-mounted' &&
        entry.sha256 === canarySha256 &&
        entry.environmentContainsValue === false,
    );
    checks.canaryRedacted = controlledLogs.some((row) =>
      row.content.includes('S6_CANARY [REDACTED]'),
    );
    checks.sourceNetworkBoundary = markers.some(
      (entry) =>
        entry.event === 'network-boundaries' &&
        entry.approvedProxyReached === true &&
        entry.privateConnectDenied === true &&
        entry.directConnections.length === 4 &&
        entry.directConnections.every((row) => row.connectionBlocked === true),
    );
    checks.kernelProxyOnlyPolicy =
      linux?.raw.networkRules?.includes('tcp dport 51449 accept') &&
      !linux.raw.networkRules.includes('dport 53 accept') &&
      !linux.raw.networkRules.includes('dport { 80, 443 } accept');
    checks.parentCgroupWritesDenied = linux?.raw.solveUidAccess?.parentCgroupWrites.every(
      (row) => row.writable === false,
    );
    checks.managerCredentialsInaccessible = linux?.raw.solveUidAccess?.guardedPaths.every(
      (row) => !row.readable && !row.searchable,
    );
  } else if (name === 'timeout') {
    checks.failed = task.status === 'failed';
    checks.shortFixedDeadline = hostRuns.every((run) => run.limits.timeoutSeconds === 40);
    checks.timeoutReported =
      task.build.runs.some((run) =>
        /TIMEOUT|TIMED_OUT/iu.test(run.closureReason ?? run.lastErrorCode ?? ''),
      ) || /TIMEOUT|TIMED_OUT/iu.test(task.errorCode ?? '');
  } else if (name === 'memory') {
    checks.failed = task.status === 'failed';
    checks.kernelOomKill = samples.some(
      (row) => kernelCounter(row.kernel, 'memory.events', 'oom_kill') > 0,
    );
  } else if (name === 'pids') {
    checks.failed = task.status === 'failed';
    checks.kernelPidLimit = samples.some(
      (row) =>
        kernelCounter(row.kernel, 'pids.events', 'max') > 0 ||
        row.descendantPidsEvents?.some(
          (entry) => kernelCounter({ 'pids.events': entry.events }, 'pids.events', 'max') > 0,
        ),
    );
  } else if (name === 'disk') {
    checks.failed = task.status === 'failed';
    checks.fixedLoopCapacity = linux?.raw.executionFilesystem?.imageBytes === 1073741824;
    checks.controlledWorkloadSawEnospc = markers.some(
      (entry) => entry.event === 'disk-allocation-ended' && entry.enospc === true,
    );
    checks.kernelDiskFilled = samples.some(
      (row) => row.diskMounted && row.diskAvailableBytes < 1024 * 1024,
    );
  } else if (name === 'disconnect') {
    const control = JSON.parse(await privateFile(directory, 'disconnect-result.json'));
    checks.hostClosedBeforeManagerResumed = control.hostClosedWhileManagerStopped === true;
    checks.managerResumed = Boolean(control.managerResumedAt);
  } else if (!item.retryDeploymentId) {
    checks.pushFailed = task.status === 'failed' && task.build.artifact.state === 'oci';
    checks.exportedArtifactRetained = task.build.artifact.producedByRunId === task.build.runs[0].id;
  } else {
    const original = await data(`/deployments/${item.deploymentId}`);
    checks.succeeded = task.status === 'succeeded';
    checks.sameArtifact =
      task.build.reuseArtifactId === original.build.artifact.id &&
      task.build.artifact.id === original.build.artifact.id &&
      task.build.artifact.rootDigest === original.build.artifact.rootDigest &&
      task.build.artifact.producedByRunId === original.build.artifact.producedByRunId;
    checks.noCheckoutOrSolve = hostRuns.every(
      (run) =>
        run.action === 'push_existing' &&
        !run.started.includes('checkout') &&
        !run.started.includes('building'),
    );
  }
  const passed = Object.values(checks).every((value) => value === true);
  const report = await evidence(
    'observed-' + name,
    'product API receipt with separate live Linux and controlled-fixture records',
    {
      case: name,
      deploymentId: id,
      passed,
      checks,
      product: task,
      hostRuns,
      rawLinuxReport: linux?.report ?? null,
      controlledWorkloadLogs: controlledLogs,
    },
  );
  console.log(JSON.stringify({ case: name, passed, checks, report }));
  requireValue(passed, 'ACCEPTANCE_NOT_ESTABLISHED');
}

async function cancel(name) {
  const item = state.cases[name];
  requireValue(uuid.test(item?.deploymentId), 'CASE_NOT_REGISTERED');
  const task =
    name === 'cancel'
      ? await workloadReady(item, 'cpu-complete')
      : await data(`/deployments/${item.deploymentId}`);
  requireValue(task.serviceId === item.serviceId, 'CASE_SERVICE_CHANGED');
  const result = (await api(`/deployments/${task.id}/cancel`, { method: 'POST', expected: 202 }))
    .value.data;
  await evidence('cancel-' + name, 'product API cancellation command receipt', { result });
  console.log(
    JSON.stringify({ status: 'cancellation-requested', case: name, deploymentId: task.id }),
  );
}

async function repeatObservedCase(name) {
  const item = state.cases[name];
  if (!item.deploymentId) await start(name);
  else {
    const original = await data(`/deployments/${item.deploymentId}`);
    if (['failed', 'cancelled', 'succeeded'].includes(original.status)) {
      requireValue(
        ['cancelled', 'failed'].includes(original.status) &&
          original.build.artifact.state === 'none' &&
          original.build.runs.length > 0 &&
          original.build.runs.every(
            (run) => run.executionState === 'ended' && run.executionClosedAt && run.proofVerifiedAt,
          ),
        'OBSERVATION_RETRY_NOT_CLOSED',
      );
      await requireDisk(10);
      const actual = await host('inspect');
      const retest = state.timeoutRetests?.at(-1);
      requireValue(
        actual.openRuns.length === 0 &&
          actual.hostSha256 ===
            (name === 'timeout' ? retest?.duringSha256 : state.hostBaseline.hostSha256) &&
          actual.launcherSha256 ===
            (retest?.hostBaseline.launcherSha256 ?? state.hostBaseline.launcherSha256) &&
          actual.helperSha256 === state.hostBaseline.helperSha256 &&
          (name === 'timeout'
            ? actual.limits.timeoutSeconds === 40
            : actual.limits.timeoutSeconds > 60) &&
          actual.builderFilesystemAvailableBytes >= 1.5 * gibibyte,
        'HOST_LIMITS_OR_IDLE_STATE_CHANGED',
      );
      const service = await data(`/services/${item.serviceId}`);
      requireValue(!service.activeTask, 'CASE_SERVICE_CHANGED');
      const task = await command(
        'retry-' + name + '-' + original.id,
        `/deployments/${original.id}/retry`,
        {
          revision: service.revision,
        },
      );
      item.deploymentHistory ??= [];
      if (!item.deploymentHistory.includes(original.id)) item.deploymentHistory.push(original.id);
      item.deploymentId = task.id;
      await save();
      console.log(
        JSON.stringify({
          status: 'retry-registered',
          case: name,
          deploymentId: task.id,
          originalDeploymentId: original.id,
          purpose: 'repeat-observed-acceptance-with-prior-attempt-retained',
        }),
      );
    }
  }
  if (name === 'cancel') {
    const results = await Promise.allSettled([observe(name), cancel(name)]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  } else await observe(name);
}

async function beginTimeoutRetest(expectedLauncherSha256) {
  const baseline = await host('inspect');
  requireValue(
    baseline.openRuns.length === 0 &&
      baseline.hostSha256 === state.hostBaseline.hostSha256 &&
      baseline.launcherSha256 === expectedLauncherSha256 &&
      baseline.helperSha256 === state.hostBaseline.helperSha256,
    'TIMEOUT_RETEST_BASELINE_CHANGED',
  );
  const attempt = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    purpose: 'verify-reviewed-systemd-runtime-rounding-fix',
    originalDeploymentId: state.cases.timeout.deploymentId,
    hostBaseline: baseline,
    expectedLauncherSha256,
  };
  state.timeoutRetests ??= [];
  state.timeoutRetests.push(attempt);
  state.limitsWindowId = attempt.id;
  await save();
  const result = await host('limits-begin', { expectedHostSha256: baseline.hostSha256 });
  attempt.duringSha256 = result.duringSha256;
  await save();
  const report = await evidence(
    'timeout-retest-window',
    'new root backup and explicit timeout retest window; original baseline retained',
    {
      windowId: attempt.id,
      originalHostBaseline: state.hostBaseline,
      ...result,
    },
  );
  console.log(
    JSON.stringify({
      status: 'timeout-retest-window-open',
      windowId: attempt.id,
      ...result,
      report,
    }),
  );
}

async function workloadReady(item, event) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const task = await data(`/deployments/${item.deploymentId}`);
    requireValue(
      !['failed', 'cancelled', 'succeeded'].includes(task.status),
      'WORKLOAD_ALREADY_ENDED',
    );
    await protectDiskDuring(task);
    const activeIds = new Set(
      task.build?.runs.filter((run) => run.executionState === 'open').map((run) => run.id),
    );
    const content = await logs(task);
    if (
      content.some(
        (row) => activeIds.has(row.runId) && row.markers.some((marker) => marker.event === event),
      )
    )
      return task;
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('S6_FAULT_WORKLOAD_NOT_READY');
}

async function registry(restore) {
  const path = resolve(registryDirectory, 'users.json');
  const current = await privateFile(registryDirectory, 'users.json');
  if (restore) {
    const original = await privateFile(directory, 'registry-before.json');
    requireValue(
      sha(original) === state.registryBeforeSha256 &&
        [state.registryBeforeSha256, state.registryDuringSha256].includes(sha(current)),
      'REGISTRY_CONFIG_CHANGED',
    );
    await atomic(path, original);
    const result = {
      action: 'registry-restore',
      sha256: sha(original),
      originalSha256: state.registryBeforeSha256,
      productApiRequired: false,
      serviceStopIsSeparate: true,
    };
    const report = await evidence(
      'registry-restore',
      'exact local fixture ACL restoration',
      result,
    );
    console.log(JSON.stringify({ ...result, report }));
    return;
  }
  if (state.registryDuringSha256 && sha(current) === state.registryDuringSha256) {
    requireValue(
      sha(await privateFile(directory, 'registry-before.json')) === state.registryBeforeSha256,
      'REGISTRY_BACKUP_CHANGED',
    );
    console.log(
      JSON.stringify({
        action: 'registry-allow',
        status: 'already-applied',
        repository: 'ozz-s6/' + state.imageRepository,
        sha256: sha(current),
      }),
    );
    return;
  }
  requireValue(sha(current) === state.registryBeforeSha256, 'REGISTRY_CONFIG_CHANGED');
  const task = await data(`/deployments/${state.cases.artifact.deploymentId}`);
  requireValue(
    task.status === 'failed' &&
      task.build.artifact.state === 'oci' &&
      task.build.runs.every((run) => run.proofVerifiedAt),
    'ARTIFACT_FAILURE_NOT_CLOSED',
  );
  const users = JSON.parse(current);
  requireValue(users.owner === 'ozz-s6-registry-token-fixture-v1', 'REGISTRY_OWNER_CHANGED');
  for (const role of ['push', 'pull']) {
    const user = users.users.find((row) => row.username === `ozz-s6-${role}`);
    requireValue(
      user &&
        user.repositories.length < 16 &&
        !user.repositories.some((row) => row.name === 'ozz-s6/' + state.imageRepository),
      'REGISTRY_ACL_LIMIT',
    );
    user.repositories.push({
      name: 'ozz-s6/' + state.imageRepository,
      actions: role === 'push' ? ['pull', 'push'] : ['pull'],
    });
  }
  try {
    await writeFile(resolve(directory, 'registry-before.json'), current, {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireValue(
      (await privateFile(directory, 'registry-before.json')) === current,
      'REGISTRY_BACKUP_CHANGED',
    );
  }
  const next = JSON.stringify(users, null, 2) + '\n';
  state.registryDuringSha256 = sha(next);
  await save();
  await atomic(path, next);
  console.log(
    JSON.stringify({
      action: 'registry-allow',
      repository: 'ozz-s6/' + state.imageRepository,
      originalSha256: state.registryBeforeSha256,
      duringSha256: state.registryDuringSha256,
    }),
  );
}

async function disconnect() {
  const item = state.cases.disconnect;
  const task = await workloadReady(item, 'ready');
  const active = task.build.runs.filter((run) => run.executionState === 'open');
  requireValue(
    task.serviceId === item.serviceId && active.length === 1 && task.phase === 'building',
    'RUN_NOT_BUILDING',
  );
  const content = await logs(task);
  requireValue(
    content.some(
      (row) => row.runId === active[0].id && row.markers.some((marker) => marker.event === 'ready'),
    ),
    'WORKLOAD_NOT_READY',
  );
  const result = await host('disconnect', { deploymentId: task.id, runId: active[0].id });
  await atomic(
    resolve(directory, 'disconnect-result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  await evidence(
    'disconnect',
    'live Linux manager pause and independent watchdog observations',
    result,
  );
  // The original run must acquire a verified closure after contact returns.
  for (let attempt = 0; attempt < 60; attempt++) {
    const observed = await data(`/deployments/${task.id}`);
    if (observed.build.runs.find((run) => run.id === active[0].id)?.proofVerifiedAt) {
      // Bound automatic retries through the same product cancellation command.
      await cancel('disconnect');
      return;
    }
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('S6_FAULT_DISCONNECT_PROOF_NOT_OBSERVED');
}

async function stopArtifact() {
  const item = state.cases.artifact;
  const service = await data(`/services/${item.serviceId}`);
  requireValue(
    service.id === item.serviceId && uuid.test(item.retryDeploymentId),
    'ARTIFACT_NOT_RETRIED',
  );
  if (
    service.desiredState === 'stopped' &&
    service.runtimeState === 'stopped' &&
    !service.activeTask
  )
    return;
  const task = await command('stop-artifact', `/services/${item.serviceId}/stop`, {
    revision: service.revision,
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    const operation = await data(`/operations/${task.id}`);
    requireValue(!['failed', 'cancelled'].includes(operation.status), 'ARTIFACT_STOP_FAILED');
    const current = await data(`/services/${item.serviceId}`);
    if (
      operation.status === 'succeeded' &&
      current.desiredState === 'stopped' &&
      current.runtimeState === 'stopped' &&
      !current.activeTask
    ) {
      await evidence('stopped-artifact', 'product API stop of the dedicated fault service', {
        operation,
        service: current,
      });
      return;
    }
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('S6_FAULT_ARTIFACT_STOP_TIMEOUT');
}

function checkedProof(task, run, hostRun, publicKey) {
  const proof = parseEndProof(hostRun.signedProof);
  const payload = verifySigned(proof, publicKey);
  requireValue(
    payload.runId === run.id &&
      payload.specHash === run.specHash &&
      payload.builderInstanceId === run.builderInstanceId &&
      payload.installationId === task.target.installationId &&
      payload.executionClosed === true,
    'RETURN_PROOF_IDENTITY_CHANGED',
  );
  return {
    signedProof: proof,
    sha256: sha(canonicalJson(proof)),
    signatureAndIdentityVerified: true,
  };
}

async function returnManifest() {
  const builder = await data(`/integrations/builders/${state.resources.builder}`);
  const services = [],
    deployments = [];
  for (const name of cases) {
    const item = state.cases[name];
    if (!item?.serviceId) {
      services.push({ case: name, state: 'not-created' });
      continue;
    }
    const service = await data(`/services/${item.serviceId}`);
    services.push({
      case: name,
      serviceId: service.id,
      desiredState: service.desiredState,
      runtimeState: service.runtimeState,
      activeTask: service.activeTask ?? null,
      publishedDeploymentId: service.published?.deploymentId ?? null,
    });
    // Enumerate the dedicated service, including a command whose HTTP receipt
    // was lost before its ID reached the local case state.
    const rows = await list(`/deployments?serviceId=${item.serviceId}`);
    for (const row of rows) {
      const task = await data(`/deployments/${row.id}`);
      const runs = [];
      for (const run of task.build?.runs ?? []) {
        let hostRun = null,
          proof = null,
          errorCode = null;
        if (run.executionState !== 'never_submitted') {
          try {
            hostRun = await host('run-inspect', { deploymentId: task.id, runId: run.id });
            proof = checkedProof(task, run, hostRun, builder.identityPublicKey);
          } catch {
            errorCode = 'S6_FAULT_RETURN_PROOF_NOT_VERIFIED';
          }
        }
        runs.push({ product: run, host: hostRun, proof, errorCode });
      }
      deployments.push({
        case: name,
        deploymentId: task.id,
        serviceId: task.serviceId,
        status: task.status,
        errorCode: task.errorCode,
        retryOfId: task.retryOfId,
        artifact: task.build?.artifact ?? null,
        runs,
      });
    }
  }
  const currentHost = await host('inspect');
  const currentAclSha256 = sha(await privateFile(registryDirectory, 'users.json'));
  const localAvailableBytes = await availableDisk();
  const checks = {
    everyScenarioRegistered: cases.every((name) => deployments.some((task) => task.case === name)),
    explicitArtifactRetryRegistered: deployments.some(
      (task) =>
        task.case === 'artifact' &&
        deployments.some(
          (original) => original.case === 'artifact' && original.deploymentId === task.retryOfId,
        ),
    ),
    allProductRunsClosed: deployments.every((task) =>
      task.runs.every(
        ({ product }) =>
          product.executionClosedAt &&
          (product.executionState === 'never_submitted' ||
            (product.executionState === 'ended' && product.proofVerifiedAt)),
      ),
    ),
    endedProofsIndependentlyVerified: deployments.every((task) =>
      task.runs.every(
        ({ product, proof }) =>
          product.executionState === 'never_submitted' ||
          proof?.signatureAndIdentityVerified === true,
      ),
    ),
    allTasksTerminal: deployments.every((task) =>
      ['failed', 'cancelled', 'succeeded'].includes(task.status),
    ),
    noServiceTaskActive: services.every((service) => !service.activeTask),
    hostHasNoOpenRun: currentHost.openRuns.length === 0,
    hostConfigRestored: currentHost.hostSha256 === state.hostBaseline.hostSha256,
    launcherMatchesRecordedBaseline:
      currentHost.launcherSha256 ===
      (state.timeoutRetests?.at(-1)?.hostBaseline.launcherSha256 ??
        state.hostBaseline.launcherSha256),
    helperUnchanged: currentHost.helperSha256 === state.hostBaseline.helperSha256,
    registryAclRestored: currentAclSha256 === state.registryBeforeSha256,
    artifactServiceStopped:
      !state.cases.artifact.retryDeploymentId ||
      services.some(
        (service) =>
          service.case === 'artifact' &&
          service.desiredState === 'stopped' &&
          service.runtimeState === 'stopped',
      ),
    localDiskFloorPreserved: localAvailableBytes >= 8 * gibibyte,
  };
  const passed = Object.values(checks).every((value) => value === true);
  const report = await evidence(
    'return-manifest',
    'complete dedicated-service API inventory, signed proofs, and restoration hashes',
    {
      passed,
      checks,
      services,
      deployments,
      hostBefore: state.hostBaseline,
      timeoutRetestWindows: state.timeoutRetests ?? [],
      hostAfter: currentHost,
      registryBeforeSha256: state.registryBeforeSha256,
      registryAfterSha256: currentAclSha256,
      localAvailableBytes,
      protectedFixture: await protectedState(),
    },
  );
  console.log(
    JSON.stringify({
      status: passed ? 'returned' : 'incomplete',
      deploymentCount: deployments.length,
      runCount: deployments.reduce((count, task) => count + task.runs.length, 0),
      checks,
      report,
    }),
  );
  requireValue(passed, 'RETURN_INVENTORY_INCOMPLETE');
}

async function main() {
  requireValue(
    process.versions.node.split('.')[0] === '24' &&
      modes.includes(mode) &&
      (mode === 'observe-saved'
        ? process.argv.length === 5 && cases.includes(selected)
        : mode === 'timeout-retest-begin'
          ? process.argv.length === 4 && /^[a-f0-9]{64}$/u.test(selected)
          : mode === 'retry-observe'
            ? process.argv.length === 4 && ['timeout', 'pids', 'disk', 'memory'].includes(selected)
            : ['start', 'observe', 'cancel'].includes(mode)
              ? process.argv.length === 4 && cases.includes(selected)
              : process.argv.length === 3),
    'USAGE_INVALID',
  );
  try {
    state = JSON.parse(await privateFile(directory, 'state.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (mode === 'status') {
    console.log(
      JSON.stringify(
        state
          ? { owner, sessionId: state.id, cases: state.cases }
          : { owner, status: 'not-prepared' },
      ),
    );
    return;
  }
  // Restoration is hash-bound to this session's own backups and must remain
  // available when the product API has failed. It creates no new run or grant.
  if (['limits-restore', 'registry-restore'].includes(mode)) {
    requireValue(state?.owner === owner && uuid.test(state.id), 'PREPARE_REQUIRED');
    const handle = await open(statePath + '.lock', 'wx', 0o600);
    locks.push({ path: statePath + '.lock', handle });
    await handle.writeFile(JSON.stringify({ owner, pid: process.pid, mode }));
    if (mode === 'limits-restore') {
      const result = await host(mode);
      const report = await evidence(mode, 'live Linux exact configuration restoration', result);
      console.log(JSON.stringify({ ...result, report }));
    } else await registry(true);
    return;
  }
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  configuration = await readProductConfiguration();
  await checkFixtureHealth(configuration);
  await checkProductHttpsHealth(configuration);
  parent = JSON.parse(await privateFile(parentDirectory, 'state.json'));
  const webhook = JSON.parse(await privateFile(webhookDirectory, 'state.json'));
  requireValue(
    webhook.owner === 'ozz-s6-webhook-product-probe-v1' &&
      webhook.completed?.['new-https-content'] &&
      webhook.completed?.['publish-pending'] &&
      webhook.completed?.['running-duplicate-stable'],
    'WEBHOOK_NOT_FINISHED',
  );
  requireValue(
    ['project', 'environment', 'repository', 'builder', 'registry', 'github'].every((key) =>
      uuid.test(parent.resources?.[key]),
    ),
    'PARENT_NOT_READY',
  );
  if (state)
    requireValue(
      state.owner === owner &&
        state.parentId === parent.id &&
        state.fixtureId === configuration.fixture.fixtureId,
      'STATE_IDENTITY_CHANGED',
    );
  else requireValue(mode === 'prepare', 'PREPARE_REQUIRED');
  // Observation can run alongside a cancellation or the scoped manager pause.
  if (!['observe', 'observe-saved'].includes(mode))
    for (const path of [
      resolve(parentDirectory, 'state.json.lock'),
      resolve(webhookDirectory, 'state.json.lock'),
      statePath + '.lock',
    ]) {
      const handle = await open(path, 'wx', 0o600);
      locks.push({ path, handle });
      await handle.writeFile(JSON.stringify({ owner, pid: process.pid, mode }));
    }
  if (!['observe', 'observe-saved'].includes(mode)) {
    try {
      state = JSON.parse(await privateFile(directory, 'state.json'));
      requireValue(
        state.owner === owner &&
          state.parentId === parent.id &&
          state.fixtureId === configuration.fixture.fixtureId,
        'STATE_IDENTITY_CHANGED',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      requireValue(mode === 'prepare', 'PREPARE_REQUIRED');
    }
  }
  if (state) await unchanged();
  const password = (await readFile(resolve(productRoot, '.secrets/admin-password'), 'utf8')).trim();
  const pat = JSON.parse(await privateFile(productDirectory, 'pat.json')).token;
  const users = JSON.parse(await privateFile(registryDirectory, 'users.json')).users;
  sensitive = [
    password,
    pat,
    Buffer.from(`x-access-token:${pat}`).toString('base64'),
    ...users.flatMap((user) => [
      user.password,
      Buffer.from(`${user.username}:${user.password}`).toString('base64'),
    ]),
  ];
  try {
    const canary = await privateFile(directory, 'canary.txt');
    canarySha256 = sha(canary);
    sensitive.push(canary, canary.slice(0, canary.length / 2), canary.slice(canary.length / 2));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let session;
  try {
    session = JSON.parse(await privateFile(directory, 'auth-session.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (session) {
    requireValue(
      session.owner === owner &&
        session.sessionId === state?.id &&
        /^ozz_session=[A-Za-z0-9_-]{43}$/u.test(session.cookie) &&
        typeof session.csrf === 'string' &&
        Date.parse(session.expiresAt) > Date.now(),
      'SESSION_INVALID',
    );
    cookie = session.cookie;
    csrf = session.csrf;
    sensitive.push(cookie, csrf);
    const current = await data('/auth/me');
    requireValue(
      current.user?.username === 'admin' && current.csrfToken === csrf,
      'SESSION_CHANGED',
    );
  } else {
    const login = await api('/auth/login', {
      method: 'POST',
      expected: 200,
      body: { username: 'admin', password },
    });
    cookie = login.headers['set-cookie']
      ?.find((value) => value.startsWith('ozz_session='))
      ?.split(';')[0];
    csrf = login.value.data.csrfToken;
    if (state && cookie && csrf)
      await atomic(
        resolve(directory, 'auth-session.json'),
        JSON.stringify({
          owner,
          sessionId: state.id,
          cookie,
          csrf,
          expiresAt: login.value.data.expiresAt,
        }) + '\n',
      );
  }
  requireValue(cookie && csrf, 'LOGIN_FAILED');
  sensitive.push(cookie, csrf);
  if (mode === 'prepare') await prepare();
  else if (mode === 'start') await start(selected);
  else if (mode === 'observe') await observe(selected);
  else if (mode === 'observe-saved') await observe(selected, savedKernelReport);
  else if (mode === 'cancel') await cancel(selected);
  else if (mode === 'run-cancel') await repeatObservedCase('cancel');
  else if (mode === 'retry-observe') await repeatObservedCase(selected);
  else if (mode === 'timeout-retest-begin') await beginTimeoutRetest(selected);
  else if (mode === 'disconnect') await disconnect();
  else if (mode === 'stop-artifact') await stopArtifact();
  else if (mode === 'report') await returnManifest();
  else if (mode === 'registry-allow' || mode === 'registry-restore')
    await registry(mode === 'registry-restore');
  else if (mode === 'limits-begin' || mode === 'limits-restore') {
    const result = await host(mode, { expectedHostSha256: state.hostBaseline.hostSha256 });
    await evidence(mode, 'live Linux configuration window receipt', result);
    console.log(JSON.stringify(result));
  } else {
    const item = state.cases.artifact;
    if (item.retryDeploymentId) {
      console.log(
        JSON.stringify({ status: 'already-registered', deploymentId: item.retryDeploymentId }),
      );
      return;
    }
    await requireDisk(10);
    const original = await data(`/deployments/${item.deploymentId}`);
    const service = await data(`/services/${item.serviceId}`);
    requireValue(
      original.status === 'failed' && original.build.artifact.state === 'oci',
      'ARTIFACT_NOT_RETRYABLE',
    );
    const task = await command('retry-artifact', `/deployments/${item.deploymentId}/retry`, {
      revision: service.revision,
    });
    item.retryDeploymentId = task.id;
    await save();
    console.log(
      JSON.stringify({
        status: 'retry-registered',
        deploymentId: task.id,
        originalDeploymentId: item.deploymentId,
      }),
    );
  }
  await requireDisk(8);
  await unchanged();
}

try {
  await main();
} catch (error) {
  const code = /^S6_FAULT_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : 'S6_FAULT_PROBE_FAILED';
  const diagnostic = {
    errorClass: error.name,
    systemCode: typeof error.code === 'string' ? error.code : null,
    sourceFrames: String(error.stack)
      .split('\n')
      .slice(1)
      .filter((line) => line.includes('/tests/probes/'))
      .map((line) => line.trim())
      .slice(0, 3),
    hostCode: /^S6_FAULT_[A-Z_]+$/mu.exec(error.stderr ?? '')?.[0] ?? null,
  };
  let report;
  if (state?.owner === owner && modes.includes(mode) && mode !== 'status') {
    try {
      report = await evidence('failed-' + mode, 'probe failure; no acceptance claim', {
        mode,
        case: selected ?? null,
        code,
        diagnostic,
        sessionId: state.id,
      });
    } catch {
      /* Keep the original failure if evidence storage also fails. */
    }
  }
  console.error(
    JSON.stringify({
      status: 'failed',
      code,
      diagnostic,
      report,
    }),
  );
  process.exitCode = 1;
} finally {
  for (const lock of locks.reverse()) {
    await lock.handle.close();
    await unlink(lock.path);
  }
}
