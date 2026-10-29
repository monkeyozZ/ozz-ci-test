import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { templateImages } from '../../packages/control-plane/dist/templates/image-assets.js';
import {
  checkProductHttpsHealth,
  privateFile,
  productRoot,
  publicAppOrigin,
  readProductConfiguration,
} from './support/s6-github-product.mjs';

// Prepared procedure only. Run after root gives this probe the C window.
// Preparation requires C already running and Builder stopped. Only run/recover
// stop/start the existing C VM; no mode changes A/B, Pebble or Builder state.
const [mode] = process.argv.slice(2);
const modes = [
  'plan',
  'status',
  'prepare',
  'retry-prepare',
  'repair-prepare',
  'run',
  'recover',
  'verify',
  'stop-service',
  'report',
];
const owner = 'ozz-gmvp-c-node-persistence-v1';
const lab = resolve(productRoot, '.local/local-lab');
const directory = resolve(lab, 'g-mvp-node-persistence');
const statePath = resolve(directory, 'state.json');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
process.umask(0o077);
let state, registered, configuration, cookie, csrf, marker, lock;
let recovering = false;
const secrets = [];
const image = templateImages['node-example'].deployReference;
const appProgram = `const fs=require('node:fs'),http=require('node:http');
http.createServer((req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);return res.end()}
 if(req.url==='/healthz'){res.writeHead(200);return res.end('ready\\n')}
 if(req.url!=='/'){res.writeHead(404);return res.end()}
 try{const fd=fs.openSync('/data/ozz-node-persistence-marker',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let value;try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size!==65)throw Error('marker-size');value=fs.readFileSync(fd)}finally{fs.closeSync(fd)}res.setHeader('content-type','text/plain');res.end(value)}catch{res.writeHead(404);res.end('marker-unavailable\\n')}
}).listen(8080,'0.0.0.0');`;
const healthProbe = {
  type: 'http',
  port: 'http',
  path: '/healthz',
  initialDelaySeconds: 0,
  periodSeconds: 3,
  timeoutSeconds: 2,
  failureThreshold: 10,
};

function requireValue(value, code) {
  if (!value) throw new Error('GMVP_NODE_' + code);
}
function safe(value) {
  const text = JSON.stringify(value);
  requireValue(
    !secrets.some((secret) => secret && text.includes(secret)) &&
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text),
    'SECRET_IN_EVIDENCE',
  );
  return value;
}
async function atomic(path, content) {
  const temporary = path + '.' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}
