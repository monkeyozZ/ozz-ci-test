import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  checkProductHttpsHealth,
  privateFile,
  productRoot,
  publicAppOrigin,
  readProductConfiguration,
} from './support/s6-github-product.mjs';

// Root-coordinated local acceptance only. Resource pressure runs in a dedicated
// 128 MiB Pod. The admission fault matches one exact Deployment in one namespace.
// No Builder execution, original service, VM, data volume or database is changed.
const [mode, ...options] = process.argv.slice(2);
if (!['prepare', 'run', 'status', 'cleanup'].includes(mode))
  throw new Error('Usage: g-mvp-workload-fault-local-lab.mjs prepare|run|status|cleanup');
const owner = 'ozz-gmvp-workload-faults-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const selectedAttempt = options
  .find((item) => item.startsWith('--attempt='))
  ?.slice('--attempt='.length);
const selectedScenario = options
  .find((item) => item.startsWith('--scenario='))
  ?.slice('--scenario='.length);
if (selectedScenario !== undefined && !['full', 'partial'].includes(selectedScenario))
  throw new Error('GMVP_WORKLOAD_SCENARIO_INVALID');
if (selectedAttempt !== undefined && !uuid.test(selectedAttempt))
  throw new Error('GMVP_WORKLOAD_ATTEMPT_INVALID');
