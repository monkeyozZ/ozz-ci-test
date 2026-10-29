import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { templateImages } from '../../packages/control-plane/dist/templates/image-assets.js';

// Real product API/Worker -> retained A/B K3s. Dedicated S5 projects only.
// Image cache assistance is recorded separately; cloud networking is unverified.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const stateFile = resolve(lab, 'storage-product-state.json');
const reportFile = resolve(root, 'docs/acceptance/s5-product-local-results.json');
const scope = process.argv[2] ?? 'all';
if (!['prepare', 'deploy', 'all'].includes(scope)) throw new Error('LOCAL_S5_SCOPE_INVALID');
const retryFailed = process.argv.includes('--retry-failed');
const retryTarget = process.argv.find((value) => value.startsWith('--retry-task='))?.slice(13);
const repairOwned = process.argv.includes('--repair-owned');
if (repairOwned && !retryFailed) throw new Error('LOCAL_S5_REPAIR_REQUIRES_RETRY');
if (retryFailed && !/^[a-f0-9-]{36}$/u.test(retryTarget ?? ''))
  throw new Error('LOCAL_S5_EXACT_RETRY_TASK_REQUIRED');
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const api = 'http://127.0.0.1:3000/api';
let cookie,
  csrf,
  stage = 'preflight',
  lock,
  state;