const save = () => atomic(statePath, JSON.stringify(safe(state), null, 2) + '\n');
async function evidence(name, value) {
  const path = resolve(directory, `${name}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(
    path,
    JSON.stringify(safe({ recordedAt: new Date().toISOString(), ...value }), null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  return path;
}
async function reserve(gibibytes = 8) {
  const disk = await statfs(productRoot);
  const bytes = disk.bavail * disk.bsize;
  requireValue(bytes >= gibibytes * 1024 ** 3, 'LOCAL_DISK_RESERVE');
  return bytes;
}
async function api(path, { method = 'GET', body, key, expected } = {}) {
  requireValue(path.startsWith('/') && !path.startsWith('//'), 'API_PATH');
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const response = await new Promise((accept, reject) => {
    const call = request(
      publicAppOrigin + '/api' + path,
      {
        method,
        ca: configuration.ca,
        rejectUnauthorized: true,
        agent: false,
        signal: recovering
          ? globalThis.AbortSignal.timeout(20000)
          : globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(20000)]),
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
          if (size > 2 * 1024 * 1024) result.destroy(new Error('GMVP_NODE_RESPONSE_BOUND'));
          else chunks.push(chunk);
        });
        result.once('error', reject);
        result.once('end', () => {
          try {
            accept({
              status: result.statusCode,
              headers: result.headers,
              value: size ? JSON.parse(Buffer.concat(chunks)) : null,
            });
          } catch {
            reject(new Error('GMVP_NODE_RESPONSE_INVALID'));
          }
        });
      },
    );
    call.once('error', reject);
    call.end(bytes);
  });
  requireValue(
    expected ? response.status === expected : response.status >= 200 && response.status < 300,
    'API_' + response.status,
  );
  return response;
}
const data = async (path) => (await api(path)).value.data;
async function authenticate() {
  let cached;
  try {
    cached = JSON.parse(await privateFile(directory, 'auth-session.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (cached) {
    requireValue(
      cached.owner === owner &&
        cached.origin === publicAppOrigin &&
        /^ozz_session=[A-Za-z0-9_-]{43}$/u.test(cached.cookie),
      'SESSION_IDENTITY',
    );
    cookie = cached.cookie;
    csrf = cached.csrf;
    secrets.push(cookie, csrf);
    const current = await data('/auth/me');
    requireValue(
      current.user?.username === 'admin' && current.csrfToken === csrf,
      'SESSION_CHANGED',
    );
    return;
  }
  const password = (await readFile(resolve(productRoot, '.secrets/admin-password'), 'utf8')).trim();
  secrets.push(password);
  const login = await api('/auth/login', {
    method: 'POST',
    expected: 200,
    body: { username: 'admin', password },
  });
  cookie = login.headers['set-cookie']
    ?.find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  requireValue(cookie && csrf, 'LOGIN_FAILED');
  secrets.push(cookie, csrf);
  await atomic(
    resolve(directory, 'auth-session.json'),
    JSON.stringify({ owner, origin: publicAppOrigin, cookie, csrf }) + '\n',
  );
}
async function list(path) {
  const rows = [],
    seen = new Set();
  let cursor;
  for (let page = 0; page < 30; page++) {
    const result = (
      await api(
        path +
          (path.includes('?') ? '&' : '?') +
          'limit=100' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      )
    ).value;
    requireValue(Array.isArray(result.data), 'PAGE_INVALID');
    rows.push(...result.data);
    if (!result.page?.hasMore) return rows;
    cursor = result.page.nextCursor;
    requireValue(cursor && !seen.has(cursor), 'PAGE_CYCLE');
    seen.add(cursor);
  }
  throw new Error('GMVP_NODE_PAGE_BOUND');
}
async function command(label, path, body, expected = 202) {
  state.commands[label] ??= { path, body, key: randomUUID() };
  const intent = state.commands[label];
  requireValue(intent.path === path && isDeepStrictEqual(intent.body, body), 'COMMAND_CHANGED');
  if (intent.result) return intent.result;
  await save();
  intent.result = (await api(path, { method: 'POST', body, key: intent.key, expected })).value.data;
  await save();
  await evidence('accepted-' + label, {
    source: 'product API command receipt',
    result: intent.result,
  });
  return intent.result;
}
async function waitFor(read, predicate, code, milliseconds = 180000) {
  const until = Date.now() + milliseconds;
  let nextProgress = 0;
  while (Date.now() < until) {
    const value = await read();
    if (predicate(value)) return value;
    await reserve();
    if (Date.now() >= nextProgress) {
      console.log(JSON.stringify({ status: 'waiting', condition: code }));
      nextProgress = Date.now() + 10000;
    }
    await delay(1000, undefined, recovering ? undefined : { signal: abort.signal });
  }
  throw new Error('GMVP_NODE_' + code);
}
async function waitTask(type, id) {
  return waitFor(
    () => data(`/${type}/${id}`),
    (task) => {
      requireValue(
        !['failed', 'cancelled'].includes(task.status),
        'TASK_' + (task.errorCode ?? 'FAILED'),
      );
      return task.status === 'succeeded';
    },
    'TASK_TIMEOUT',
    240000,
  );
}
async function limaStatus(builder = false) {
  const name = builder ? 'ozz-build' : 'ozz-lab-c';
  const result = await execute(
    resolve(lab, 'tools/lima-2.2.1/bin/limactl'),
    ['list', '--json', name],
    {
      env: { ...process.env, LIMA_HOME: resolve(lab, builder ? 'builder/lima' : 'lima') },
      timeout: 10000,
      maxBuffer: 128 * 1024,
    },
  );
  const lines = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  requireValue(lines.length === 1 && lines[0].name === name, 'EXISTING_VM_REQUIRED');
  return { name, status: lines[0].status };
}
async function requireBuilderStopped() {
  requireValue((await limaStatus(true)).status === 'Stopped', 'BUILDER_MUST_BE_STOPPED_BY_ROOT');
}
async function cIdentityFiles() {
  const paths = [
    'lima/ozz-lab-c/lima.yaml',
    'lima/ozz-lab-c/vz-identifier',
    'credentials/known_hosts',
    'credentials/ssh_config',
  ];
  return Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, sha(await readFile(resolve(lab, path)))])),
  );
}
async function moveC(action) {
  requireValue(['stop', 'start'].includes(action), 'VM_ACTION');
  await requireBuilderStopped();
  requireValue(
    isDeepStrictEqual(await cIdentityFiles(), state.vmIdentityFiles),
    'VM_IDENTITY_FILES_CHANGED',
  );
  const before = await limaStatus();
  if (before.status === (action === 'stop' ? 'Stopped' : 'Running'))
    return { action, before, unchanged: true };
  requireValue(
    before.status === (action === 'stop' ? 'Running' : 'Stopped'),
    'VM_STATE_NOT_STABLE',
  );
  const intent = await evidence('c-' + action + '-intent', {
    action,
    vm: 'ozz-lab-c',
    before,
    source: 'explicit existing-C VM operation; no other VM may be mutated',
  });
  await execute(
    resolve(lab, 'tools/lima-2.2.1/bin/limactl'),
    [action, '--tty=false', 'ozz-lab-c'],
    {
      env: { ...process.env, LIMA_HOME: resolve(lab, 'lima') },
      timeout: 55000,
      maxBuffer: 128 * 1024,
    },
  ).catch(() => {
    throw new Error('GMVP_NODE_C_' + action.toUpperCase() + '_COMMAND_FAILED');
  });
  const after = await limaStatus();
  requireValue(
    after.status === (action === 'stop' ? 'Stopped' : 'Running'),
    'VM_TRANSITION_NOT_OBSERVED',
  );
  const result = { action, vm: 'ozz-lab-c', intent, before, after, at: new Date().toISOString() };
  await evidence('c-' + action, result);
  return result;
}
async function remote(guest, action, additional = {}) {
  requireValue(['b', 'c'].includes(guest) && (guest !== 'b' || action === 'node'), 'REMOTE_SCOPE');
  const source = await readFile(
    resolve(productRoot, 'tests/probes/support/g-mvp-node-persistence-host.py'),
    'utf8',
  );
  const parameters = {
    guest,
    action,
    kubeSystemUid: state.identities[guest].kubeSystemUid,
    ...additional,
  };
  const job = execute(
    '/usr/bin/ssh',
    [
      '-F',
      resolve(lab, 'credentials/ssh_config'),
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=4',
      'ozz-lab-' + guest,
      'sudo -n /usr/bin/python3 -I -B -',
    ],
    { timeout: 55000, maxBuffer: 128 * 1024 },
  );
  job.child.stdin.end(
    `import json\nparameters = json.loads(${JSON.stringify(JSON.stringify(parameters))})\n${source}`,
  );
  try {
    return safe(JSON.parse((await job).stdout));
  } catch {
    throw new Error('GMVP_NODE_REMOTE_' + guest.toUpperCase() + '_FAILED');
  }
}
const service = () => data('/services/' + state.serviceId);
const volume = () => data('/volumes/' + state.volumeId);
async function resourceSelector() {
  const [current, disk] = await Promise.all([service(), volume()]);
  requireValue(
    current.clusterId === registered.clusters.c &&
      current.projectId === state.projectId &&
      current.environmentId === state.environmentId &&
      !disk.destroyedAt &&
      disk.pvc?.uid &&
      disk.pv?.uid,
    'PRODUCT_RESOURCE_IDENTITY_CHANGED',
  );
  return {
    environmentId: state.environmentId,
    serviceId: state.serviceId,
    volumeId: state.volumeId,
    pvcUid: disk.pvc.uid,
    pvUid: disk.pv.uid,
    pvName: disk.pv.name,
  };
}
async function snapshotC(action = 'snapshot', additional = {}) {
  return remote('c', action, { ...(await resourceSelector()), ...additional });
}
function sameB(before, after) {
  return (
    before.nodeUid === after.nodeUid &&
    before.kubeSystemUid === after.kubeSystemUid &&
    before.bootId === after.bootId &&
    before.nodeReady &&
    after.nodeReady
  );
}
async function validateProductTargets() {
  const [c, b, server] = await Promise.all([
    data('/clusters/' + registered.clusters.c),
    data('/clusters/' + registered.clusters.b),
    data('/servers/' + registered.serverC),
  ]);
  requireValue(
    c.identity?.kubeSystemUid &&
      b.identity?.kubeSystemUid &&
      server.hostKey?.trustedFingerprint &&
      ['https://127.0.0.1:36443', 'https://127.0.0.1:36443/'].includes(c.apiEndpoint) &&
      ['https://127.0.0.1:26443', 'https://127.0.0.1:26443/'].includes(b.apiEndpoint),
    'EXISTING_CLUSTER_TARGET_CHANGED',
  );
  const line = (await readFile(resolve(lab, 'credentials/known_hosts'), 'utf8'))
    .split('\n')
    .find((entry) => entry.startsWith('ozz-lab-c '));
  requireValue(line, 'TRUSTED_C_HOST_KEY_MISSING');
  const fingerprint =
    'SHA256:' +
    createHash('sha256')
      .update(Buffer.from(line.split(/\s+/u)[2], 'base64'))
      .digest('base64')
      .replace(/=+$/u, '');
  requireValue(fingerprint === server.hostKey.trustedFingerprint, 'C_SSH_TRUST_CHANGED');
  const identities = {
    b: { clusterId: b.id, kubeSystemUid: b.identity.kubeSystemUid },
    c: {
      clusterId: c.id,
      kubeSystemUid: c.identity.kubeSystemUid,
      serverId: server.id,
      sshFingerprint: fingerprint,
    },
  };
  if (state.identities)
    requireValue(isDeepStrictEqual(state.identities, identities), 'CLUSTER_IDENTITY_CHANGED');
  else {
    state.identities = identities;
    await save();
  }
}
async function retryPreparation() {
  requireValue(
    state.deploymentId && !state.writeIntent && !state.baseline && !state.stopIntent,
    'PREPARATION_RETRY_NOT_ALLOWED',
  );
  await requireBuilderStopped();
  requireValue((await limaStatus()).status === 'Running', 'C_NOT_RUNNING');
  await reserve(10);
  await validateProductTargets();
  const originalId = state.firstFailedDeploymentId ?? state.deploymentId;
  requireValue(state.commands.publish?.result?.id === originalId, 'ORIGINAL_PUBLICATION_CHANGED');
  const original = await data('/deployments/' + originalId);
  requireValue(
    original.status === 'failed' &&
      original.errorCode === 'WORKLOAD_ROLLOUT_TIMEOUT' &&
      original.serviceId === state.serviceId &&
      original.target.clusterId === registered.clusters.c &&
      original.snapshot.configuration.image === image,
    'ORIGINAL_FAILURE_CHANGED',
  );
  state.firstFailedDeploymentId = originalId;
  state.firstFailedDeploymentEvidence ??= await evidence('first-failed-deployment', {
    source: 'original failed product deployment, retained before an explicit preparation retry',
    deployment: original,
  });
  await save();
  const label = 'retry-preparation';
  let body = state.commands[label]?.body;
  if (!body) {
    const current = await service();
    requireValue(
      !current.activeTask &&
        current.desiredState === 'running' &&
        current.configRevision === original.configRevision,
      'PREPARATION_SERVICE_CHANGED',
    );
    body = {
      revision: current.revision,
      ...(['partial', 'drifted', 'unknown'].includes(current.configurationState)
        ? { allowConfigurationRepair: true }
        : {}),
    };
  }
  // The durable command keeps its original revision/key after a lost response.
  // Re-entering this mode retrieves that one retry; it never creates another.
  const accepted = await command(label, '/deployments/' + originalId + '/retry', body);
  requireValue(
    accepted.id !== originalId &&
      accepted.retryOfId === originalId &&
      accepted.serviceId === state.serviceId,
    'PREPARATION_RETRY_IDENTITY',
  );
  const done = await waitFor(
    () => data('/deployments/' + accepted.id),
    (task) => ['succeeded', 'failed', 'cancelled'].includes(task.status),
    'PREPARATION_RETRY_TIMEOUT',
    240000,
  );
  const proof = await evidence('preparation-retry-deployment', { deployment: done });
  state.preparationRetry = {
    originalDeploymentId: originalId,
    deploymentId: done.id,
    status: done.status,
    proof,
  };
  await save();
  requireValue(
    done.status === 'succeeded' &&
      done.retryOfId === originalId &&
      done.serviceId === state.serviceId &&
      done.snapshot.configuration.image === image,
    'PREPARATION_RETRY_NOT_SUCCEEDED',
  );
  const current = await service();
  requireValue(
    current.published?.deploymentId === done.id && !current.activeTask,
    'RETRY_PUBLICATION_NOT_OBSERVED',
  );
  // Keep commands.publish and the first failure intact. Only a successful new
  // publication may become the baseline and reach the first marker write.
  state.deploymentId = done.id;
  await save();
  await prepare();
}
async function repairPreparation() {
  requireValue(
    state.firstFailedDeploymentId &&
      state.preparationRetry?.status === 'failed' &&
      !state.writeIntent &&
      !state.baseline &&
      !state.stopIntent,
    'PREPARATION_REPAIR_NOT_ALLOWED',
  );
  await requireBuilderStopped();
  requireValue((await limaStatus()).status === 'Running', 'C_NOT_RUNNING');
  await reserve(10);
  await validateProductTargets();
  const previous = await data('/deployments/' + state.preparationRetry.deploymentId);
  requireValue(
    previous.status === 'failed' &&
      previous.serviceId === state.serviceId &&
      previous.retryOfId === state.firstFailedDeploymentId &&
      previous.snapshot.configuration.image === image &&
      previous.snapshot.configuration.startup?.path === '/' &&
      previous.snapshot.configuration.readiness?.path === '/healthz',
    'PREPARATION_REPAIR_SOURCE_CHANGED',
  );
  let current = await service();
  requireValue(
    current.configuration.image === image &&
      current.configuration.command[0] === 'node' &&
      current.configuration.args[1] === appProgram,
    'PREPARATION_APPLICATION_CHANGED',
  );
  const startup = { ...previous.snapshot.configuration.startup, path: '/healthz' };
  state.startupCorrection ??= {
    requestedAt: new Date().toISOString(),
    afterFailedDeploymentId: previous.id,
    before: previous.snapshot.configuration.startup,
    after: startup,
    source: 'health checks must not require the marker before its first explicit write',
  };
  await save();
  if (!isDeepStrictEqual(current.configuration.startup, startup)) {
    requireValue(!current.activeTask, 'PREPARATION_SERVICE_CHANGED');
    current = (
      await api('/services/' + state.serviceId, {
        method: 'PATCH',
        body: {
          revision: current.revision,
          configuration: { ...current.configuration, startup },
        },
        expected: 200,
      })
    ).value.data;
  }
  const label = 'publish-preparation-repair';
  const body = state.commands[label]?.body ?? {
    revision: current.revision,
    allowConfigurationRepair: true,
  };
  // A retry keeps its original snapshot, so this explicit configuration change
  // requires a new publication. The failed original and retry remain untouched.
  const accepted = await command(label, '/services/' + state.serviceId + '/deployments', body);
  const done = await waitFor(
    () => data('/deployments/' + accepted.id),
    (task) => ['succeeded', 'failed', 'cancelled'].includes(task.status),
    'PREPARATION_REPAIR_TIMEOUT',
    240000,
  );
  const proof = await evidence('preparation-repair-deployment', { deployment: done });
  state.preparationRepair = { deploymentId: done.id, status: done.status, proof };
  await save();
  requireValue(
    done.status === 'succeeded' &&
      done.id !== previous.id &&
      done.serviceId === state.serviceId &&
      done.snapshot.configuration.image === image &&
      done.snapshot.configuration.startup?.path === '/healthz' &&
      done.snapshot.configuration.readiness?.path === '/healthz',
    'PREPARATION_REPAIR_NOT_SUCCEEDED',
  );
  current = await service();
  requireValue(
    current.published?.deploymentId === done.id && !current.activeTask,
    'REPAIR_PUBLICATION_NOT_OBSERVED',
  );
  state.deploymentId = done.id;
  await save();
  await prepare();
}
async function prepare() {
  await requireBuilderStopped();
  requireValue((await limaStatus()).status === 'Running', 'ROOT_MUST_START_EXISTING_C');
  await reserve(10);
  await validateProductTargets();
  state.vmIdentityFiles ??= await cIdentityFiles();
  await save();
  const [nodeC, nodeB] = await Promise.all([remote('c', 'node'), remote('b', 'node')]);
  requireValue(nodeC.nodeReady && nodeB.nodeReady, 'NODES_NOT_READY');
  const slug = 'gmvp-c-pvc-' + state.id.slice(0, 8);
  if (!state.projectId) {
    const existing = await list('/projects?search=' + slug);
    requireValue(!existing.some((row) => row.slug === slug), 'UNRECORDED_PROJECT');
    const project = await command(
      'create-project',
      '/projects',
      {
        name: 'GMVP C persistent node recovery',
        slug,
        clusterId: registered.clusters.c,
        description: owner + ':' + state.id,
      },
      201,
    );
    state.projectId = project.id;
    await save();
  }
  if (!state.environmentId) {
    const environments = await list('/environments?projectId=' + state.projectId);
    state.environmentId = environments.find((entry) => entry.slug === 'production')?.id;
    requireValue(uuid.test(state.environmentId), 'ENVIRONMENT_MISSING');
    await save();
  }
  await waitFor(
    () => data('/clusters/' + registered.clusters.c + '/storage'),
    (storage) =>
      !storage.stale &&
      storage.capabilities?.storageClasses.some(
        (entry) => entry.name === 'local-path' && entry.supported,
      ),
    'STORAGE_NOT_READY',
  );
  if (!state.serviceId) {
    const created = await command(
      'create-service',
      '/services',
      {
        projectId: state.projectId,
        environmentId: state.environmentId,
        name: 'C read-only marker application',
        slug: 'marker',
        template: { id: 'docker', version: '1.0.0', parameters: { image, port: 8080 } },
      },
      201,
    );
    state.serviceId = created.id;
    await save();
  }
  if (!state.volumeId) {
    const created = await command('create-volume', '/volumes', {
      environmentId: state.environmentId,
      name: 'C retained marker',
      slug: 'marker-data',
      storageClassName: 'local-path',
      requestedBytes: '1073741824',
    });
    state.volumeId = created.volumeId;
    await save();
    await waitTask('operations', created.operation.id);
  }
  let current = await service();
  const disk = await volume();
  const mounts = await data('/services/' + state.serviceId + '/volume-mounts');
  if (!mounts.some((entry) => entry.volumeId === state.volumeId && entry.desired)) {
    await api('/services/' + state.serviceId + '/volume-mounts', {
      method: 'POST',
      expected: 200,
      body: {
        revision: current.revision,
        volumeId: state.volumeId,
        volumeRevision: disk.revision,
        mountPath: '/data',
        readOnly: false,
      },
    });
    current = await service();
  }
  if (current.configuration.command[0] !== 'node' || current.configuration.args[1] !== appProgram) {
    requireValue(!state.writeIntent, 'APPLICATION_CONFIG_CHANGED_AFTER_WRITE');
    await api('/services/' + state.serviceId, {
      method: 'PATCH',
      expected: 200,
      body: {
        revision: current.revision,
        configuration: {
          ...current.configuration,
          command: ['node'],
          args: ['-e', appProgram],
          replicas: 1,
          resources: {
            requests: { cpuMillis: 25, memoryMiB: 32 },
            limits: { cpuMillis: 250, memoryMiB: 256 },
          },
          readiness: healthProbe,
          startup: healthProbe,
          healthTimeoutSeconds: 120,
        },
      },
    });
    current = await service();
  }
  if (!state.deploymentId) {
    const task = await command('publish', '/services/' + state.serviceId + '/deployments', {
      revision: current.revision,
    });
    state.deploymentId = task.id;
    await save();
    await waitTask('deployments', task.id);
  }
  await waitFor(
    service,
    (entry) =>
      entry.runtimeState === 'running' &&
      entry.published?.deploymentId === state.deploymentId &&
      !entry.activeTask,
    'APPLICATION_NOT_READY',
  );
  await waitFor(
    volume,
    (entry) => entry.pvc?.uid && entry.pv?.uid && !entry.observation?.stale,
    'VOLUME_NOT_BOUND',
  );
  if (!state.writeIntent) {
    state.writeIntent = {
      id: randomUUID(),
      attemptedAt: new Date().toISOString(),
      markerSha256: sha(marker),
    };
    await save();
    const written = await snapshotC('write-once', { marker, writeIntentId: state.writeIntent.id });
    requireValue(
      written.marker.sha256 === sha(marker) &&
        written.marker.exclusiveCreate &&
        written.marker.fsynced,
      'INITIAL_WRITE_NOT_VERIFIED',
    );
    state.writeReceipt = await evidence('initial-marker-write', {
      source: 'single explicit exclusive marker write, never repeated during recovery',
      result: written,
    });
    await save();
  }
  // A lost write response resumes here with a read only. An absent file fails;
  // it never falls back to another write or changes the durable write intent.
  const read = await snapshotC('read');
  requireValue(read.marker.sha256 === sha(marker) && read.readOnly, 'INITIAL_MARKER_NOT_VERIFIED');
  if (state.baseline) {
    requireValue(
      read.pvcUid === state.baseline.c.pvcUid &&
        read.pvUid === state.baseline.c.pvUid &&
        read.nodeUid === state.baseline.c.nodeUid,
      'PREPARED_IDENTITIES_CHANGED',
    );
  } else {
    state.baseline = { c: read, b: nodeB, service: await service(), volume: await volume() };
    state.preparedAt = new Date().toISOString();
    await save();
  }
  const report = await evidence('prepared', {
    status: 'prepared',
    source: 'product API deployment and independent existing C/B observations',
    baseline: state.baseline,
    image,
    originalFailedDeploymentId: state.firstFailedDeploymentId ?? null,
    preparationRetry: state.preparationRetry ?? null,
    preparationRepair: state.preparationRepair ?? null,
    startupCorrection: state.startupCorrection ?? null,
    markerSha256: sha(marker),
    writeIntent: state.writeIntent,
  });
  console.log(
    JSON.stringify({
      status: 'prepared',
      report,
      serviceId: state.serviceId,
      volumeId: state.volumeId,
    }),
  );
}
async function recoverC() {
  requireValue(state.stopIntent, 'NO_C_STOP_INTENT');
  recovering = true;
  try {
    const result = await moveC('start');
    state.resume = result;
    await save();
    return result;
  } finally {
    recovering = false;
  }
}
async function verify() {
  requireValue(state.baseline && state.stopIntent && state.stopped, 'NODE_FAULT_NOT_RECORDED');
  await requireBuilderStopped();
  requireValue((await limaStatus()).status === 'Running', 'C_NOT_RUNNING');
  await validateProductTargets();
  await waitFor(
    async () => {
      try {
        return await remote('c', 'node');
      } catch {
        return null;
      }
    },
    (entry) => entry?.nodeReady,
    'C_NODE_NOT_RECOVERED',
    240000,
  );
  await waitFor(
    service,
    (entry) => entry.runtimeState === 'running' && !entry.observationStale && !entry.activeTask,
    'PRODUCT_NOT_RECOVERED',
    240000,
  );
  const [c, b, current, disk] = await Promise.all([
    snapshotC('read'),
    remote('b', 'node'),
    service(),
    volume(),
  ]);
  const before = state.baseline.c;
  const checks = {
    wholeCNodeStopped: state.stopped.after.status === 'Stopped',
    cBootChanged: c.bootId !== before.bootId,
    cNodeIdentityRetained: c.kubeSystemUid === before.kubeSystemUid && c.nodeUid === before.nodeUid,
    persistentVolumeIdentityRetained: c.pvcUid === before.pvcUid && c.pvUid === before.pvUid,
    originalMarkerReadWithoutRewrite:
      c.readOnly === true &&
      c.marker.sha256 === state.writeIntent.markerSha256 &&
      c.marker.bytes === 65,
    markerMetadataRetained:
      c.marker.inode === before.marker.inode &&
      c.marker.mtimeMilliseconds === before.marker.mtimeMilliseconds,
    independentBUnchanged:
      state.outageObserved === true &&
      state.duringB.length >= 2 &&
      sameB(state.baseline.b, b) &&
      state.duringB.every((sample) => sameB(state.baseline.b, sample)),
    applicationServedOriginalMarker:
      c.httpMarker.readOnly === true && c.httpMarker.sha256 === state.writeIntent.markerSha256,
    originalPublicationRetained:
      current.published?.deploymentId === state.deploymentId &&
      current.desiredState === 'running' &&
      current.runtimeState === 'running',
    volumeNotDestroyed:
      !disk.destroyedAt && disk.pvc.uid === before.pvcUid && disk.pv.uid === before.pvUid,
    noActiveProductTask: !current.activeTask,
  };
  const passed = Object.values(checks).every((value) => value === true);
  const report = await evidence('verified', {
    source: 'post-node-start read-only product and direct C/B observations; no marker write',
    passed,
    checks,
    before: state.baseline,
    after: { c, b, service: current, volume: disk },
    stopped: state.stopped,
    resume: state.resume,
    duringB: state.duringB,
    localAvailableBytes: await reserve(),
  });
  state.verification = { passed, checks, report, verifiedAt: new Date().toISOString() };
  await save();
  console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', checks, report }));
  requireValue(passed, 'ACCEPTANCE_NOT_ESTABLISHED');
}
async function run() {
  requireValue(state.baseline && !state.stopIntent, 'PREPARE_OR_RECOVERY_REQUIRED');
  await requireBuilderStopped();
  await reserve(10);
  const [c, b] = await Promise.all([snapshotC('read'), remote('b', 'node')]);
  requireValue(
    c.marker.sha256 === state.writeIntent.markerSha256 &&
      c.pvcUid === state.baseline.c.pvcUid &&
      c.pvUid === state.baseline.c.pvUid &&
      c.nodeUid === state.baseline.c.nodeUid &&
      c.bootId === state.baseline.c.bootId &&
      sameB(state.baseline.b, b),
    'PRE_FAULT_BASELINE_CHANGED',
  );
  state.stopIntent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    vm: 'ozz-lab-c',
    durationSeconds: 30,
  };
  state.duringB = [];
  await save();
  try {
    state.stopped = await moveC('stop');
    await save();
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const sample = await remote('b', 'node');
      state.duringB.push(sample);
      await save();
      requireValue(sameB(state.baseline.b, sample), 'B_CHANGED_DURING_C_STOP');
      requireValue((await limaStatus()).status === 'Stopped', 'C_RESTARTED_UNEXPECTEDLY');
      await reserve();
      console.log(JSON.stringify({ status: 'c-stopped', independentBReady: sample.nodeReady }));
      await delay(3000, undefined, { signal: abort.signal });
    }
    state.outageObserved = true;
    await save();
  } finally {
    await recoverC();
  }
  await verify();
}
async function stopService() {
  requireValue(state.verification?.passed, 'VERIFICATION_REQUIRED');
  const current = await service();
  if (
    current.desiredState === 'stopped' &&
    current.runtimeState === 'stopped' &&
    !current.activeTask
  )
    return;
  const operation = await command('stop-service', '/services/' + state.serviceId + '/stop', {
    revision: current.revision,
  });
  await waitTask('operations', operation.id);
  await waitFor(
    service,
    (entry) =>
      entry.desiredState === 'stopped' && entry.runtimeState === 'stopped' && !entry.activeTask,
    'SERVICE_NOT_STOPPED',
  );
  const disk = await volume();
  requireValue(
    !disk.destroyedAt && disk.pvc.uid === state.baseline.c.pvcUid,
    'VOLUME_NOT_RETAINED',
  );
  await evidence('service-stopped', {
    service: await service(),
    volume: disk,
    volumeDeletionRequested: false,
  });
}
async function main() {
  requireValue(process.argv.length === 3 && modes.includes(mode), 'USAGE_INVALID');
  if (mode === 'plan') {
    console.log(
      JSON.stringify({
        status: 'prepared-procedure-only',
        vm: 'ozz-lab-c',
        requiredBuilderState: 'Stopped',
        existingCluster: true,
        newProjects: 1,
        newServices: 1,
        newPvcCount: 1,
        requestedBytes: '1073741824',
        image,
        initialMarkerWrites: 1,
        recoveryMarkerWrites: 0,
        vmStopSeconds: 30,
        independentObserver: 'B',
        executed: false,
      }),
    );
    return;
  }
  try {
    state = JSON.parse(await privateFile(directory, 'state.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (mode === 'status') {
    console.log(
      JSON.stringify(
        state
          ? {
              owner: state.owner,
              id: state.id,
              preparedAt: state.preparedAt,
              verification: state.verification,
            }
          : { status: 'not-prepared' },
      ),
    );
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  lock = await open(statePath + '.lock', 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, owner, mode }));
  requireValue(state || mode === 'prepare', 'PREPARE_REQUIRED');
  if (state) requireValue(state.owner === owner && uuid.test(state.id), 'STATE_IDENTITY');
  if (mode === 'recover') {
    await recoverC();
    console.log(
      JSON.stringify({
        status: 'c-started',
        verificationStillRequired: true,
        markerWritten: false,
      }),
    );
    return;
  }
  configuration = await readProductConfiguration();
  await checkProductHttpsHealth(configuration);
  registered = JSON.parse(await privateFile(lab, 'product-state.json'));
  requireValue(
    uuid.test(registered.clusters?.c) &&
      uuid.test(registered.clusters?.b) &&
      uuid.test(registered.serverC),
    'ORIGINAL_CLUSTER_REGISTRATION_REQUIRED',
  );
  await authenticate();
  if (!state) {
    state = { owner, id: randomUUID(), createdAt: new Date().toISOString(), commands: {} };
    await save();
  }
  try {
    marker = await privateFile(directory, 'marker.txt');
  } catch (error) {
    if (error.code !== 'ENOENT' || state.writeIntent) throw error;
    requireValue(mode === 'prepare', 'INITIAL_MARKER_MISSING');
    marker = randomBytes(32).toString('hex') + '\n';
    await writeFile(resolve(directory, 'marker.txt'), marker, { mode: 0o600, flag: 'wx' });
  }
  secrets.push(marker, marker.trim());
  requireValue(/^[a-f0-9]{64}\n$/u.test(marker), 'MARKER_INVALID');
  if (mode === 'prepare') await prepare();
  else if (mode === 'retry-prepare') await retryPreparation();
  else if (mode === 'repair-prepare') await repairPreparation();
  else if (mode === 'run') await run();
  else if (mode === 'verify') await verify();
  else if (mode === 'stop-service') await stopService();
  else {
    requireValue(state.verification?.passed, 'VERIFICATION_REQUIRED');
    const [current, disk, cVm, b] = await Promise.all([
      service(),
      volume(),
      limaStatus(),
      remote('b', 'node'),
    ]);
    requireValue(
      !current.activeTask &&
        !disk.destroyedAt &&
        disk.pvc.uid === state.baseline.c.pvcUid &&
        sameB(state.baseline.b, b),
      'FINAL_STATE_CHANGED',
    );
    const report = await evidence('final', {
      passed: true,
      verification: state.verification,
      originalFailedDeploymentId: state.firstFailedDeploymentId ?? null,
      preparationRetry: state.preparationRetry ?? null,
      preparationRepair: state.preparationRepair ?? null,
      startupCorrection: state.startupCorrection ?? null,
      service: current,
      volume: disk,
      cVm,
      b,
      resourcesRetained: true,
      markerWrittenDuringRecovery: false,
      localAvailableBytes: await reserve(),
    });
    console.log(JSON.stringify({ status: 'passed', report }));
  }
}
try {
  await main();
} catch (error) {
  const code = /^GMVP_NODE_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : 'GMVP_NODE_PROBE_FAILED';
  let report;
  if (state?.owner === owner)
    try {
      report = await evidence('failed', {
        mode,
        code,
        source: 'probe failure, no acceptance claim',
      });
    } catch {
      /* Keep the original error. */
    }
  console.error(JSON.stringify({ status: 'failed', code, report }));
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(statePath + '.lock');
  }
}
