import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';
import { templateImages } from '../../packages/control-plane/dist/templates/image-assets.js';

// Explicitly run only after the parent S5 probe has migrated the control plane,
// published its providers, and written its runId to both persistent markers.
// This probe owns only its two application consumers and one temporary environment.
// It never writes storage-product-state.json or mutates existing S3/S4 resources.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const stateFile = resolve(lab, 'storage-bindings-state.json');
const parentStateFile = resolve(lab, 'storage-product-state.json');
const mode = process.argv[2];
if (!['run', 'release'].includes(mode)) {
  console.error('Usage: node tests/probes/s5-bindings-local-lab.mjs run|release [--retry-failed]');
  process.exit(2);
}
const retryFailed = process.argv.includes('--retry-failed');
const reportFile = resolve(
  root,
  mode === 'run'
    ? 'docs/acceptance/s5-bindings-local-results.json'
    : 'docs/acceptance/s5-bindings-local-release-results.json',
);
const api = 'http://127.0.0.1:3000/api';
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const engineNames = ['postgresql', 'redis'];
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const safeCode = (value, fallback = 'LOCAL_S5_BINDINGS_INTERRUPTED') =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,99}$/u.test(value) ? value : fallback;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
let state,
  parent,
  registered,
  lock,
  cookie,
  csrf,
  stage = 'preflight';
const report = {
  version: 1,
  status: 'running',
  mode,
  startedAt: new Date().toISOString(),
  scope:
    'Dedicated S5 consumers on retained local ARM64 K3s A, real product API/Worker, PostgreSQL and Redis authentication. Existing fixed-image cache assistance; no cloud or backup/restore acceptance.',
  credentials:
    'Admin password and SSH configuration are read from existing protected files. Database credentials stay inside the dedicated guest/container; reports contain only checks and resource identities.',
  controlledLogProbe:
    'A dedicated consumer emits its own injected URI once. Only redaction/absence booleans are retained; raw Kubernetes and SSE logs are not persisted.',
  checks: [],
};

