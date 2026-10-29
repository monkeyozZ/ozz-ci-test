import { execFile } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '../../packages/database/dist/index.js';
import {
  KubernetesAdapterError,
  parseKubeconfig,
} from '../../packages/infrastructure/dist/kubernetes.js';
import {
  createInspectionClient,
  transportLimits,
} from '../../packages/infrastructure/dist/kubernetes/transport.js';

// Explicit local fault probe. It neither modifies product configuration nor restarts Pebble.
// A's API process has a 55-second independent watchdog; the certificate fault owns one new Ingress.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const owner = 'ozz-s4-observation-probe-v1';
const stateFile = resolve(lab, 's4-observation-probe-state.json');
const reportFile = resolve(root, 'docs/acceptance/s4-observation-local-results.json');
const api = 'http://127.0.0.1:3000/api';
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const db = new PrismaClient();
const abort = new globalThis.AbortController();
const mode = process.argv[2] ?? 'all';
if (!['all', 'outage', 'certificate', 'cleanup'].includes(mode))
  throw new Error('S4_OBSERVATION_MODE_INVALID');
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let cookie;
let csrf;
let lock;
let stage = 'preflight';
let state;
let fixture;
let registered;
let baseline;
let recovering = false;
const report = {
  owner,
  attemptId: randomUUID(),
  startedAt: new Date().toISOString(),
  status: 'running',
  scope:
    'Real local ARM64 K3s A/B API outage, retained domain observations, real HTTP-01 renewal blockage and certificate expiry/recovery. Local test CA only.',
  mode,
  checks: [],
  samples: [],
  publicCloudVerified: false,
};

