import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
import { crashAndRestartLocalWorker } from './local-worker-crash.mjs';

// Real API -> durable Worker -> A/B K3s -> cert-manager -> Pebble HTTP-01.
// Certificates from this fixture, including its production endpoint, are local test certificates.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const stateFile = resolve(lab, 'networking-product-state.json');
const reportFile = resolve(root, 'docs/acceptance/s4-product-local-results.json');
const commandScope = process.argv[2] ?? 'all';
if (!['prepare', 'issuance', 'all'].includes(commandScope))
  throw new Error('LOCAL_S4_COMMAND_INVALID');
const retryFailed = process.argv.includes('--retry-failed');
const api = 'http://127.0.0.1:3000/api';
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const image =
  'ghcr.io/stefanprodan/podinfo@sha256:ec73780a8425f59ea49f5bc8cdff0d598805a224fbaa1f86c67a244f250fa9da';
const appsDomainSuffix = 'apps.ozz.test';
const acmeEmail = 'acme@ozz.test';
const db = new PrismaClient();
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let cookie;
let csrf;
let stage = 'preflight';
let lock;
let registered;
let fixture;
let state;
try {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('LOCAL_S4_STATE_INVALID');
}
state ??= {
  version: 1,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  projects: {},
  environments: {},
  services: {},
  domains: {},
  commands: {},
  completed: {},
  checks: [],
};
if (state.version !== 1) throw new Error('LOCAL_S4_STATE_INVALID');
const report = {
  scope:
    'Real local API/Worker/PostgreSQL, ARM64 K3s A/B, Traefik, cert-manager and Pebble HTTP-01. Explicit split DNS and test CA only; not public DNS, trusted public certificates, AMD64 or Oracle capacity acceptance.',
  runId: state.runId,
  startedAt: state.startedAt,
  resumedAt: new Date().toISOString(),
  commandScope,
  checks: state.checks,
  status: 'running',
  localCertificateAuthority: true,
  publicCloudVerified: false,
};