async function save() {
  const pending = `${stateFile}.pending`;
  await writeFile(pending, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(pending, stateFile);
}
async function check(name, passed, identities = {}) {
  requireValue(passed, `LOCAL_S5_BINDINGS_${name.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, '_')}`);
  const result = { name, passed: true, observedAt: new Date().toISOString(), ...identities };
  const previous = state.checks.findIndex((entry) => entry.name === name);
  if (previous < 0) state.checks.push(result);
  else state.checks[previous] = result;
  console.log(JSON.stringify({ check: name, passed: true }));
  await save();
}
async function phase(name, work) {
  stage = name;
  if (Object.hasOwn(state.completed, name)) return state.completed[name];
  console.log(JSON.stringify({ stage }));
  const result = (await work()) ?? true;
  state.completed[name] = result;
  await save();
  return result;
}
async function responseJson(response) {
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new Error('LOCAL_S5_BINDINGS_API_RESPONSE_INVALID');
  }
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
  const value = await responseJson(response);
  if (expected !== null && (expected !== undefined ? response.status !== expected : !response.ok))
    throw Object.assign(new Error('LOCAL_S5_BINDINGS_API_FAILED'), {
      code: safeCode(value?.code, 'LOCAL_S5_BINDINGS_API_FAILED'),
      status: response.status,
    });
  return { value, response };
}
const data = async (path) => (await request(path)).value.data;
async function waitFor(read, accept, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('LOCAL_S5_BINDINGS_OBSERVATION_TIMEOUT');
}
async function command(label, path, method, body, expected = 202) {
  state.commands[label] ??= { path, method, body, key: randomUUID() };
  const intent = state.commands[label];
  requireValue(
    intent.path === path && intent.method === method,
    'LOCAL_S5_BINDINGS_INTENT_CHANGED',
  );
  await save();
  const result = (await request(path, method, intent.body, intent.key, expected)).value.data;
  requireValue(uuidPattern.test(result.id), 'LOCAL_S5_BINDINGS_COMMAND_ID_INVALID');
  requireValue(!intent.id || intent.id === result.id, 'LOCAL_S5_BINDINGS_IDEMPOTENCY_CHANGED');
  intent.id = result.id;
  await save();
  return result;
}
async function waitTask(type, initial, label) {
  let task = await data(`/${type}/${initial.id}`);
  const deadline = Date.now() + 600_000;
  let prior,
    retries = 0;
  while (Date.now() < deadline) {
    const signature = `${task.status}:${task.phase}:${task.errorCode}`;
    if (signature !== prior) {
      console.log(
        JSON.stringify({
          taskId: task.id,
          status: task.status,
          phase: task.phase,
          code: task.errorCode ? safeCode(task.errorCode) : null,
        }),
      );
      prior = signature;
    }
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed' && retryFailed && retries < 2) {
      requireValue(type === 'deployments', 'LOCAL_S5_BINDINGS_AUTOMATIC_OPERATION_RETRY_FORBIDDEN');
      const service = await data(`/services/${task.serviceId}`);
      task = await command(`${label}:retry:${++retries}`, `/deployments/${task.id}/retry`, 'POST', {
        revision: service.revision,
      });
    } else if (['failed', 'cancelled'].includes(task.status))
      throw Object.assign(new Error('LOCAL_S5_BINDINGS_TASK_FAILED'), {
        code: safeCode(task.errorCode, 'LOCAL_S5_BINDINGS_TASK_FAILED'),
        taskId: task.id,
      });
    else {
      await delay(1000, undefined, { signal: abort.signal });
      task = await data(`/${type}/${task.id}`);
    }
  }
  throw new Error('LOCAL_S5_BINDINGS_TASK_TIMEOUT');
}
async function ownedService(engine, allowCrossEnvironment = false) {
  const id = state.services[engine];
  requireValue(uuidPattern.test(id), 'LOCAL_S5_BINDINGS_CONSUMER_ID_MISSING');
  const value = await data(`/services/${id}`);
  requireValue(
    value.id === id &&
      value.kind === 'application' &&
      value.projectId === state.source.projectId &&
      value.clusterId === state.source.clusterId &&
      (value.environmentId === state.source.environmentId ||
        (allowCrossEnvironment && value.environmentId === state.crossEnvironmentId)) &&
      value.slug === `s5-binding-${engine}-${state.runId.slice(0, 8)}`,
    'LOCAL_S5_BINDINGS_CONSUMER_TARGET_CHANGED',
  );
  return value;
}
const mappings = {
  postgresql: {
    profile: 'fields',
    mapping: {
      host: 'PGHOST',
      port: 'PGPORT',
      database: 'PGDATABASE',
      user: 'PGUSER',
      password: 'PGPASSWORD',
    },
  },
  redis: { profile: 'url', mapping: { url: 'OZZ_REDIS_URL' } },
};
function program(engine) {
  return [
    'set -eu',
    "trap 'exit 0' TERM INT",
    'printf "OZZ_S5_BINDINGS_STARTED:%s\\n" "$OZZ_S5_RUN_ID"',
    engine === 'postgresql'
      ? 'if [ -n "${PGPASSWORD:-}" ]; then printf "OZZ_S5_BINDINGS_URI:%s:postgresql://%s:%s@%s:%s/%s\\n" "$OZZ_S5_RUN_ID" "$PGUSER" "$PGPASSWORD" "$PGHOST" "$PGPORT" "$PGDATABASE"; fi'
      : 'if [ -n "${OZZ_REDIS_URL:-}" ]; then printf "OZZ_S5_BINDINGS_URI:%s:%s\\n" "$OZZ_S5_RUN_ID" "$OZZ_REDIS_URL"; fi',
    'while :; do sleep 5 & wait "$!"; done',
  ].join('\n');
}
function consumerConfiguration(engine) {
  return {
    image: templateImages[engine].deployReference,
    replicas: 1,
    command: ['sh', '-c'],
    args: [program(engine)],
    ports: [],
    resources: {
      requests: { cpuMillis: 25, memoryMiB: 32 },
      limits: { cpuMillis: 250, memoryMiB: 128 },
    },
    environment: [{ name: 'OZZ_S5_RUN_ID', value: state.source.parentRunId, secret: false }],
    readiness: null,
    startup: null,
    healthTimeoutSeconds: 120,
  };
}
async function configureConsumer(engine) {
  const current = await ownedService(engine, true);
  const desired = consumerConfiguration(engine);
  if (same(current.configuration, desired)) return;
  requireValue(
    !current.published && !current.activeTask,
    'LOCAL_S5_BINDINGS_CONFIGURATION_ALREADY_PUBLISHED',
  );
  await request(
    `/services/${current.id}`,
    'PATCH',
    { revision: current.revision, configuration: desired },
    undefined,
    200,
  );
  requireValue(
    same((await ownedService(engine, true)).configuration, desired),
    'LOCAL_S5_BINDINGS_CONFIGURATION_MISMATCH',
  );
}
async function createConsumer(engine, environmentId) {
  if (!state.services[engine]) {
    const created = await command(
      `create:${engine}`,
      '/services',
      'POST',
      {
        projectId: state.source.projectId,
        environmentId,
        name: `S5 ${engine} 连接消费者`,
        slug: `s5-binding-${engine}-${state.runId.slice(0, 8)}`,
        description: `S5 binding probe ${state.runId}; source ${state.source.parentRunId}`,
        template: {
          id: 'docker',
          version: '1.0.0',
          parameters: { image: templateImages[engine].deployReference, port: 8080 },
        },
      },
      201,
    );
    state.services[engine] = created.id;
    await save();
  }
  await ownedService(engine, true);
  await configureConsumer(engine);
}
async function createCrossEnvironment() {
  if (state.crossEnvironmentId) {
    const found = await data(`/environments/${state.crossEnvironmentId}`);
    requireValue(
      found.projectId === state.source.projectId &&
        found.slug === state.crossEnvironmentIntent.slug,
      'LOCAL_S5_BINDINGS_ENVIRONMENT_CHANGED',
    );
    return;
  }
  state.crossEnvironmentIntent ??= {
    projectId: state.source.projectId,
    name: 'S5 连接隔离验证',
    slug: `s5-binding-check-${state.runId.slice(0, 8)}`,
    description: `S5 binding probe ${state.runId}; metadata-only cross-environment check`,
  };
  await save();
  const all = (await request(`/environments?projectId=${state.source.projectId}&limit=100`)).value;
  requireValue(!all.page.hasMore, 'LOCAL_S5_BINDINGS_ENVIRONMENT_LIST_TRUNCATED');
  const matches = all.data.filter((entry) => entry.slug === state.crossEnvironmentIntent.slug);
  requireValue(matches.length < 2, 'LOCAL_S5_BINDINGS_ENVIRONMENT_AMBIGUOUS');
  let environment = matches[0];
  if (environment)
    requireValue(
      environment.description === state.crossEnvironmentIntent.description,
      'LOCAL_S5_BINDINGS_UNOWNED_ENVIRONMENT',
    );
  else
    environment = (
      await request('/environments', 'POST', state.crossEnvironmentIntent, undefined, 201)
    ).value.data;
  state.crossEnvironmentId = environment.id;
  await save();
}
async function crossEnvironment() {
  await createCrossEnvironment();
  await createConsumer('postgresql', state.crossEnvironmentId);
  await phase('cross-environment:reject', async () => {
    const current = await ownedService('postgresql', true);
    requireValue(
      current.environmentId === state.crossEnvironmentId &&
        !current.published &&
        !current.activeTask,
      'LOCAL_S5_BINDINGS_CROSS_ENVIRONMENT_PRECONDITION',
    );
    const rejected = await request(
      `/services/${current.id}/database-bindings`,
      'POST',
      {
        revision: current.revision,
        databaseInstanceId: state.source.providers.postgresql.databaseId,
        ...mappings.postgresql,
      },
      undefined,
      422,
    );
    const after = await ownedService('postgresql', true);
    const bindings = (await request(`/services/${current.id}/database-bindings`)).value;
    await check(
      'cross_environment_rejected_without_draft_change',
      rejected.value.code === 'DATABASE_TARGET_MISMATCH' &&
        after.revision === current.revision &&
        bindings.data.length === 0 &&
        !after.published,
      { serviceId: current.id, environmentId: state.crossEnvironmentId },
    );
  });
  await phase('cross-environment:move-before-first-publication', async () => {
    let current = await ownedService('postgresql', true);
    requireValue(
      !current.published && !current.remoteCreatedAt && !current.activeTask,
      'LOCAL_S5_BINDINGS_MOVE_REQUIRES_UNPUBLISHED_CONSUMER',
    );
    if (current.environmentId !== state.source.environmentId)
      await request(
        `/services/${current.id}`,
        'PATCH',
        { revision: current.revision, environmentId: state.source.environmentId },
        undefined,
        200,
      );
    current = await ownedService('postgresql');
    return { serviceId: current.id, environmentId: current.environmentId };
  });
}
async function publish(engine, label) {
  const current = await ownedService(engine);
  const accepted = await command(label, `/services/${current.id}/deployments`, 'POST', {
    revision: current.revision,
  });
  const task = await waitTask('deployments', accepted, label);
  const service = await waitFor(
    () => ownedService(engine),
    (item) =>
      !item.observationStale &&
      item.runtimeState === 'running' &&
      item.published?.deploymentId === task.id &&
      item.observation?.pods.some((pod) => pod.ready && !pod.deletionTimestamp),
  );
  return { service, task };
}
function selectedPod(service) {
  const pods =
    service.observation?.pods.filter(
      (pod) =>
        pod.ready && !pod.deletionTimestamp && pod.snapshotId === service.published?.deploymentId,
    ) ?? [];
  requireValue(
    pods.length === 1 && pods[0].owner && service.observation?.controller?.kind === 'Deployment',
    'LOCAL_S5_BINDINGS_POD_IDENTITY_UNAVAILABLE',
  );
  return pods[0];
}

