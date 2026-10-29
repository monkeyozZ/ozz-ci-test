import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '../../packages/database/dist/index.js';
import { workloadNames } from '../../packages/infrastructure/dist/workload.js';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/local-lab/private-registry-b');
const lab = resolve(directory, '..');
const stateFile = resolve(directory, 'product-state.json');
const reportFile = resolve(root, 'docs/acceptance/s3-private-registry-product-results.json');
const registered = JSON.parse(readFileSync(resolve(lab, 'product-state.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(resolve(directory, 'seed-result.json'), 'utf8'));
const credential = JSON.parse(readFileSync(resolve(lab, 'credentials/registry-b.json'), 'utf8'));
const rotated = JSON.parse(
  readFileSync(resolve(lab, 'credentials/registry-b-rotated.json'), 'utf8'),
);
const api = 'http://127.0.0.1:3000/api';
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const db = new PrismaClient();
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : {
      version: 1,
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      requests: {},
      completed: {},
      checks: [],
      credentials: {},
      tasks: {},
      serviceId: null,
    };
if (state.version !== 1) throw new Error('PRIVATE_PROBE_STATE_INVALID');
if (state.pid) {
  try {
    process.kill(state.pid, 0);
    throw new Error('PRIVATE_PROBE_ALREADY_RUNNING');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
state.pid = process.pid;
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let cookie;
let csrf;
let stage = 'login';
const secretValues = [
  credential.password,
  rotated.password,
  Buffer.from(`${credential.username}:${credential.password}`).toString('base64'),
  Buffer.from(`${rotated.username}:${rotated.password}`).toString('base64'),
];
const report = {
  scope:
    '产品 API/Worker/PostgreSQL + 真实 K3s B + 真实 TLS/Basic 私仓；只创建并清理本次专用服务。节点 CA 为 fixture 显式安装，并非产品自动配置信任。',
  runId: state.runId,
  startedAt: state.startedAt,
  checks: state.checks,
  status: 'running',
  registry: credential.registry,
  runtimeImage: fixtures.runtimeImage,
  baseLayerCache:
    '保留并复用既有 Podinfo base blobs；新 config、marker layer 与 manifest 在发布前确认不存在于节点，并核验 runtime GET 200。',
};

function save() {
  writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(stateFile + '.tmp', stateFile);
}
async function check(name, passed, details = {}) {
  if (!passed) throw new Error(`PRIVATE_PROBE_ASSERTION: ${name}`);
  if (!state.checks.some((item) => item.name === name))
    state.checks.push({ name, passed: true, observedAt: new Date().toISOString(), ...details });
  console.log(JSON.stringify({ check: name, passed: true }));
  save();
}
async function phase(name, work) {
  stage = name;
  if (Object.hasOwn(state.completed, name)) return state.completed[name];
  console.log(JSON.stringify({ stage }));
  const result = await work();
  state.completed[name] = result ?? true;
  save();
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
  if (secretValues.some((secret) => JSON.stringify(value).includes(secret)))
    throw new Error('PRIVATE_PROBE_RESPONSE_EXPOSED_CREDENTIAL');
  if (expected === undefined ? !response.ok : response.status !== expected) {
    const error = new Error('PRIVATE_PROBE_API_FAILED');
    error.status = response.status;
    error.code = value?.code;
    throw error;
  }
  return { response, value };
}
async function once(name, path, method, body, expected) {
  if (!state.requests[name]) {
    state.requests[name] = {
      path,
      method,
      body,
      key: randomUUID(),
      requestedAt: new Date().toISOString(),
    };
    save();
  }
  const saved = state.requests[name];
  if (saved.path !== path || saved.method !== method)
    throw new Error('PRIVATE_PROBE_REQUEST_CHANGED');
  if (saved.response) return saved.response;
  const result = await request(saved.path, saved.method, saved.body, saved.key, expected);
  saved.status = result.response.status;
  saved.response = result.value;
  save();
  return result.value;
}
const service = async () => (await request(`/services/${state.serviceId}`)).value.data;
function taskEvidence(task) {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    errorCode: task.errorCode,
    serviceId: task.serviceId,
    configRevision: task.configRevision,
    mutationRevision: task.mutationRevision,
    retryOfId: task.retryOfId,
    appliedAt: task.appliedAt,
    target: task.target ?? task.input?.target,
    image: task.snapshot?.configuration?.image,
    resolvedImage: task.resolvedImage,
    published: task.result?.published,
    failureObservation: task.failureObservation,
  };
}
async function waitTask(type, id, expected = 'succeeded') {
  const deadline = Date.now() + 210_000;
  let prior;
  while (Date.now() < deadline) {
    const task = (await request(`/${type}/${id}`)).value.data;
    const signature = `${task.status}/${task.errorCode}`;
    if (signature !== prior)
      console.log(JSON.stringify({ task: id, status: task.status, code: task.errorCode }));
    prior = signature;
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      state.tasks[id] = taskEvidence(task);
      save();
      if (task.status !== expected) {
        const error = new Error('PRIVATE_PROBE_TASK_FAILED');
        error.code = task.errorCode;
        throw error;
      }
      return task;
    }
    await delay(500, undefined, { signal: abort.signal });
  }
  throw new Error('PRIVATE_PROBE_TASK_TIMEOUT');
}
async function publish(name, expected = 'succeeded') {
  const saved = state.requests[name];
  const input = saved?.body ?? { revision: (await service()).revision };
  const value = await once(name, `/services/${state.serviceId}/deployments`, 'POST', input, 202);
  return waitTask('deployments', value.data.id, expected);
}
async function action(name, action) {
  const saved = state.requests[name];
  const input = saved?.body ?? { revision: (await service()).revision };
  const path = `/services/${state.serviceId}${action === 'delete' ? '' : `/${action}`}`;
  const value = await once(name, path, action === 'delete' ? 'DELETE' : 'POST', input, 202);
  return waitTask('operations', value.data.id);
}
async function patch(name, values, expected = 200) {
  const body = state.requests[name]?.body ?? { revision: (await service()).revision, ...values };
  return once(name, `/services/${state.serviceId}`, 'PATCH', body, expected);
}
async function noRemoteEffect(task, code) {
  const current = await service();
  const resources = await db.managedResource.count({ where: { serviceId: state.serviceId } });
  await check(
    `${code}: failure is durable before any service workload reservation`,
    task.errorCode === code &&
      task.result === null &&
      task.appliedAt === null &&
      !current.published &&
      !current.remoteCreatedAt &&
      resources === 0,
    { deploymentId: task.id, errorCode: task.errorCode, managedResources: resources },
  );
}
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function remote(data) {
  const script = `import base64, json, subprocess, sys\nfrom pathlib import Path\nmeta = json.load(sys.stdin)\nassert Path('/etc/ozz-local-lab-instance').read_text().strip() == 'ozz-lab-b'\ndef run(args):\n    value = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)\n    if value.returncode:\n        if '(NotFound)' in value.stderr:\n            return None\n        raise RuntimeError('REMOTE_READ_FAILED')\n    return value.stdout\ndef kube(kind, name=None, selector=None):\n    args = ['k3s', 'kubectl']\n    if kind != 'namespace':\n        args += ['-n', meta['namespace']]\n    args += ['get', kind]\n    if name: args += [name]\n    if selector: args += ['-l', selector]\n    args += ['-o', 'json']\n    raw = run(args)\n    return json.loads(raw) if raw else None\nif meta['mode'] == 'cache':\n    raw = run(['k3s', 'ctr', '--namespace', 'k8s.io', 'content', 'ls', '-q'])\n    present = set(raw.splitlines())\n    print(json.dumps({key: digest in present for key, digest in meta['digests'].items()}))\nelif meta['mode'] == 'logs':\n    path = Path('/var/lib/ozz-local-lab/b/registry-3.1.2/runtime-access.jsonl')\n    records = []\n    for line in path.read_text().splitlines() if path.exists() else []:\n        value = json.loads(line)\n        if value['path'].startswith('/v2/' + meta['repository'] + '/'):\n            records.append({key: value.get(key) for key in ['time', 'path', 'status']})\n    print(json.dumps({'runtimeGets': records[-512:], 'truncated': len(records) > 512}))\nelse:\n    selector = 'ozz.dev/service-id=' + meta['serviceId']\n    namespace = kube('namespace', meta['namespace'])\n    resources = kube('deployment,service,secret', selector=selector)\n    result = {'namespaceUid': namespace['metadata']['uid'] if namespace else None, 'managed': [{'kind': item['kind'], 'name': item['metadata']['name'], 'uid': item['metadata']['uid']} for item in resources['items']]}\n    if meta['mode'] == 'inspect':\n        deployment = kube('deployment', meta['deployment'])\n        secret = kube('secret', meta['pullSecret'])\n        payload = json.loads(base64.b64decode(secret['data']['.dockerconfigjson']))\n        entry = payload['auths'].get(meta['registry'], {})\n        result['pullSecret'] = {'uid': secret['metadata']['uid'], 'type': secret['type'], 'credentialMatches': entry.get('username') == meta['username'] and entry.get('password') == meta['password'], 'mutationRevision': secret['metadata'].get('annotations', {}).get('ozz.dev/mutation-revision')}\n        result['deployment'] = {'uid': deployment['metadata']['uid'], 'replicas': deployment['spec']['replicas'], 'image': deployment['spec']['template']['spec']['containers'][0]['image'], 'pullSecretNames': [item['name'] for item in deployment['spec']['template']['spec'].get('imagePullSecrets', [])]}\n    print(json.dumps(result))\n`;
  const output = execFileSync(
    'ssh',
    ['-F', resolve(lab, 'credentials/ssh_config'), 'ozz-lab-b', `sudo python3 -c ${quote(script)}`],
    {
      input: JSON.stringify(data),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 25_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(output);
}
function inspect(credentialValue, mode = 'inspect') {
  const names = workloadNames({ environmentId: state.environmentId, serviceId: state.serviceId });
  return remote({
    mode,
    namespace: names.namespace,
    serviceId: state.serviceId,
    deployment: names.deployment,
    pullSecret: names.pullSecret,
    registry: credential.registry,
    username: credentialValue?.username,
    password: credentialValue?.password,
  });
}
function configuration(image) {
  return {
    image,
    replicas: 1,
    ports: [{ name: 'http', protocol: 'http', containerPort: 9898, servicePort: 80 }],
    resources: {
      requests: { cpuMillis: 100, memoryMiB: 32 },
      limits: { cpuMillis: 500, memoryMiB: 128 },
    },
    environment: [{ name: 'PODINFO_UI_MESSAGE', value: 'Ozz private registry acceptance fixture' }],
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
  };
}

try {
  save();
  const password = readFileSync(resolve(root, '.secrets/admin-password'), 'utf8').trim();
  secretValues.push(password);
  const login = await request('/auth/login', 'POST', { username: 'admin', password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  if (!cookie || !csrf) throw new Error('PRIVATE_PROBE_LOGIN_FAILED');
  await phase('credentials', async () => {
    const values = {
      caOnly: {
        payload: { registry: credential.registry, caCertificate: credential.caCertificate },
      },
      wrong: { payload: { ...credential, password: 'incorrect-fixture-password' } },
      valid: { payload: credential },
      rotated: { payload: rotated },
      expired: { payload: credential, expiresAt: new Date(Date.now() - 60_000).toISOString() },
      wrongKind: { kind: 'generic', payload: { value: 'fixture-kind-mismatch' } },
      wrongRegistry: { payload: { ...credential, registry: '127.0.0.1:50444' } },
    };
    for (const [name, value] of Object.entries(values)) {
      const response = await once(
        `credential-${name}`,
        '/secrets',
        'POST',
        {
          name: `Ozz private ${name} ${state.runId.slice(0, 8)}`,
          kind: value.kind ?? 'registry',
          payload: value.payload,
          ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
        },
        201,
      );
      state.credentials[name] = response.data.id;
      save();
      await check(
        `${name}: credential API returns metadata without its write-only payload`,
        !Object.hasOwn(response.data, 'payload') && response.data.keyVersion >= 1,
        { credentialRefId: response.data.id },
      );
    }
  });
  await phase('create-own-service', async () => {
    const environments = (
      await request(`/environments?projectId=${registered.projects.b}&limit=100`)
    ).value.data;
    const environment = environments.find((value) => value.slug === 'production');
    if (!environment) throw new Error('PRIVATE_PROBE_ENVIRONMENT_MISSING');
    state.environmentId = environment.id;
    const response = await once(
      'create-service',
      '/services',
      'POST',
      {
        projectId: registered.projects.b,
        environmentId: environment.id,
        name: `私仓验收 ${state.runId.slice(0, 8)}`,
        slug: `private-registry-${state.runId.slice(0, 8)}`,
        description: '仅此专用服务用于真实私仓凭证矩阵；验收后通过产品删除。',
        registryCredentialRefId: state.credentials.caOnly,
        configuration: configuration(fixtures.runtimeImage.reference),
      },
      201,
    );
    state.serviceId = response.data.id;
    save();
    await check(
      'private test service inherits only project B and its production namespace',
      response.data.projectId === registered.projects.b &&
        response.data.clusterId === registered.clusters.b &&
        response.data.environmentId === environment.id,
      { serviceId: state.serviceId, clusterId: response.data.clusterId },
    );
  });
  await phase('new-runtime-content-not-cached', async () => {
    const cached = remote({
      mode: 'cache',
      digests: {
        newLayer: fixtures.runtimeImage.newLayer.digest,
        config: fixtures.runtimeImage.configDigest,
        manifest: fixtures.runtimeImage.manifestDigest,
      },
    });
    state.beforePull = cached;
    await check(
      'new private layer, config and manifest are absent from the B runtime before publication',
      Object.values(cached).every((value) => value === false),
      cached,
    );
  });
  await phase('credential-admission-matrix', async () => {
    const before = await service();
    for (const [name, code] of [
      ['expired', 'CREDENTIAL_EXPIRED'],
      ['wrongKind', 'CREDENTIAL_KIND_MISMATCH'],
      ['wrongRegistry', 'REGISTRY_ACCESS_MISMATCH'],
    ]) {
      const result = await patch(
        `admission-${name}`,
        { registryCredentialRefId: state.credentials[name] },
        422,
      );
      const after = await service();
      await check(
        `${code}: reference admission leaves the service unchanged`,
        result.code === code &&
          after.revision === before.revision &&
          after.registryCredentialRefId === before.registryCredentialRefId,
        { httpStatus: 422, code },
      );
    }
  });
  await phase('missing-basic-auth', async () =>
    noRemoteEffect(await publish('deploy-ca-only', 'failed'), 'REGISTRY_AUTH_REQUIRED'),
  );
  await phase('wrong-basic-auth', async () => {
    await patch('bind-wrong', { registryCredentialRefId: state.credentials.wrong });
    await noRemoteEffect(await publish('deploy-wrong-auth', 'failed'), 'REGISTRY_UNAUTHENTICATED');
  });
  await phase('unsupported-arm-platform', async () => {
    await patch('bind-amd64-only', {
      registryCredentialRefId: state.credentials.valid,
      configuration: configuration(fixtures.amd64Only.reference),
    });
    await noRemoteEffect(
      await publish('deploy-amd64-only', 'failed'),
      'REGISTRY_PLATFORM_UNSUPPORTED',
    );
  });
  await phase('valid-private-publication', async () => {
    await patch('bind-valid-arm', {
      registryCredentialRefId: state.credentials.valid,
      configuration: configuration(fixtures.runtimeImage.reference),
    });
    const done = await publish('deploy-valid-private');
    const current = await service();
    state.successfulDeploymentId = done.id;
    state.published = done.result.published;
    const actual = inspect(credential);
    state.firstRuntime = actual;
    await check(
      'valid private publication reaches healthy Pods using a real managed imagePullSecret',
      current.runtimeState === 'running' &&
        done.resolvedImage.manifestDigest === fixtures.runtimeImage.manifestDigest &&
        done.result.published.usesPullSecret &&
        actual.pullSecret.credentialMatches &&
        actual.deployment.pullSecretNames.length === 1 &&
        actual.deployment.image === done.resolvedImage.deployReference,
      {
        deploymentId: done.id,
        deploymentUid: actual.deployment.uid,
        pullSecretUid: actual.pullSecret.uid,
        image: actual.deployment.image,
      },
    );
    const access = remote({ mode: 'logs', repository: fixtures.runtimeImage.repository });
    state.firstRuntimeGets = access;
    const newLayerPath = `/v2/${fixtures.runtimeImage.repository}/blobs/${fixtures.runtimeImage.newLayer.digest}`;
    const configPath = `/v2/${fixtures.runtimeImage.repository}/blobs/${fixtures.runtimeImage.configDigest}`;
    await check(
      'containerd authenticates to the private registry and GETs the previously uncached layer and config',
      access.runtimeGets.some((entry) => entry.path === newLayerPath && entry.status === 200) &&
        access.runtimeGets.some((entry) => entry.path === configPath && entry.status === 200),
      { runtimeGets: access.runtimeGets, inheritedBaseLayersMayBeCached: true },
    );
    const originalRequest = state.requests['deploy-valid-private'];
    const replay = await request(
      originalRequest.path,
      originalRequest.method,
      originalRequest.body,
      originalRequest.key,
      202,
    );
    await check(
      'repeating the original private publication request returns the same durable task',
      replay.value.data.id === done.id,
      { deploymentId: done.id, idempotencyKey: originalRequest.key },
    );
  });
  await phase('stop-rotate-resume', async () => {
    await action('stop-private', 'stop');
    await patch('bind-current-rotated', { registryCredentialRefId: state.credentials.rotated });
    const beforeResume = inspect(credential);
    await check(
      'credential selection alone preserves the stopped published workload',
      beforeResume.deployment.replicas === 0 &&
        beforeResume.pullSecret.credentialMatches &&
        beforeResume.deployment.uid === state.firstRuntime.deployment.uid,
    );
    const done = await action('resume-private-rotated', 'resume');
    const actual = inspect(rotated);
    const current = await service();
    await check(
      'resume writes the current rotated authentication while preserving publication and resource UIDs',
      current.runtimeState === 'running' &&
        current.published.deploymentId === state.successfulDeploymentId &&
        actual.pullSecret.credentialMatches &&
        actual.pullSecret.uid === state.firstRuntime.pullSecret.uid &&
        actual.deployment.uid === state.firstRuntime.deployment.uid &&
        done.result.rollout.snapshotId === state.published.snapshotId,
      {
        operationId: done.id,
        pullSecretUid: actual.pullSecret.uid,
        deploymentUid: actual.deployment.uid,
      },
    );
  });
  await phase('restart-private', async () => {
    const done = await action('restart-private', 'restart');
    const actual = inspect(rotated);
    await check(
      'restart retains current private authentication and the published image template',
      actual.pullSecret.credentialMatches &&
        done.result.rollout.snapshotId === state.published.snapshotId &&
        done.result.rollout.templateFingerprint === state.published.templateFingerprint &&
        done.result.rollout.rolloutId === done.id,
      { operationId: done.id },
    );
  });
  await phase('current-invalid-auth-does-not-fall-back', async () => {
    await patch('bind-wrong-again', { registryCredentialRefId: state.credentials.wrong });
    const done = await publish('deploy-current-wrong-auth', 'failed');
    const current = await service();
    const actual = inspect(rotated);
    await check(
      'a new publication validates the current credential and never falls back to a previous working pull secret',
      done.errorCode === 'REGISTRY_UNAUTHENTICATED' &&
        done.appliedAt === null &&
        done.result === null &&
        current.published.deploymentId === state.successfulDeploymentId &&
        actual.pullSecret.credentialMatches &&
        actual.deployment.uid === state.firstRuntime.deployment.uid,
      {
        failedDeploymentId: done.id,
        unchangedPublishedDeploymentId: current.published.deploymentId,
      },
    );
    await patch('restore-current-rotated', { registryCredentialRefId: state.credentials.rotated });
  });
  await phase('cleanup-own-service', async () => {
    const done = await action('delete-private-service', 'delete');
    const missing = await request(`/services/${state.serviceId}`, 'GET', undefined, undefined, 404);
    const actual = inspect(undefined, 'removed');
    await check(
      'only the dedicated test service is deleted while the shared environment Namespace remains',
      missing.response.status === 404 &&
        actual.managed.length === 0 &&
        actual.namespaceUid === state.firstRuntime.namespaceUid,
      {
        deletedServiceId: state.serviceId,
        deleteOperationId: done.id,
        namespaceUid: actual.namespaceUid,
      },
    );
    for (const task of Object.values(state.tasks).filter((task) => task.kind === 'image_deploy')) {
      const retained = (await request(`/deployments/${task.id}`)).value.data;
      await check(
        `history ${task.id}: original task outcome survives service deletion`,
        retained.status === task.status &&
          retained.errorCode === task.errorCode &&
          retained.target.serviceId === state.serviceId &&
          retained.serviceId === null,
        { deploymentId: task.id, status: task.status, errorCode: task.errorCode },
      );
    }
    state.cleaned = true;
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    code: error.code ?? null,
    httpStatus: error.status ?? null,
    message: error.message?.slice(0, 180),
  };
  console.error(JSON.stringify({ stage, code: error.code ?? error.name, failed: true }));
  process.exitCode = 1;
} finally {
  state.pid = null;
  save();
  report.finishedAt = new Date().toISOString();
  report.serviceId = state.serviceId;
  report.serviceDeleted = Boolean(state.cleaned);
  report.tasks = Object.values(state.tasks);
  report.requests = Object.entries(state.requests).map(([name, value]) => ({
    name,
    path: value.path,
    method: value.method,
    idempotencyKey: value.key,
    status: value.status,
    resourceId: value.response?.data?.id ?? null,
  }));
  report.credentialsRetainedEncrypted = state.credentials;
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (secretValues.some((secret) => serialized.includes(secret)))
    // eslint-disable-next-line no-unsafe-finally -- A credential must block report output even after another failure.
    throw new Error('PRIVATE_PROBE_EVIDENCE_SECRET_LEAK_BLOCKED');
  writeFileSync(reportFile, serialized);
  await db.$disconnect();
}