try {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
state ??= {
  version: 1,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  projects: {},
  environments: {},
  services: {},
  volumes: {},
  commands: {},
  completed: {},
  checks: [],
};
if (state.version !== 1) throw new Error('LOCAL_S5_STATE_INVALID');
const report = {
  status: 'running',
  scope:
    'Local ARM64 A/B K3s, real product API/Worker, persistent volumes and databases. Exact public image cache assistance; not native unassisted registry or cloud acceptance.',
  runId: state.runId,
  startedAt: state.startedAt,
  resumedAt: new Date().toISOString(),
  checks: state.checks,
};
const registered = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
async function save() {
  await writeFile(`${stateFile}.pending`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${stateFile}.pending`, stateFile);
}
async function check(name, passed, details = {}) {
  requireValue(passed, `LOCAL_S5_ASSERTION: ${name}`);
  state.checks.push({ name, passed: true, observedAt: new Date().toISOString(), ...details });
  console.log(JSON.stringify({ check: name, passed: true }));
  await save();
}
async function phase(name, work) {
  stage = name;
  if (Object.hasOwn(state.completed, name)) return state.completed[name];
  console.log(JSON.stringify({ stage }));
  const result = await work();
  state.completed[name] = result ?? true;
  await save();
  return result;
}
async function request(path, method = 'GET', body, key, expected) {
  const response = await fetch(api + path, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(20_000)]),
  });
  const value = response.status === 204 ? null : await response.json();
  if (expected ? response.status !== expected : !response.ok)
    throw Object.assign(new Error('LOCAL_S5_API_FAILED'), {
      code: value?.code,
      status: response.status,
    });
  return { value, response };
}
const data = async (path) => (await request(path)).value.data;
const service = async (name) => data(`/services/${state.services[name]}`);
async function waitFor(read, accept, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('LOCAL_S5_OBSERVATION_TIMEOUT');
}
async function command(label, path, method, body, expected = 202) {
  state.commands[label] ??= { path, method, body, key: randomUUID() };
  const intent = state.commands[label];
  requireValue(intent.path === path && intent.method === method, 'LOCAL_S5_COMMAND_TARGET_CHANGED');
  await save();
  const result = (await request(intent.path, intent.method, intent.body, intent.key, expected))
    .value.data;
  const id = result.operation?.id ?? result.id;
  requireValue(!intent.id || intent.id === id, 'LOCAL_S5_IDEMPOTENCY_CHANGED');
  intent.id = id;
  await save();
  return result;
}
async function waitTask(type, initial, label) {
  let task = await data(`/${type}/${initial.id}`),
    retries = 0,
    submittedRetry = false,
    last;
  const end = Date.now() + 600_000;
  while (Date.now() < end) {
    if (last !== `${task.status}:${task.phase}:${task.errorCode}`) {
      last = `${task.status}:${task.phase}:${task.errorCode}`;
      console.log(
        JSON.stringify({
          task: task.id,
          status: task.status,
          phase: task.phase,
          code: task.errorCode,
        }),
      );
    }
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed') {
      const retryLabel = `${label}:retry:${++retries}`;
      const accepted = state.commands[retryLabel];
      if (accepted) {
        requireValue(accepted.path === `/${type}/${task.id}/retry`, 'LOCAL_S5_RETRY_CHAIN_CHANGED');
        task = accepted.id
          ? await data(`/${type}/${accepted.id}`)
          : await command(retryLabel, accepted.path, 'POST', accepted.body);
        continue;
      }
      if (!retryFailed || task.id !== retryTarget || submittedRetry)
        throw Object.assign(new Error('LOCAL_S5_TASK_FAILED'), {
          code: task.errorCode,
          taskId: task.id,
        });
      const current = type === 'deployments' ? await data(`/services/${task.serviceId}`) : null;
      if (repairOwned && type === 'deployments')
        requireValue(
          Object.values(state.services).includes(task.serviceId) &&
            (task.errorCode === 'WORKLOAD_CONFIGURATION_DRIFT' ||
              task.snapshot?.allowConfigurationRepair === true),
          'LOCAL_S5_REPAIR_NOT_OWNED_DRIFT',
        );
      const body =
        type === 'deployments'
          ? {
              revision: current.revision,
              ...(repairOwned ? { allowConfigurationRepair: true } : {}),
            }
          : undefined;
      task = await command(retryLabel, `/${type}/${task.id}/retry`, 'POST', body);
      submittedRetry = true;
    } else if (['failed', 'cancelled'].includes(task.status))
      throw Object.assign(new Error('LOCAL_S5_TASK_FAILED'), {
        code: task.errorCode,
        taskId: task.id,
      });
    else {
      await delay(1000, undefined, { signal: abort.signal });
      task = await data(`/${type}/${task.id}`);
    }
  }
  throw new Error('LOCAL_S5_TASK_TIMEOUT');
}
async function publish(name, label = `publish:${name}`) {
  const current = await service(name);
  const accepted = await command(label, `/services/${current.id}/deployments`, 'POST', {
    revision: current.revision,
  });
  const task = await waitTask('deployments', accepted, label);
  const after = await waitFor(
    () => service(name),
    (item) => item.runtimeState === 'running' && item.published?.deploymentId === task.id,
  );
  requireValue(
    after.observation?.pods.some((pod) => pod.ready && !pod.deletionTimestamp),
    'LOCAL_S5_READY_POD_MISSING',
  );
  return { service: after, task };
}

const fileProgram =
  "const http=require('node:http');const fs=require('node:fs');http.createServer((req,res)=>{res.setHeader('content-type','text/plain');res.end(fs.existsSync('/data/ozz-s5-marker')?fs.readFileSync('/data/ozz-s5-marker'):'S5 volume ready')}).listen(8080,'0.0.0.0')";
async function createTemplate(name, id, guest = 'a', parameters = {}) {
  if (!state.services[name]) {
    const created = await command(
      `create:${name}`,
      '/services',
      'POST',
      {
        projectId: state.projects[guest],
        environmentId: state.environments[guest],
        name: `S5 ${name}`,
        slug: name,
        template: { id, version: '1.0.0', parameters },
      },
      201,
    );
    state.services[name] = created.id;
    await save();
  }
  const current = await service(name);
  requireValue(
    current.clusterId === registered.clusters[guest] &&
      current.environmentId === state.environments[guest],
    'LOCAL_S5_SERVICE_TARGET_CHANGED',
  );
  return current;
}
async function prepare() {
  for (const guest of ['a', 'b'])
    await phase(`project:${guest}`, async () => {
      const slug = `s5-data-${guest}-${state.runId.slice(0, 8)}`;
      if (!state.projects[guest]) {
        const matches = await data(`/projects?search=${slug}&limit=100`);
        requireValue(!matches.some((item) => item.slug === slug), 'LOCAL_S5_UNRECORDED_PROJECT');
        const created = (
          await request(
            '/projects',
            'POST',
            {
              name: `数据验证 ${guest.toUpperCase()}`,
              slug,
              clusterId: registered.clusters[guest],
              description: 'S5 本地数据库、卷与异目标恢复验证。',
            },
            undefined,
            201,
          )
        ).value.data;
        state.projects[guest] = created.id;
        await save();
      }
      const environments = await data(`/environments?projectId=${state.projects[guest]}&limit=100`);
      const environment = environments.find((item) => item.slug === 'production');
      requireValue(environment, 'LOCAL_S5_ENVIRONMENT_MISSING');
      state.environments[guest] = environment.id;
      await save();
      const storage = await waitFor(
        () => data(`/clusters/${registered.clusters[guest]}/storage`),
        (item) =>
          !item.stale &&
          item.capabilities?.storageClasses.some(
            (entry) => entry.name === 'local-path' && entry.supported,
          ),
      );
      await check(
        `${guest}: actual local-path class is available without a hard quota claim`,
        storage.capabilities.storageClasses.find((entry) => entry.name === 'local-path')
          .hardQuotaSupport === 'unsupported',
        { projectId: state.projects[guest], environmentId: environment.id },
      );
    });
  await phase('catalog-and-preview', async () => {
    const templates = await data('/templates?limit=100');
    requireValue(templates.length === 5, 'LOCAL_S5_TEMPLATE_CATALOG_INCOMPLETE');
    const preview = (
      await request(
        '/templates/postgresql/preview',
        'POST',
        { environmentId: state.environments.a, version: '1.0.0', parameters: {} },
        undefined,
        200,
      )
    ).value.data;
    await check(
      'fixed templates expose real architecture assets and a read-only preview',
      templates.every((item) => item.id === 'docker' || item.image?.platforms.includes('arm64')) &&
        preview.plannedCredentials[0]?.generated === true &&
        preview.plannedVolumes.length === 1,
    );
  });
  for (const id of ['postgresql', 'redis', 'node-example', 'static-example'])
    await phase(`create:${id}`, async () => {
      const current = await createTemplate(id, id);
      if (current.databaseInstanceId) {
        const database = await data(`/databases/${current.databaseInstanceId}`);
        state.volumes[id] = database.dataVolume.id;
        await save();
      }
      await check(
        `${id}: creating a template saves a draft without automatic deployment`,
        !current.activeTask && !current.published,
        { serviceId: current.id },
      );
    });
  await phase('create:files', async () => {
    let current = await createTemplate('files', 'docker', 'a', {
      image: templateImages['node-example'].deployReference,
      port: 8080,
    });
    if (!state.volumes.files) {
      const created = await command('volume:files', '/volumes', 'POST', {
        environmentId: state.environments.a,
        name: 'S5 普通文件',
        slug: 'files-data',
        storageClassName: 'local-path',
        requestedBytes: '1073741824',
      });
      state.volumes.files = created.volumeId;
      await save();
      await waitTask('operations', created.operation, 'volume:files');
    }
    const volume = await data(`/volumes/${state.volumes.files}`);
    const mounts = await data(`/services/${current.id}/volume-mounts`);
    if (!mounts.some((item) => item.volumeId === volume.id && item.desired))
      await request(
        `/services/${current.id}/volume-mounts`,
        'POST',
        {
          revision: current.revision,
          volumeId: volume.id,
          volumeRevision: volume.revision,
          mountPath: '/data',
          readOnly: false,
        },
        undefined,
        200,
      );
    current = await service('files');
    if (current.configuration.command[0] !== 'node')
      await request(
        `/services/${current.id}`,
        'PATCH',
        {
          revision: current.revision,
          configuration: {
            ...current.configuration,
            command: ['node'],
            args: ['-e', fileProgram],
            resources: {
              requests: { cpuMillis: 25, memoryMiB: 32 },
              limits: { cpuMillis: 250, memoryMiB: 128 },
            },
          },
        },
        undefined,
        200,
      );
    await check(
      'ordinary writable volume is a draft mount using single-replica Recreate',
      (await service('files')).controller.strategy === 'Recreate' && !volume.destroyedAt,
      { volumeId: volume.id },
    );
  });
}

async function deploy() {
  for (const name of ['postgresql', 'redis', 'node-example', 'static-example', 'files'])
    await phase(`publish:${name}`, async () => {
      const result = await publish(name);
      await check(
        `${name}: template is running through the common deployment engine`,
        result.task.snapshot.version === 2 && result.service.runtimeState === 'running',
        {
          serviceId: result.service.id,
          deploymentId: result.task.id,
          controller: result.service.observation.controller?.kind,
        },
      );
      if (result.service.databaseInstanceId) {
        const database = await waitFor(
          () => data(`/databases/${result.service.databaseInstanceId}`),
          (item) => item.databaseReady,
        );
        const volume = await data(`/volumes/${database.dataVolume.id}`);
        await check(
          `${name}: authenticated database uses its original bound PVC`,
          database.observation.authenticated &&
            database.protection.active &&
            database.initialization.pvcUid === volume.pvc.uid &&
            volume.observation?.state === 'ready' &&
            !volume.observation.stale,
          {
            databaseId: database.id,
            volumeId: volume.id,
            pvcUid: volume.pvc.uid,
            engineVersion: database.observation.engineVersion,
          },
        );
      }
    });
}

// Fixed commands only; source values are synthetic markers and resource identities.
const remoteSource = String.raw`import json,subprocess,sys
from pathlib import Path
m=json.load(sys.stdin)
assert m['guest'] in ['a','b']
assert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-'+m['guest']
def kube(args):
 p=subprocess.run(['k3s','kubectl']+args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=25)
 if p.returncode: raise RuntimeError('S5_REMOTE_KUBERNETES_FAILED')
 return p.stdout
system=json.loads(kube(['get','namespace','kube-system','-o','json']))
assert system['metadata']['uid']==m['kubeSystemUid']
p=json.loads(kube(['-n',m['namespace'],'get','pod',m['podName'],'-o','json']))
assert p['metadata']['uid']==m['podUid']
assert any(o.get('controller') and o['uid']==m['owner']['uid'] and o['kind']==m['owner']['kind'] for o in p['metadata']['ownerReferences'])
marker=m['marker']; assert len(marker)==36 and all(c in '0123456789abcdef-' for c in marker)
kind=m['kind']; action=m['action']; assert action in ['write','read']
if kind=='postgresql':
 sql="CREATE TABLE IF NOT EXISTS ozz_s5_probe (id text PRIMARY KEY,value text NOT NULL); INSERT INTO ozz_s5_probe VALUES ('persistent','"+marker+"') ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value;" if action=='write' else "SELECT value FROM ozz_s5_probe WHERE id='persistent';"
 cmd=['sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "$1"','sh',sql]
elif kind=='redis':
 cmd=['sh','-c','REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning -h 127.0.0.1 "$@"','sh']+(['SET','ozz:s5:persistent',marker] if action=='write' else ['GET','ozz:s5:persistent'])
elif kind=='files':
 cmd=['node','-e',"const fs=require('node:fs');"+("fs.writeFileSync('/data/ozz-s5-marker',process.argv[1]);" if action=='write' else "process.stdout.write(fs.readFileSync('/data/ozz-s5-marker'));"),marker]
else: raise RuntimeError('S5_REMOTE_KIND_INVALID')
value=kube(['-n',m['namespace'],'exec',m['podName'],'-c','app','--']+cmd).decode().strip()
after=json.loads(kube(['-n',m['namespace'],'get','pod',m['podName'],'-o','json']))
assert after['metadata']['uid']==m['podUid']
print(json.dumps({'verified':action=='write' or value==marker,'podUid':m['podUid']}))
`;
async function dataCommand(name, action) {
  const expectedOwner = name === 'files' ? 'ReplicaSet' : 'StatefulSet';
  const selectedPod = (item) =>
    item.ready && !item.deletionTimestamp && item.owner?.kind === expectedOwner;
  const current = await waitFor(
    () => service(name),
    (item) => !item.observationStale && item.observation?.pods.some(selectedPod),
  );
  const cluster = await data(`/clusters/${current.clusterId}`);
  const pod = current.observation.pods.find(selectedPod);
  requireValue(pod?.owner, 'LOCAL_S5_POD_OWNER_UNAVAILABLE');
  const quoted = `'${remoteSource.replaceAll("'", "'\\''")}'`;
  requireValue(cluster.identity?.kubeSystemUid, 'LOCAL_S5_CLUSTER_IDENTITY_MISSING');
  return new Promise((accept, reject) => {
    const child = execFile(
      'ssh',
      ['-F', resolve(lab, 'credentials/ssh_config'), 'ozz-lab-a', `sudo python3 -c ${quoted}`],
      { timeout: 35_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error('LOCAL_S5_DATA_PROBE_FAILED'));
          return;
        }
        try {
          accept(JSON.parse(stdout));
        } catch {
          reject(new Error('LOCAL_S5_DATA_PROBE_INVALID'));
        }
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        guest: 'a',
        kubeSystemUid: cluster.identity.kubeSystemUid,
        namespace: pod.namespace,
        podName: pod.name,
        podUid: pod.uid,
        owner: pod.owner,
        marker: state.runId,
        kind: name,
        action,
      }),
    );
  });
}

async function action(name, verb, label) {
  const current = await service(name);
  const task = await command(label, `/services/${current.id}/${verb}`, 'POST', {
    revision: current.revision,
  });
  return waitTask('operations', task, label);
}
async function lifecycle() {
  for (const name of ['postgresql', 'redis', 'files'])
    await phase(`write:${name}`, async () => {
      const result = await dataCommand(name, 'write');
      await check(
        `${name}: writes a marker into real persistent application data`,
        result.verified,
      );
    });
  for (const name of ['postgresql', 'redis', 'files'])
    await phase(`restart:${name}`, async () => {
      const before = await service(name);
      const volume = await data(`/volumes/${state.volumes[name]}`);
      const podUid = before.observation.pods.find(
        (pod) => pod.ready && !pod.deletionTimestamp,
      )?.uid;
      await action(name, 'restart', `restart:${name}`);
      const after = await waitFor(
        () => service(name),
        (item) =>
          item.runtimeState === 'running' &&
          item.observation.pods.some(
            (pod) => pod.ready && !pod.deletionTimestamp && pod.uid !== podUid,
          ),
      );
      const kept = await data(`/volumes/${volume.id}`);
      const contents = await dataCommand(name, 'read');
      await check(
        `${name}: a new Pod retains the same PVC and written data`,
        contents.verified &&
          kept.pvc.uid === volume.pvc.uid &&
          after.published.deploymentId === before.published.deploymentId,
        { oldPodUid: podUid, pvcUid: kept.pvc.uid },
      );
    });
  for (const name of ['postgresql', 'redis', 'files'])
    await phase(`stop-resume:${name}`, async () => {
      const volume = await data(`/volumes/${state.volumes[name]}`);
      await action(name, 'stop', `stop:${name}`);
      const stopped = await service(name);
      const kept = await data(`/volumes/${volume.id}`);
      await check(
        `${name}: stop drains Pods while retaining the published volume`,
        stopped.desiredState === 'stopped' &&
          stopped.runtimeState === 'stopped' &&
          kept.pvc.uid === volume.pvc.uid &&
          !kept.destroyedAt,
      );
      await action(name, 'resume', `resume:${name}`);
      await waitFor(
        () => service(name),
        (item) => item.runtimeState === 'running',
      );
      await check(
        `${name}: resume authenticates and reads the original data`,
        (await dataCommand(name, 'read')).verified,
      );
    });
}

try {
  await mkdir(lab, { recursive: true, mode: 0o700 });
  lock = await open(`${stateFile}.lock`, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
  const login = await request('/auth/login', 'POST', { username: 'admin', password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  requireValue(cookie && csrf, 'LOCAL_S5_LOGIN_FAILED');
  await prepare();
  if (scope !== 'prepare') await deploy();
  if (scope === 'all') await lifecycle();
  report.status = scope === 'all' ? 'passed' : 'partial';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    code: error.code ?? error.message,
    taskId: error.taskId ?? null,
    httpStatus: error.status ?? null,
  };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.resources = {
    projects: state.projects,
    environments: state.environments,
    services: state.services,
    volumes: state.volumes,
  };
  if (lock) {
    await save();
    await lock.close();
    await unlink(`${stateFile}.lock`);
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (report.status === 'failed') {
    await mkdir(resolve(lab, 's5-attempts'), { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(lab, `s5-attempts/${Date.now()}.json`),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}