// Named reads verify kube-system, Pod -> ReplicaSet -> Deployment and the exact
// immutable runtime Secret. CLI output and secret values never leave this process.
const remoteSource = String.raw`import base64,json,re,subprocess,sys,urllib.parse
from pathlib import Path
m=json.load(sys.stdin)
def need(ok,code):
 if not ok: raise RuntimeError(code)
def kube(args):
 p=subprocess.run(['k3s','kubectl']+args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=25)
 need(p.returncode==0 and len(p.stdout)<=2097152,'S5_BINDINGS_KUBERNETES_FAILED')
 return p.stdout
need(Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-a','S5_BINDINGS_GUEST_CHANGED')
t=m['target']; pod_id=m['pod']; snapshot=m['snapshotId']; marker=m['marker']; engine=m['engine']
need(engine in ['postgresql','redis'] and re.fullmatch(r'[a-f0-9-]{36}',marker),'S5_BINDINGS_INPUT_INVALID')
need(t['namespace']=='ozz-e-'+t['environmentId'].replace('-',''),'S5_BINDINGS_NAMESPACE_CHANGED')
system=json.loads(kube(['get','namespace','kube-system','-o','json']))
need(system['metadata']['uid']==m['kubeSystemUid'],'S5_BINDINGS_CLUSTER_CHANGED')
labels={'app.kubernetes.io/managed-by':'ozz','ozz.dev/installation-id':t['installationId'],'ozz.dev/cluster-id':t['clusterId'],'ozz.dev/project-id':t['projectId'],'ozz.dev/environment-id':t['environmentId'],'ozz.dev/service-id':t['serviceId']}
def named(kind,name):
 return json.loads(kube(['-n',t['namespace'],'get',kind,name,'-o','json']))
def owned(value):
 meta=value.get('metadata',{})
 need(meta.get('namespace')==t['namespace'] and all(meta.get('labels',{}).get(k)==v for k,v in labels.items()),'S5_BINDINGS_OWNERSHIP_CHANGED')
def fence():
 pod=named('pod',pod_id['name']); owned(pod)
 need(pod['metadata']['uid']==pod_id['uid'] and not pod['metadata'].get('deletionTimestamp'),'S5_BINDINGS_POD_CHANGED')
 need(pod['metadata'].get('labels',{}).get('ozz.dev/snapshot-id')==snapshot,'S5_BINDINGS_SNAPSHOT_CHANGED')
 owners=[o for o in pod['metadata'].get('ownerReferences',[]) if o.get('controller')]
 need(len(owners)==1 and owners[0]['kind']=='ReplicaSet' and owners[0]['apiVersion']=='apps/v1' and owners[0]['uid']==pod_id['owner']['uid'],'S5_BINDINGS_REPLICASET_CHANGED')
 owner=owners[0]; rs=named('replicaset',owner['name']); owned(rs)
 need(rs['metadata']['uid']==owner['uid'],'S5_BINDINGS_REPLICASET_REPLACED')
 roots=[o for o in rs['metadata'].get('ownerReferences',[]) if o.get('controller')]
 need(len(roots)==1 and roots[0]['kind']=='Deployment' and roots[0]['apiVersion']=='apps/v1','S5_BINDINGS_CONTROLLER_CHANGED')
 root_name='ozz-s-'+t['serviceId'].replace('-','')
 need(roots[0]['name']==root_name and roots[0]['uid']==m['controllerUid'],'S5_BINDINGS_CONTROLLER_REPLACED')
 controller=named('deployment',root_name); owned(controller)
 need(controller['metadata']['uid']==m['controllerUid'] and not controller['metadata'].get('deletionTimestamp'),'S5_BINDINGS_CONTROLLER_REPLACED')
 need(controller['spec']['template']['metadata'].get('labels',{}).get('ozz.dev/snapshot-id')==snapshot,'S5_BINDINGS_CONTROLLER_SNAPSHOT_CHANGED')
 containers=[c for c in pod['spec']['containers'] if c['name']=='app']
 need(len(containers)==1,'S5_BINDINGS_CONTAINER_CHANGED')
 expected_secret='ozz-r-'+snapshot.replace('-','')
 refs=containers[0].get('envFrom',[])
 need(len(refs)==1 and refs[0].get('secretRef',{}).get('name')==expected_secret,'S5_BINDINGS_RUNTIME_REFERENCE_CHANGED')
 secret=named('secret',expected_secret); owned(secret)
 need(secret.get('immutable') is True and secret['metadata'].get('labels',{}).get('ozz.dev/snapshot-id')==snapshot,'S5_BINDINGS_RUNTIME_SECRET_CHANGED')
 env={k:base64.b64decode(v,validate=True).decode() for k,v in secret.get('data',{}).items()}
 need(env.get('OZZ_S5_RUN_ID')==marker,'S5_BINDINGS_CONSUMER_MARKER_CHANGED')
 return pod,secret,env
pod,secret,env=fence()
present=bool(env.get('PGPASSWORD')) if engine=='postgresql' else bool(env.get('OZZ_REDIS_URL'))
result={'podUid':pod_id['uid'],'controllerUid':m['controllerUid'],'snapshotId':snapshot,'runtimeSecretUid':secret['metadata']['uid'],'bound':present}
def container(args):
 return kube(['-n',t['namespace'],'exec',pod_id['name'],'-c','app','--']+args)
if m['action']=='unbound':
 need(not present,'S5_BINDINGS_UNEXPECTED_HOT_UPDATE')
 code='test -z "$PGPASSWORD"' if engine=='postgresql' else 'test -z "$OZZ_REDIS_URL"'
 container(['sh','-c',code])
 result['liveEnvironmentAbsent']=True
else:
 need(present,'S5_BINDINGS_RUNTIME_NOT_INJECTED')
 if engine=='postgresql':
  password=env['PGPASSWORD']; host=env['PGHOST']; port=int(env['PGPORT']); user=env['PGUSER']; database=env['PGDATABASE']
  uri='postgresql://'+urllib.parse.quote(user,safe='')+':'+urllib.parse.quote(password,safe='')+'@'+host+':'+str(port)+'/'+urllib.parse.quote(database,safe='')
  command=['psql','-v','ON_ERROR_STOP=1','-qAt','-c',"SELECT value FROM ozz_s5_probe WHERE id='persistent';"]
 else:
  uri=env['OZZ_REDIS_URL']; parsed=urllib.parse.urlsplit(uri)
  need(parsed.scheme=='redis' and parsed.username=='default' and parsed.password is not None,'S5_BINDINGS_URI_INVALID')
  password=urllib.parse.unquote(parsed.password); host=parsed.hostname; port=parsed.port; database=parsed.path[1:]; user=parsed.username
  need(re.fullmatch(r'[A-Za-z0-9_-]{43}',password) is not None and parsed.password==password,'S5_BINDINGS_GENERATED_CREDENTIAL_FORMAT_CHANGED')
  command=['sh','-c','v="@{OZZ_REDIS_URL#redis://}"; a="@{v%%@*}"; h="@{v#*@}"; hp="@{h%%/*}"; n="@{h#*/}"; export REDISCLI_AUTH="@{a#*:}"; exec redis-cli --no-auth-warning --raw -h "@{hp%:*}" -p "@{hp##*:}" -n "$n" GET ozz:s5:persistent'.replace('@{',chr(36)+'{')]
 expected=m['provider']
 need(host==expected['host'] and port==expected['port'] and user==expected['username'] and str(database)==str(expected['database']),'S5_BINDINGS_PROVIDER_OUTPUT_CHANGED')
 value=container(command).decode().strip()
 result['markerMatches']=value==marker
 tokens=[password,urllib.parse.quote(password,safe=''),uri]
 public=m.get('publicBytes','')
 result['publicSecretAbsent']=all(token not in public for token in tokens)
 if m['action']=='secrecy':
  raw=kube(['-n',t['namespace'],'logs',pod_id['name'],'-c','app','--tail=100','--limit-bytes=65536']).decode()
  prefix='OZZ_S5_BINDINGS_URI:'+marker+':'
  result['sourceUriLogged']=(prefix+uri) in raw
  result['sseRedacted']=(prefix+'[REDACTED]') in m['sseText']
  result['sseSecretAbsent']=all(token not in m['sseText'] and token not in m['sseRaw'] for token in tokens)
fence()
print(json.dumps(result))
`;
const booleanFields = [
  'bound',
  'liveEnvironmentAbsent',
  'markerMatches',
  'publicSecretAbsent',
  'sourceUriLogged',
  'sseRedacted',
  'sseSecretAbsent',
];
async function remote(engine, service, task, action, extras = {}) {
  const pod = selectedPod(service);
  const provider = state.source.providers[engine];
  const payload = {
    action,
    engine,
    marker: state.source.parentRunId,
    kubeSystemUid: state.source.kubeSystemUid,
    target: task.target,
    snapshotId: task.id,
    controllerUid: service.observation.controller.uid,
    pod: { name: pod.name, uid: pod.uid, owner: pod.owner },
    provider: {
      host: provider.host,
      port: provider.port,
      username: provider.username,
      database: provider.database,
    },
    ...extras,
  };
  requireValue(
    task.target.serviceId === service.id &&
      task.target.projectId === state.source.projectId &&
      task.target.environmentId === state.source.environmentId &&
      task.target.clusterId === state.source.clusterId &&
      task.id === service.published.deploymentId,
    'LOCAL_S5_BINDINGS_REMOTE_TARGET_CHANGED',
  );
  const quoted = `'${remoteSource.replaceAll("'", "'\\''")}'`;
  return new Promise((accept, reject) => {
    const child = execFile(
      'ssh',
      [
        '-F',
        resolve(lab, 'credentials/ssh_config'),
        '-T',
        'ozz-lab-a',
        `sudo python3 -c ${quoted}`,
      ],
      { timeout: 55_000, maxBuffer: 64 * 1024, signal: abort.signal },
      (error, stdout, stderr) => {
        if (error) {
          const controlled = /RuntimeError: (S5_BINDINGS_[A-Z0-9_]{1,80})/u.exec(stderr)?.[1];
          return reject(
            new Error(controlled ? `LOCAL_${controlled}` : 'LOCAL_S5_BINDINGS_REMOTE_PROBE_FAILED'),
          );
        }
        try {
          const value = JSON.parse(stdout);
          requireValue(
            value.podUid === pod.uid &&
              value.snapshotId === task.id &&
              value.controllerUid === service.observation.controller.uid &&
              uuidPattern.test(value.runtimeSecretUid),
            'LOCAL_S5_BINDINGS_REMOTE_RECEIPT_CHANGED',
          );
          requireValue(
            Object.keys(value).every((key) =>
              [
                'podUid',
                'snapshotId',
                'controllerUid',
                'runtimeSecretUid',
                ...booleanFields,
              ].includes(key),
            ),
            'LOCAL_S5_BINDINGS_REMOTE_OUTPUT_INVALID',
          );
          for (const key of booleanFields)
            requireValue(
              value[key] === undefined || typeof value[key] === 'boolean',
              'LOCAL_S5_BINDINGS_REMOTE_OUTPUT_INVALID',
            );
          accept(value);
        } catch {
          reject(new Error('LOCAL_S5_BINDINGS_REMOTE_RECEIPT_INVALID'));
        }
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
async function baseline(engine) {
  const { service, task } = await publish(engine, `baseline:${engine}`);
  requireValue(
    task.snapshot.version === 2 &&
      task.snapshot.database === null &&
      task.snapshot.databaseBindings.length === 0 &&
      task.snapshot.volumes.length === 0,
    'LOCAL_S5_BINDINGS_BASELINE_NOT_EMPTY',
  );
  const observed = await remote(engine, service, task, 'unbound');
  const deployments = (await request(`/deployments?serviceId=${service.id}&limit=100`)).value;
  requireValue(
    !deployments.page.hasMore && deployments.data.some((entry) => entry.id === task.id),
    'LOCAL_S5_BINDINGS_BASELINE_DEPLOYMENT_LIST_INVALID',
  );
  await check(
    `${engine}_baseline_has_no_database_environment`,
    !observed.bound && observed.liveEnvironmentAbsent,
    { serviceId: service.id, deploymentId: task.id, podUid: observed.podUid },
  );
  return {
    serviceId: service.id,
    deploymentId: task.id,
    configRevision: service.configRevision,
    podUid: observed.podUid,
    runtimeSecretUid: observed.runtimeSecretUid,
    snapshotHash: hash(task.snapshot),
    deploymentIds: deployments.data.map((entry) => entry.id).sort(),
  };
}
async function saveBinding(engine) {
  const original = state.completed[`baseline:${engine}`];
  let service = await ownedService(engine);
  const provider = state.source.providers[engine];
  state.bindingIntents[engine] ??= {
    revision: service.revision,
    configRevision: service.configRevision,
    databaseInstanceId: provider.databaseId,
    ...mappings[engine],
  };
  const intent = state.bindingIntents[engine];
  await save();
  let collection = (await request(`/services/${service.id}/database-bindings`)).value;
  let binding = collection.data.find(
    (entry) => entry.databaseInstanceId === provider.databaseId && entry.desired,
  );
  if (!binding) {
    requireValue(
      service.revision === intent.revision &&
        service.configRevision === intent.configRevision &&
        collection.data.length === 0,
      'LOCAL_S5_BINDINGS_DRAFT_CHANGED',
    );
    collection = (
      await request(
        `/services/${service.id}/database-bindings`,
        'POST',
        {
          revision: intent.revision,
          databaseInstanceId: intent.databaseInstanceId,
          profile: intent.profile,
          mapping: intent.mapping,
        },
        undefined,
        200,
      )
    ).value;
    binding = collection.data.find(
      (entry) => entry.databaseInstanceId === provider.databaseId && entry.desired,
    );
  }
  requireValue(
    binding &&
      binding.profile === intent.profile &&
      same(binding.mapping, intent.mapping) &&
      collection.serviceRevision === intent.revision + 1 &&
      collection.configRevision === intent.configRevision + 1,
    'LOCAL_S5_BINDINGS_DRAFT_RECEIPT_CHANGED',
  );
  state.bindings[engine] = binding.id;
  await save();
  await delay(1500, undefined, { signal: abort.signal });
  service = await ownedService(engine);
  const task = await data(`/deployments/${original.deploymentId}`);
  const observed = await remote(engine, service, task, 'unbound');
  const tasks = (await request(`/deployments?serviceId=${service.id}&limit=100`)).value;
  await check(
    `${engine}_saving_binding_does_not_hot_update`,
    service.published.deploymentId === original.deploymentId &&
      hash(task.snapshot) === original.snapshotHash &&
      observed.podUid === original.podUid &&
      observed.runtimeSecretUid === original.runtimeSecretUid &&
      observed.liveEnvironmentAbsent &&
      !service.activeTask &&
      !binding.published &&
      !tasks.page.hasMore &&
      same(tasks.data.map((entry) => entry.id).sort(), original.deploymentIds),
    {
      serviceId: service.id,
      bindingId: binding.id,
      deploymentId: task.id,
      podUid: observed.podUid,
      draftConfigRevision: collection.configRevision,
    },
  );
  return {
    bindingId: binding.id,
    serviceRevision: collection.serviceRevision,
    configRevision: collection.configRevision,
  };
}
async function publicBytes(engine, service, task) {
  const baseline = state.completed[`baseline:${engine}`];
  const original = await data(`/deployments/${baseline.deploymentId}`);
  requireValue(
    hash(original.snapshot) === baseline.snapshotHash,
    'LOCAL_S5_BINDINGS_ORIGINAL_SNAPSHOT_CHANGED',
  );
  const secret = await data(`/secrets/${state.source.providers[engine].credentialRefId}`);
  requireValue(
    ['encryptedPayload', 'nonce', 'tag', 'payload'].every((key) => !Object.hasOwn(secret, key)),
    'LOCAL_S5_BINDINGS_PUBLIC_CREDENTIAL_PAYLOAD_PRESENT',
  );
  const bindings = (await request(`/services/${service.id}/database-bindings`)).value;
  return JSON.stringify({ service, task, original, secret, bindings });
}
async function publishBound(engine) {
  const { service, task } = await publish(engine, `bound:${engine}`);
  const provider = state.source.providers[engine];
  const refs = task.snapshot.databaseBindings;
  requireValue(
    task.snapshot.version === 2 &&
      refs.length === 1 &&
      refs[0].bindingId === state.bindings[engine] &&
      refs[0].databaseInstanceId === provider.databaseId &&
      refs[0].providerServiceId === provider.serviceId &&
      refs[0].credentialRefId === provider.credentialRefId &&
      refs[0].credentialContentRevision === provider.credentialContentRevision &&
      refs[0].profile === mappings[engine].profile &&
      same(refs[0].mapping, mappings[engine].mapping),
    'LOCAL_S5_BINDINGS_SNAPSHOT_REFERENCE_CHANGED',
  );
  const observed = await remote(engine, service, task, 'auth', {
    publicBytes: await publicBytes(engine, service, task),
  });
  await check(
    `${engine}_explicit_publication_authenticates_original_data`,
    observed.bound &&
      observed.markerMatches &&
      observed.publicSecretAbsent &&
      observed.podUid !== state.completed[`baseline:${engine}`].podUid,
    {
      serviceId: service.id,
      deploymentId: task.id,
      podUid: observed.podUid,
      databaseId: provider.databaseId,
      providerDeploymentId: refs[0].providerDeploymentId,
      providerServiceUid: refs[0].providerServiceUid,
      credentialRefId: refs[0].credentialRefId,
      credentialContentRevision: refs[0].credentialContentRevision,
    },
  );
  return { deploymentId: task.id, podUid: observed.podUid, snapshotHash: hash(task.snapshot) };
}
async function sse(engine) {
  const service = await ownedService(engine);
  requireValue(
    service.published?.deploymentId === state.completed[`publish-binding:${engine}`].deploymentId,
    'LOCAL_S5_BINDINGS_SSE_PUBLICATION_CHANGED',
  );
  const task = await data(`/deployments/${service.published.deploymentId}`);
  const pod = selectedPod(service);
  const response = await fetch(
    `${api}/services/${service.id}/logs?${new URLSearchParams({ podUid: pod.uid, container: 'app', follow: 'false', previous: 'false', tailLines: '100' })}`,
    {
      headers: { cookie, origin, 'x-csrf-token': csrf },
      signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(30_000)]),
    },
  );
  requireValue(
    response.status === 200 &&
      response.headers.get('content-type')?.startsWith('text/event-stream'),
    'LOCAL_S5_BINDINGS_SSE_FAILED',
  );
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      requireValue(bytes <= 1024 * 1024, 'LOCAL_S5_BINDINGS_SSE_TOO_LARGE');
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel();
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let text = '',
    ended = false;
  for (const frame of raw.replaceAll('\r\n', '\n').split('\n\n')) {
    const lines = frame.split('\n');
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    if (!event) continue;
    const payload = JSON.parse(
      lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    );
    if (event === 'log') {
      requireValue(typeof payload.text === 'string', 'LOCAL_S5_BINDINGS_SSE_EVENT_INVALID');
      text += payload.text;
    } else if (event === 'end') ended = payload.reason === 'eof';
  }
  requireValue(ended, 'LOCAL_S5_BINDINGS_SSE_NOT_COMPLETE');
  const observed = await remote(engine, service, task, 'secrecy', {
    publicBytes: await publicBytes(engine, service, task),
    sseText: text,
    sseRaw: raw,
  });
  await check(
    `${engine}_real_uri_is_redacted_in_product_sse`,
    observed.sourceUriLogged &&
      observed.sseRedacted &&
      observed.sseSecretAbsent &&
      observed.publicSecretAbsent &&
      observed.markerMatches,
    {
      serviceId: service.id,
      podUid: pod.uid,
      deploymentId: task.id,
      sseBytes: bytes,
      rawLogsPersisted: false,
    },
  );
}
async function providerDeletionRejected(engine) {
  const provider = state.source.providers[engine];
  const current = await data(`/services/${provider.serviceId}`);
  requireValue(
    current.projectId === state.source.projectId &&
      current.environmentId === state.source.environmentId &&
      current.databaseInstanceId === provider.databaseId,
    'LOCAL_S5_BINDINGS_PROVIDER_TARGET_CHANGED',
  );
  const preview = (
    await request(
      `/services/${current.id}/deletion-preview`,
      'POST',
      { revision: current.revision },
      undefined,
      200,
    )
  ).value.data;
  requireValue(
    preview.blockers.some((entry) => entry.code === 'DATABASE_DEPENDENCY_IN_USE') &&
      preview.databaseConsumers.some(
        (entry) => entry.serviceId === state.services[engine] && entry.desired && entry.published,
      ),
    'LOCAL_S5_BINDINGS_PROVIDER_DEPENDENCY_NOT_RECORDED',
  );
  state.deleteKeys[engine] ??= randomUUID();
  await save();
  const response = await fetch(api + `/services/${current.id}`, {
    method: 'DELETE',
    headers: {
      origin,
      cookie,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      'idempotency-key': state.deleteKeys[engine],
    },
    body: JSON.stringify({ revision: current.revision }),
    signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(20_000)]),
  });
  const value = await responseJson(response);
  if (response.status === 202 && uuidPattern.test(value?.data?.id)) {
    // Cancel only this probe's unexpectedly accepted task; never retry it.
    state.unexpectedDeletion = { engine, taskId: value.data.id, providerServiceId: current.id };
    await save();
    await request(`/operations/${value.data.id}/cancel`, 'POST', undefined, undefined, 202);
    throw new Error('LOCAL_S5_BINDINGS_PROVIDER_DELETION_UNEXPECTEDLY_ACCEPTED');
  }
  requireValue(
    response.status === 409 && value?.code === 'DATABASE_DEPENDENCY_IN_USE',
    'LOCAL_S5_BINDINGS_PROVIDER_DELETION_NOT_REJECTED',
  );
  const after = await data(`/services/${current.id}`);
  await check(
    `${engine}_in_use_provider_delete_is_rejected`,
    after.revision === current.revision &&
      after.published?.deploymentId === current.published?.deploymentId &&
      !after.activeTask,
    {
      providerServiceId: current.id,
      consumerServiceId: state.services[engine],
      httpStatus: response.status,
    },
  );
}
function protectedIdentity(database) {
  return {
    id: database.id,
    engine: database.engine,
    majorVersion: database.majorVersion,
    exactVersion: database.exactVersion,
    originalService: database.originalService,
    dataVolume: database.dataVolume,
    credential: database.credential,
    protection: database.protection,
    initialization: database.initialization,
  };
}
async function rejectedConfiguration(service, configuration, expectedStatus, code) {
  const response = await request(
    `/services/${service.id}`,
    'PATCH',
    { revision: service.revision, configuration },
    undefined,
    null,
  );
  if (response.response.ok) {
    // A failed negative assertion may have changed only a draft. Restore that
    // exact draft immediately without requesting a workload publication.
    const after = await data(`/services/${service.id}`);
    await request(
      `/services/${service.id}`,
      'PATCH',
      { revision: after.revision, configuration: service.configuration },
      undefined,
      200,
    );
    throw new Error('LOCAL_S5_BINDINGS_PROTECTED_UPDATE_UNEXPECTEDLY_ACCEPTED');
  }
  requireValue(
    response.response.status === expectedStatus && response.value?.code === code,
    'LOCAL_S5_BINDINGS_PROTECTED_UPDATE_NOT_REJECTED',
  );
  const after = await data(`/services/${service.id}`);
  requireValue(
    after.revision === service.revision &&
      after.configRevision === service.configRevision &&
      same(after.configuration, service.configuration) &&
      after.published?.deploymentId === service.published?.deploymentId &&
      !after.activeTask,
    'LOCAL_S5_BINDINGS_REJECTED_UPDATE_CHANGED_SERVICE',
  );
}
async function databaseConfigurationRejected(engine) {
  const provider = state.source.providers[engine];
  const current = await data(`/services/${provider.serviceId}`);
  const before = await data(`/databases/${provider.databaseId}`);
  requireValue(
    current.projectId === state.source.projectId &&
      current.environmentId === state.source.environmentId &&
      current.databaseInstanceId === provider.databaseId &&
      before.protection.active &&
      !current.activeTask,
    'LOCAL_S5_BINDINGS_DATABASE_UPDATE_TARGET_CHANGED',
  );
  await rejectedConfiguration(
    current,
    {
      ...current.configuration,
      image: templateImages[engine === 'postgresql' ? 'redis' : 'postgresql'].deployReference,
    },
    409,
    'DATABASE_DATA_PROTECTED',
  );
  await rejectedConfiguration(
    current,
    {
      ...current.configuration,
      environment: [
        {
          name: engine === 'postgresql' ? 'POSTGRES_PASSWORD' : 'REDIS_PASSWORD',
          value: `s5-forbidden-password-change-${state.runId}`,
          secret: true,
        },
      ],
    },
    409,
    'DATABASE_DATA_PROTECTED',
  );
  const consumer = await ownedService(engine);
  await rejectedConfiguration(
    consumer,
    {
      ...consumer.configuration,
      environment: [
        ...consumer.configuration.environment,
        {
          name: 'OZZ_FORBIDDEN_DATABASE_PASSWORD',
          secretRefId: provider.credentialRefId,
          secretKey: 'password',
        },
      ],
    },
    422,
    'SERVICE_SECRET_INVALID',
  );
  const after = await data(`/databases/${provider.databaseId}`);
  await check(
    `${engine}_ordinary_image_and_credential_updates_are_blocked`,
    same(protectedIdentity(before), protectedIdentity(after)),
    {
      providerServiceId: current.id,
      databaseId: provider.databaseId,
      pvcUid: provider.pvcUid,
      credentialRefId: provider.credentialRefId,
      credentialContentRevision: provider.credentialContentRevision,
    },
  );
}
async function sourceIdentity() {
  parent = JSON.parse(await readFile(parentStateFile, 'utf8'));
  registered = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
  requireValue(
    parent.version === 1 &&
      uuidPattern.test(parent.runId) &&
      uuidPattern.test(parent.projects?.a) &&
      uuidPattern.test(parent.environments?.a) &&
      uuidPattern.test(registered.clusters?.a),
    'LOCAL_S5_BINDINGS_PARENT_STATE_NOT_READY',
  );
  const project = await data(`/projects/${parent.projects.a}`);
  requireValue(
    project.clusterId === registered.clusters.a &&
      project.slug === `s5-data-a-${parent.runId.slice(0, 8)}`,
    'LOCAL_S5_BINDINGS_PARENT_PROJECT_CHANGED',
  );
  const cluster = await data(`/clusters/${registered.clusters.a}`);
  requireValue(cluster.identity?.kubeSystemUid, 'LOCAL_S5_BINDINGS_CLUSTER_UNVERIFIED');
  const source = {
    parentRunId: parent.runId,
    projectId: parent.projects.a,
    environmentId: parent.environments.a,
    clusterId: registered.clusters.a,
    kubeSystemUid: cluster.identity.kubeSystemUid,
    providers: {},
  };
  for (const engine of engineNames) {
    requireValue(
      uuidPattern.test(parent.services?.[engine]),
      'LOCAL_S5_BINDINGS_PARENT_PROVIDER_MISSING',
    );
    const service = await data(`/services/${parent.services[engine]}`);
    const database = await data(`/databases/${service.databaseInstanceId}`);
    requireValue(
      service.projectId === source.projectId &&
        service.environmentId === source.environmentId &&
        service.clusterId === source.clusterId &&
        database.engine === engine &&
        database.service?.id === service.id &&
        database.dataVolume.id === parent.volumes[engine] &&
        database.dataVolume.pvcUid &&
        database.protection.active,
      'LOCAL_S5_BINDINGS_PARENT_DATA_IDENTITY_CHANGED',
    );
    if (mode === 'run')
      requireValue(
        database.databaseReady && !service.activeTask && service.runtimeState === 'running',
        'LOCAL_S5_BINDINGS_PARENT_DATA_NOT_READY',
      );
    source.providers[engine] = {
      serviceId: service.id,
      databaseId: database.id,
      volumeId: database.dataVolume.id,
      pvcUid: database.dataVolume.pvcUid,
      credentialRefId: database.credential.refId,
      credentialContentRevision: database.credential.contentRevision,
      host: database.connection.host,
      port: database.connection.port,
      username: database.connection.username,
      database:
        engine === 'postgresql' ? database.connection.database : database.connection.redisDatabase,
    };
  }
  return source;
}
async function initialize() {
  await mkdir(lab, { recursive: true, mode: 0o700 });
  lock = await open(`${stateFile}.lock`, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: report.startedAt }));
  const passwordFile = resolve(root, '.secrets/admin-password');
  const [passwordStat, sshStat] = await Promise.all([
    stat(passwordFile),
    stat(resolve(lab, 'credentials/ssh_config')),
  ]);
  requireValue(
    passwordStat.isFile() &&
      (passwordStat.mode & 0o077) === 0 &&
      sshStat.isFile() &&
      (sshStat.mode & 0o077) === 0,
    'LOCAL_S5_BINDINGS_PROTECTED_CREDENTIAL_FILE_REQUIRED',
  );
  const password = (await readFile(passwordFile, 'utf8')).trim();
  const login = await request('/auth/login', 'POST', { username: 'admin', password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  requireValue(cookie && csrf, 'LOCAL_S5_BINDINGS_LOGIN_FAILED');
  const source = await sourceIdentity();
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('LOCAL_S5_BINDINGS_STATE_INVALID');
  }
  if (state)
    requireValue(
      state.version === 1 && same(state.source, source),
      'LOCAL_S5_BINDINGS_SOURCE_CHANGED',
    );
  else {
    requireValue(mode === 'run', 'LOCAL_S5_BINDINGS_RELEASE_STATE_MISSING');
    state = {
      version: 1,
      runId: randomUUID(),
      startedAt: report.startedAt,
      source,
      services: {},
      commands: {},
      completed: {},
      bindings: {},
      bindingIntents: {},
      deleteKeys: {},
      checks: [],
    };
  }
  requireValue(mode !== 'run' || !state.released, 'LOCAL_S5_BINDINGS_ALREADY_RELEASED');
  report.runId = state.runId;
  report.parentRunId = source.parentRunId;
  report.checks = state.checks;
  await save();
}
async function release() {
  for (const engine of engineNames)
    if (state.services[engine])
      await phase(`release:${engine}`, async () => {
        const label = `release:${engine}`;
        const serviceId = state.services[engine];
        const intent = state.commands[label];
        let body;
        if (intent) {
          requireValue(
            uuidPattern.test(serviceId) &&
              intent.path === `/services/${serviceId}` &&
              intent.method === 'DELETE' &&
              Number.isInteger(intent.body?.revision) &&
              Object.keys(intent.body).length === 1,
            'LOCAL_S5_BINDINGS_RELEASE_INTENT_CHANGED',
          );
          body = intent.body;
        } else {
          const current = await ownedService(engine);
          requireValue(!current.databaseInstanceId, 'LOCAL_S5_BINDINGS_RELEASE_DATABASE_FORBIDDEN');
          const volumes = (await request(`/services/${current.id}/volume-mounts`)).value;
          requireValue(volumes.data.length === 0, 'LOCAL_S5_BINDINGS_RELEASE_VOLUME_FORBIDDEN');
          body = { revision: current.revision };
        }
        const task = await command(label, `/services/${serviceId}`, 'DELETE', body);
        await waitTask('operations', task, label);
        await request(`/services/${serviceId}`, 'GET', undefined, undefined, 404);
        return { serviceId, operationId: task.id };
      });
  state.released = true;
  await save();
  report.status = 'passed';
}

