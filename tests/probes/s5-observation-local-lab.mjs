import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { PrismaClient } from '../../packages/database/dist/index.js';
import { parseKubeconfig } from '../../packages/infrastructure/dist/kubernetes.js';
import {
  createInspectionClient,
  transportLimits,
} from '../../packages/infrastructure/dist/kubernetes/transport.js';

// Explicit local fault probe. It never creates/deletes resources, changes desired
// state, writes database markers, restarts a VM, or signals networking/Pebble units.
// The durable injection intent is single use, including an ambiguous SSH failure.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const owner = 'ozz-s5-observation-probe-v1';
const stateFile = resolve(lab, 's5-observation-probe-state.json');
const reportFile = resolve(root, 'docs/acceptance/s5-observation-local-results.json');
const ownLockFile = `${stateFile}.lock`;
const parentLockFile = resolve(lab, 'storage-product-state.json.lock');
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const abort = new globalThis.AbortController();
const terminal = ['succeeded', 'failed', 'cancelled'];
const maxBodyBytes = 256 * 1024;
let state, report, parent, fixture, registered, db, api, origin, cookie;
let stage = 'arguments';
let recovering = false;
let ownLock, parentLock;
let writeEvidence = false;

process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());

function requireValue(value, code) {
  if (!value) throw new Error(`S5_OBSERVATION_${code}`);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const same = (a, b) => hash(a) === hash(b);
const timestamp = () => new Date().toISOString();
const uuid = (value) => typeof value === 'string' && uuidPattern.test(value);
function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,99}$/u.test(value) ? value : null;
}
function safeFailure(error) {
  return {
    stage,
    code: /^S5_OBSERVATION_[A-Z0-9_]+$/u.test(error?.message ?? '')
      ? error.message
      : 'S5_OBSERVATION_FAILED',
    problemCode: safeCode(error?.code),
    status: Number.isInteger(error?.status) ? error.status : null,
  };
}
async function readJson(path) {
  const contents = await readFile(path, 'utf8');
  requireValue(Buffer.byteLength(contents) <= 2 * 1024 * 1024, 'LOCAL_STATE_TOO_LARGE');
  return JSON.parse(contents);
}
async function atomicJson(path, value, mode) {
  const pending = `${path}.${randomUUID()}.pending`;
  const file = await open(pending, 'wx', mode);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(pending, path);
  await chmod(path, mode);
}
async function checkpoint() {
  state.report = report;
  await atomicJson(stateFile, state, 0o600);
  await atomicJson(reportFile, report, 0o644);
}
async function check(name, passed, details = {}) {
  report.checks.push({ name, passed: Boolean(passed), observedAt: timestamp(), ...details });
  await checkpoint();
  console.log(JSON.stringify({ check: name, passed: Boolean(passed) }));
  requireValue(passed, 'ASSERTION_FAILED');
}
function boundedSignal(milliseconds) {
  const deadline = globalThis.AbortSignal.timeout(Math.max(1, Math.min(milliseconds, 15_000)));
  return recovering ? deadline : globalThis.AbortSignal.any([abort.signal, deadline]);
}
async function request(path, { method = 'GET', body, timeout = 4_000 } = {}) {
  const response = await fetch(api + path, {
    method,
    redirect: 'error',
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: boundedSignal(timeout),
  });
  const declared = response.headers.get('content-length');
  requireValue(!declared || Number(declared) <= maxBodyBytes, 'API_RESPONSE_TOO_LARGE');
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        requireValue(bytes <= maxBodyBytes, 'API_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(item.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const value = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  if (!response.ok) {
    const error = new Error('S5_OBSERVATION_API_FAILED');
    error.code = safeCode(value?.code);
    error.status = response.status;
    throw error;
  }
  return { data: value?.data, response };
}
const data = async (path, timeout) => (await request(path, { timeout })).data;
async function login() {
  const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
  const result = await request('/auth/login', {
    method: 'POST',
    body: { username: 'admin', password },
    timeout: 10_000,
  });
  cookie = result.response.headers
    .getSetCookie()
    .find((item) => item.startsWith('ozz_session='))
    ?.split(';')[0];
  requireValue(cookie, 'LOGIN_FAILED');
}
async function until(read, accept, timeout, label) {
  const deadline = Date.now() + timeout;
  let nextProgress = 0;
  while (Date.now() < deadline) {
    if (!recovering) abort.signal.throwIfAborted();
    const value = await read(Math.max(1, deadline - Date.now()));
    if (accept(value)) return value;
    if (Date.now() >= nextProgress) {
      console.log(JSON.stringify({ stage, waiting: label }));
      nextProgress = Date.now() + 15_000;
    }
    await delay(
      Math.min(1_000, Math.max(1, deadline - Date.now())),
      undefined,
      recovering ? {} : { signal: abort.signal },
    );
  }
  throw new Error('S5_OBSERVATION_WAIT_TIMEOUT');
}
async function idleTasks() {
  const counts = await db.$transaction(
    async (tx) => {
      const [operations, deployments, a, b] = await Promise.all([
        tx.operation.count({ where: { status: { notIn: terminal } } }),
        tx.deployment.count({ where: { status: { notIn: terminal } } }),
        tx.service.findUnique({
          where: { id: state.targets.a.serviceId },
          select: {
            id: true,
            environmentId: true,
            publishedDeploymentId: true,
          },
        }),
        tx.service.findUnique({
          where: { id: state.targets.b.serviceId },
          select: {
            id: true,
            environmentId: true,
            publishedDeploymentId: true,
          },
        }),
      ]);
      return { operations, deployments, a, b };
    },
    { maxWait: 1_000, timeout: 5_000 },
  );
  for (const guest of ['a', 'b'])
    requireValue(
      counts[guest]?.environmentId === state.targets[guest].environmentId &&
        counts[guest]?.publishedDeploymentId === state.targets[guest].deploymentId,
      'API_AND_TASK_DATABASE_DIFFER',
    );
  requireValue(counts.operations === 0 && counts.deployments === 0, 'NONTERMINAL_TASKS_PRESENT');
  return {
    observedAt: timestamp(),
    operations: counts.operations,
    deployments: counts.deployments,
  };
}
function sorted(items, key) {
  requireValue(Array.isArray(items) && items.length <= 100, 'OBSERVATION_COLLECTION_INVALID');
  return items.toSorted((a, b) => String(a[key]).localeCompare(String(b[key])));
}
function controller(value) {
  if (!value) return null;
  return {
    kind: value.kind,
    name: value.name,
    uid: value.uid,
    snapshotId: value.snapshotId,
    configRevision: value.configRevision,
    replicas: value.replicas,
  };
}
function serviceSample(value) {
  return {
    id: value.id,
    clusterId: value.clusterId,
    environmentId: value.environmentId,
    desiredState: value.desiredState,
    runtimeState: value.runtimeState,
    stale: value.observationStale,
    observedAt: value.lastObservedAt,
    lastErrorCode: safeCode(value.lastErrorCode),
    deploymentId: value.published?.deploymentId ?? null,
    controller: controller(value.observation?.controller ?? value.observation?.deployment),
    pods: sorted(value.observation?.pods ?? [], 'uid').map((pod) => ({
      uid: pod.uid,
      name: pod.name,
      namespace: pod.namespace,
      nodeName: pod.nodeName,
      phase: pod.phase,
      ready: pod.ready,
      deleting: Boolean(pod.deletionTimestamp),
      owner: controller(pod.owner),
    })),
  };
}
function volumeRetention(value) {
  return {
    id: value.id,
    namespace: value.namespace,
    desiredState: value.desiredState,
    retained: value.retained,
    destroyedAt: value.destroyedAt,
    locality: value.locality,
    pvc: {
      name: value.pvc.name,
      uid: value.pvc.uid,
      resourceVersion: value.pvc.resourceVersion,
      phase: value.pvc.phase,
      deleting: value.pvc.deleting,
    },
    pv: value.pv
      ? {
          name: value.pv.name,
          uid: value.pv.uid,
          claimUid: value.pv.claimUid,
          capacityBytes: value.pv.capacityBytes,
          reclaimPolicy: value.pv.reclaimPolicy,
          storageClassName: value.pv.storageClassName,
          provisioner: value.pv.provisioner,
          nodeAffinitySha256: hash(value.pv.nodeAffinity),
        }
      : null,
    nodes: sorted(value.nodes, 'uid').map(({ name, uid, ready }) => ({ name, uid, ready })),
    dataState: value.observation.state,
    mounts: sorted(value.mounts.actual, 'podUid').map((mount) => ({
      podUid: mount.podUid,
      namespace: mount.namespace,
      nodeName: mount.nodeName,
      phase: mount.phase,
      deleting: mount.deleting,
      serviceId: mount.serviceId,
      controller: controller(mount.controller),
    })),
    manualDataIdentity: value.manualDataIdentity
      ? {
          installationId: value.manualDataIdentity.installationId,
          clusterId: value.manualDataIdentity.clusterId,
          kubeSystemUid: value.manualDataIdentity.kubeSystemUid,
          environmentId: value.manualDataIdentity.environmentId,
          volumeId: value.manualDataIdentity.volumeId,
          pvcUid: value.manualDataIdentity.pvcUid,
        }
      : null,
    retainedDatabase: value.retainedDatabase
      ? {
          id: value.retainedDatabase.id,
          serviceId: value.retainedDatabase.serviceId,
          engine: value.retainedDatabase.engine,
          majorVersion: value.retainedDatabase.majorVersion,
          initializedAt: value.retainedDatabase.initializedAt,
          initializationFenceAt: value.retainedDatabase.initializationFenceAt,
        }
      : null,
  };
}
function databaseRetention(value) {
  if (!value) return null;
  return {
    id: value.id,
    engine: value.engine,
    majorVersion: value.majorVersion,
    serviceId: value.service?.id ?? null,
    originalServiceId: value.originalService.id,
    clusterId: value.clusterId,
    environmentId: value.environmentId,
    dataVolume: {
      id: value.dataVolume.id,
      namespace: value.dataVolume.namespace,
      pvcName: value.dataVolume.pvcName,
      pvcUid: value.dataVolume.pvcUid,
      destroyedAt: value.dataVolume.destroyedAt,
    },
    protection: {
      active: value.protection.active,
      revision: value.protection.revision,
      fencedAt: value.protection.fencedAt,
    },
    initialization: {
      state: value.initialization.state,
      initializedAt: value.initialization.initializedAt,
      pvcUid: value.initialization.pvcUid,
    },
    credential: {
      refId: value.credential.refId,
      contentRevision: value.credential.contentRevision,
    },
    dataObservation: value.observation
      ? {
          state: value.observation.state,
          authenticated: value.observation.authenticated,
          engineVersion: value.observation.engineVersion,
          persistence: value.observation.persistence,
          podUid: value.observation.podUid,
          pvcUid: value.observation.pvcUid,
        }
      : null,
  };
}
function sample(bundle) {
  return {
    service: serviceSample(bundle.service),
    volume: {
      ...volumeRetention(bundle.volume),
      stale: bundle.volume.observation.stale,
      observedAt: bundle.volume.observation.observedAt,
      lastAttemptAt: bundle.volume.lastAttemptAt,
      lastErrorCode: safeCode(bundle.volume.lastErrorCode),
      observationCode: safeCode(bundle.volume.observation.code),
    },
    database: bundle.database
      ? {
          ...databaseRetention(bundle.database),
          stale: bundle.database.observationStale,
          ready: bundle.database.databaseReady,
          observedAt: bundle.database.observation?.observedAt ?? null,
        }
      : null,
  };
}
async function bundle(guest, timeout = 4_000) {
  const target = state.targets[guest];
  const [service, volume, database] = await Promise.all([
    data(`/services/${target.serviceId}`, timeout),
    data(`/volumes/${target.volumeId}`, timeout),
    target.databaseId ? data(`/databases/${target.databaseId}`, timeout) : Promise.resolve(null),
  ]);
  requireValue(
    service.id === target.serviceId &&
      service.clusterId === registered.clusters[guest] &&
      volume.id === target.volumeId &&
      volume.cluster?.id === service.clusterId &&
      volume.environment?.id === service.environmentId &&
      service.environmentId === target.environmentId &&
      volume.mounts.published.some((mount) => mount.serviceId === service.id) &&
      service.published?.deploymentId === target.deploymentId,
    'RESOURCE_TARGET_CHANGED',
  );
  requireValue(
    !service.activeTask &&
      !volume.activeTask &&
      (!volume.maintenance || volume.maintenance.state === 'closed'),
    'RESOURCE_NOT_IDLE',
  );
  if (database)
    requireValue(
      service.databaseInstanceId === database.id &&
        database.service?.id === service.id &&
        database.dataVolume.id === volume.id &&
        database.dataVolume.pvcUid === volume.pvc.uid,
      'DATABASE_VOLUME_TARGET_CHANGED',
    );
  return { service, volume, database };
}
function fresh(value) {
  return (
    !value.service.observationStale &&
    value.service.desiredState === 'running' &&
    value.service.runtimeState === 'running' &&
    !value.volume.observation.stale &&
    value.volume.observation.state === 'ready' &&
    value.volume.pvc.phase === 'Bound' &&
    !value.volume.pvc.deleting &&
    !value.volume.destroyedAt &&
    value.volume.pv &&
    value.volume.nodes.length > 0 &&
    value.volume.nodes.every((node) => node.ready === true) &&
    (!value.database || (!value.database.observationStale && value.database.databaseReady))
  );
}
function recent(value) {
  const times = [
    value.service.lastObservedAt,
    value.volume.observation.observedAt,
    ...(value.database ? [value.database.observation?.observedAt] : []),
  ];
  return (
    fresh(value) &&
    times.every(
      (time) =>
        Number.isFinite(Date.parse(time)) &&
        Date.now() - Date.parse(time) >= -2_000 &&
        Date.now() - Date.parse(time) < 20_000,
    )
  );
}
async function withCluster(guest, volume) {
  const expectedEndpoint = `https://127.0.0.1:${guest === 'a' ? 16443 : 26443}`;
  const registeredCluster = await data(`/clusters/${registered.clusters[guest]}`);
  requireValue(
    [expectedEndpoint, expectedEndpoint + '/'].includes(registeredCluster.apiEndpoint) &&
      registeredCluster.identity?.kubeSystemUid === fixture.identities[guest].kubeSystemUid,
    'REGISTERED_CLUSTER_ENDPOINT_CHANGED',
  );
  const connection = parseKubeconfig(
    await readFile(resolve(lab, `credentials/${guest}.kubeconfig.json`), 'utf8'),
  );
  requireValue(connection.endpoint === expectedEndpoint, 'KUBERNETES_ENDPOINT_CHANGED');
  const client = await createInspectionClient(
    connection,
    transportLimits({ requestTimeoutMs: 6_000 }),
    boundedSignal(15_000),
  );
  try {
    const [system, nodes, pvc, pv] = await Promise.all([
      client.core.readNamespace({ name: 'kube-system' }),
      client.core.listNode({ limit: 10 }),
      client.core.readNamespacedPersistentVolumeClaim({
        namespace: volume.namespace,
        name: volume.pvc.name,
      }),
      client.core.readPersistentVolume({ name: volume.pv.name }),
    ]);
    requireValue(
      system.metadata?.uid === fixture.identities[guest].kubeSystemUid &&
        !nodes.metadata?._continue &&
        nodes.items.length === 1 &&
        nodes.items[0].metadata?.uid === fixture.identities[guest].nodes[0].uid,
      'CLUSTER_OR_NODE_IDENTITY_CHANGED',
    );
    requireValue(
      pvc.metadata?.uid === volume.pvc.uid &&
        pv.metadata?.uid === volume.pv.uid &&
        pvc.spec?.volumeName === pv.metadata.name &&
        pv.spec?.claimRef?.uid === pvc.metadata.uid &&
        !pvc.metadata.deletionTimestamp &&
        !pv.metadata.deletionTimestamp,
      'PVC_OR_PV_IDENTITY_CHANGED',
    );
    return {
      kubeSystemUid: system.metadata.uid,
      nodeUid: nodes.items[0].metadata.uid,
      pvcUid: pvc.metadata.uid,
      pvUid: pv.metadata.uid,
    };
  } finally {
    client.close();
  }
}

