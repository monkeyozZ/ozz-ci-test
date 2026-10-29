import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { templateImages } from '../../packages/control-plane/dist/templates/image-assets.js';

// Destructive checks are confined to this probe's own new resources. Previously
// retained S3/S4/S5 workloads, data, cluster identities and ACME are never changed.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const stateFile = resolve(lab, 'storage-retention-state.json');
const reportFile = resolve(root, 'docs/acceptance/s5-retention-local-results.json');
const api = 'http://127.0.0.1:3000/api';
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const registered = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
let state;
try {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
state ??= { version: 1, runId: randomUUID(), commands: {}, completed: {}, checks: [] };
if (state.version !== 1) throw new Error('S5_RETENTION_STATE_INVALID');
let cookie, csrf, lock;
let stage = 'preflight';
const report = {
  status: 'running',
  runId: state.runId,
  startedAt: new Date().toISOString(),
  scope:
    'Real local K3s A, product service deletion and independent volume destruction. Only dedicated probe data may be destroyed; original S3/S4/S5 data remain intact.',
  checks: state.checks,
};
function requireValue(value, code) {
  if (!value) throw new Error(code);
}
async function save() {
  await writeFile(`${stateFile}.pending`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${stateFile}.pending`, stateFile);
}
async function check(name, passed, details = {}) {
  const result = {
    name,
    passed: Boolean(passed),
    observedAt: new Date().toISOString(),
    ...details,
  };
  const previous = state.checks.findIndex((item) => item.name === name);
  if (previous < 0) state.checks.push(result);
  else state.checks[previous] = result;
  await save();
  console.log(JSON.stringify({ check: name, passed: Boolean(passed) }));
  requireValue(passed, 'S5_RETENTION_ASSERTION_FAILED');
}
async function phase(name, work) {
  stage = name;
  if (state.completed[name]) return;
  console.log(JSON.stringify({ stage }));
  await work();
  state.completed[name] = true;
  await save();
}
async function request(path, method = 'GET', body, key, expected = 200) {
  const response = await fetch(api + path, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(20_000),
  });
  const value = response.status === 204 ? null : await response.json();
  if (response.status !== expected)
    throw Object.assign(new Error('S5_RETENTION_API_FAILED'), {
      code: value?.code,
      status: response.status,
    });
  return { value, response };
}
const data = async (path) => (await request(path)).value.data;
async function command(label, path, method, body, expected = 202) {
  state.commands[label] ??= { path, method, body, key: randomUUID() };
  const intent = state.commands[label];
  requireValue(intent.path === path && intent.method === method, 'S5_RETENTION_TARGET_CHANGED');
  await save();
  const result = (await request(path, method, intent.body, intent.key, expected)).value.data;
  const id = result.operation?.id ?? result.id;
  requireValue(!intent.id || intent.id === id, 'S5_RETENTION_IDEMPOTENCY_CHANGED');
  intent.id = id;
  await save();
  return result;
}
async function until(read, predicate, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(1000);
  }
  throw new Error('S5_RETENTION_TIMEOUT');
}
async function waitTask(type, task) {
  const result = await until(
    () => data(`/${type}/${task.id}`),
    (item) => ['succeeded', 'failed', 'cancelled'].includes(item.status),
    600_000,
  );
  if (result.status !== 'succeeded')
    throw Object.assign(new Error('S5_RETENTION_TASK_FAILED'), {
      code: result.errorCode,
      taskId: result.id,
    });
  return result;
}
async function serviceAction(name, verb) {
  const id = state[name].serviceId;
  const label = `${verb}:${name}`;
  const intent = state.commands[label];
  const current = intent ? null : await data(`/services/${id}`);
  const task = await command(
    label,
    `/services/${id}${verb === 'delete' ? '' : `/${verb}`}`,
    verb === 'delete' ? 'DELETE' : 'POST',
    { revision: current?.revision },
  );
  return waitTask('operations', task);
}
function confirmation(preview) {
  return Object.fromEntries(
    ['volumeId', 'volumeName', 'pvcUid', 'reclaimPolicy', 'previewDigest'].map((key) => [
      key,
      preview[key],
    ]),
  );
}
async function previewVolume(id) {
  const volume = await data(`/volumes/${id}`);
  return (await request(`/volumes/${id}/deletion-preview`, 'POST', { revision: volume.revision }))
    .value.data;
}

// This test-only read validates the exact original PVC/PV/host identity and file
// content after the service is gone. It never creates a helper or writes on host.
const readRetainedFile = String.raw`import json,subprocess,sys
from pathlib import Path
m=json.load(sys.stdin)
assert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-a'
def get(args):
 p=subprocess.run(['k3s','kubectl']+args+['-o','json'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 if p.returncode: raise RuntimeError('S5_RETENTION_KUBERNETES_READ_FAILED')
 return json.loads(p.stdout)
assert get(['get','namespace','kube-system'])['metadata']['uid']==m['kubeSystemUid']
pvc=get(['-n',m['namespace'],'get','pvc',m['pvcName']]); assert pvc['metadata']['uid']==m['pvcUid']
pv=get(['get','pv',pvc['spec']['volumeName']]); assert pv['metadata']['uid']==m['pvUid']
assert pv['spec']['claimRef']['uid']==m['pvcUid']
sources=[pv['spec'][kind] for kind in ['local','hostPath'] if kind in pv['spec']]
assert len(sources)==1 and isinstance(sources[0].get('path'),str)
path=Path(sources[0]['path']); expected=pv['metadata']['name']+'_'+m['namespace']+'_'+m['pvcName']
assert path.parent==Path('/var/lib/rancher/k3s/storage') and path.name==expected and path.resolve()==path
file=path/'ozz-retention-marker'; assert not file.is_symlink() and file.is_file()
print(json.dumps({'verified':file.read_text()==m['marker'],'pvcUid':m['pvcUid'],'pvUid':m['pvUid']}))
`;
async function verifyRetainedFile(volume) {
  const cluster = await data(`/clusters/${registered.clusters.a}`);
  const quoted = `'${readRetainedFile.replaceAll("'", "'\\''")}'`;
  return new Promise((accept, reject) => {
    const child = execFile(
      'ssh',
      ['-F', resolve(lab, 'credentials/ssh_config'), 'ozz-lab-a', `sudo python3 -c ${quoted}`],
      { timeout: 30_000, maxBuffer: 4096 },
      (error, stdout) => {
        if (error) return reject(new Error('S5_RETENTION_FILE_READ_FAILED'));
        try {
          accept(JSON.parse(stdout));
        } catch {
          reject(new Error('S5_RETENTION_FILE_RESULT_INVALID'));
        }
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        kubeSystemUid: cluster.identity.kubeSystemUid,
        namespace: volume.namespace,
        pvcName: volume.pvc.name,
        pvcUid: volume.pvc.uid,
        pvUid: volume.pv.uid,
        marker: state.runId,
      }),
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
    .find((entry) => entry.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  requireValue(cookie && csrf, 'S5_RETENTION_LOGIN_FAILED');
  await phase('prepare-dedicated-target', async () => {
    const slug = `s5-retain-${state.runId.slice(0, 8)}`;
    if (!state.projectId) {
      const found = await data(`/projects?search=${slug}`);
      requireValue(!found.some((item) => item.slug === slug), 'S5_RETENTION_UNRECORDED_TARGET');
      state.projectId = (
        await request(
          '/projects',
          'POST',
          { name: '数据保留验证', slug, clusterId: registered.clusters.a },
          undefined,
          201,
        )
      ).value.data.id;
      await save();
    }
    state.environmentId = (await data(`/environments?projectId=${state.projectId}`)).find(
      (item) => item.slug === 'production',
    )?.id;
    requireValue(state.environmentId, 'S5_RETENTION_ENVIRONMENT_MISSING');
  });
  for (const name of ['redis', 'files']) {
    await phase(`create:${name}`, async () => {
      if (!state[name]) {
        const created = await command(
          `create:${name}`,
          '/services',
          'POST',
          {
            environmentId: state.environmentId,
            name: `Retention ${name}`,
            slug: name,
            template: {
              id: name === 'redis' ? 'redis' : 'docker',
              version: '1.0.0',
              parameters:
                name === 'redis'
                  ? {}
                  : { image: templateImages['node-example'].deployReference, port: 8080 },
            },
          },
          201,
        );
        state[name] = { serviceId: created.id };
        await save();
      }
      let current = await data(`/services/${state[name].serviceId}`);
      if (name === 'redis') {
        const database = await data(`/databases/${current.databaseInstanceId}`);
        Object.assign(state[name], {
          volumeId: database.dataVolume.id,
          databaseId: database.id,
          credentialRefId: database.credential.refId,
        });
      } else {
        if (!state.files.volumeId) {
          const created = await command('create:files-volume', '/volumes', 'POST', {
            environmentId: state.environmentId,
            name: '可销毁的验证文件',
            slug: 'retention-files',
            storageClassName: 'local-path',
            requestedBytes: '1073741824',
          });
          state.files.volumeId = created.volumeId;
          await save();
          await waitTask('operations', created.operation);
        }
        const volume = await data(`/volumes/${state.files.volumeId}`);
        const mounts = await data(`/services/${current.id}/volume-mounts`);
        if (!mounts.some((item) => item.volumeId === volume.id && item.desired))
          await request(`/services/${current.id}/volume-mounts`, 'POST', {
            revision: current.revision,
            volumeId: volume.id,
            volumeRevision: volume.revision,
            mountPath: '/data',
            readOnly: false,
          });
        current = await data(`/services/${current.id}`);
        const program = `require('node:fs').writeFileSync('/data/ozz-retention-marker',${JSON.stringify(state.runId)});require('node:http').createServer((req,res)=>res.end('retention test')).listen(8080,'0.0.0.0')`;
        if (current.configuration.args[1] !== program)
          await request(`/services/${current.id}`, 'PATCH', {
            revision: current.revision,
            configuration: {
              ...current.configuration,
              command: ['node'],
              args: ['-e', program],
              resources: {
                requests: { cpuMillis: 25, memoryMiB: 32 },
                limits: { cpuMillis: 250, memoryMiB: 128 },
              },
            },
          });
      }
      await save();
    });
    await phase(`publish:${name}`, async () => {
      const current = await data(`/services/${state[name].serviceId}`);
      const task = await command(`publish:${name}`, `/services/${current.id}/deployments`, 'POST', {
        revision: current.revision,
      });
      await waitTask('deployments', task);
      await until(
        () => data(`/services/${current.id}`),
        (item) => item.runtimeState === 'running',
      );
      const volume = await until(
        () => data(`/volumes/${state[name].volumeId}`),
        (item) =>
          item.pvc.uid &&
          item.pv.uid &&
          item.observation?.state === 'ready' &&
          !item.observation.stale,
      );
      Object.assign(state[name], { pvcUid: volume.pvc.uid, pvUid: volume.pv.uid });
      await save();
      const preview = await previewVolume(volume.id);
      const rejected = await request(
        `/volumes/${volume.id}`,
        'DELETE',
        { revision: preview.revision, confirmation: confirmation(preview) },
        randomUUID(),
        409,
      );
      await check(
        `${name}: destroying a mounted volume is rejected`,
        preview.blockers.length > 0 && Boolean(rejected.value.code),
        { code: rejected.value.code, volumeId: volume.id },
      );
    });
  }
  await phase('database-data-is-not-a-generic-mount', async () => {
    const current = await data(`/services/${state.files.serviceId}`);
    const volume = await data(`/volumes/${state.redis.volumeId}`);
    const rejected = await request(
      `/services/${current.id}/volume-mounts`,
      'POST',
      {
        revision: current.revision,
        volumeId: volume.id,
        volumeRevision: volume.revision,
        mountPath: '/borrowed-database',
        readOnly: false,
      },
      undefined,
      409,
    );
    await check(
      'another application cannot repurpose a protected database volume',
      rejected.value.code === 'VOLUME_DATABASE_PROTECTED',
      { code: rejected.value.code },
    );
  });
  for (const name of ['redis', 'files']) {
    await phase(`stop:${name}`, () => serviceAction(name, 'stop'));
    await phase(`deletion-preview:${name}`, async () => {
      const current = await data(`/services/${state[name].serviceId}`);
      const preview = (
        await request(`/services/${current.id}/deletion-preview`, 'POST', {
          revision: current.revision,
        })
      ).value.data;
      await check(
        `${name}: service deletion preview explicitly retains the original data volume`,
        preview.retainedVolumes.some(
          (item) => item.id === state[name].volumeId && item.pvcUid === state[name].pvcUid,
        ) && preview.blockers.length === 0,
      );
    });
    await phase(`delete:${name}`, () => serviceAction(name, 'delete'));
    await phase(`retained:${name}`, async () => {
      await request(`/services/${state[name].serviceId}`, 'GET', undefined, undefined, 404);
      const retained = await until(
        () => data(`/volumes/${state[name].volumeId}`),
        (item) => item.retained && item.mounts.actual.length === 0 && !item.observation?.stale,
      );
      await check(
        `${name}: deleting the service retains the original PVC and PV`,
        retained.pvc.uid === state[name].pvcUid &&
          retained.pv.uid === state[name].pvUid &&
          !retained.destroyedAt,
        { volumeId: retained.id, pvcUid: retained.pvc.uid, pvUid: retained.pv.uid },
      );
    });
  }
  await phase('orphaned-database-identity', async () => {
    const database = await data(`/databases/${state.redis.databaseId}`);
    const credential = await data(`/secrets/${state.redis.credentialRefId}`);
    const rejected = await request(
      `/secrets/${credential.id}?revision=${credential.revision}`,
      'DELETE',
      undefined,
      undefined,
      409,
    );
    await check(
      'retained database keeps its original identity and protected credential after service deletion',
      database.service === null &&
        database.originalService.id === state.redis.serviceId &&
        database.protection.active &&
        !database.databaseReady &&
        Boolean(rejected.value.code),
      { databaseId: database.id, credentialDeletionCode: rejected.value.code },
    );
  });
  await phase('retained-file-is-readable', async () => {
    const volume = await data(`/volumes/${state.files.volumeId}`);
    await check(
      'the original file content remains readable after service deletion',
      (await verifyRetainedFile(volume)).verified,
    );
  });
  await phase('independent-volume-destruction', async () => {
    let body = state.commands['destroy:files-volume']?.body;
    if (!body) {
      const preview = await previewVolume(state.files.volumeId);
      requireValue(
        preview.blockers.length === 0 &&
          preview.reclaimPolicy === 'Delete' &&
          preview.pvcUid === state.files.pvcUid,
        'S5_RETENTION_DESTROY_PREVIEW_BLOCKED',
      );
      body = { revision: preview.revision, confirmation: confirmation(preview) };
    }
    const task = await command(
      'destroy:files-volume',
      `/volumes/${state.files.volumeId}`,
      'DELETE',
      body,
    );
    await waitTask('operations', task);
    const destroyed = await data(`/volumes/${state.files.volumeId}`);
    const databaseVolume = await data(`/volumes/${state.redis.volumeId}`);
    await check(
      'separate confirmed destruction records a tombstone while unrelated retained data survive',
      destroyed.desiredState === 'destroyed' &&
        Boolean(destroyed.destroyedAt) &&
        databaseVolume.pvc.uid === state.redis.pvcUid &&
        !databaseVolume.destroyedAt,
      { destroyedVolumeId: destroyed.id, retainedDatabaseVolumeId: databaseVolume.id },
    );
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    code: error.code ?? error.message,
    httpStatus: error.status ?? null,
    taskId: error.taskId ?? null,
  };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.resources = {
    projectId: state.projectId,
    environmentId: state.environmentId,
    redis: state.redis,
    files: state.files,
  };
  if (lock) {
    await save();
    await lock.close();
    await unlink(`${stateFile}.lock`);
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (report.status === 'failed') {
    await mkdir(resolve(lab, 's5-retention-attempts'), { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(lab, `s5-retention-attempts/${Date.now()}.json`),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}
