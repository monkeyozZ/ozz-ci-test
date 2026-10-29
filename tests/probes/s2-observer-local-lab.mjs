import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SshAdapter } from '../../packages/infrastructure/dist/ssh.js';

// Uses the retained, product-connected lab. Only VM A is stopped; its disk,
// cluster identity and saved SSH trust must survive. No direct database writes,
// manual sync or Kubernetes API calls may make the product observer pass.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const state = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
const reportFile = resolve(root, 'docs/acceptance/s2-observer-local-results.json');
const endpoint = 'http://127.0.0.1:3000/api';
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const execute = promisify(execFile);
const abort = new globalThis.AbortController();
const ssh = new SshAdapter();
const report = {
  scope: '真实三 VM / 三 K3s 的产品后台观察失联与恢复；不包含云网络或应用入口验收。',
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: [],
  stoppedInstance: 'ozz-lab-a',
  retainedResources: true,
  restored: false,
};
let cookie;
let csrf;
let recovering = false;
let mustRestore = false;
let stage = 'preconditions';
let before;
let hostKey;
let trustHash;
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function check(name, passed, details = {}) {
  report.checks.push({ name, passed: Boolean(passed), ...details });
  console.log(JSON.stringify({ check: name, passed: Boolean(passed) }));
  if (!passed) throw new Error('OBSERVER_LOCAL_ASSERTION_FAILED');
}

function safeFailure(error) {
  return {
    stage,
    code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'OBSERVER_LOCAL_FAILURE',
    httpStatus: error.status ?? null,
    problemCode: error.problemCode ?? null,
  };
}

async function request(path, method = 'GET', body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: {
      origin,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: recovering
      ? globalThis.AbortSignal.timeout(10_000)
      : globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(10_000)]),
  });
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error('OBSERVER_LOCAL_API_FAILED');
    error.status = response.status;
    error.problemCode = typeof value?.code === 'string' ? value.code : null;
    throw error;
  }
  return { data: value?.data, response };
}

async function local(command) {
  const result = await execute(process.execPath, ['scripts/local-lab.mjs', command, 'a'], {
    cwd: root,
    env: process.env,
    timeout: command === 'start' ? 660_000 : 150_000,
    maxBuffer: 128 * 1024,
  });
  return result.stdout;
}

async function clusters() {
  return Object.fromEntries(
    await Promise.all(
      ['a', 'b', 'c'].map(async (key) => [
        key,
        (await request(`/clusters/${state.clusters[key]}`)).data,
      ]),
    ),
  );
}

async function nodes(key) {
  const values = (await request(`/clusters/${state.clusters[key]}/nodes?limit=100`)).data;
  return values
    .map((node) => {
      const snapshot = { ...node };
      delete snapshot.cluster;
      return snapshot;
    })
    .sort((a, b) => a.uid.localeCompare(b.uid));
}

async function until(sample, predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await sample();
    if (predicate(value)) return value;
    await delay(1_000);
  }
  throw new Error('OBSERVER_LOCAL_TIMEOUT');
}

function connected(cluster) {
  return cluster.connectionStatus === 'connected' && !cluster.observationStale;
}