function required(value, code) {
  if (!value) throw new Error(code);
}
function hash(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}
function safeFailure(error) {
  return {
    stage,
    code: /^[A-Z0-9_]+$/u.test(error.message ?? '') ? error.message : 'S4_OBSERVATION_FAILURE',
    problemCode:
      typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : null,
    status: error.status ?? null,
  };
}
async function save() {
  await writeFile(`${stateFile}.pending`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${stateFile}.pending`, stateFile);
}
async function checkpoint() {
  await save();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
}
async function check(name, passed, details = {}) {
  report.checks.push({
    name,
    passed: Boolean(passed),
    observedAt: new Date().toISOString(),
    ...details,
  });
  console.log(JSON.stringify({ check: name, passed: Boolean(passed) }));
  await checkpoint();
  required(passed, 'S4_OBSERVATION_ASSERTION_FAILED');
}
async function request(path, method = 'GET', body, key) {
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
    signal: recovering
      ? globalThis.AbortSignal.timeout(15_000)
      : globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(15_000)]),
  });
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error('S4_OBSERVATION_API_FAILED');
    error.code = value?.code;
    error.status = response.status;
    throw error;
  }
  return { data: value?.data, response };
}
async function command(label, path, body) {
  state.commands[label] ??= { path, body, key: randomUUID() };
  await save();
  const intent = state.commands[label];
  required(intent.path === path, 'S4_OBSERVATION_COMMAND_TARGET_CHANGED');
  const result = (await request(path, 'POST', intent.body, intent.key)).data;
  required(!intent.id || intent.id === result.id, 'S4_OBSERVATION_COMMAND_ID_CHANGED');
  intent.id = result.id;
  await save();
  return result;
}
async function until(read, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let nextProgress = Date.now();
  while (Date.now() < deadline) {
    if (!recovering) abort.signal.throwIfAborted();
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= nextProgress) {
      console.log(JSON.stringify({ stage, waiting: label }));
      nextProgress = Date.now() + 15_000;
    }
    await delay(1_000, undefined, recovering ? {} : { signal: abort.signal });
  }
  throw new Error('S4_OBSERVATION_WAIT_TIMEOUT');
}
async function waitTask(type, id) {
  const result = await until(
    async () => (await request(`/${type}/${id}`)).data,
    (task) => ['succeeded', 'failed', 'cancelled'].includes(task.status),
    360_000,
    `${type}:${id}`,
  );
  if (result.status !== 'succeeded') {
    const error = new Error('S4_OBSERVATION_TASK_FAILED');
    error.code = result.errorCode;
    throw error;
  }
  return result;
}
async function domain(id) {
  return (await request(`/domains/${id}`)).data;
}
function sample(value) {
  return {
    id: value.id,
    hostname: value.hostname,
    revision: value.revision,
    serviceId: value.serviceId,
    clusterId: value.cluster.id,
    environmentId: value.environment.id,
    portId: value.servicePort.id,
    stale: value.observationStale,
    lastAttemptAt: value.lastAttemptAt,
    lastErrorCode: value.lastErrorCode,
    dns: value.dns,
    route: value.route,
    certificate: value.certificate,
  };
}
function ready(value) {
  return (
    !value.observationStale &&
    value.route?.state === 'ready' &&
    ['ready', 'staging_ready'].includes(value.certificate?.state)
  );
}
async function withCluster(guest, work) {
  required(['a', 'b'].includes(guest), 'S4_OBSERVATION_GUEST_INVALID');
  const connection = parseKubeconfig(
    await readFile(resolve(lab, `credentials/${guest}.kubeconfig.json`), 'utf8'),
  );
  required(
    connection.endpoint === `https://127.0.0.1:${guest === 'a' ? 16443 : 26443}`,
    'S4_OBSERVATION_ENDPOINT_CHANGED',
  );
  const signal = recovering
    ? globalThis.AbortSignal.timeout(25_000)
    : globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(25_000)]);
  const client = await createInspectionClient(
    connection,
    transportLimits({ requestTimeoutMs: 8_000 }),
    signal,
  );
  try {
    const system = await client.core.readNamespace({ name: 'kube-system' });
    required(
      system.metadata?.uid === fixture.identities[guest].kubeSystemUid,
      'S4_OBSERVATION_CLUSTER_UID_CHANGED',
    );
    const nodes = await client.core.listNode({ limit: 10 });
    required(
      !nodes.metadata?._continue &&
        nodes.items.length === 1 &&
        nodes.items[0].metadata?.uid === fixture.identities[guest].nodes[0].uid,
      'S4_OBSERVATION_NODE_UID_CHANGED',
    );
    return await work(client);
  } finally {
    client.close();
  }
}
async function inventory(id) {
  return db.networkManagedResource.findMany({
    where: { domainId: id, deletedAt: null },
    select: { kind: true, name: true, namespace: true, role: true, uid: true, creationNonce: true },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });
}
async function remote(guest, source, body) {
  required(['a', 'b'].includes(guest), 'S4_OBSERVATION_GUEST_INVALID');
  const quoted = `'${source.replaceAll("'", "'\\''")}'`;
  try {
    const stdout = await new Promise((done, reject) => {
      const child = execFile(
        'ssh',
        [
          '-F',
          resolve(lab, 'credentials/ssh_config'),
          `ozz-lab-${guest}`,
          `sudo python3 -c ${quoted}`,
        ],
        { encoding: 'utf8', timeout: 25_000, maxBuffer: 128 * 1024 },
        (error, output) => (error ? reject(error) : done(output)),
      );
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify(body));
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error('S4_OBSERVATION_REMOTE_FAILED');
  }
}

const processSource = String.raw`
import hashlib, json, os, signal, subprocess, sys, time
from pathlib import Path
value = json.load(sys.stdin)
assert Path('/etc/ozz-local-lab-instance').read_text().strip() == 'ozz-lab-' + value['guest']
def ticks(pid): return Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')',1)[1].split()[19]
def command(pid): return Path('/proc/' + str(pid) + '/cmdline').read_bytes()
def main(unit): return int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'], timeout=5).strip())
if value['action'] == 'inspect':
    system = json.loads(subprocess.check_output(['k3s','kubectl','get','namespace','kube-system','-o','json','--request-timeout=5s'], timeout=8))
    assert system['metadata']['uid'] == value['kubeSystemUid']
    pid = main('k3s')
    assert pid > 1 and b'k3s' in command(pid) and b'server' in command(pid)
    units = {}
    for kind in ['dns','staging','production']:
        other = main('ozz-local-networking-' + value['guest'] + '-' + kind)
        assert other > 1
        units[kind] = {'pid':other,'startTicks':ticks(other)}
    configs = {}
    for path in ['/etc/resolv.conf','/etc/rancher/k3s/config.yaml','/var/lib/rancher/k3s/server/manifests/traefik.yaml','/etc/ssl/certs/ca-certificates.crt']:
        p=Path(path); configs[path] = hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
    print(json.dumps({'pid':pid,'startTicks':ticks(pid),'fixtureProcesses':units,'configurationHashes':configs})); sys.exit(0)
pid = int(value['pid']); expected = value['startTicks']
assert pid > 1 and ticks(pid) == expected and b'k3s' in command(pid) and b'server' in command(pid)
if value['action'] == 'pause':
    assert value['guest'] == 'a' and main('k3s') == pid
    watchdog = "import os,signal,sys,time; from pathlib import Path; time.sleep(55); p=int(sys.argv[1]); s=Path('/proc/'+str(p)+'/stat'); ok=s.exists() and s.read_text().rsplit(')',1)[1].split()[19]==sys.argv[2]; cmd=Path('/proc/'+str(p)+'/cmdline').read_bytes() if ok else b''; os.kill(p,signal.SIGCONT) if ok and b'k3s' in cmd and b'server' in cmd else None"
    guard = subprocess.Popen([sys.executable,'-c',watchdog,str(pid),expected], stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
    os.kill(pid, signal.SIGSTOP)
    print(json.dumps({'pid':pid,'startTicks':expected,'watchdogPid':guard.pid,'watchdogStartTicks':ticks(guard.pid),'watchdogSeconds':55,'startedAt':time.time()}))
elif value['action'] == 'resume':
    os.kill(pid, signal.SIGCONT)
    print(json.dumps({'pid':pid,'startTicks':expected,'resumed':True,'resumedAt':time.time()}))
else: raise RuntimeError('invalid process action')
`;

const watchdogSource = String.raw`
import json, os, signal, subprocess, sys, time
from pathlib import Path
value=json.load(sys.stdin)
assert Path('/etc/ozz-local-lab-instance').read_text().strip() == 'ozz-lab-a'
def ticks(pid): return Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')',1)[1].split()[19]
if value['action'] == 'cancel':
    pid=int(value['pid']); p=Path('/proc/'+str(pid)+'/stat')
    if p.exists() and ticks(pid)==value['startTicks']:
        cmd=Path('/proc/'+str(pid)+'/cmdline').read_bytes()
        assert b'ozz-s4-observation-fault-watchdog' in cmd
        os.kill(pid,signal.SIGTERM)
    print(json.dumps({'cancelled':True})); sys.exit(0)
assert value['action']=='start' and value['owner']=='ozz-s4-observation-probe-v1'
assert all(c.isalnum() or c=='-' for c in value['namespace']+value['name'])
program = r'''
import json,subprocess,sys,time
from pathlib import Path
# ozz-s4-observation-fault-watchdog
v=json.loads(sys.argv[1]); time.sleep(420)
assert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-a'
for attempt in range(3):
    try:
        system=json.loads(subprocess.check_output(['k3s','kubectl','get','namespace','kube-system','-o','json','--request-timeout=5s'],stderr=subprocess.DEVNULL,timeout=8))
        assert system['metadata']['uid']==v['kubeSystemUid']
        path='/apis/networking.k8s.io/v1/namespaces/'+v['namespace']+'/ingresses/'+v['name']
        result=subprocess.run(['k3s','kubectl','get','--raw',path,'--request-timeout=5s'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8)
        if result.returncode:
            if b'NotFound' in result.stderr or b'not found' in result.stderr: break
            raise RuntimeError('read failed')
        current=json.loads(result.stdout); m=current['metadata']
        assert m['uid']==v['uid'] and m['labels']['probe.ozz.dev/owner']==v['owner'] and m['annotations']['probe.ozz.dev/run-id']==v['runId']
        assert current['spec']['rules'][0]['host']==v['hostname']
        body={'apiVersion':'v1','kind':'DeleteOptions','preconditions':{'uid':v['uid'],'resourceVersion':m['resourceVersion']}}
        subprocess.run(['k3s','kubectl','delete','--raw',path,'-f','-','--request-timeout=5s'],input=json.dumps(body).encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8,check=True)
        break
    except Exception:
        time.sleep(5)
'''
p=subprocess.Popen([sys.executable,'-c',program,json.dumps(value)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
print(json.dumps({'pid':p.pid,'startTicks':ticks(p.pid),'seconds':420}))
`;

const httpSource = String.raw`
import hashlib,http.client,json,socket,ssl,sys
from pathlib import Path
v=json.load(sys.stdin)
assert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-'+v['guest']
assert v['hostname'].endswith('.apps.ozz.test') and all(c.isalnum() or c in '.-' for c in v['hostname'])
connection=http.client.HTTPConnection(v['ip'],80,timeout=6)
connection.request('GET',v.get('path','/'),headers={'Host':v['hostname']})
r=connection.getresponse(); body=r.read(65536)
result={'httpStatus':r.status,'location':r.getheader('Location'),'bodySha256':hashlib.sha256(body).hexdigest()};connection.close()
if v.get('apiProcess'):
    p=v['apiProcess']; fields=Path('/proc/'+str(p['pid'])+'/stat').read_text().rsplit(')',1)[1].split()
    assert fields[19]==p['startTicks']
    result['apiProcessPaused']=fields[0] in ['T','t']
if v.get('challengeOnly'): print(json.dumps(result));sys.exit(0)
ca='/var/lib/ozz-local-lab/'+v['guest']+'/networking-v1/'+v['environment']+'-signing-root.pem'
context=ssl.create_default_context(cafile=ca)
try:
    with socket.create_connection((v['ip'],443),timeout=6) as raw:
        with context.wrap_socket(raw,server_hostname=v['hostname']) as stream:
            c=stream.getpeercert(); result.update({'tlsVerified':True,'serialNumber':c['serialNumber'],'notBefore':c['notBefore'],'notAfter':c['notAfter'],'fingerprint':hashlib.sha256(stream.getpeercert(binary_form=True)).hexdigest()})
            stream.sendall(('GET / HTTP/1.1\r\nHost: '+v['hostname']+'\r\nConnection: close\r\n\r\n').encode())
            reply=http.client.HTTPResponse(stream);reply.begin();payload=json.loads(reply.read(65536));result.update({'httpsStatus':reply.status,'applicationMessage':payload.get('message')})
except ssl.SSLCertVerificationError as error:
    result.update({'tlsVerified':False,'tlsVerifyCode':error.verify_code,'expiredRejected':error.verify_code==10})
print(json.dumps(result))
`;

async function route(guest, value, challengeOnly = false) {
  return remote(guest, httpSource, {
    guest,
    ip: fixture.ip,
    hostname: value.hostname,
    environment: value.certificateEnvironment,
    challengeOnly,
    ...(guest === 'a' && state.apiPause ? { apiProcess: state.apiPause } : {}),
    ...(challengeOnly ? { path: '/.well-known/acme-challenge/ozz-probe-unmatched-token' } : {}),
  });
}
async function processes(guest) {
  return remote(guest, processSource, {
    action: 'inspect',
    guest,
    kubeSystemUid: fixture.identities[guest].kubeSystemUid,
  });
}
async function resumeApi() {
  if (!state.apiPause) return;
  const result = await remote('a', processSource, {
    action: 'resume',
    guest: 'a',
    ...state.apiPause,
  });
  report.apiResume = result;
  delete state.apiPause;
  await save();
}
async function outage() {
  stage = 'outage-baseline';
  const before = await until(
    async () => ({ a: await domain(baseline.domains.a), b: await domain(baseline.domains.b) }),
    (values) =>
      ready(values.a) &&
      ready(values.b) &&
      Date.now() - Date.parse(values.a.route.observedAt) < 5_000 &&
      Date.parse(values.a.certificate.notAfter) - Date.now() > 100_000,
    360_000,
    'fresh baseline with sufficient certificate lifetime',
  );
  const priorInventory = await inventory(before.a.id);
  const beforeProcess = await processes('a');
  await check(
    'A/B domain baselines are fresh with distinct cluster identities',
    before.a.cluster.id === registered.clusters.a &&
      before.b.cluster.id === registered.clusters.b &&
      before.a.cluster.id !== before.b.cluster.id,
    { a: sample(before.a), b: sample(before.b), aInventory: priorInventory },
  );
  state.apiPause = { pid: beforeProcess.pid, startTicks: beforeProcess.startTicks };
  await save();
  stage = 'pause-a-api';
  const startedAt = Date.now();
  report.apiPause = await remote('a', processSource, {
    action: 'pause',
    guest: 'a',
    ...state.apiPause,
  });
  await checkpoint();
  try {
    stage = 'observe-api-outage';
    const failed = await until(
      async () => {
        const values = { a: await domain(before.a.id), b: await domain(before.b.id) };
        report.samples.push({
          phase: stage,
          at: new Date().toISOString(),
          a: sample(values.a),
          b: sample(values.b),
        });
        return values;
      },
      (values) => values.a.observationStale && Boolean(values.a.lastErrorCode),
      48_000,
      'A failed observation before watchdog',
    );
    await check(
      'first API failure marks A stale before the 90-second observation TTL and preserves route/certificate',
      Date.now() - Date.parse(before.a.route.observedAt) < 90_000 &&
        hash(failed.a.route) === hash(before.a.route) &&
        hash(failed.a.certificate) === hash(before.a.certificate) &&
        failed.a.id === before.a.id &&
        failed.a.hostname === before.a.hostname,
      {
        detectedAfterMs: Date.now() - startedAt,
        before: sample(before.a),
        failed: sample(failed.a),
      },
    );
    const other = await until(
      async () => ({ a: await domain(before.a.id), b: await domain(before.b.id) }),
      (values) => ready(values.b) && Date.parse(values.b.route.observedAt) > startedAt,
      Math.max(1_000, 49_000 - (Date.now() - startedAt)),
      'B observer continues',
    );
    await check(
      'B keeps observing while A API is paused',
      other.a.observationStale &&
        ready(other.b) &&
        Date.parse(other.b.route.observedAt) > startedAt,
      { b: sample(other.b) },
    );
    const served = await route('a', before.a);
    await check(
      'A application and its valid certificate continue serving during API pause',
      served.apiProcessPaused && served.tlsVerified && served.httpsStatus === 200,
      { application: served },
    );
  } finally {
    await resumeApi();
  }
  stage = 'observe-api-recovery';
  const after = await until(
    () => domain(before.a.id),
    (value) => ready(value) && Date.parse(value.route.observedAt) > startedAt,
    150_000,
    'A returns to fresh observations',
  );
  const afterProcess = await processes('a');
  await check(
    'A recovers with original cluster process and network resource identities',
    beforeProcess.pid === afterProcess.pid &&
      beforeProcess.startTicks === afterProcess.startTicks &&
      hash(beforeProcess.fixtureProcesses) === hash(afterProcess.fixtureProcesses) &&
      hash(priorInventory) === hash(await inventory(before.a.id)),
    { recovered: sample(after), processes: afterProcess },
  );
  state.completed.outage = {
    completedAt: new Date().toISOString(),
    reportAttempt: report.attemptId,
  };
  await checkpoint();
}

async function prepareCertificateService() {
  stage = 'prepare-isolated-certificate-service';
  state.fixture ??= { slug: `s4-expiry-${state.runId.slice(0, 8)}` };
  await save();
  if (!state.fixture.environmentId) {
    const created = (
      await request('/environments', 'POST', {
        projectId: baseline.projects.a,
        name: `证书故障验证 ${state.runId.slice(0, 8)}`,
        slug: state.fixture.slug,
      })
    ).data;
    state.fixture.environmentId = created.id;
    await save();
  }
  if (!state.fixture.serviceId) {
    const created = (
      await request('/services', 'POST', {
        projectId: baseline.projects.a,
        environmentId: state.fixture.environmentId,
        name: '证书到期验证应用',
        slug: 'podinfo',
        description: `${owner}:${state.runId}`,
        configuration: {
          image:
            'ghcr.io/stefanprodan/podinfo@sha256:ec73780a8425f59ea49f5bc8cdff0d598805a224fbaa1f86c67a244f250fa9da',
          replicas: 1,
          ports: [{ name: 'http', protocol: 'http', containerPort: 9898, servicePort: 80 }],
          resources: {
            requests: { cpuMillis: 25, memoryMiB: 32 },
            limits: { cpuMillis: 200, memoryMiB: 96 },
          },
          environment: [{ name: 'PODINFO_UI_MESSAGE', value: 'Ozz S4 expiry probe' }],
          readiness: {
            type: 'http',
            port: 'http',
            path: '/readyz',
            initialDelaySeconds: 0,
            periodSeconds: 2,
            timeoutSeconds: 1,
            failureThreshold: 3,
          },
          healthTimeoutSeconds: 120,
        },
      })
    ).data;
    state.fixture.serviceId = created.id;
    await save();
  }
  const service = (await request(`/services/${state.fixture.serviceId}`)).data;
  required(
    service.projectId === baseline.projects.a &&
      service.environmentId === state.fixture.environmentId &&
      service.clusterId === registered.clusters.a &&
      service.description === `${owner}:${state.runId}`,
    'S4_OBSERVATION_FIXTURE_SERVICE_CHANGED',
  );
  const deployed = await command('deploy-probe', `/services/${service.id}/deployments`, {
    revision: service.revision,
  });
  await waitTask('deployments', deployed.id);
  if (!state.fixture.domainId) {
    const network = (await request(`/services/${service.id}/networking`)).data;
    const port = network.eligiblePorts.find((value) => value.name === 'http');
    required(port, 'S4_OBSERVATION_PORT_MISSING');
    const bound = await command('bind-probe', `/services/${service.id}/domains`, {
      revision: network.serviceRevision,
      portId: port.id,
    });
    state.fixture.domainId = bound.input.domainId;
    await save();
    await waitTask('operations', bound.id);
  }
  return until(
    () => domain(state.fixture.domainId),
    ready,
    300_000,
    'isolated staging certificate ready',
  );
}
async function resourceSnapshot(value) {
  const rows = await inventory(value.id);
  const tlsRow = rows.find((item) => item.role === 'tls');
  const certificateRow = rows.find((item) => item.role === 'certificate');
  required(
    tlsRow?.uid && certificateRow?.uid && tlsRow.namespace === certificateRow.namespace,
    'S4_OBSERVATION_CERTIFICATE_LEDGER_MISSING',
  );
  return withCluster('a', async (client) => {
    const namespace = await client.core.readNamespace({ name: tlsRow.namespace });
    required(
      namespace.metadata?.labels?.['ozz.dev/environment-id'] === state.fixture.environmentId,
      'S4_OBSERVATION_NAMESPACE_OWNER_CHANGED',
    );
    const certificate = await client.request(
      'GET',
      `/apis/cert-manager.io/v1/namespaces/${certificateRow.namespace}/certificates/${certificateRow.name}`,
    );
    const secret = await client.core.readNamespacedSecret({
      namespace: tlsRow.namespace,
      name: tlsRow.name,
    });
    for (const [object, row] of [
      [certificate, certificateRow],
      [secret, tlsRow],
    ])
      required(
        object.metadata?.uid === row.uid &&
          object.metadata.annotations?.['networking.ozz.dev/creation-nonce'] === row.creationNonce,
        'S4_OBSERVATION_RESOURCE_UID_CHANGED',
      );
    const pem = secret.data?.['tls.crt'];
    required(typeof pem === 'string' && pem.length < 128 * 1024, 'S4_OBSERVATION_TLS_LEAF_INVALID');
    const leaf = new X509Certificate(Buffer.from(pem, 'base64'));
    required(
      leaf.checkHost(value.hostname, { wildcards: false, subject: 'never' }) === value.hostname,
      'S4_OBSERVATION_CERTIFICATE_HOST_CHANGED',
    );
    const list = async (group, plural) => {
      const response = await client.request(
        'GET',
        `/apis/${group}/v1/namespaces/${tlsRow.namespace}/${plural}?limit=101`,
      );
      required(
        Array.isArray(response.items) &&
          response.items.length <= 100 &&
          !response.metadata?.continue,
        'S4_OBSERVATION_RESOURCE_LIST_LIMIT',
      );
      return response.items;
    };
    const requests = (await list('cert-manager.io', 'certificaterequests')).filter((item) =>
      item.metadata?.ownerReferences?.some(
        (ref) => ref.kind === 'Certificate' && ref.uid === certificateRow.uid,
      ),
    );
    const orders = (await list('acme.cert-manager.io', 'orders')).filter((item) =>
      item.metadata?.ownerReferences?.some(
        (ref) =>
          ref.kind === 'CertificateRequest' &&
          requests.some((request) => request.metadata.uid === ref.uid),
      ),
    );
    const challenges = (await list('acme.cert-manager.io', 'challenges')).filter(
      (item) =>
        item.spec?.dnsName === value.hostname &&
        item.metadata?.ownerReferences?.some(
          (ref) => ref.kind === 'Order' && orders.some((order) => order.metadata.uid === ref.uid),
        ),
    );
    const conditions = (object) =>
      (object.status?.conditions ?? []).map((condition) => ({
        type: condition.type,
        status: condition.status,
        reason: condition.reason,
        observedGeneration: condition.observedGeneration,
        lastTransitionTime: condition.lastTransitionTime,
      }));
    return {
      namespace: tlsRow.namespace,
      namespaceUid: namespace.metadata.uid,
      rows,
      certificate: {
        name: certificateRow.name,
        uid: certificateRow.uid,
        generation: certificate.metadata.generation,
        revision: certificate.status?.revision,
        notAfter: certificate.status?.notAfter,
        renewalTime: certificate.status?.renewalTime,
        failedIssuanceAttempts: certificate.status?.failedIssuanceAttempts,
        conditions: conditions(certificate),
      },
      leaf: {
        secretName: tlsRow.name,
        secretUid: tlsRow.uid,
        serialNumber: leaf.serialNumber,
        fingerprint: leaf.fingerprint256,
        notBefore: leaf.validFromDate.toISOString(),
        notAfter: leaf.validToDate.toISOString(),
      },
      requests: requests.map((item) => ({
        name: item.metadata.name,
        uid: item.metadata.uid,
        conditions: conditions(item),
      })),
      orders: orders.map((item) => ({
        name: item.metadata.name,
        uid: item.metadata.uid,
        state: item.status?.state,
        errorType: item.status?.reason?.type,
      })),
      challenges: challenges.map((item) => ({
        name: item.metadata.name,
        uid: item.metadata.uid,
        dnsName: item.spec.dnsName,
        state: item.status?.state,
        processing: item.status?.processing,
        presented: item.status?.presented,
        selfCheckBlocked:
          typeof item.status?.reason === 'string' &&
          /propagation|self.check|wrong status|did not get expected/u.test(
            item.status.reason.toLowerCase(),
          ),
      })),
    };
  });
}
async function createFault(value, snapshot) {
  stage = 'inject-owned-challenge-fault';
  state.faultIngress = {
    namespace: snapshot.namespace,
    namespaceUid: snapshot.namespaceUid,
    name: `ozz-expiry-fault-${state.runId.slice(0, 8)}`,
    hostname: value.hostname,
    owner,
    runId: state.runId,
    kubeSystemUid: fixture.identities.a.kubeSystemUid,
    creationAttempted: true,
  };
  await save();
  const fault = state.faultIngress;
  const actual = await withCluster('a', async (client) => {
    const https = snapshot.rows.find((row) => row.role === 'https');
    required(https, 'S4_OBSERVATION_ROUTE_MISSING');
    const ingress = await client.request(
      'GET',
      `/apis/networking.k8s.io/v1/namespaces/${snapshot.namespace}/ingresses/${https.name}`,
    );
    required(
      ingress.metadata.uid === https.uid &&
        ingress.spec.rules.length === 1 &&
        ingress.spec.rules[0].host === value.hostname,
      'S4_OBSERVATION_BACKEND_IDENTITY_CHANGED',
    );
    const backend = ingress.spec.rules[0].http.paths[0].backend;
    const manifest = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: fault.name,
        namespace: fault.namespace,
        labels: { 'probe.ozz.dev/owner': owner },
        annotations: {
          'probe.ozz.dev/run-id': state.runId,
          'traefik.ingress.kubernetes.io/router.entrypoints': 'web',
          'traefik.ingress.kubernetes.io/router.priority': '20000',
        },
      },
      spec: {
        ingressClassName: 'traefik',
        rules: [
          {
            host: value.hostname,
            http: {
              paths: [{ path: '/.well-known/acme-challenge/', pathType: 'Prefix', backend }],
            },
          },
        ],
      },
    };
    return client.request(
      'POST',
      `/apis/networking.k8s.io/v1/namespaces/${fault.namespace}/ingresses`,
      manifest,
    );
  });
  fault.uid = actual.metadata.uid;
  fault.resourceVersion = actual.metadata.resourceVersion;
  await save();
  state.faultWatchdog = await remote('a', watchdogSource, { action: 'start', ...fault });
  await checkpoint();
  await check(
    'fault Ingress matches only the isolated hostname and ACME path',
    Boolean(fault.uid),
    { fault: { ...fault }, watchdog: state.faultWatchdog },
  );
}
async function removeFault() {
  const fault = state.faultIngress;
  if (!fault) return;
  await withCluster('a', async (client) => {
    const namespace = await client.core.readNamespace({ name: fault.namespace });
    required(
      namespace.metadata.uid === fault.namespaceUid,
      'S4_OBSERVATION_FAULT_NAMESPACE_CHANGED',
    );
    const path = `/apis/networking.k8s.io/v1/namespaces/${fault.namespace}/ingresses/${fault.name}`;
    let actual;
    try {
      actual = await client.request('GET', path);
    } catch (error) {
      if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return;
      throw error;
    }
    required(
      (fault.uid ? actual.metadata.uid === fault.uid : fault.creationAttempted) &&
        actual.metadata.labels?.['probe.ozz.dev/owner'] === owner &&
        actual.metadata.annotations?.['probe.ozz.dev/run-id'] === state.runId &&
        actual.spec.rules.length === 1 &&
        actual.spec.rules[0].host === fault.hostname,
      'S4_OBSERVATION_FAULT_OWNERSHIP_CHANGED',
    );
    fault.uid ??= actual.metadata.uid;
    await client.request('DELETE', path, {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: fault.uid, resourceVersion: actual.metadata.resourceVersion },
    });
    await until(
      async () => {
        try {
          await client.request('GET', path);
          return false;
        } catch (error) {
          if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return true;
          throw error;
        }
      },
      (absent) => absent,
      10_000,
      'fault Ingress absent after conditional deletion',
    );
  });
  report.faultRemoval = {
    namespace: fault.namespace,
    name: fault.name,
    uid: fault.uid,
    removedAt: new Date().toISOString(),
    conditionalDelete: true,
    absenceVerified: true,
  };
  if (state.faultWatchdog)
    await remote('a', watchdogSource, { action: 'cancel', ...state.faultWatchdog });
  delete state.faultIngress;
  delete state.faultWatchdog;
  await save();
}
async function certificateFailure() {
  let value = await prepareCertificateService();
  stage = 'certificate-baseline';
  let before = await resourceSnapshot(value);
  if (Date.parse(before.leaf.notAfter) - Date.now() < 150_000) {
    const serial = before.leaf.serialNumber;
    await until(
      async () => {
        value = await domain(value.id);
        before = await resourceSnapshot(value);
        return before;
      },
      (snapshot) =>
        snapshot.leaf.serialNumber !== serial &&
        Date.parse(snapshot.leaf.notAfter) - Date.now() > 150_000,
      300_000,
      'fresh short certificate',
    );
  }
  await check(
    'isolated certificate has a real short lifetime and valid TLS before injection',
    Date.parse(before.leaf.notAfter) - Date.parse(before.leaf.notBefore) >= 180_000 &&
      Date.parse(before.leaf.notAfter) - Date.parse(before.leaf.notBefore) <= 300_000 &&
      (await route('a', value)).tlsVerified,
    { domain: sample(value), resources: before },
  );
  await createFault(value, before);
  let expired;
  try {
    stage = 'observe-renewal-blocked';
    const blocked = await until(
      async () => {
        value = await domain(value.id);
        const resources = await resourceSnapshot(value);
        if (report.samples.length < 400)
          report.samples.push({
            phase: stage,
            at: new Date().toISOString(),
            domain: sample(value),
            resources,
          });
        await delay(2_000, undefined, { signal: abort.signal });
        return { value, resources };
      },
      ({ resources }) =>
        resources.challenges.some((item) => item.processing && item.selfCheckBlocked),
      280_000,
      'real renewal HTTP-01 self-check blocked',
    );
    await check(
      'real renewal creates an owned ACME Challenge whose HTTP-01 validation is blocked',
      blocked.resources.leaf.serialNumber === before.leaf.serialNumber &&
        blocked.resources.challenges.some((item) => item.selfCheckBlocked),
      {
        domain: sample(blocked.value),
        resources: blocked.resources,
        challengeHttp: await route('a', value, true),
      },
    );
    stage = 'observe-actual-certificate-expiry';
    expired = await until(
      async () => {
        const current = await domain(value.id);
        if (report.samples.length < 400)
          report.samples.push({
            phase: stage,
            at: new Date().toISOString(),
            domain: sample(current),
          });
        return current;
      },
      (current) =>
        Date.now() > Date.parse(before.leaf.notAfter) &&
        current.certificate?.state === 'expired' &&
        !current.observationStale,
      Math.max(90_000, Date.parse(before.leaf.notAfter) - Date.now() + 90_000),
      'product observes the actual notAfter',
    );
    const actual = await resourceSnapshot(expired);
    const expiredTls = await route('a', expired);
    await check(
      'certificate expires in real time and explicit trusted TLS verification rejects it',
      expired.certificate.state === 'expired' &&
        ['CERTIFICATE_EXPIRED', 'ACME_CHALLENGE_SELF_CHECK_PENDING'].includes(
          expired.certificate.code,
        ) &&
        actual.leaf.serialNumber === before.leaf.serialNumber &&
        Date.parse(actual.leaf.notAfter) <= Date.now() &&
        expiredTls.expiredRejected &&
        expired.route.state === 'ready',
      { domain: sample(expired), resources: actual, tls: expiredTls },
    );
    const other = await domain(baseline.domains.b);
    await check(
      'B remains fresh during the isolated certificate fault',
      !other.observationStale &&
        other.route?.state === 'ready' &&
        ['ready', 'staging_ready', 'renewing'].includes(other.certificate?.state) &&
        Date.parse(other.certificate.notAfter) > Date.now(),
      { b: sample(other) },
    );
  } finally {
    await removeFault();
  }
  stage = 'observe-certificate-recovery';
  const recovered = await until(
    () => domain(value.id),
    (current) =>
      ready(current) && Date.parse(current.certificate.notAfter) > Date.parse(before.leaf.notAfter),
    240_000,
    'new actual certificate after challenge repair',
  );
  const after = await resourceSnapshot(recovered);
  const tls = await route('a', recovered);
  await check(
    'cert-manager repairs the original resources with a new certificate and valid TLS',
    after.leaf.serialNumber !== before.leaf.serialNumber &&
      after.leaf.secretUid === before.leaf.secretUid &&
      after.certificate.uid === before.certificate.uid &&
      hash(after.rows) === hash(before.rows) &&
      tls.tlsVerified &&
      tls.httpsStatus === 200 &&
      tls.applicationMessage === 'Ozz S4 expiry probe',
    {
      before: before.leaf,
      expired: sample(expired),
      recovered: sample(recovered),
      resources: after,
      tls,
    },
  );
  state.completed.certificate = {
    completedAt: new Date().toISOString(),
    reportAttempt: report.attemptId,
  };
  await checkpoint();
}

