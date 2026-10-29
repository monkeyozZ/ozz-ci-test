import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const stateFile = resolve(lab, 'product-state.json');
const reportFile = resolve(root, 'docs/acceptance/s2-local-results.json');
const endpoint = 'http://127.0.0.1:3000/api';
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let state;
try {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
} catch {
  state = { version: 1, runId: randomUUID(), clusters: {}, keys: {}, operations: {} };
}
if (state.version !== 1) throw new Error('INVALID_LOCAL_PRODUCT_STATE');
const report = {
  scope:
    '真实本地 Linux + 产品 API/Worker + 三套 K3s；不代表云端 SSH/防火墙、公网入口或 Oracle 容量验收。',
  runId: state.runId,
  startedAt: new Date().toISOString(),
  checks: [],
  status: 'running',
  retainedResources: true,
};
let cookie;
let csrf;
let stage = 'login';

async function save() {
  await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${stateFile}.tmp`, stateFile);
}

function check(name, value, details = {}) {
  report.checks.push({ name, passed: Boolean(value), ...details });
  if (!value) throw new Error('LOCAL_ACCEPTANCE_ASSERTION_FAILED');
  console.log(JSON.stringify({ check: name, passed: true }));
}

async function request(path, method = 'GET', body, key) {
  const response = await fetch(endpoint + path, {
    method,
    headers: {
      origin,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(15_000)]),
  });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error('LOCAL_API_REQUEST_FAILED');
    error.status = response.status;
    error.problemCode = typeof result?.code === 'string' ? result.code : null;
    throw error;
  }
  return { body: result, response };
}

async function command(name, path, body) {
  if (!state.keys[name]) {
    state.keys[name] = randomUUID();
    await save();
  }
  const result = await request(path, 'POST', body, state.keys[name]);
  const operation = result.body.data;
  state.operations[name] = operation.id;
  await save();
  check(`${name}: durable acceptance`, result.response.status === 202 && Boolean(operation.id));
  return operation;
}

async function waitOperation(id, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const value = (await request(`/operations/${id}`)).body.data;
    const fingerprint = `${value.status}/${value.attempts}/${value.errorCode ?? ''}`;
    if (last !== fingerprint)
      console.log(
        JSON.stringify({
          operationId: id,
          kind: value.kind,
          status: value.status,
          attempt: value.attempts,
          errorCode: value.errorCode,
        }),
      );
    last = fingerprint;
    if (value.status === 'succeeded') return value;
    if (['failed', 'cancelled'].includes(value.status)) {
      const error = new Error('LOCAL_OPERATION_FAILED');
      error.problemCode = value.errorCode;
      throw error;
    }
    await delay(750, undefined, { signal: abort.signal });
  }
  throw new Error('LOCAL_OPERATION_TIMEOUT');
}

async function ensureCluster(key) {
  if (state.clusters[key]) return (await request(`/clusters/${state.clusters[key]}`)).body.data;
  const slug = `ozz-local-${key}`;
  const existing = (await request(`/clusters?search=${slug}&limit=100`)).body.data.find(
    (row) => row.slug === slug,
  );
  if (existing) throw new Error('LOCAL_CLUSTER_WITHOUT_SAVED_OWNERSHIP');
  const cluster = (
    await request('/clusters', 'POST', {
      name: `本地集群 ${key.toUpperCase()}`,
      slug,
      description: 'Ozz 产品本地接入验收；真实 Linux/K3s，保留用于后续开发。',
    })
  ).body.data;
  state.clusters[key] = cluster.id;
  await save();
  return cluster;
}

async function importCluster(key) {
  stage = `import-${key}`;
  let cluster = await ensureCluster(key);
  if (!cluster.identity) {
    state.kubeconfigRefs ??= {};
    if (!state.kubeconfigRefs[key]) {
      const kubeconfig = await readFile(resolve(lab, `credentials/${key}.kubeconfig.json`), 'utf8');
      const credential = (
        await request('/secrets', 'POST', {
          name: `本地集群 ${key.toUpperCase()} 接入凭证`,
          kind: 'kubeconfig',
          payload: { kubeconfig },
        })
      ).body.data;
      state.kubeconfigRefs[key] = credential.id;
      await save();
    }
    const operation = await command(`connect-${key}`, `/clusters/${cluster.id}/connect`, {
      revision: cluster.revision,
      credentialRefId: state.kubeconfigRefs[key],
    });
    await waitOperation(operation.id);
    cluster = (await request(`/clusters/${cluster.id}`)).body.data;
  }
  check(
    `import-${key}: verified identity and real nodes`,
    cluster.connectionStatus === 'connected' &&
      Boolean(cluster.identity?.kubeSystemUid) &&
      cluster.nodeCount === 1,
    { clusterId: cluster.id, nodeCount: cluster.nodeCount },
  );
  return cluster;
}

async function initializeC() {
  stage = 'server-c';
  if (!state.sshCredentialRefId) {
    const privateKey = await readFile(resolve(lab, 'lima/_config/user'), 'utf8');
    state.sshCredentialRefId = (
      await request('/secrets', 'POST', {
        name: '本地 Lima SSH 接入凭证',
        kind: 'ssh',
        payload: { privateKey },
      })
    ).body.data.id;
    await save();
  }
  if (!state.serverC) {
    state.serverC = (
      await request('/servers', 'POST', {
        name: '本地 Linux C',
        host: '127.0.0.1',
        sshPort: 60322,
        sshUser: 'ozz',
        credentialRefId: state.sshCredentialRefId,
        region: 'local-vz',
        tags: ['ozz-local-lab', 'product-initialization'],
      })
    ).body.data.id;
    await save();
  }
  let server = (await request(`/servers/${state.serverC}`)).body.data;
  if (!server.hostKey.trustedFingerprint) {
    const operation = await command('discover-c', `/servers/${server.id}/discover-host-key`, {
      revision: server.revision,
    });
    await waitOperation(operation.id);
    server = (await request(`/servers/${server.id}`)).body.data;
    const line = (await readFile(resolve(lab, 'credentials/known_hosts'), 'utf8'))
      .split('\n')
      .find((value) => value.startsWith('ozz-lab-c '));
    if (!line) throw new Error('TRUSTED_LAB_HOST_KEY_MISSING');
    const fingerprint =
      'SHA256:' +
      createHash('sha256')
        .update(Buffer.from(line.split(/\s+/)[2], 'base64'))
        .digest('base64')
        .replace(/=+$/, '');
    check(
      'server-c: discovered fingerprint equals independent VZ bootstrap channel',
      fingerprint === server.hostKey.observedFingerprint,
    );
    server = (
      await request(`/servers/${server.id}/trust-host-key`, 'POST', {
        revision: server.revision,
        discoveryOperationId: operation.id,
        fingerprint,
        source:
          '通过项目内 Lima VZ 控制通道读取虚拟机 SSH 公钥，并与本地受保护 known_hosts 独立核对。',
      })
    ).body.data;
  }
  let cluster = await ensureCluster('c');
  if (!state.initializationRequest) {
    const operation = await command('preflight-c', `/servers/${server.id}/preflight`, {
      revision: server.revision,
    });
    await waitOperation(operation.id);
    server = (await request(`/servers/${server.id}`)).body.data;
    check(
      'server-c: actual clean Linux passed preflight',
      server.preflight?.blockers.length === 0 && server.preflight?.k3s.installed === false,
      { architecture: server.preflight?.architecture, cpuCount: server.preflight?.cpuCount },
    );
    state.initializationRequest = {
      revision: server.revision,
      clusterId: cluster.id,
      nodeName: 'ozz-node',
      apiEndpoint: 'https://127.0.0.1:36443',
    };
    await save();
  }
  stage = 'initialize-c';
  const operation = await command(
    'initialize-c',
    `/servers/${server.id}/initialize`,
    state.initializationRequest,
  );
  let execution = (await request(`/operations/${state.initializationExecutionId ?? operation.id}`))
    .body.data;
  if (execution.status === 'failed' && process.argv.includes('--retry-initialization')) {
    execution = await command(
      `retry-initialize-c-${execution.id}`,
      `/operations/${execution.id}/retry`,
      {},
    );
    state.initializationExecutionId = execution.id;
    await save();
  }
  await waitOperation(execution.id, 15 * 60_000);
  cluster = (await request(`/clusters/${cluster.id}`)).body.data;
  server = (await request(`/servers/${server.id}`)).body.data;
  check(
    'server-c: initialized through product Worker with encryption',
    cluster.connectionStatus === 'connected' &&
      server.preflight?.k3s.installed &&
      server.preflight.k3s.secretsEncryption === 'enabled',
    { serverId: server.id, clusterId: cluster.id, version: server.preflight?.k3s.version },
  );
  const repeated = await command(
    'initialize-c',
    `/servers/${server.id}/initialize`,
    state.initializationRequest,
  );
  check(
    'server-c: repeated acceptance returns the same initialization',
    repeated.id === operation.id,
  );
  const nodes = (await request(`/servers/${server.id}/nodes`)).body.data;
  check(
    'server-c: Server and Cluster share one Node identity',
    nodes.length === 1 && nodes[0].clusterId === cluster.id && nodes[0].serverId === server.id,
  );
  return cluster;
}

try {
  await mkdir(lab, { recursive: true, mode: 0o700 });
  const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
  const login = await request('/auth/login', 'POST', { username: 'admin', password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.body.data.csrfToken;
  if (!cookie || !csrf) throw new Error('LOCAL_LOGIN_FAILED');
  const clusters = [await importCluster('a'), await importCluster('b'), await initializeC()];
  check(
    'three independent clusters retain unique identities',
    new Set(clusters.map((cluster) => cluster.identity.kubeSystemUid)).size === 3 &&
      new Set(clusters.map((cluster) => cluster.identity.caFingerprint)).size === 3,
  );
  const nodes = await Promise.all(
    clusters.map(async (cluster) => (await request(`/clusters/${cluster.id}/nodes`)).body.data),
  );
  check(
    'same node names remain separate by cluster + UID',
    nodes.every((list) => list[0]?.name === 'ozz-node') &&
      new Set(nodes.map((list) => list[0]?.uid)).size === 3,
  );
  stage = 'project-binding';
  state.projects ??= {};
  for (const [index, cluster] of clusters.entries()) {
    const key = ['a', 'b', 'c'][index];
    if (!state.projects[key]) {
      state.projects[key] = (
        await request('/projects', 'POST', {
          name: `本地项目 ${key.toUpperCase()}`,
          slug: `ozz-local-project-${key}`,
          clusterId: cluster.id,
          description: '用于验证项目固定归属集群与后续真实部署。',
        })
      ).body.data.id;
      await save();
    }
    const project = (await request(`/projects/${state.projects[key]}`)).body.data;
    check(`project-${key}: fixed Cluster with production`, project.clusterId === cluster.id, {
      projectId: project.id,
      clusterId: cluster.id,
    });
  }
  report.resources = { clusters: state.clusters, serverC: state.serverC, projects: state.projects };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    errorType: error.name,
    ioCode: typeof error.code === 'string' ? error.code : null,
    causeCode: typeof error.cause?.code === 'string' ? error.cause.code : null,
    code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_ACCEPTANCE_FAILED',
    httpStatus: error.status ?? null,
    problemCode: error.problemCode ?? null,
  };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  if (cookie && csrf) {
    try {
      await request('/auth/logout', 'POST');
    } catch {
      /* Session expires independently. */
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      report: reportFile,
      state: stateFile,
    }),
  );
}