// Remote sources below are fixed programs. stdin contains resource identities,
// never passwords, kubeconfig, arbitrary commands, or arbitrary signal numbers.
const processSource = String.raw`
import hashlib, json, os, re, select, signal, stat, subprocess, sys, time
from pathlib import Path
v=json.load(sys.stdin)
assert v['guest'] in ['a','b']
assert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-'+v['guest']
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def trusted_executable():
 current=Path('/var/lib/rancher/k3s/data/current')
 assert current.lstat().st_uid==0
 path=(current/'bin/k3s').resolve(strict=True)
 assert re.fullmatch(r'/var/lib/rancher/k3s/data/[a-f0-9]{64}/bin/k3s',str(path))
 info=path.stat()
 assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o755
 for directory in [current.parent,path.parent.parent,path.parent]:
  info=directory.stat()
  assert stat.S_ISDIR(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)&0o022==0
 return str(path)
expected_exe=trusted_executable()
def fields(pid): return Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
def ticks(pid): return fields(pid)[19]
def command(pid): return Path('/proc/'+str(pid)+'/cmdline').read_bytes()
def command_hash(pid): return hashlib.sha256(command(pid)).hexdigest()
def server_command(raw):
 return raw.split(b'\0') in [[b'/usr/local/bin/k3s server',b''],[b'/usr/local/bin/k3s',b'server',b'']]
def main(unit): return int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],timeout=2).strip())
def server(pid):
 try:
  return os.readlink('/proc/'+str(pid)+'/exe')==expected_exe and server_command(command(pid))
 except (OSError,IndexError): return False
def unique():
 pid=main('k3s.service')
 candidates=sorted(int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit() and server(int(p.name)))
 assert pid>1 and candidates==[pid]
 return pid
def original():
 pid=int(v['pid'])
 assert v['bootId']==Path('/proc/sys/kernel/random/boot_id').read_text().strip()
 assert pid==unique() and ticks(pid)==v['startTicks']
 assert v['executable']==trusted_executable()==expected_exe
 assert command_hash(pid)==v['cmdlineSha256']
 return pid
if v['action']=='inspect':
 system=json.loads(subprocess.check_output(['k3s','kubectl','get','namespace','kube-system','-o','json','--request-timeout=4s'],stderr=subprocess.DEVNULL,timeout=6))
 assert system['metadata']['uid']==v['kubeSystemUid']
 pid=unique(); assert fields(pid)[0] not in ['T','t']
 units={}
 for kind in ['dns','staging','production']:
  other=main('ozz-local-networking-'+v['guest']+'-'+kind)
  assert other>1
  units[kind]={'pid':other,'startTicks':ticks(other)}
 paths=['/etc/resolv.conf','/etc/rancher/k3s/config.yaml','/var/lib/rancher/k3s/server/manifests/traefik.yaml','/etc/ssl/certs/ca-certificates.crt']
 hashes={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).exists() else None for p in paths}
 print(json.dumps({'pid':pid,'startTicks':ticks(pid),'bootId':boot,'executable':expected_exe,'cmdlineSha256':command_hash(pid),'fixtureProcesses':units,'configurationHashes':hashes}));sys.exit(0)
assert v['guest']=='a'
pid=original()
if v['action']=='status':
 print(json.dumps({'pid':pid,'startTicks':ticks(pid),'paused':fields(pid)[0] in ['T','t']}));sys.exit(0)
if v['action']=='resume':
 os.kill(pid,signal.SIGCONT)
 deadline=time.monotonic()+1
 while fields(pid)[0] in ['T','t'] and time.monotonic()<deadline: time.sleep(0.01)
 assert fields(pid)[0] not in ['T','t'] and original()==pid
 guard=v.get('watchdog')
 cancelled=False
 if guard:
  gpid=int(guard['pid'])
  p=Path('/proc/'+str(gpid)+'/stat')
  if p.exists() and ticks(gpid)==guard['startTicks']:
   guard_command=Path('/proc/'+str(gpid)+'/cmdline').read_bytes().split(b'\0')
   assert len(guard_command)==11 and guard_command[-1]==b'' and guard_command[1]==b'-c'
   assert b'ozz-s5-observation-api-watchdog-v1' in guard_command[2]
   assert guard_command[3]==v['runId'].encode()
   os.kill(gpid,signal.SIGTERM);cancelled=True
 print(json.dumps({'pid':pid,'startTicks':ticks(pid),'resumed':True,'paused':False,'watchdogCancelled':cancelled,'resumedAt':time.time()}));sys.exit(0)
assert v['action']=='pause' and v['owner']=='ozz-s5-observation-probe-v1'
assert fields(pid)[0] not in ['T','t']
assert len(v['runId'])==36 and all(c in '0123456789abcdef-' for c in v['runId'])
watchdog_program=r'''
# ozz-s5-observation-api-watchdog-v1
import hashlib,os,re,signal,stat,subprocess,sys,time
from pathlib import Path
run,pid,start,boot,executable,cmdline_sha256,ready=sys.argv[1:]
pid=int(pid);ready=int(ready)
assert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-a'
def trusted_executable():
 current=Path('/var/lib/rancher/k3s/data/current')
 assert current.lstat().st_uid==0
 path=(current/'bin/k3s').resolve(strict=True)
 assert re.fullmatch(r'/var/lib/rancher/k3s/data/[a-f0-9]{64}/bin/k3s',str(path))
 info=path.stat()
 assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o755
 for directory in [current.parent,path.parent.parent,path.parent]:
  info=directory.stat()
  assert stat.S_ISDIR(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)&0o022==0
 return str(path)
expected_exe=trusted_executable()
def fields(process): return Path('/proc/'+str(process)+'/stat').read_text().rsplit(')',1)[1].split()
def command(process): return Path('/proc/'+str(process)+'/cmdline').read_bytes()
def server_command(raw):
 return raw.split(b'\0') in [[b'/usr/local/bin/k3s server',b''],[b'/usr/local/bin/k3s',b'server',b'']]
def server(process):
 try:
  return os.readlink('/proc/'+str(process)+'/exe')==expected_exe and server_command(command(process))
 except (OSError,IndexError): return False
def original():
 assert Path('/proc/sys/kernel/random/boot_id').read_text().strip()==boot
 main=int(subprocess.check_output(['systemctl','show','k3s.service','-p','MainPID','--value'],timeout=2).strip())
 candidates=sorted(int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit() and server(int(p.name)))
 assert pid>1 and pid==main and candidates==[pid] and fields(pid)[19]==start
 assert executable==trusted_executable()==expected_exe
 assert hashlib.sha256(command(pid)).hexdigest()==cmdline_sha256
original()
os.write(ready,b'R');os.close(ready)
time.sleep(55)
try:
 original()
 os.kill(pid,signal.SIGCONT)
except (OSError,AssertionError,IndexError,ValueError,subprocess.SubprocessError): pass
'''
read_fd,write_fd=os.pipe()
guard=subprocess.Popen([sys.executable,'-c',watchdog_program,v['runId'],str(pid),v['startTicks'],boot,expected_exe,v['cmdlineSha256'],str(write_fd)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,pass_fds=(write_fd,),close_fds=True,start_new_session=True)
os.close(write_fd)
try:
 assert select.select([read_fd],[],[],3)[0] and os.read(read_fd,1)==b'R'
finally: os.close(read_fd)
assert original()==pid
watchdog={'pid':guard.pid,'startTicks':ticks(guard.pid),'seconds':55,'readyHandshake':True}
os.kill(pid,signal.SIGSTOP)
deadline=time.monotonic()+1
while fields(pid)[0] not in ['T','t'] and time.monotonic()<deadline: time.sleep(0.01)
assert fields(pid)[0] in ['T','t']
print(json.dumps({'pid':pid,'startTicks':ticks(pid),'paused':True,'watchdog':watchdog,'startedAt':time.time()}))
`;