try {
  required(process.env.NODE_ENV !== 'production', 'S4_OBSERVATION_PRODUCTION_REJECTED');
  await mkdir(lab, { recursive: true, mode: 0o700 });
  // Coordinate with the main S4 mutation probe without editing its saved state.
  lock = await open(resolve(lab, 'networking-product-state.json.lock'), 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ owner, pid: process.pid, startedAt: report.startedAt }));
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  state ??= { version: 1, owner, runId: randomUUID(), commands: {}, completed: {} };
  required(state.owner === owner && state.version === 1, 'S4_OBSERVATION_STATE_OWNER_CHANGED');
  baseline = JSON.parse(await readFile(resolve(lab, 'networking-product-state.json'), 'utf8'));
  fixture = JSON.parse(await readFile(resolve(lab, 'networking-lab/state.json'), 'utf8'));
  registered = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
  required(
    fixture.owner === 'ozz-local-networking-lab-v1' &&
      fixture.ip === '192.168.5.15' &&
      baseline.domains.a &&
      baseline.domains.b &&
      fixture.leafValiditySeconds >= 180 &&
      fixture.leafValiditySeconds <= 300,
    'S4_OBSERVATION_FIXTURE_INVALID',
  );
  report.runId = state.runId;
  recovering = true;
  await resumeApi();
  await removeFault();
  recovering = false;
  if (mode !== 'cleanup') {
    const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
    const login = await request('/auth/login', 'POST', { username: 'admin', password });
    cookie = login.response.headers
      .getSetCookie()
      .find((item) => item.startsWith('ozz_session='))
      ?.split(';')[0];
    csrf = login.data.csrfToken;
    required(cookie && csrf, 'S4_OBSERVATION_LOGIN_FAILED');
    const beforeProcesses = {};
    for (const guest of ['a', 'b']) {
      await withCluster(guest, async () => {});
      beforeProcesses[guest] = await processes(guest);
    }
    report.beforeProcesses = beforeProcesses;
    if (['all', 'outage'].includes(mode) && !state.completed.outage) await outage();
    if (['all', 'certificate'].includes(mode) && !state.completed.certificate)
      await certificateFailure();
    const afterProcesses = {};
    for (const guest of ['a', 'b']) afterProcesses[guest] = await processes(guest);
    await check(
      'Pebble accounts/roots and global guest network/trust configuration were preserved',
      ['a', 'b'].every(
        (guest) =>
          hash(beforeProcesses[guest].fixtureProcesses) ===
            hash(afterProcesses[guest].fixtureProcesses) &&
          hash(beforeProcesses[guest].configurationHashes) ===
            hash(afterProcesses[guest].configurationHashes),
      ),
      { afterProcesses },
    );
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = safeFailure(error);
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  recovering = true;
  if (state && fixture) {
    try {
      await resumeApi();
      await removeFault();
      report.cleanup = { apiResumed: true, faultIngressRemoved: true };
    } catch (error) {
      report.cleanup = {
        error: safeFailure(error),
        apiWatchdogSeconds: 55,
        ingressWatchdogSeconds: 420,
      };
      report.status = 'failed';
      process.exitCode = 1;
    }
  }
  report.completedAt = new Date().toISOString();
  if (lock) {
    if (state) await save();
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    await writeFile(
      reportFile.replace('.json', `-${report.status}-${report.attemptId}.json`),
      JSON.stringify(report, null, 2) + '\n',
    );
    await lock.close();
    await unlink(resolve(lab, 'networking-product-state.json.lock'));
  }
  await db.$disconnect();
}