const directory = resolve(
  productRoot,
  '.local/local-lab/g-mvp-workload-faults',
  ...(selectedAttempt ? ['attempts', selectedAttempt] : []),
);
const registryDirectory = resolve(productRoot, '.local/local-lab/s6-registry');
const statePath = resolve(directory, 'state.json');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
process.umask(0o077);
let state, configuration, cookie, csrf, kube, lock, report;
let cleaning = false;
const secrets = [];
function requireValue(value, code) {
  if (!value) throw new Error('GMVP_WORKLOAD_' + code);
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
async function atomic(path, value) {
  const temporary = path + '.' + randomUUID();
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
const save = () => atomic(statePath, JSON.stringify(safe(state), null, 2) + '\n');
async function evidence(name, value) {
  requireValue(/^[a-z0-9-]+$/u.test(name), 'EVIDENCE_NAME');
  const path = resolve(directory, `${name}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, JSON.stringify(safe(value), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}
async function wire(origin, path, tls, method = 'GET', body, headers = {}) {
  requireValue(path.startsWith('/') && !path.startsWith('//'), 'REQUEST_PATH');
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((accept, reject) => {
    const call = request(
      origin + path,
      {
        ...tls,
        rejectUnauthorized: true,
        agent: false,
        method,
        signal: cleaning
          ? globalThis.AbortSignal.timeout(20000)
          : globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(20000)]),
        headers: {
          ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) response.destroy(new Error('GMVP_WORKLOAD_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            accept({
              status: response.statusCode,
              headers: response.headers,
              value: size ? JSON.parse(Buffer.concat(chunks)) : null,
            });
          } catch {
            reject(new Error('GMVP_WORKLOAD_RESPONSE_INVALID'));
          }
        });
      },
    );
    call.once('error', reject);
    call.end(bytes);
  });
}
async function api(path, method = 'GET', body, key, expected) {
  const result = await wire(
    publicAppOrigin,
    '/api' + path,
    { ca: configuration.ca },
    method,
    body,
    {
      origin: publicAppOrigin,
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
  );
  requireValue(
    expected ? result.status === expected : result.status >= 200 && result.status < 300,
    `API_${result.status}_${/^[A-Z0-9_]+$/u.test(result.value?.code ?? '') ? result.value.code : 'FAILED'}`,
  );
  return result;
}
const data = async (path) => (await api(path)).value.data;
async function authenticate(password) {
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
        /^ozz_session=[A-Za-z0-9_-]{43}$/u.test(cached.cookie) &&
        typeof cached.csrf === 'string' &&
        cached.csrf.length >= 32,
      'SESSION_IDENTITY',
    );
    cookie = cached.cookie;
    csrf = cached.csrf;
    secrets.push(cookie, csrf);
    const current = await wire(
      publicAppOrigin,
      '/api/auth/me',
      { ca: configuration.ca },
      'GET',
      undefined,
      { cookie },
    );
    if (current.status === 200) {
      requireValue(
        current.value.data.user?.username === 'admin' && current.value.data.csrfToken === csrf,
        'SESSION_CHANGED',
      );
      return;
    }
    requireValue(current.status === 401, 'SESSION_CHECK_FAILED');
    cookie = csrf = undefined;
  }
  const login = await api('/auth/login', 'POST', { username: 'admin', password }, undefined, 200);
  cookie = login.headers['set-cookie']
    ?.find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  requireValue(cookie && csrf, 'LOGIN_FAILED');
  secrets.push(cookie, csrf);
  await atomic(
    resolve(directory, 'auth-session.json'),
    JSON.stringify({ owner, origin: publicAppOrigin, cookie, csrf }),
  );
}
async function list(path) {
  const rows = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const value = (
      await api(
        path +
          (path.includes('?') ? '&' : '?') +
          'limit=100' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      )
    ).value;
    rows.push(...value.data);
    cursor = value.page?.nextCursor;
    if (!cursor) return rows;
    requireValue(!seen.has(cursor), 'PAGINATION_CYCLE');
    seen.add(cursor);
  }
  throw new Error('GMVP_WORKLOAD_PAGINATION_LIMIT');
}
async function command(name, path, body) {
  state.commands[name] ??= { path, body, key: randomUUID() };
  const intent = state.commands[name];
  requireValue(intent.path === path, 'COMMAND_CHANGED');
  if (intent.id) return data(intent.location);
  await save();
  const value = (await api(path, 'POST', intent.body, intent.key, 202)).value.data;
  intent.id = value.id;
  intent.location =
    value.pollUrl?.replace(/^\/api/u, '') ??
    `/${path.endsWith('/deployments') ? 'deployments' : 'operations'}/${value.id}`;
  requireValue(/^\/(deployments|operations)\/[0-9a-f-]{36}$/u.test(intent.location), 'POLL_PATH');
  await save();
  return value;
}
async function waitTask(location) {
  const deadline = Date.now() + 240000;
  const signal = cleaning
    ? globalThis.AbortSignal.timeout(240000)
    : globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(240000)]);
  for (;;) {
    const task = await data(location);
    if (['failed', 'cancelled', 'succeeded'].includes(task.status)) return task;
    requireValue(Date.now() < deadline, 'TASK_TIMEOUT');
    const disk = await statfs(productRoot);
    requireValue(disk.bavail * disk.bsize >= 8 * 1024 ** 3, 'DISK_RESERVE');
    await delay(700, undefined, { signal });
  }
}
const service = () => data('/services/' + state.serviceId);
const namespace = () => 'ozz-e-' + state.environmentId.replaceAll('-', '');
const workloadName = () => 'ozz-s-' + state.serviceId.replaceAll('-', '');
const deployPath = () => `/apis/apps/v1/namespaces/${namespace()}/deployments/${workloadName()}`;
async function cluster(path, method = 'GET', body, expected, headers) {
  const result = await wire(kube.origin, path, kube.tls, method, body, headers);
  requireValue(
    expected ? result.status === expected : result.status >= 200 && result.status < 300,
    'KUBERNETES_' + result.status,
  );
  return result.value;
}
async function connectCluster() {
  const value = JSON.parse(
    await privateFile(resolve(productRoot, '.local/local-lab/credentials'), 'b.kubeconfig.json'),
  );
  requireValue(value.clusters?.length === 1 && value.users?.length === 1, 'KUBE_CONTEXT');
  const target = value.clusters[0].cluster,
    user = value.users[0].user;
  requireValue(
    target.server === 'https://127.0.0.1:26443' &&
      !target['insecure-skip-tls-verify'] &&
      target['certificate-authority-data'] &&
      user['client-certificate-data'] &&
      user['client-key-data'] &&
      !user.exec,
    'KUBE_IDENTITY',
  );
  kube = {
    origin: target.server,
    tls: {
      ca: Buffer.from(target['certificate-authority-data'], 'base64'),
      cert: Buffer.from(user['client-certificate-data'], 'base64'),
      key: Buffer.from(user['client-key-data'], 'base64'),
    },
  };
  const system = await cluster('/api/v1/namespaces/kube-system');
  requireValue(system.metadata.uid === state.target.kubeSystemUid, 'CLUSTER_CHANGED');
}
function identity(resource) {
  const meta = resource.metadata;
  const template = resource.spec?.template?.metadata;
  return {
    kind: resource.kind,
    name: meta.name,
    namespace: meta.namespace ?? null,
    uid: meta.uid,
    resourceVersion: meta.resourceVersion,
    snapshotId:
      template?.labels?.['ozz.dev/snapshot-id'] ??
      meta.annotations?.['ozz.dev/snapshot-id'] ??
      meta.labels?.['ozz.dev/snapshot-id'] ??
      null,
    configRevision:
      template?.labels?.['ozz.dev/config-revision'] ??
      meta.annotations?.['ozz.dev/config-revision'] ??
      meta.labels?.['ozz.dev/config-revision'] ??
      null,
    taskId: meta.annotations?.['ozz.dev/task-id'] ?? null,
    mutationRevision: meta.annotations?.['ozz.dev/mutation-revision'] ?? null,
  };
}
async function currentInventory(taskId) {
  const current = await cluster(deployPath());
  const serviceObject = await cluster(
    `/api/v1/namespaces/${namespace()}/services/${workloadName()}`,
  );
  const secretName = 'ozz-r-' + taskId.replaceAll('-', '');
  const secret = await cluster(`/api/v1/namespaces/${namespace()}/secrets/${secretName}`);
  return {
    controller: identity(current),
    service: identity(serviceObject),
    runtimeSecret: identity(secret),
  };
}
async function pullPermission(restore = false) {
  const path = resolve(registryDirectory, 'users.json');
  const current = await privateFile(registryDirectory, 'users.json');
  if (restore) {
    if (!state.acl) return;
    const original = await privateFile(directory, 'registry-before.json');
    requireValue(
      sha(original) === state.acl.beforeSha256 &&
        [state.acl.beforeSha256, state.acl.duringSha256].includes(sha(current)),
      'REGISTRY_CHANGED',
    );
    await atomic(path, original);
    state.acl.restored = true;
    await save();
    return;
  }
  if (state.acl) {
    requireValue(
      !state.acl.restored && sha(current) === state.acl.duringSha256,
      'ACL_WINDOW_CLOSED',
    );
    return;
  }
  const users = JSON.parse(current);
  requireValue(users.owner === 'ozz-s6-registry-token-fixture-v1', 'REGISTRY_OWNER');
  const pull = users.users.find((user) => user.username === 'ozz-s6-pull');
  requireValue(
    pull && !pull.repositories.some((repo) => repo.name === state.imageRepository),
    'REGISTRY_SCOPE',
  );
  pull.repositories.push({ name: state.imageRepository, actions: ['pull'] });
  const next = JSON.stringify(users, null, 2) + '\n';
  await writeFile(resolve(directory, 'registry-before.json'), current, { mode: 0o600, flag: 'wx' });
  state.acl = {
    beforeSha256: sha(current),
    duringSha256: sha(next),
    repository: state.imageRepository,
    restored: false,
  };
  await save();
  await atomic(path, next);
}
function initialConfiguration(canary) {
  return {
    image: state.image,
    replicas: 1,
    command: ['/s6-workload'],
    args: ['serve'],
    ports: [{ name: 'http', protocol: 'http', containerPort: 8080, servicePort: 80 }],
    resources: {
      requests: { cpuMillis: 50, memoryMiB: 32 },
      limits: { cpuMillis: 250, memoryMiB: 128 },
    },
    environment: [{ name: 'OZZ_L05_SECRET', value: canary, secret: true }],
    readiness: {
      type: 'http',
      port: 'http',
      path: '/',
      initialDelaySeconds: 0,
      periodSeconds: 2,
      timeoutSeconds: 1,
      failureThreshold: 3,
    },
    startup: null,
    healthTimeoutSeconds: 40,
  };
}
async function prepare() {
  if (state.serviceId) return;
  const selected = options.find((item) => item.startsWith('--artifact-deployment='))?.split('=')[1];
  const faults = JSON.parse(
    await privateFile(resolve(productRoot, '.local/local-lab/s6-builder-faults'), 'state.json'),
  );
  requireValue(
    uuid.test(selected ?? '') && selected === faults.cases.artifact.retryDeploymentId,
    'FINAL_ARTIFACT_REQUIRED',
  );
  const task = await data('/deployments/' + selected);
  requireValue(
    task.status === 'succeeded' &&
      task.build?.artifact.state === 'registry' &&
      task.build.artifact.availability === 'available' &&
      task.build.runs.every((run) => run.proofVerifiedAt),
    'ARTIFACT_NOT_READY',
  );
  const parent = JSON.parse(
    await privateFile(resolve(productRoot, '.local/local-lab/s6-product'), 'state.json'),
  );
  state.parentServiceId = parent.resources.service;
  state.clusterId = parent.resources.cluster;
  state.image = task.resolvedImage.deployReference;
  state.imageRepository = task.resolvedImage.repository;
  state.artifactDeploymentId = selected;
  requireValue(
    task.target.clusterId === state.clusterId &&
      task.resolvedImage.registry === 'host.lima.internal:50444' &&
      state.imageRepository.startsWith('ozz-s6/fault-') &&
      /^sha256:[0-9a-f]{64}$/u.test(task.resolvedImage.manifestDigest),
    'ARTIFACT_TARGET',
  );
  const registry = await data('/integrations/registries/' + parent.resources.registry);
  state.pullCredentialRefId = registry.pullCredentialRefId;
  const parentService = await data('/services/' + state.parentServiceId);
  state.parentBaseline = {
    id: parentService.id,
    revision: parentService.revision,
    desiredState: parentService.desiredState,
    publishedDeploymentId: parentService.published?.deploymentId,
  };
  await save();
  const slug = 'gmvp-workload-' + state.id.slice(0, 8);
  let project = (await list('/projects')).find((item) => item.slug === slug);
  if (!project)
    project = (
      await api(
        '/projects',
        'POST',
        { name: 'G-MVP 运行故障验收', slug, clusterId: state.clusterId },
        undefined,
        201,
      )
    ).value.data;
  requireValue(project.clusterId === state.clusterId, 'PROJECT_TARGET');
  state.projectId = project.id;
  await save();
  const environments = await list('/environments?projectId=' + state.projectId);
  const environment = environments.find((item) => item.slug === 'production');
  requireValue(environment, 'ENVIRONMENT_REQUIRED');
  state.environmentId = environment.id;
  await save();
  let created = (await list('/services?environmentId=' + state.environmentId)).find(
    (item) => item.slug === 'bounded-fault',
  );
  if (!created) {
    let canary;
    try {
      canary = await privateFile(directory, 'canary.txt');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      canary = randomBytes(32).toString('hex');
      await writeFile(resolve(directory, 'canary.txt'), canary, { mode: 0o600, flag: 'wx' });
    }
    secrets.push(canary);
    created = (
      await api(
        '/services',
        'POST',
        {
          projectId: state.projectId,
          environmentId: state.environmentId,
          name: '有界运行故障样本',
          slug: 'bounded-fault',
          description: owner + ':' + state.id,
          registryCredentialRefId: state.pullCredentialRefId,
          configuration: initialConfiguration(canary),
        },
        undefined,
        201,
      )
    ).value.data;
  }
  requireValue(
    created.projectId === state.projectId &&
      created.clusterId === state.clusterId &&
      created.description === owner + ':' + state.id &&
      created.configuration.image === state.image,
    'SERVICE_IDENTITY',
  );
  state.serviceId = created.id;
  await save();
}
async function phase(name, work) {
  if (state.completed[name]) return state.completed[name];
  console.log(JSON.stringify({ phase: name, status: 'running' }));
  const value = await work();
  state.completed[name] = value ?? { passed: true };
  await save();
  console.log(JSON.stringify({ phase: name, status: 'passed' }));
  return value;
}
async function configure(name, transform) {
  return phase(name, async () => {
    const before = await service();
    const next = globalThis.structuredClone(before.configuration);
    transform(next);
    const after = (
      await api('/services/' + state.serviceId, 'PATCH', {
        revision: before.revision,
        configuration: next,
      })
    ).value.data;
    return { revision: after.revision, configRevision: after.configRevision };
  });
}
async function publish(name, expected = 'succeeded', extra = {}) {
  return phase(name, async () => {
    const before = await service();
    await command(name, '/services/' + state.serviceId + '/deployments', {
      revision: before.revision,
      ...extra,
    });
    const done = await waitTask(state.commands[name].location);
    const proof = await evidence(name, done);
    requireValue(
      done.status === expected && done.serviceId === state.serviceId,
      'PUBLICATION_' + done.status,
    );
    return {
      id: done.id,
      status: done.status,
      mutationRevision: done.mutationRevision,
      configRevision: done.configRevision,
      proof,
    };
  });
}
async function lifecycle(name, action) {
  const before = await service();
  await command(name, '/services/' + state.serviceId + '/' + action, { revision: before.revision });
  const done = await waitTask(state.commands[name].location);
  const proof = await evidence(name, done);
  requireValue(done.status === 'succeeded', 'LIFECYCLE_FAILED');
  const stopped = action === 'stop' ? await waitStopped() : undefined;
  return { id: done.id, proof, ...(stopped ? { stopped } : {}) };
}
async function waitStopped() {
  await connectCluster();
  const deadline = Date.now() + 120000;
  for (;;) {
    const controller = await wire(kube.origin, deployPath(), kube.tls);
    requireValue([200, 404].includes(controller.status), 'STOP_CONTROLLER_READ');
    const pods = await cluster(
      `/api/v1/namespaces/${namespace()}/pods?labelSelector=${encodeURIComponent('ozz.dev/service-id=' + state.serviceId)}`,
    );
    if (
      (controller.status === 404 || controller.value.spec.replicas === 0) &&
      pods.items.length === 0
    )
      return {
        observedAt: new Date().toISOString(),
        controllerUid: controller.value?.metadata?.uid ?? null,
        replicas: controller.status === 404 ? null : 0,
        pods: 0,
      };
    requireValue(Date.now() < deadline, 'STOP_NOT_OBSERVED');
    await delay(500);
  }
}
const admissionPath = (kind) => '/apis/admissionregistration.k8s.io/v1/' + kind;
async function installPolicy() {
  const name = 'ozz-gmvp-fault-' + state.id;
  state.policy ??= { name };
  await save();
  for (const [kind, resource, uidField] of [
    ['ValidatingAdmissionPolicy', 'validatingadmissionpolicies', 'policyUid'],
    ['ValidatingAdmissionPolicyBinding', 'validatingadmissionpolicybindings', 'bindingUid'],
  ]) {
    if (state.policy[uidField]) continue;
    const spec =
      kind === 'ValidatingAdmissionPolicy'
        ? {
            failurePolicy: 'Fail',
            matchConstraints: {
              matchPolicy: 'Equivalent',
              namespaceSelector: {},
              objectSelector: {},
              resourceRules: [
                {
                  apiGroups: ['apps'],
                  apiVersions: ['v1'],
                  operations: ['UPDATE'],
                  resources: ['deployments'],
                  scope: 'Namespaced',
                },
              ],
            },
            matchConditions: [
              {
                name: 'exact-local-fixture',
                expression: `object.metadata.namespace == '${namespace()}' && object.metadata.name == '${workloadName()}'`,
              },
            ],
            validations: [
              {
                expression: 'false',
                reason: 'Forbidden',
                message: 'OZZ_GMVP_CONTROLLED_CONTROLLER_DENIAL',
              },
            ],
          }
        : { policyName: name, validationActions: ['Deny'] };
    const body = {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind,
      metadata: { name, labels: { 'ozz.test/owner': owner, 'ozz.test/session': state.id } },
      spec,
    };
    await evidence('admission-manifest', body);
    const existing = await wire(kube.origin, admissionPath(resource) + '/' + name, kube.tls);
    requireValue([200, 404].includes(existing.status), 'POLICY_READ');
    const result =
      existing.status === 404
        ? await cluster(admissionPath(resource), 'POST', body, 201)
        : existing.value;
    requireValue(
      result.metadata.labels?.['ozz.test/session'] === state.id &&
        isDeepStrictEqual(result.spec, spec),
      'POLICY_CONFLICT',
    );
    state.policy[uidField] = result.metadata.uid;
    await save();
  }
  const deadline = Date.now() + 15000;
  for (;;) {
    const result = await wire(
      kube.origin,
      deployPath() + '?dryRun=All',
      kube.tls,
      'PATCH',
      { spec: { replicas: 1 } },
      { 'content-type': 'application/merge-patch+json' },
    );
    if (
      result.status === 403 &&
      result.value?.message?.includes('OZZ_GMVP_CONTROLLED_CONTROLLER_DENIAL')
    )
      break;
    requireValue(Date.now() < deadline, 'POLICY_NOT_ENFORCED');
    await delay(300);
  }
  return { name, namespace: namespace(), deployment: workloadName(), deniedDryRun: true };
}
async function removePolicy() {
  if (!state.policy) return;
  await connectCluster();
  for (const [resource, uidField] of [
    ['validatingadmissionpolicybindings', 'bindingUid'],
    ['validatingadmissionpolicies', 'policyUid'],
  ]) {
    const path = admissionPath(resource) + '/' + state.policy.name;
    const read = await wire(kube.origin, path, kube.tls);
    if (read.status === 404) continue;
    requireValue(
      read.status === 200 &&
        read.value.metadata.labels?.['ozz.test/session'] === state.id &&
        (!state.policy[uidField] || read.value.metadata.uid === state.policy[uidField]),
      'POLICY_IDENTITY_CHANGED',
    );
    await cluster(path, 'DELETE', {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: read.value.metadata.uid },
    });
  }
  // Admission caches can still reject an UPDATE after DELETE has returned.
  // Observe removal using the same harmless server dry-run before the next
  // product operation; do not assume the API receipt proves propagation.
  const deadline = Date.now() + 20000;
  for (;;) {
    const controller = await wire(kube.origin, deployPath(), kube.tls);
    requireValue([200, 404].includes(controller.status), 'POLICY_CONTROLLER_READ');
    if (controller.status === 404) break;
    const result = await wire(
      kube.origin,
      deployPath() + '?dryRun=All',
      kube.tls,
      'PATCH',
      { spec: { replicas: controller.value.spec.replicas } },
      { 'content-type': 'application/merge-patch+json' },
    );
    if (result.status === 200) break;
    requireValue(
      result.status === 403 &&
        result.value?.message?.includes('OZZ_GMVP_CONTROLLED_CONTROLLER_DENIAL'),
      'POLICY_REMOVAL_UNEXPECTED_DENIAL',
    );
    requireValue(Date.now() < deadline, 'POLICY_REMOVAL_NOT_OBSERVED');
    await delay(300);
  }
  state.policy.removed = true;
  state.policy.removalObservedAt = new Date().toISOString();
  await save();
}
async function run() {
  requireValue(state.serviceId && !state.acl?.restored, 'PREPARE_REQUIRED');
  await pullPermission();
  const baseline = await publish('healthy-baseline');
  const task = await data('/deployments/' + baseline.id);
  state.target = task.target;
  await save();
  await connectCluster();
  let healthy = baseline;
  if ((state.scenario ?? 'full') === 'full') {
    await configure('memory-configuration', (value) => {
      value.args = ['memory'];
    });
    const failed = await publish('memory-publication', 'failed');
    await phase('real-pod-oom', async () => {
      const failure = await data('/deployments/' + failed.id);
      const pods = await cluster(
        `/api/v1/namespaces/${namespace()}/pods?labelSelector=${encodeURIComponent('ozz.dev/service-id=' + state.serviceId)}`,
      );
      const actual = pods.items
        .filter(
          (pod) =>
            pod.metadata.annotations?.['ozz.dev/rollout-id'] === failed.id ||
            pod.metadata.labels?.['ozz.dev/rollout-id'] === failed.id,
        )
        .map((pod) => ({
          uid: pod.metadata.uid,
          name: pod.metadata.name,
          states: (pod.status.containerStatuses ?? []).map((container) => ({
            name: container.name,
            restartCount: container.restartCount,
            state: container.state,
            lastState: container.lastState,
          })),
        }));
      const rawEvidence = await evidence('memory-kubernetes', {
        deploymentId: failed.id,
        pods: actual,
      });
      requireValue(
        actual.some((pod) =>
          pod.states.some(
            (item) =>
              item.state.terminated?.reason === 'OOMKilled' ||
              item.lastState.terminated?.reason === 'OOMKilled',
          ),
        ),
        'NO_REAL_OOM',
      );
      requireValue(
        failure.failureObservation?.pods.some(
          (pod) =>
            pod.rolloutId === failed.id &&
            pod.containers?.some(
              (item) =>
                item.oomKilled ||
                item.reason === 'OOMKilled' ||
                item.lastTerminationReason === 'OOMKilled',
            ),
        ),
        'OOM_NOT_RETAINED',
      );
      return {
        deploymentId: failed.id,
        pods: actual,
        rawEvidence,
        failureObservation: failure.failureObservation,
      };
    });
    await configure('healthy-configuration', (value) => {
      value.args = ['serve'];
    });
    healthy = await publish('healthy-again');
  }
  await phase('install-controller-fault', installPolicy);
  await configure('partial-configuration', (value) => {
    value.environment.push({ name: 'OZZ_L05_REVISION', value: state.id });
  });
  const partial = await publish('partial-publication', 'failed');
  await phase('actual-partial-application', async () => {
    const observed = await service();
    const inventory = await currentInventory(partial.id);
    requireValue(
      ['partial', 'drifted'].includes(observed.configurationState),
      'PARTIAL_NOT_RECORDED',
    );
    requireValue(
      inventory.controller.snapshotId === healthy.id &&
        inventory.service.taskId === partial.id &&
        inventory.service.mutationRevision === String(partial.mutationRevision) &&
        inventory.runtimeSecret.snapshotId === partial.id &&
        inventory.runtimeSecret.uid,
      'PARTIAL_RESOURCES_NOT_OBSERVED',
    );
    const rejected = await api(
      '/services/' + state.serviceId + '/restart',
      'POST',
      { revision: observed.revision },
      randomUUID(),
      409,
    );
    requireValue(rejected.value.code === 'PUBLISHED_CONFIGURATION_REQUIRED', 'RESTART_NOT_GATED');
    return {
      configurationState: observed.configurationState,
      inventory,
      restartErrorCode: rejected.value.code,
    };
  });
  await phase('remove-controller-fault', async () => {
    await removePolicy();
    return { removed: true };
  });
  await phase('stop-partial', () => lifecycle('stop-partial-command', 'stop'));
  await phase('resume-partial-refused', async () => {
    const current = await service();
    const rejected = await api(
      '/services/' + state.serviceId + '/resume',
      'POST',
      { revision: current.revision },
      randomUUID(),
      409,
    );
    requireValue(rejected.value.code === 'PUBLISHED_CONFIGURATION_REQUIRED', 'RESUME_NOT_GATED');
    return { code: rejected.value.code, desiredState: current.desiredState };
  });
  await publish('explicit-repair', 'succeeded', {
    allowConfigurationRepair: true,
    deployAndStart: true,
  });
  await phase('stop-fixture', () => lifecycle('final-stop-command', 'stop'));
  await phase('parent-service-unchanged', async () => {
    const current = await data('/services/' + state.parentServiceId);
    const observed = {
      id: current.id,
      revision: current.revision,
      desiredState: current.desiredState,
      publishedDeploymentId: current.published?.deploymentId,
    };
    requireValue(isDeepStrictEqual(observed, state.parentBaseline), 'PARENT_SERVICE_CHANGED');
    return observed;
  });
}
async function cleanup() {
  cleaning = true;
  const issues = [];
  try {
    await removePolicy();
  } catch (error) {
    issues.push({ step: 'remove-policy', code: error.message });
  }
  try {
    if (cookie && state.serviceId) {
      let current = await service();
      if (current.activeTask) {
        const task = current.activeTask;
        requireValue(
          Object.values(state.commands).some((item) => item.id === task.id),
          'FOREIGN_ACTIVE_TASK',
        );
        const path = `/${task.type === 'deployment' ? 'deployments' : 'operations'}/${task.id}`;
        await api(path + '/cancel', 'POST', undefined, undefined, 202);
        await waitTask(path);
        current = await service();
      }
      await connectCluster();
      const controller = await wire(kube.origin, deployPath(), kube.tls);
      requireValue([200, 404].includes(controller.status), 'CLEANUP_CONTROLLER_READ');
      if (
        current.desiredState !== 'stopped' ||
        (controller.status === 200 && controller.value.spec.replicas !== 0)
      )
        await lifecycle('cleanup-stop', 'stop');
      state.cleanupStoppedObserved = await waitStopped();
    }
  } catch (error) {
    issues.push({ step: 'stop-fixture', code: error.message });
  }
  try {
    await pullPermission(true);
  } catch (error) {
    issues.push({ step: 'restore-acl', code: error.message });
  }
  state.cleanupIssues = issues.map((item) => ({
    ...item,
    code: /^GMVP_WORKLOAD_[A-Z0-9_]+$/u.test(item.code) ? item.code : 'CLEANUP_FAILED',
  }));
  await save();
  requireValue(!issues.length, 'CLEANUP_INCOMPLETE');
}
try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  lock = await open(resolve(directory, 'probe.lock'), 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, mode }));
  try {
    state = JSON.parse(await privateFile(directory, 'state.json'));
  } catch (error) {
    if (error.code !== 'ENOENT' || mode !== 'prepare') throw error;
    state = {
      owner,
      id: selectedAttempt ?? randomUUID(),
      scenario: selectedScenario ?? 'full',
      createdAt: new Date().toISOString(),
      commands: {},
      completed: {},
    };
    await save();
  }
  requireValue(state.owner === owner && uuid.test(state.id), 'STATE_IDENTITY');
  requireValue(
    !selectedScenario || selectedScenario === (state.scenario ?? 'full'),
    'SCENARIO_CHANGED',
  );
  if (mode === 'status')
    console.log(
      JSON.stringify({
        id: state.id,
        serviceId: state.serviceId,
        completed: Object.keys(state.completed),
        policyRemoved: state.policy?.removed,
        aclRestored: state.acl?.restored,
      }),
    );
  else {
    report = {
      version: 1,
      startedAt: new Date().toISOString(),
      mode,
      status: 'running',
      scope: owner,
      scenario: state.scenario ?? 'full',
    };
    configuration = await readProductConfiguration();
    await checkProductHttpsHealth(configuration);
    const password = (await privateFile(resolve(productRoot, '.secrets'), 'admin-password')).trim();
    secrets.push(password);
    const registry = JSON.parse(await privateFile(registryDirectory, 'users.json'));
    for (const user of registry.users)
      secrets.push(
        user.password,
        Buffer.from(user.username + ':' + user.password).toString('base64'),
      );
    try {
      secrets.push(await privateFile(directory, 'canary.txt'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await authenticate(password);
    if (mode === 'prepare') await prepare();
    else if (mode === 'cleanup') await cleanup();
    else {
      try {
        await run();
      } finally {
        await cleanup();
      }
    }
    report.status = 'passed';
  }
} catch (error) {
  process.exitCode = 1;
  const code = /^GMVP_WORKLOAD_[A-Z0-9_]+$/u.test(error.message ?? '')
    ? error.message
    : 'GMVP_WORKLOAD_PROBE_FAILED';
  if (report) {
    report.status = 'failed';
    report.code = code;
    report.errorKind = ['TypeError', 'SyntaxError', 'RangeError', 'Error', 'AbortError'].includes(
      error.name,
    )
      ? error.name
      : 'UnknownError';
    report.probeFrames =
      typeof error.stack === 'string'
        ? error.stack
            .split('\n')
            .slice(1)
            .filter((line) => line.includes(import.meta.filename))
            .slice(0, 5)
        : [];
  }
  console.error(JSON.stringify({ status: 'failed', code }));
} finally {
  if (report && state) {
    report.completedAt = new Date().toISOString();
    report.completed = state.completed;
    report.policyRemoved = state.policy?.removed ?? null;
    report.aclRestored = state.acl?.restored ?? null;
    report.cleanupIssues = state.cleanupIssues ?? [];
    report.serviceId = state.serviceId;
    const path = await evidence('report', report);
    console.log(JSON.stringify({ status: report.status, report: path }));
  }
  if (lock) {
    await lock.close();
    await unlink(resolve(directory, 'probe.lock'));
  }
}