const dataSource = String.raw`
import json,subprocess,sys
from pathlib import Path
v=json.load(sys.stdin)
assert v['guest']=='a' and v['kind'] in ['postgresql','redis']
assert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-a'
assert len(v['marker'])==36 and all(c in '0123456789abcdef-' for c in v['marker'])
def kube(args):
 result=subprocess.run(['k3s','kubectl','--request-timeout=5s']+args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8)
 assert result.returncode==0 and len(result.stdout)<=1024*1024
 return result.stdout
system=json.loads(kube(['get','namespace','kube-system','-o','json']))
assert system['metadata']['uid']==v['kubeSystemUid']
pvc=json.loads(kube(['-n',v['namespace'],'get','pvc',v['pvcName'],'-o','json']))
assert pvc['metadata']['uid']==v['pvcUid']
pod=json.loads(kube(['-n',v['namespace'],'get','pod',v['podName'],'-o','json']))
assert pod['metadata']['uid']==v['podUid']
assert any(o.get('controller') and o['uid']==v['podOwner']['uid'] and o['kind']==v['podOwner']['kind'] for o in pod['metadata'].get('ownerReferences',[]))
assert any(volume.get('persistentVolumeClaim',{}).get('claimName')==v['pvcName'] for volume in pod['spec'].get('volumes',[]))
if v['kind']=='postgresql':
 command=['sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=3000" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "SELECT value FROM ozz_s5_probe WHERE id=\'persistent\';"']
else:
 command=['sh','-c','REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning -h 127.0.0.1 GET ozz:s5:persistent']
value=kube(['-n',v['namespace'],'exec',v['podName'],'-c','app','--']+command).decode().strip()
after=json.loads(kube(['-n',v['namespace'],'get','pod',v['podName'],'-o','json']))
assert after['metadata']['uid']==v['podUid']
print(json.dumps({'markerVerified':value==v['marker'],'podUid':v['podUid'],'pvcUid':v['pvcUid'],'readOnly':True}))
`;