try {
  const running = JSON.parse(await local('status'));
  check(
    'three retained VMs exist and are running',
    ['a', 'b', 'c'].every((key) =>
      running.some((vm) => vm.name === `ozz-lab-${key}` && vm.status === 'Running'),
    ) && ['a', 'b', 'c'].every((key) => Boolean(state.clusters[key] && state.projects[key])),
  );
  const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
  const login = await request('/auth/login', 'POST', { username: 'admin', password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.data.csrfToken;
  if (!cookie || !csrf) throw new Error('OBSERVER_LOCAL_LOGIN_FAILED');
  before = await until(clusters, (values) => Object.values(values).every(connected));
  const initialNodes = await nodes('a');
  check(
    'product has fresh observations and distinct cluster identities',
    new Set(Object.values(before).map((cluster) => cluster.identity.kubeSystemUid)).size === 3 &&
      initialNodes.length === 1 &&
      initialNodes[0].present,
  );
  hostKey = await ssh.discoverHostKey({ host: '127.0.0.1', port: 60122 });
  trustHash = digest(await readFile(resolve(lab, 'credentials/known_hosts'), 'utf8'));
  stage = 'stop-a';
  mustRestore = true;
  report.faultStartedAt = new Date().toISOString();
  await local('stop');
  stage = 'observe-outage';
  const failed = await until(clusters, (values) =>
    ['unknown', 'unreachable'].includes(values.a.connectionStatus),
  );
  const outageNodes = await nodes('a');
  check(
    'background observer marks A unavailable and retains its last observation',
    failed.a.observationStale &&
      Boolean(failed.a.lastErrorCode) &&
      Boolean(failed.a.observation) &&
      failed.a.lastObservedAt === failed.a.observation.observedAt &&
      outageNodes.length === initialNodes.length &&
      outageNodes.every((node) =>
        initialNodes.some((old) => old.uid === node.uid && old.id === node.id && node.present),
      ),
    {
      connectionStatus: failed.a.connectionStatus,
      errorCode: failed.a.lastErrorCode,
      lastObservedAt: failed.a.lastObservedAt,
      detectedAt: new Date().toISOString(),
      nodeCount: outageNodes.length,
    },
  );
  const observationHash = digest(failed.a.observation);
  const nodesHash = digest(outageNodes);
  const healthy = await until(
    clusters,
    (values) =>
      ['b', 'c'].every(
        (key) => connected(values[key]) && values[key].lastObservedAt > failed[key].lastObservedAt,
      ),
    90_000,
  );
  check(
    'B and C keep publishing new real observations while A is down',
    ['b', 'c'].every(
      (key) =>
        connected(healthy[key]) &&
        healthy[key].lastObservedAt > failed[key].lastObservedAt &&
        digest(healthy[key].identity) === digest(before[key].identity),
    ),
    {
      bObservedAt: healthy.b.lastObservedAt,
      cObservedAt: healthy.c.lastObservedAt,
    },
  );
  check(
    'repeated failed reads preserve node and metrics snapshots without fabricated zeroes',
    healthy.a.observationStale &&
      healthy.a.lastObservedAt === failed.a.lastObservedAt &&
      digest(healthy.a.observation) === observationHash &&
      digest(await nodes('a')) === nodesHash,
    { observationHash, nodesHash },
  );
  const projectA = (await request(`/projects/${state.projects.a}`)).data;
  const nodeSummary = (await request(`/clusters/${state.clusters.a}/nodes`)).data;
  check(
    'project and node summaries show the same unavailable target',
    projectA.clusterId === state.clusters.a &&
      ['unknown', 'unreachable'].includes(projectA.cluster.connectionStatus) &&
      nodeSummary.every((node) =>
        ['unknown', 'unreachable'].includes(node.cluster.connectionStatus),
      ),
  );
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = safeFailure(error);
  process.exitCode = 1;
} finally {
  recovering = true;
  if (mustRestore) {
    try {
      stage = 'restore-a';
      await local('start');
      const restored = await until(clusters, (values) => Object.values(values).every(connected));
      const restoredNodes = await nodes('a');
      const restoredHostKey = await ssh.discoverHostKey({ host: '127.0.0.1', port: 60122 });
      check(
        'A reconnects automatically with its original cluster and node identity',
        Object.values(restored).every(connected) &&
          digest(restored.a.identity) === digest(before.a.identity) &&
          restored.a.lastObservedAt > before.a.lastObservedAt &&
          restored.a.lastErrorCode === null &&
          restoredNodes.length === before.a.observation.nodes.length &&
          restoredNodes.every((node) =>
            before.a.observation.nodes.some((old) => old.uid === node.uid),
          ),
        { recoveredAt: restored.a.lastObservedAt, clusterId: restored.a.id },
      );
      check(
        'VM restart preserves the verified SSH host key and saved trust',
        restoredHostKey.fingerprint === hostKey.fingerprint &&
          digest(await readFile(resolve(lab, 'credentials/known_hosts'), 'utf8')) === trustHash,
      );
      report.restored = true;
    } catch (error) {
      report.status = 'failed';
      report.recoveryFailure = safeFailure(error);
      process.exitCode = 1;
    }
  }
  if (cookie && csrf) {
    try {
      await request('/auth/logout', 'POST');
    } catch {
      // Session expires independently; never print authentication material.
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      restored: report.restored,
      report: reportFile,
    }),
  );
}