function requireValue(value, code) {
  if (!value) throw new Error(code);
}
async function save() {
  await writeFile(`${stateFile}.pending`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${stateFile}.pending`, stateFile);
}
async function check(name, passed, details = {}) {
  requireValue(passed, `LOCAL_S4_ASSERTION: ${name}`);
  const result = { name, passed: true, observedAt: new Date().toISOString(), ...details };
  state.checks.push(result);
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
  if (expected ? response.status !== expected : !response.ok) {
    const error = new Error('LOCAL_S4_API_FAILED');
    error.status = response.status;
    error.code = value?.code;
    throw error;
  }
  return { response, value };
}
async function command(name, path, method, body) {
  if (!state.commands[name]) {
    state.commands[name] = { path, method, body, key: randomUUID() };
    await save();
  }
  const intent = state.commands[name];
  requireValue(intent.path === path && intent.method === method, 'LOCAL_S4_COMMAND_TARGET_CHANGED');
  const result = await request(intent.path, intent.method, intent.body, intent.key, 202);
  requireValue(!intent.id || intent.id === result.value.data.id, 'LOCAL_S4_IDEMPOTENCY_CHANGED');
  intent.id = result.value.data.id;
  await save();
  return result.value.data;
}
async function waitTask(type, id, { expected = 'succeeded', timeoutMs = 600_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  while (Date.now() < deadline) {
    const task = (await request(`/${type}/${id}`)).value.data;
    const signature = `${task.status}/${task.errorCode}/${task.attempts}`;
    if (signature !== previous)
      console.log(JSON.stringify({ task: id, status: task.status, code: task.errorCode }));
    previous = signature;
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      if (task.status !== expected) {
        const error = new Error('LOCAL_S4_TASK_FAILED');
        error.code = task.errorCode;
        error.taskId = id;
        throw error;
      }
      return task;
    }
    await delay(750, undefined, { signal: abort.signal });
  }
  throw new Error('LOCAL_S4_TASK_TIMEOUT');
}
async function finishOperation(name, task) {
  let current = (await request(`/operations/${task.id}`)).value.data;
  let retryIndex = 0;
  while (current.status === 'failed' && retryFailed) {
    const retryName = `${name}-retry-${++retryIndex}`;
    const existed = Boolean(state.commands[retryName]);
    current = await command(retryName, `/operations/${current.id}/retry`, 'POST');
    if (!existed) break;
    current = (await request(`/operations/${current.id}`)).value.data;
    requireValue(retryIndex <= 8, 'LOCAL_S4_RETRY_LIMIT');
  }
  return waitTask('operations', current.id);
}
const service = async (key) => (await request(`/services/${state.services[key]}`)).value.data;
const domain = async (key) => (await request(`/domains/${state.domains[key]}`)).value.data;
async function waitDomain(key, predicate, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  while (Date.now() < deadline) {
    const current = await domain(key);
    const signature = `${current.dns?.state}/${current.route?.state}/${current.certificate?.state}/${current.lastErrorCode}`;
    if (signature !== previous)
      console.log(JSON.stringify({ domain: current.id, observation: signature }));
    previous = signature;
    if (predicate(current)) return current;
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('LOCAL_S4_OBSERVATION_TIMEOUT');
}
async function domainAction(key, verb, label = `${verb}-${key}`) {
  const current = await domain(key);
  const task = await command(
    label,
    `/domains/${current.id}${verb === 'unbind' ? '' : `/${verb}`}`,
    verb === 'unbind' ? 'DELETE' : 'POST',
    { revision: current.revision },
  );
  return finishOperation(label, task);
}
async function fixtureDns(action, hostname) {
  requireValue(
    ['clear-a', 'add-a'].includes(action) && hostname.endsWith(`.a.${appsDomainSuffix}`),
    'LOCAL_S4_DNS_OVERRIDE_TARGET_INVALID',
  );
  const response = await fetch(`http://127.0.0.1:18055/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      host: hostname,
      ...(action === 'add-a' ? { addresses: ['192.0.2.123'] } : {}),
    }),
    // Cleanup must still complete when the acceptance run was cancelled.
    signal: globalThis.AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  requireValue(response.ok, 'LOCAL_S4_DNS_OVERRIDE_FAILED');
}
async function networkInventory(key, { includeDeleted = false } = {}) {
  return db.networkManagedResource.findMany({
    where: {
      domainId: state.domains[key],
      ...(includeDeleted ? {} : { deletedAt: null }),
    },
    select: {
      apiVersion: true,
      kind: true,
      namespace: true,
      name: true,
      role: true,
      scope: true,
      uid: true,
      creationNonce: true,
      resourceVersion: true,
      deletedAt: true,
    },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });
}
async function withLocalCluster(key, work) {
  requireValue(['a', 'b'].includes(key), 'LOCAL_S4_GUEST_INVALID');
  const connection = parseKubeconfig(
    await readFile(resolve(lab, `credentials/${key}.kubeconfig.json`), 'utf8'),
  );
  const url = new URL(connection.endpoint);
  requireValue(
    url.protocol === 'https:' && url.hostname === '127.0.0.1',
    'LOCAL_S4_KUBERNETES_NOT_LOCAL',
  );
  const client = await createInspectionClient(connection, transportLimits({}), abort.signal);
  try {
    const system = await client.core.readNamespace({ name: 'kube-system' });
    requireValue(
      system.metadata?.uid === fixture.identities[key].kubeSystemUid,
      'LOCAL_S4_CLUSTER_IDENTITY_CHANGED',
    );
    return await work(client);
  } finally {
    client.close();
  }
}
async function readOwnedIngress(client, row) {
  requireValue(
    row.kind === 'Ingress' && /^[a-z0-9-]+$/u.test(row.namespace) && /^[a-z0-9-]+$/u.test(row.name),
    'LOCAL_S4_FAULT_TARGET_INVALID',
  );
  try {
    const current = await client.request(
      'GET',
      `/apis/networking.k8s.io/v1/namespaces/${row.namespace}/ingresses/${row.name}`,
    );
    requireValue(
      current.metadata?.uid === row.uid &&
        current.metadata.annotations?.['networking.ozz.dev/creation-nonce'] === row.creationNonce,
      'LOCAL_S4_FAULT_TARGET_REPLACED',
    );
    return current;
  } catch (error) {
    if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return null;
    throw error;
  }
}