async function remote(guest, source, payload, timeout = 20_000) {
  requireValue(['a', 'b'].includes(guest), 'SSH_GUEST_INVALID');
  const quoted = `'${source.replaceAll("'", "'\\''")}'`;
  try {
    const stdout = await new Promise((accept, reject) => {
      const child = execFile(
        'ssh',
        [
          '-F',
          resolve(lab, 'credentials/ssh_config'),
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'ConnectTimeout=4',
          '-o',
          'ConnectionAttempts=1',
          '-o',
          'ServerAliveInterval=2',
          '-o',
          'ServerAliveCountMax=2',
          `ozz-lab-${guest}`,
          `sudo python3 -c ${quoted}`,
        ],
        { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 },
        (error, output) => (error ? reject(error) : accept(output)),
      );
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify({ ...payload, guest }));
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error('S5_OBSERVATION_REMOTE_FAILED');
  }
}
async function processes(guest) {
  return remote(guest, processSource, {
    action: 'inspect',
    kubeSystemUid: fixture.identities[guest].kubeSystemUid,
  });
}
async function readMarker(value) {
  const pods = value.service.observation?.pods.filter((pod) => pod.ready && !pod.deletionTimestamp);
  requireValue(pods?.length === 1 && pods[0].owner, 'DATA_POD_NOT_UNIQUE');
  return remote(
    'a',
    dataSource,
    {
      kind: state.targets.a.engine,
      marker: state.parentRunId,
      kubeSystemUid: fixture.identities.a.kubeSystemUid,
      namespace: value.volume.namespace,
      pvcName: value.volume.pvc.name,
      pvcUid: value.volume.pvc.uid,
      podName: pods[0].name,
      podUid: pods[0].uid,
      podOwner: { kind: pods[0].owner.kind, uid: pods[0].owner.uid },
    },
    45_000,
  );
}
async function resumeApi() {
  if (!state?.injection || state.injection.phase === 'resumed') return;
  const result = await remote(
    'a',
    processSource,
    {
      action: 'resume',
      runId: state.runId,
      ...state.injection.process,
      ...(state.injection.watchdog ? { watchdog: state.injection.watchdog } : {}),
    },
    15_000,
  );
  requireValue(result.resumed && !result.paused, 'API_RESUME_UNCONFIRMED');
  state.injection.phase = 'resumed';
  state.injection.resumedAt = timestamp();
  report.resume = result;
  await checkpoint();
}

async function resolveTargets(engine, bServiceId, bVolumeId) {
  requireValue(
    parent.version === 1 &&
      uuid(parent.runId) &&
      uuid(parent.services?.[engine]) &&
      uuid(parent.volumes?.[engine]) &&
      uuid(bServiceId) &&
      uuid(bVolumeId),
    'TARGET_ARGUMENTS_REQUIRED',
  );
  const targets = {};
  for (const guest of ['a', 'b']) {
    const serviceId = guest === 'a' ? parent.services[engine] : bServiceId;
    const volumeId = guest === 'a' ? parent.volumes[engine] : bVolumeId;
    const service = await data(`/services/${serviceId}`);
    requireValue(
      service.id === serviceId &&
        service.clusterId === registered.clusters[guest] &&
        uuid(service.environmentId) &&
        uuid(service.published?.deploymentId),
      'SERVICE_TARGET_INVALID',
    );
    if (guest === 'a')
      requireValue(
        service.projectId === parent.projects.a &&
          service.environmentId === parent.environments.a &&
          uuid(service.databaseInstanceId),
        'PRIMARY_DATABASE_TARGET_INVALID',
      );
    const cluster = await data(`/clusters/${service.clusterId}`);
    const expectedEndpoint = `https://127.0.0.1:${guest === 'a' ? 16443 : 26443}`;
    requireValue(
      cluster.identity?.kubeSystemUid === fixture.identities[guest].kubeSystemUid &&
        [expectedEndpoint, expectedEndpoint + '/'].includes(cluster.apiEndpoint),
      'REGISTERED_CLUSTER_IDENTITY_CHANGED',
    );
    targets[guest] = {
      serviceId,
      volumeId,
      clusterId: service.clusterId,
      environmentId: service.environmentId,
      projectId: service.projectId,
      deploymentId: service.published.deploymentId,
      databaseId: service.databaseInstanceId ?? null,
      apiEndpoint: expectedEndpoint,
      ...(guest === 'a' ? { engine } : {}),
    };
  }
  requireValue(
    targets.a.clusterId !== targets.b.clusterId &&
      targets.a.serviceId !== targets.b.serviceId &&
      targets.a.volumeId !== targets.b.volumeId,
    'INDEPENDENT_TARGETS_REQUIRED',
  );
  return targets;
}
async function pairs(timeout = 4_000) {
  const [a, b] = await Promise.all([bundle('a', timeout), bundle('b', timeout)]);
  return { a, b };
}
function identity(value) {
  return {
    serviceId: value.service.id,
    deploymentId: value.service.deploymentId,
    controllerUid: value.service.controller?.uid,
    podUids: value.service.pods.map((pod) => pod.uid),
    volumeId: value.volume.id,
    pvcUid: value.volume.pvc.uid,
    pvUid: value.volume.pv?.uid,
    nodeUids: value.volume.nodes.map((node) => node.uid),
    manualDataIdentity: value.volume.manualDataIdentity,
    database: value.database
      ? {
          id: value.database.id,
          dataVolume: value.database.dataVolume,
          protection: value.database.protection,
          initialization: value.database.initialization,
          credential: value.database.credential,
        }
      : null,
  };
}
async function recoverObservations() {
  stage = 'fresh-observations-after-resume';
  requireValue(
    state.baseline && state.beforeProcesses && state.injection?.phase === 'resumed',
    'RECOVERY_CHECKPOINT_MISSING',
  );
  const recoveredAfter = Date.parse(state.injection.resumedAt);
  const current = await until(
    () => pairs(),
    (values) =>
      fresh(values.a) &&
      fresh(values.b) &&
      Date.parse(values.a.service.lastObservedAt) > recoveredAfter &&
      Date.parse(values.a.volume.observation.observedAt) > recoveredAfter &&
      Date.parse(values.a.database.observation.observedAt) > recoveredAfter,
    150_000,
    'A service, volume and database observations become fresh',
  );
  const afterProcesses = {};
  for (const guest of ['a', 'b']) {
    afterProcesses[guest] = await processes(guest);
    const actual = await withCluster(guest, current[guest].volume);
    await check(
      `${guest}_original_resource_identity_preserved`,
      same(identity(sample(current[guest])), identity(state.baseline[guest])) &&
        same(actual, state.clusterIdentities[guest]),
      { actual },
    );
  }
  await check(
    'a_and_b_processes_pebble_and_configuration_unchanged',
    same(afterProcesses, state.beforeProcesses),
    { afterProcesses },
  );
  const marker = await readMarker(current.a);
  await check(
    'a_original_persistent_marker_is_readable_after_recovery',
    marker.readOnly && marker.markerVerified && marker.pvcUid === state.baseline.a.volume.pvc.uid,
    { marker },
  );
  report.tasksAfter = await idleTasks();
  report.recovered = { a: sample(current.a), b: sample(current.b) };
  requireValue(state.outageObserved, 'OUTAGE_EVIDENCE_INCOMPLETE_NO_AUTOMATIC_REINJECTION');
  requireValue(
    report.checks.every((entry) => entry.passed),
    'EARLIER_ASSERTION_FAILED_NO_REINJECTION',
  );
  state.completedAt = timestamp();
  report.status = 'passed';
  await checkpoint();
}
async function outage() {
  requireValue(!state.injection, 'INJECTION_ALREADY_ATTEMPTED');
  stage = 'baseline';
  let before = await until(
    () => pairs(),
    (values) => recent(values.a) && recent(values.b),
    150_000,
    'fresh A/B service and volume observations',
  );
  requireValue(
    before.a.database.engine === state.targets.a.engine &&
      before.a.database.initialization.state === 'verified' &&
      before.a.database.initialization.initializedAt &&
      before.a.database.protection.active,
    'PRIMARY_DATABASE_NOT_INITIALIZED',
  );
  report.tasksBefore = await idleTasks();
  state.beforeProcesses = {};
  state.clusterIdentities = {};
  for (const guest of ['a', 'b']) {
    state.beforeProcesses[guest] = await processes(guest);
    state.clusterIdentities[guest] = await withCluster(guest, before[guest].volume);
  }
  const marker = await readMarker(before.a);
  await check(
    'a_main_s5_persistent_marker_exists_before_fault',
    marker.readOnly && marker.markerVerified,
    { marker },
  );
  // Refresh the observation baseline after read-only SSH/API preflight work.
  before = await until(
    () => pairs(),
    (values) => recent(values.a) && recent(values.b),
    150_000,
    'recent final baseline',
  );
  state.baseline = { a: sample(before.a), b: sample(before.b) };
  await check(
    'a_and_b_have_fresh_independent_storage_baselines',
    before.a.volume.pvc.uid !== before.b.volume.pvc.uid &&
      before.a.volume.pv.uid !== before.b.volume.pv.uid,
    { a: state.baseline.a, b: state.baseline.b },
  );
  report.tasksImmediatelyBeforePause = await idleTasks();
  state.injection = {
    phase: 'intent',
    intendedAt: timestamp(),
    process: {
      pid: state.beforeProcesses.a.pid,
      startTicks: state.beforeProcesses.a.startTicks,
      bootId: state.beforeProcesses.a.bootId,
      executable: state.beforeProcesses.a.executable,
      cmdlineSha256: state.beforeProcesses.a.cmdlineSha256,
    },
    watchdogSeconds: 55,
  };
  stage = 'pause-only-a-k3s';
  await checkpoint(); // Commit before SSH: a lost response must never cause another SIGSTOP.
  const startedAt = Date.now();
  try {
    const paused = await remote(
      'a',
      processSource,
      {
        action: 'pause',
        owner,
        runId: state.runId,
        ...state.injection.process,
      },
      15_000,
    );
    requireValue(
      paused.paused && paused.watchdog?.readyHandshake && paused.watchdog.seconds === 55,
      'INDEPENDENT_WATCHDOG_NOT_CONFIRMED',
    );
    state.injection.phase = 'paused';
    state.injection.watchdog = paused.watchdog;
    report.pause = paused;
    await checkpoint();
    stage = 'observe-stale-a-and-fresh-b';
    const lastGood = {
      volume: volumeRetention(before.a.volume),
      database: databaseRetention(before.a.database),
    };
    const observed = await until(
      async (remaining) => {
        const values = await pairs(Math.min(3_000, remaining));
        if (!values.a.volume.observation.stale) lastGood.volume = volumeRetention(values.a.volume);
        if (!values.a.database.observationStale)
          lastGood.database = databaseRetention(values.a.database);
        requireValue(report.samples.length < 60, 'SAMPLE_LIMIT_REACHED');
        report.samples.push({ at: timestamp(), a: sample(values.a), b: sample(values.b) });
        await checkpoint();
        return values;
      },
      (values) =>
        values.a.service.observationStale &&
        values.a.volume.observation.stale &&
        values.a.database.observationStale &&
        Boolean(values.a.service.lastErrorCode) &&
        Boolean(values.a.volume.lastErrorCode) &&
        fresh(values.b) &&
        Date.parse(values.b.service.lastObservedAt) > startedAt &&
        Date.parse(values.b.volume.observation.observedAt) > startedAt,
      Math.max(1, 45_000 - (Date.now() - startedAt)),
      'A becomes stale while B continues observing',
    );
    const pausedStill = await remote(
      'a',
      processSource,
      {
        action: 'status',
        ...state.injection.process,
      },
      8_000,
    );
    requireValue(
      pausedStill.paused && Date.now() - startedAt < 53_000,
      'OUTAGE_WINDOW_NO_LONGER_ACTIVE',
    );
    await check(
      'a_stale_retains_last_pvc_pv_node_mount_and_database_data_state',
      same(volumeRetention(observed.a.volume), lastGood.volume) &&
        same(databaseRetention(observed.a.database), lastGood.database) &&
        same(identity(sample(observed.a)), identity(state.baseline.a)),
      {
        detectedAfterMs: Date.now() - startedAt,
        volumeRetentionSha256: hash(lastGood.volume),
        databaseRetentionSha256: hash(lastGood.database),
        actual: sample(observed.a),
      },
    );
    await check(
      'a_unknown_is_not_falsely_reported_as_stopped_or_database_ready',
      observed.a.service.desiredState === 'running' &&
        observed.a.service.runtimeState === 'unknown' &&
        !observed.a.database.databaseReady &&
        observed.a.volume.observation.state === before.a.volume.observation.state &&
        !observed.a.volume.destroyedAt &&
        !observed.a.volume.retained,
      {
        serviceState: observed.a.service.runtimeState,
        databaseReady: observed.a.database.databaseReady,
      },
    );
    await check(
      'b_service_and_volume_observation_timestamps_advance_during_a_pause',
      fresh(observed.b) &&
        Date.parse(observed.b.service.lastObservedAt) > startedAt &&
        Date.parse(observed.b.volume.observation.observedAt) > startedAt &&
        same(identity(sample(observed.b)), identity(state.baseline.b)),
      { b: sample(observed.b) },
    );
    state.outageObserved = true;
    await checkpoint();
  } finally {
    const previous = recovering;
    recovering = true;
    try {
      await resumeApi();
    } finally {
      recovering = previous;
    }
  }
  await recoverObservations();
}

async function lockFile(path) {
  const handle = await open(path, 'wx', 0o600);
  await handle.writeFile(
    JSON.stringify({ owner, pid: process.pid, nonce: randomUUID(), createdAt: timestamp() }),
  );
  return handle;
}
async function acquireOwnLock(mode) {
  try {
    return await lockFile(ownLockFile);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Recovery can preserve an abandoned own lock after the process has died.
    // An exclusive reclaim guard prevents two recovery commands racing each other.
    requireValue(mode === 'recover', 'LOCKED_USE_RECOVER_AFTER_OWNER_EXIT');
    const guardFile = `${ownLockFile}.reclaim`;
    const guard = await lockFile(guardFile);
    try {
      const old = await readJson(ownLockFile);
      requireValue(
        old.owner === owner && Number.isSafeInteger(old.pid) && old.pid > 1,
        'LOCK_OWNER_CHANGED',
      );
      let alive = true;
      try {
        process.kill(old.pid, 0);
      } catch (cause) {
        if (cause.code === 'ESRCH') alive = false;
        else throw cause;
      }
      requireValue(!alive, 'LOCK_OWNER_STILL_RUNNING');
      await rename(ownLockFile, `${ownLockFile}.abandoned-${randomUUID()}`);
      return await lockFile(ownLockFile);
    } finally {
      await guard.close();
      await unlink(guardFile);
    }
  }
}
function localApi(value) {
  const url = new URL(value);
  requireValue(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['/', '/api', '/api/'].includes(url.pathname),
    'LOOPBACK_API_REQUIRED',
  );
  return `${url.origin}/api`;
}
function localOrigin(value) {
  const url = new URL(value);
  requireValue(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    'LOOPBACK_ORIGIN_REQUIRED',
  );
  return url.origin;
}
async function initializeInputs() {
  parent = await readJson(resolve(lab, 'storage-product-state.json'));
  fixture = await readJson(resolve(lab, 'networking-lab/state.json'));
  registered = await readJson(resolve(lab, 'product-state.json'));
  requireValue(
    fixture.owner === 'ozz-local-networking-lab-v1' &&
      ['a', 'b'].every(
        (guest) =>
          uuid(registered.clusters?.[guest]) &&
          fixture.identities?.[guest]?.kubeSystemUid &&
          fixture.identities[guest].nodes?.length === 1,
      ),
    'LOCAL_FIXTURE_IDENTITIES_REQUIRED',
  );
  requireValue(
    parent.runId === state.parentRunId &&
      parent.services[state.requested.engine] === state.requested.aServiceId &&
      parent.volumes[state.requested.engine] === state.requested.aVolumeId,
    'PRIMARY_STATE_IDENTITY_CHANGED',
  );
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'api-url': { type: 'string' },
      origin: { type: 'string' },
      'a-engine': { type: 'string', default: 'postgresql' },
      'b-service-id': { type: 'string' },
      'b-volume-id': { type: 'string' },
    },
  });
  const mode = positionals[0];
  if (values.help || !mode) {
    console.log(
      'Usage: node --env-file=.env tests/probes/s5-observation-local-lab.mjs outage --api-url http://127.0.0.1:3000/api --b-service-id UUID --b-volume-id UUID [--a-engine postgresql|redis] [--origin http://127.0.0.1:5173]',
    );
    console.log(
      'Recovery only: node --env-file=.env tests/probes/s5-observation-local-lab.mjs recover',
    );
    console.log(
      'Run only in the coordinated idle window. Re-entry never repeats an existing injection intent. No result file is produced by --help.',
    );
    return;
  }
  requireValue(positionals.length === 1 && ['outage', 'recover'].includes(mode), 'MODE_INVALID');
  requireValue(mode === 'recover' || process.env.NODE_ENV !== 'production', 'PRODUCTION_REJECTED');
  await mkdir(lab, { recursive: true, mode: 0o700 });
  ownLock = await acquireOwnLock(mode);
  try {
    try {
      state = await readJson(stateFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!state && mode === 'recover') {
      console.log(JSON.stringify({ status: 'no-existing-injection-to-recover' }));
      return;
    }
    if (state)
      requireValue(
        state.version === 1 &&
          state.owner === owner &&
          uuid(state.runId) &&
          uuid(state.parentRunId),
        'STATE_OWNER_OR_VERSION_CHANGED',
      );
    if (mode === 'outage') {
      requireValue(
        values['api-url'] &&
          uuid(values['b-service-id']) &&
          uuid(values['b-volume-id']) &&
          ['postgresql', 'redis'].includes(values['a-engine']),
        'EXPLICIT_TARGET_ARGUMENTS_REQUIRED',
      );
      api = localApi(values['api-url']);
      origin = localOrigin(values.origin ?? process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173');
      const source = await readJson(resolve(lab, 'storage-product-state.json'));
      const requested = {
        api,
        origin,
        engine: values['a-engine'],
        aServiceId: source.services?.[values['a-engine']],
        aVolumeId: source.volumes?.[values['a-engine']],
        bServiceId: values['b-service-id'],
        bVolumeId: values['b-volume-id'],
      };
      requireValue(
        source.version === 1 &&
          uuid(source.runId) &&
          uuid(requested.aServiceId) &&
          uuid(requested.aVolumeId),
        'PRIMARY_STATE_NOT_READY',
      );
      state ??= {
        version: 1,
        owner,
        runId: randomUUID(),
        parentRunId: source.runId,
        requested,
        injection: null,
        outageObserved: false,
      };
      requireValue(same(requested, state.requested), 'SAVED_TARGETS_DIFFER');
    } else {
      api = localApi(state.requested.api);
      origin = localOrigin(state.requested.origin);
    }
    if (state.completedAt) {
      console.log(
        JSON.stringify({
          status: 'already-completed-not-reinjected',
          completedAt: state.completedAt,
          reportFile,
        }),
      );
      return;
    }
    await mkdir(resolve(root, 'docs/acceptance'), { recursive: true });
    report = state.injection
      ? state.report
      : {
          owner,
          version: 1,
          runId: state.runId,
          attemptId: randomUUID(),
          startedAt: timestamp(),
          status: 'running',
          scope:
            'Local A/B Kubernetes API outage, retained S5 storage/data observations and read-only marker recovery; no VPS or public-cloud acceptance.',
          checks: [],
          samples: [],
          credentials:
            'Only resource identities, checks, status and hashes are recorded. Credentials and marker contents are never persisted.',
          watchdogSeconds: 55,
          automaticReinjection: false,
          publicCloudVerified: false,
        };
    requireValue(
      report?.owner === owner && report.runId === state.runId && uuid(report.attemptId),
      'REPORT_OWNER_CHANGED',
    );
    if (state.injection && report.failure) {
      report.previousFailures ??= [];
      report.previousFailures.push({ ...report.failure, recordedAt: timestamp() });
      delete report.failure;
    }
    report.status = 'running';
    writeEvidence = true;
    await checkpoint();
    // Resume first, before login, task DB access, or a changed parent fixture can fail.
    recovering = true;
    try {
      await resumeApi();
    } finally {
      recovering = false;
    }
    if (state.injection && !state.outageObserved) {
      report.status = 'incomplete';
      report.reentry =
        'Original process resumed; the single-use fault intent will not be repeated automatically.';
      process.exitCode = 1;
      return;
    }
    if (!state.injection && mode === 'recover') {
      report.status = 'not-injected';
      return;
    }
    // The main S5 lifecycle probe owns this same lock. Its state is never edited.
    parentLock = await lockFile(parentLockFile);
    await initializeInputs();
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
    requireValue(
      ['postgresql:', 'postgres:'].includes(databaseUrl.protocol) &&
        ['127.0.0.1', 'localhost'].includes(databaseUrl.hostname),
      'LOCAL_TASK_DATABASE_REQUIRED',
    );
    databaseUrl.searchParams.set('connect_timeout', '4');
    databaseUrl.searchParams.set('pool_timeout', '4');
    db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
    await login();
    if (!state.injection) {
      state.targets = await resolveTargets(
        state.requested.engine,
        state.requested.bServiceId,
        state.requested.bVolumeId,
      );
      report.targets = state.targets;
      await checkpoint();
      await outage();
    } else {
      report.resumedAt = timestamp();
      await recoverObservations();
    }
  } catch (error) {
    if (report) {
      report.status = 'failed';
      report.failure = safeFailure(error);
    }
    console.error(JSON.stringify(safeFailure(error)));
    process.exitCode = 1;
  } finally {
    recovering = true;
    if (state?.injection && writeEvidence) {
      try {
        await resumeApi();
        report.cleanup = { apiResumed: state.injection.phase === 'resumed', watchdogSeconds: 55 };
      } catch (error) {
        report.status = 'failed';
        report.cleanup = { error: safeFailure(error), independentWatchdogSeconds: 55 };
        process.exitCode = 1;
      }
    }
    try {
      if (writeEvidence) {
        report.finishedAt = timestamp();
        await checkpoint();
        const history = resolve(lab, 's5-observation-reports');
        await mkdir(history, { recursive: true, mode: 0o700 });
        await atomicJson(resolve(history, `${report.attemptId}.json`), report, 0o600);
        console.log(
          JSON.stringify({
            status: report.status,
            reportFile,
            injected: Boolean(state.injection),
            resumed: state.injection?.phase === 'resumed',
            automaticReinjection: false,
          }),
        );
      }
    } finally {
      if (parentLock) {
        await parentLock.close();
        await unlink(parentLockFile);
      }
      if (ownLock) {
        await ownLock.close();
        await unlink(ownLockFile);
      }
      await db?.$disconnect();
    }
  }
}

void main().catch((error) => {
  console.error(JSON.stringify(safeFailure(error)));
  process.exitCode = 1;
});