try {
  await initialize();
  if (mode === 'release') await release();
  else {
    await crossEnvironment();
    await phase('create:redis', () => createConsumer('redis', state.source.environmentId));
    for (const engine of engineNames) {
      await phase(`baseline:${engine}`, () => baseline(engine));
      await phase(`save-binding:${engine}`, () => saveBinding(engine));
      await phase(`publish-binding:${engine}`, () => publishBound(engine));
      await phase(`sse:${engine}`, () => sse(engine));
      await phase(`provider-delete:${engine}`, () => providerDeletionRejected(engine));
      await phase(`protected-config:${engine}`, () => databaseConfigurationRejected(engine));
    }
    await phase('final:both-consumers-read-original-markers', async () => {
      for (const engine of engineNames) {
        const service = await ownedService(engine);
        const published = state.completed[`publish-binding:${engine}`];
        requireValue(
          service.published?.deploymentId === published.deploymentId,
          'LOCAL_S5_BINDINGS_FINAL_PUBLICATION_CHANGED',
        );
        const task = await data(`/deployments/${service.published.deploymentId}`);
        requireValue(
          hash(task.snapshot) === published.snapshotHash,
          'LOCAL_S5_BINDINGS_FINAL_SNAPSHOT_CHANGED',
        );
        const observed = await remote(engine, service, task, 'auth', {
          publicBytes: await publicBytes(engine, service, task),
        });
        await check(
          `${engine}_final_live_binding_authentication`,
          observed.markerMatches && observed.publicSecretAbsent,
          { serviceId: service.id, podUid: observed.podUid, deploymentId: task.id },
        );
      }
    });
    report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    code: safeCode(error.code ?? error.message),
    taskId: uuidPattern.test(error.taskId) ? error.taskId : null,
    httpStatus: Number.isInteger(error.status) ? error.status : null,
  };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  if (state) {
    report.resources = {
      sourceProjectId: state.source.projectId,
      sourceEnvironmentId: state.source.environmentId,
      consumerServices: state.services,
      crossEnvironmentId: state.crossEnvironmentId ?? null,
      bindings: state.bindings,
      released: state.released ?? false,
    };
    if (lock) await save();
  }
  if (lock) {
    await lock.close();
    await unlink(`${stateFile}.lock`);
  }
  await mkdir(resolve(root, 'docs/acceptance'), { recursive: true });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (report.status === 'failed') {
    await mkdir(resolve(lab, 's5-bindings-attempts'), { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(lab, `s5-bindings-attempts/${Date.now()}.json`),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}