function remote(guest, source, body) {
  requireValue(['a', 'b'].includes(guest), 'LOCAL_S4_GUEST_INVALID');
  const quoted = `'${source.replaceAll("'", "'\\''")}'`;
  try {
    return JSON.parse(
      execFileSync(
        'ssh',
        [
          '-F',
          resolve(lab, 'credentials/ssh_config'),
          `ozz-lab-${guest}`,
          `sudo python3 -c ${quoted}`,
        ],
        {
          input: JSON.stringify(body),
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 128 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ),
    );
  } catch {
    // SSH output may contain a response or a credential. Keep failures controlled.
    throw new Error('LOCAL_S4_REMOTE_CHECK_FAILED');
  }
}
const httpSource = String.raw`
import hashlib, http.client, json, socket, ssl, sys
from pathlib import Path
value = json.load(sys.stdin)
assert Path('/etc/ozz-local-lab-instance').read_text().strip() == 'ozz-lab-' + value['guest']
host = value['hostname']
assert host.endswith('.apps.ozz.test') and all(c.isalnum() or c in '.-' for c in host)
connection = http.client.HTTPConnection(value['ip'], 80, timeout=8)
connection.request('GET', '/', headers={'Host': host})
response = connection.getresponse()
result = {'httpStatus': response.status, 'location': response.getheader('Location')}
response.read(65536); connection.close()
if not value.get('tls', True):
    print(json.dumps(result)); sys.exit(0)
ca = '/var/lib/ozz-local-lab/' + value['guest'] + '/networking-v1/' + value['environment'] + '-signing-root.pem'
context = ssl.create_default_context(cafile=ca)
with socket.create_connection((value['ip'],443), timeout=8) as raw:
    with context.wrap_socket(raw, server_hostname=host) as stream:
        cert = stream.getpeercert()
        result.update({'serialNumber': cert['serialNumber'], 'notBefore': cert['notBefore'], 'notAfter': cert['notAfter'], 'peerFingerprint':hashlib.sha256(stream.getpeercert(binary_form=True)).hexdigest(), 'hostnameVerified':True, 'localChainVerified':True})
        stream.sendall(('GET / HTTP/1.1\r\nHost: '+host+'\r\nConnection: close\r\n\r\n').encode())
        reply = http.client.HTTPResponse(stream); reply.begin()
        result['httpsStatus'] = reply.status
        application = json.loads(reply.read(65536))
        result['applicationHostname'] = application.get('hostname')
        result['applicationMessage'] = application.get('message')
try:
    with socket.create_connection((value['ip'],443), timeout=8) as raw:
        with ssl.create_default_context().wrap_socket(raw,server_hostname=host): pass
    result['defaultTrustRejected'] = False
except ssl.SSLCertVerificationError:
    result['defaultTrustRejected'] = True
print(json.dumps(result))
`;
function routeCheck(
  key,
  current,
  environment = current.certificateEnvironment,
  guest = key,
  tls = true,
) {
  return remote(guest, httpSource, {
    guest,
    hostname: current.hostname,
    environment,
    ip: fixture.ip,
    tls,
  });
}
function configuration(key) {
  return {
    image,
    replicas: 1,
    ports: [{ name: 'http', protocol: 'http', containerPort: 9898, servicePort: 80 }],
    resources: {
      requests: { cpuMillis: 50, memoryMiB: 32 },
      limits: { cpuMillis: 300, memoryMiB: 128 },
    },
    environment: [{ name: 'PODINFO_UI_MESSAGE', value: `Ozz S4 ${key.toUpperCase()}` }],
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
async function prepareProject(key) {
  if (!state.projects[key]) {
    const slug = `s4-network-${key}-${state.runId.slice(0, 8)}`;
    const existing = (await request(`/projects?search=${slug}&limit=100`)).value.data;
    requireValue(!existing.some((item) => item.slug === slug), 'LOCAL_S4_UNRECORDED_PROJECT');
    const created = (
      await request('/projects', 'POST', {
        name: `HTTPS 验证 ${key.toUpperCase()}`,
        slug,
        clusterId: registered.clusters[key],
        description: 'S4 真实本地路由与证书验收；测试 CA，不是公网可信签发。',
      })
    ).value.data;
    state.projects[key] = created.id;
    await save();
  }
  const project = (await request(`/projects/${state.projects[key]}`)).value.data;
  requireValue(project.clusterId === registered.clusters[key], 'LOCAL_S4_PROJECT_TARGET_CHANGED');
  const environments = (await request(`/environments?projectId=${project.id}&limit=100`)).value
    .data;
  const environment = environments.find((item) => item.slug === 'production');
  requireValue(environment, 'LOCAL_S4_ENVIRONMENT_MISSING');
  state.environments[key] = environment.id;
  await save();
  await check(`${key}: dedicated project inherits the existing trusted cluster`, true, {
    projectId: project.id,
    environmentId: environment.id,
    clusterId: project.clusterId,
  });
}
async function prepareService(key, guest = key) {
  if (!state.services[key]) {
    const created = (
      await request('/services', 'POST', {
        projectId: state.projects[guest],
        environmentId: state.environments[guest],
        name: key === guest ? `HTTPS 应用 ${key.toUpperCase()}` : `HTTPS ${key}`,
        slug: key === guest ? 'podinfo' : key,
        description: 'S4 本地真实验收专用服务。',
        configuration: configuration(key),
      })
    ).value.data;
    state.services[key] = created.id;
    await save();
  }
  const current = await service(key);
  requireValue(
    current.projectId === state.projects[guest] && current.clusterId === registered.clusters[guest],
    'LOCAL_S4_SERVICE_TARGET_CHANGED',
  );
  const task = await command(`publish-${key}`, `/services/${current.id}/deployments`, 'POST', {
    revision: current.revision,
  });
  await waitTask('deployments', task.id);
  const after = await service(key);
  await check(
    `${key}: published HTTP service is healthy`,
    after.runtimeState === 'running' &&
      after.published?.deploymentId === task.id &&
      after.observation?.pods.some((pod) => pod.ready),
    { serviceId: current.id, deploymentId: task.id },
  );
  return current.id;
}
async function prepareSettings() {
  const current = (await request('/platform-settings')).value.data;
  requireValue(
    !current.appsDomainSuffix ||
      (current.appsDomainSuffix === appsDomainSuffix && current.acmeEmail === acmeEmail),
    'LOCAL_S4_EXISTING_PLATFORM_SETTINGS',
  );
  if (current.appsDomainSuffix !== appsDomainSuffix)
    await request('/platform-settings', 'PATCH', {
      revision: current.revision,
      appsDomainSuffix,
      acmeEmail,
    });
  for (const key of ['a', 'b']) {
    const id = registered.clusters[key];
    const cluster = (await request(`/clusters/${id}`)).value.data;
    requireValue(
      cluster.identity?.kubeSystemUid === fixture.identities[key].kubeSystemUid,
      'LOCAL_S4_CLUSTER_IDENTITY_CHANGED',
    );
    const previous = (await request(`/clusters/${id}/networking`)).value.data;
    const desired = { subdomain: key, entryAddresses: [fixture.ip], cnameTarget: null };
    requireValue(
      !previous.subdomain ||
        (previous.subdomain === key &&
          JSON.stringify(previous.entryAddresses) === JSON.stringify(desired.entryAddresses) &&
          previous.cnameTarget === null),
      'LOCAL_S4_EXISTING_CLUSTER_SETTINGS',
    );
    if (!previous.subdomain)
      await request(`/clusters/${id}/networking`, 'PATCH', {
        revision: previous.revision,
        ...desired,
      });
    await check(
      `${key}: application entry and suffix are explicit and separate from API endpoint`,
      true,
      { clusterId: id, expectedAddress: fixture.ip, domainSuffix: `${key}.${appsDomainSuffix}` },
    );
  }
}
async function install(key) {
  const id = registered.clusters[key];
  const settings = (await request(`/clusters/${id}/networking`)).value.data;
  const initial = await command(
    `network-check-${key}`,
    `/clusters/${id}/networking/check`,
    'POST',
    { revision: settings.revision },
  );
  await finishOperation(`network-check-${key}`, initial);
  const before = (await request(`/clusters/${id}/networking`)).value.data;
  requireValue(
    ['missing', 'ready'].includes(before.capabilities?.certManager),
    'LOCAL_S4_CERT_MANAGER_PRECHECK_FAILED',
  );
  const task = await command(
    `install-${key}`,
    `/clusters/${id}/networking/install-cert-manager`,
    'POST',
    { revision: settings.revision },
  );
  await finishOperation(`install-${key}`, task);
  const after = (await request(`/clusters/${id}/networking`)).value.data;
  await check(
    `${key}: fixed cert-manager install and Traefik capability check are ready`,
    after.capabilities?.certManager === 'ready' &&
      after.capabilities?.ingressClass === 'ready' &&
      after.capabilities?.traefikMiddleware === 'ready',
    { operationId: task.id, capabilities: after.capabilities },
  );
}
async function bind(key, guest = key) {
  const networking = (await request(`/services/${state.services[key]}/networking`)).value.data;
  const port = networking.eligiblePorts.find((item) => item.name === 'http');
  requireValue(port, 'LOCAL_S4_HTTP_PORT_NOT_ELIGIBLE');
  const task = await command(`bind-${key}`, `/services/${state.services[key]}/domains`, 'POST', {
    revision: networking.serviceRevision,
    portId: port.id,
  });
  requireValue(task.input?.domainId && task.input.hostname, 'LOCAL_S4_BINDING_IDENTITY_MISSING');
  state.domains[key] = task.input.domainId;
  await save();
  const replay = await command(`bind-${key}`, `/services/${state.services[key]}/domains`, 'POST', {
    revision: networking.serviceRevision,
    portId: port.id,
  });
  requireValue(
    replay.id === task.id && replay.input.hostname === task.input.hostname,
    'LOCAL_S4_BINDING_REPLAY_CHANGED',
  );
  await finishOperation(`bind-${key}`, task);
  const current = await waitDomain(
    key,
    (item) =>
      item.dns?.state === 'matched' &&
      item.route?.state === 'ready' &&
      item.certificate?.state === 'staging_ready' &&
      !item.observationStale,
  );
  await check(
    `${key}: stable published port and idempotent hostname reach real staging issuance`,
    current.servicePort.id === port.id &&
      current.cluster.id === registered.clusters[guest] &&
      current.certificate.authority === 'local_test' &&
      current.hostname.endsWith(`.${guest}.${appsDomainSuffix}`),
    {
      domainId: current.id,
      hostname: current.hostname,
      portId: port.id,
      certificate: current.certificate,
    },
  );
  const actual = routeCheck(key, current, 'staging', guest);
  await check(
    `${key}: HTTP redirects and hostname-verified local TLS serves the correct application`,
    [301, 302, 307, 308].includes(actual.httpStatus) &&
      actual.location === `https://${current.hostname}/` &&
      actual.httpsStatus === 200 &&
      actual.applicationMessage === `Ozz S4 ${key.toUpperCase()}` &&
      actual.defaultTrustRejected,
    actual,
  );
  return {
    domainId: current.id,
    hostname: current.hostname,
    certificate: current.certificate,
    tls: actual,
  };
}

try {
  await mkdir(lab, { recursive: true, mode: 0o700 });
  lock = await open(`${stateFile}.lock`, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  registered = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
  fixture = JSON.parse(await readFile(resolve(lab, 'networking-lab/state.json'), 'utf8'));
  requireValue(
    fixture.owner === 'ozz-local-networking-lab-v1' && fixture.ip === '192.168.5.15',
    'LOCAL_S4_FIXTURE_MISMATCH',
  );
  const fixturePath = resolve(lab, 'networking-lab/worker-test-config.json');
  requireValue(
    process.env.NODE_ENV !== 'production' &&
      process.env.NETWORK_LOCAL_ACME_CONFIG_FILE === fixturePath &&
      process.env.NETWORK_DNS_SERVERS === '127.0.0.1:10553',
    'LOCAL_S4_WORKER_FIXTURE_CONFIG_REQUIRED',
  );
  const fixtureStat = await stat(fixturePath);
  requireValue(
    fixtureStat.isFile() && (fixtureStat.mode & 0o077) === 0,
    'LOCAL_S4_FIXTURE_PERMISSIONS',
  );
  const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
  const login = await request('/auth/login', 'POST', { username: 'admin', password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  requireValue(cookie && csrf, 'LOCAL_S4_LOGIN_FAILED');
  if (state.dnsOverride) {
    await fixtureDns('clear-a', state.dnsOverride);
    delete state.dnsOverride;
    await save();
  }
  await phase('platform-and-cluster-settings', prepareSettings);
  for (const key of ['a', 'b']) {
    await phase(`project-${key}`, () => prepareProject(key));
    await phase(`service-${key}`, () => prepareService(key));
  }
  await phase('service-ui-check', () => prepareService('ui-check', 'a'));
  await phase('service-delete-check', () => prepareService('delete-check', 'a'));
  if (commandScope !== 'prepare') {
    for (const key of ['a', 'b']) {
      await phase(`cert-manager-${key}`, () => install(key));
      await phase(`binding-${key}`, () => bind(key));
    }
    await phase('cross-cluster-routing', async () => {
      for (const key of ['a', 'b']) {
        const current = await domain(key);
        const other = key === 'a' ? 'b' : 'a';
        const actual = routeCheck(key, current, 'staging', other, false);
        await check(
          `${key}: the other cluster has no route for this hostname`,
          actual.httpStatus === 404,
          {
            hostname: current.hostname,
            wrongCluster: registered.clusters[other],
            httpStatus: actual.httpStatus,
          },
        );
      }
    });
    await phase('binding-identity-protection', async () => {
      const before = await domain('a');
      const current = await service('a');
      await request(`/services/${current.id}`, 'PATCH', {
        revision: current.revision,
        name: 'HTTPS 应用 A · 已改名',
      });
      const renamed = await service('a');
      const sameDomain = await domain('a');
      await check(
        'service display-name changes keep the allocated hostname and bound port identity',
        sameDomain.id === before.id &&
          sameDomain.hostname === before.hostname &&
          sameDomain.servicePort.id === before.servicePort.id,
      );
      const invalid = globalThis.structuredClone(renamed.configuration);
      invalid.ports[0].name = 'replacement';
      invalid.readiness.port = 'replacement';
      const rejected = await request(
        `/services/${current.id}`,
        'PATCH',
        { revision: renamed.revision, configuration: invalid },
        undefined,
        409,
      );
      await check(
        'a bound published HTTP port cannot be removed through an ordinary configuration save',
        rejected.value.code === 'DOMAIN_PORT_IN_USE',
      );
    });
    await phase('dns-mismatch-production-gate', async () => {
      const before = await domain('a');
      state.dnsOverride = before.hostname;
      await save();
      try {
        await fixtureDns('clear-a', before.hostname);
        await fixtureDns('add-a', before.hostname);
        await domainAction('a', 'sync', 'mismatched-dns-sync');
        const mismatched = await waitDomain('a', (item) => item.dns?.state === 'mismatch');
        const refused = await request(
          `/domains/${before.id}/production`,
          'POST',
          { revision: mismatched.revision },
          randomUUID(),
          409,
        );
        await check(
          'a wrong DNS answer is visible independently and blocks production admission',
          refused.value.code === 'STAGING_CERTIFICATE_REQUIRED' &&
            mismatched.route?.state === 'ready' &&
            mismatched.certificate?.authority === 'local_test' &&
            mismatched.certificateEnvironment === 'staging',
          { dns: mismatched.dns, route: mismatched.route, certificate: mismatched.certificate },
        );
      } finally {
        await fixtureDns('clear-a', before.hostname);
        delete state.dnsOverride;
        await save();
      }
      await domainAction('a', 'sync', 'restored-dns-sync');
      const restored = await waitDomain(
        'a',
        (item) => item.dns?.state === 'matched' && !item.observationStale,
      );
      await check(
        'removing one test DNS override restores the original binding',
        restored.id === before.id &&
          restored.hostname === before.hostname &&
          restored.revision === before.revision,
        { domainId: restored.id, dns: restored.dns },
      );
    });
    for (const key of ['a', 'b']) {
      await phase(`production-${key}`, async () => {
        // Refresh the short-lived staging evidence immediately before admission.
        await domainAction(key, 'sync', `staging-refresh-${key}`);
        await waitDomain(
          key,
          (item) =>
            item.certificate?.state === 'staging_ready' &&
            item.dns?.state === 'matched' &&
            !item.observationStale,
        );
        const task = await domainAction(key, 'production');
        const current = await waitDomain(
          key,
          (item) =>
            item.certificateEnvironment === 'production' &&
            item.certificate?.state === 'ready' &&
            item.certificate?.environment === 'production' &&
            !item.observationStale,
        );
        const actual = routeCheck(key, current);
        await check(
          `${key}: explicit production transition retains staging proof and uses a separate test authority`,
          task.input.stagingVerification?.authority === 'local_test' &&
            current.certificate.authority === 'local_test' &&
            actual.httpsStatus === 200 &&
            actual.defaultTrustRejected,
          {
            operationId: task.id,
            stagingVerification: task.input.stagingVerification,
            certificate: current.certificate,
            tls: actual,
          },
        );
        return {
          notAfter: current.certificate.notAfter,
          serialNumber: actual.serialNumber,
          peerFingerprint: actual.peerFingerprint,
        };
      });
    }
  }
  if (commandScope === 'all') {
    for (const key of ['a', 'b']) {
      await phase(`automatic-renewal-${key}`, async () => {
        const before = state.completed[`production-${key}`];
        const current = await waitDomain(
          key,
          (item) =>
            item.certificate?.state === 'ready' &&
            Date.parse(item.certificate.notAfter) > Date.parse(before.notAfter) &&
            !item.observationStale,
          360_000,
        );
        const actual = routeCheck(key, current);
        await check(
          `${key}: cert-manager renews without a control-plane certificate write`,
          actual.serialNumber !== before.serialNumber &&
            actual.peerFingerprint !== before.peerFingerprint &&
            actual.httpsStatus === 200,
          { before, certificate: current.certificate, tls: actual },
        );
      });
    }
    await phase('reconcile-retains-binding', async () => {
      const before = await domain('a');
      const inventory = await networkInventory('a');
      await domainAction('a', 'reconcile');
      const after = await waitDomain(
        'a',
        (item) =>
          item.route?.state === 'ready' &&
          item.certificate?.state === 'ready' &&
          !item.observationStale,
      );
      const later = await networkInventory('a');
      await check(
        'explicit reconcile retains hostname, port, certificate environment and existing resource identities',
        after.id === before.id &&
          after.hostname === before.hostname &&
          after.servicePort.id === before.servicePort.id &&
          after.certificateEnvironment === before.certificateEnvironment &&
          after.revision === before.revision + 1 &&
          inventory.every((item) =>
            later.some(
              (next) =>
                next.kind === item.kind &&
                next.name === item.name &&
                next.uid === item.uid &&
                next.creationNonce === item.creationNonce,
            ),
          ),
        {
          domainId: after.id,
          beforeRevision: before.revision,
          afterRevision: after.revision,
          resources: later,
        },
      );
    });
    await phase('missing-route-requires-explicit-reconcile', async () => {
      const before = await domain('a');
      if (!state.missingRoute) {
        const row = (await networkInventory('a')).find(
          (item) => item.kind === 'Ingress' && item.role === 'http',
        );
        requireValue(row?.uid, 'LOCAL_S4_HTTP_INGRESS_NOT_OWNED');
        state.missingRoute = {
          ...row,
          domainId: before.id,
          hostname: before.hostname,
          revision: before.revision,
        };
        await save();
      }
      const original = state.missingRoute;
      requireValue(
        original.domainId === before.id && original.hostname === before.hostname,
        'LOCAL_S4_FAULT_TARGET_CHANGED',
      );
      await withLocalCluster('a', async (client) => {
        const current = await readOwnedIngress(client, original);
        if (current) {
          await client.request(
            'DELETE',
            `/apis/networking.k8s.io/v1/namespaces/${original.namespace}/ingresses/${original.name}`,
            {
              apiVersion: 'v1',
              kind: 'DeleteOptions',
              propagationPolicy: 'Foreground',
              preconditions: {
                uid: current.metadata.uid,
                resourceVersion: current.metadata.resourceVersion,
              },
            },
          );
          const deadline = Date.now() + 30_000;
          while (await readOwnedIngress(client, original)) {
            requireValue(Date.now() < deadline, 'LOCAL_S4_FAULT_DELETION_TIMEOUT');
            await delay(250, undefined, { signal: abort.signal });
          }
        }
      });
      await domainAction('a', 'sync', 'missing-route-sync');
      const missing = await waitDomain('a', (item) => item.route?.state === 'missing');
      const remainsAbsent = await withLocalCluster(
        'a',
        async (client) => (await readOwnedIngress(client, original)) === null,
      );
      await check(
        'read-only sync reports a missing owned route without recreating it',
        remainsAbsent &&
          missing.revision === original.revision &&
          missing.certificateEnvironment === 'production',
        { originalIngressUid: original.uid, domainId: missing.id, route: missing.route },
      );
      await domainAction('a', 'reconcile', 'recreate-missing-route');
      const recovered = await waitDomain(
        'a',
        (item) =>
          item.route?.state === 'ready' &&
          item.certificate?.state === 'ready' &&
          !item.observationStale,
      );
      const recreated = (await networkInventory('a')).find(
        (item) => item.kind === original.kind && item.name === original.name,
      );
      await check(
        'explicit reconcile recreates only the confirmed absent route with a new UID and nonce',
        recreated?.uid &&
          recreated.uid !== original.uid &&
          recreated.creationNonce !== original.creationNonce &&
          recovered.id === original.domainId &&
          recovered.hostname === original.hostname &&
          recovered.revision === original.revision + 1 &&
          routeCheck('a', recovered).httpsStatus === 200,
        {
          originalIngressUid: original.uid,
          replacementIngressUid: recreated?.uid,
          domainId: recovered.id,
        },
      );
    });
    await phase('binding-delete-check', () => bind('delete-check', 'a'));
    await phase('service-delete-cleans-domain', async () => {
      const current = await service('delete-check');
      const inventory = await networkInventory('delete-check');
      const task = await command('delete-service', `/services/${current.id}`, 'DELETE', {
        revision: current.revision,
      });
      await finishOperation('delete-service', task);
      await request(`/services/${current.id}`, 'GET', undefined, undefined, 404);
      await request(`/domains/${state.domains['delete-check']}`, 'GET', undefined, undefined, 404);
      const retained = await db.networkManagedResource.findMany({
        where: {
          clusterId: registered.clusters.a,
          uid: { in: inventory.map((item) => item.uid).filter(Boolean) },
        },
        select: { uid: true, deletedAt: true, domainId: true },
      });
      await check(
        'service deletion confirms domain resources gone and retains their historical receipts',
        retained.length === inventory.length &&
          retained.every((item) => item.deletedAt && item.domainId === null),
        {
          serviceId: current.id,
          domainId: state.domains['delete-check'],
          retainedResourceCount: retained.length,
        },
      );
      const sibling = await domain('a');
      await check(
        'shared environment and another service remain routable after domain-aware deletion',
        routeCheck('a', sibling).httpsStatus === 200,
      );
    });
    await phase('worker-recovers-network-write', async () => {
      const before = await domain('b');
      if (!state.recoveryBaseline) {
        state.recoveryBaseline = {
          id: before.id,
          hostname: before.hostname,
          portId: before.servicePort.id,
          resources: await networkInventory('b'),
        };
        await save();
      }
      const original = state.recoveryBaseline;
      requireValue(
        original.id === before.id && original.hostname === before.hostname,
        'LOCAL_S4_RECOVERY_TARGET_CHANGED',
      );
      const task = await command(
        'recover-network-worker',
        `/domains/${before.id}/reconcile`,
        'POST',
        { revision: before.revision },
      );
      if (!state.workerCrash) {
        const deadline = Date.now() + 60_000;
        let observedWrite = false;
        while (Date.now() < deadline) {
          const current = await db.operation.findUniqueOrThrow({
            where: { id: task.id },
            select: { status: true },
          });
          requireValue(
            !['succeeded', 'failed', 'cancelled'].includes(current.status),
            'LOCAL_S4_WORKER_CRASH_WINDOW_MISSED',
          );
          if (
            current.status === 'running' &&
            (await db.networkManagedResource.count({
              where: {
                domainId: before.id,
                revision: task.input.domainRevision,
                uid: { not: null },
                deletedAt: null,
              },
            }))
          ) {
            observedWrite = true;
            break;
          }
          await delay(20, undefined, { signal: abort.signal });
        }
        requireValue(observedWrite, 'LOCAL_S4_WORKER_WRITE_WINDOW_TIMEOUT');
      }
      await crashAndRestartLocalWorker({
        root,
        database: db,
        state,
        save,
        operationId: task.id,
        domainId: before.id,
      });
      const completed = await waitTask('operations', task.id, { timeoutMs: 180_000 });
      const recovered = await waitDomain(
        'b',
        (item) =>
          item.route?.state === 'ready' &&
          item.certificate?.state === 'ready' &&
          !item.observationStale,
      );
      const later = await networkInventory('b');
      await check(
        'SIGKILL after a confirmed network write recovers the same durable task and resource identities',
        completed.attempts >= 2 &&
          recovered.id === original.id &&
          recovered.hostname === original.hostname &&
          recovered.servicePort.id === original.portId &&
          original.resources.every((item) =>
            later.some(
              (next) =>
                next.kind === item.kind &&
                next.name === item.name &&
                next.uid === item.uid &&
                next.creationNonce === item.creationNonce,
            ),
          ),
        { operationId: completed.id, attempts: completed.attempts, workerCrash: state.workerCrash },
      );
      const actual = routeCheck('b', recovered);
      await check(
        'the recovered binding serves the original application over verified local TLS',
        actual.httpsStatus === 200 && actual.applicationMessage === 'Ozz S4 B',
        actual,
      );
    });
  }
  report.status = commandScope === 'all' ? 'passed' : 'partial';
  report.prepared = {
    projects: state.projects,
    environments: state.environments,
    services: state.services,
    domains: state.domains,
  };
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    message: String(error.message ?? '').startsWith('LOCAL_S4_')
      ? error.message
      : 'LOCAL_S4_UNEXPECTED_FAILURE',
    code: typeof error.code === 'string' && /^[A-Z_]+$/u.test(error.code) ? error.code : null,
    status: error.status ?? null,
    taskId: error.taskId ?? null,
  };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  if (lock) {
    await save();
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    if (report.status === 'failed')
      await writeFile(
        reportFile.replace('.json', `-failure-${Date.now()}.json`),
        JSON.stringify(report, null, 2) + '\n',
      );
    await lock.close();
    await unlink(`${stateFile}.lock`);
  }
  await db.$disconnect();
}
