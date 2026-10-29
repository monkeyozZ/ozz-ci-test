import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';
import { crashAndRestartLocalWorker } from './local-worker-crash.mjs';

const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const stateFile = resolve(lab, 'service-product-state.json');
const reportFile = resolve(root, 'docs/acceptance/s3-product-local-results.json');
const registered = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
const api = 'http://127.0.0.1:3000/api';
const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const image =
  'ghcr.io/stefanprodan/podinfo@sha256:ec73780a8425f59ea49f5bc8cdff0d598805a224fbaa1f86c67a244f250fa9da';
const marker = 'ozz-s3-synthetic-runtime-secret';
let state;
try {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('LOCAL_S3_STATE_INVALID');
}
state ??= {
  version: 1,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  commands: {},
  completed: {},
  checks: [],
  services: {},
};
if (state.version !== 1) throw new Error('LOCAL_S3_STATE_INVALID');
if (state.pid) {
  try {
    process.kill(state.pid, 0);
    throw new Error('LOCAL_S3_PROBE_ALREADY_RUNNING');
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
const report = {
  scope:
    '产品 API/Worker/PostgreSQL 与真实本地 K3s A/B；同 digest 镜像缓存辅助，非公网 Registry 拉取、私仓、公网入口或 Oracle 容量验收。',
  runId: state.runId,
  startedAt: state.startedAt,
  resumedAt: new Date().toISOString(),
  checks: state.checks,
  status: 'running',
};

async function save() {
  await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(stateFile + '.tmp', stateFile);
}
async function check(name, passed, details = {}) {
  if (!passed) throw new Error(`LOCAL_S3_ASSERTION: ${name}`);
  const result = { name, passed: true, observedAt: new Date().toISOString(), ...details };
  state.checks.push(result);
  console.log(JSON.stringify({ check: name, passed: true }));
  await save();
}
async function request(path, method = 'GET', body, key, expected) {
  const response = await fetch(api + path, {
    method,
    headers: {
      origin,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(20_000)]),
  });
  const value = response.status === 204 ? null : await response.json();
  if (expected ? response.status !== expected : !response.ok) {
    const error = new Error('LOCAL_S3_API_FAILED');
    error.status = response.status;
    error.code = value?.code;
    throw error;
  }
  return { response, value };
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
async function command(name, path, method, body) {
  if (!state.commands[name]) {
    state.commands[name] = { path, method, body, key: randomUUID() };
    await save();
  }
  const saved = state.commands[name];
  if (saved.path !== path || saved.method !== method)
    throw new Error('LOCAL_S3_COMMAND_TARGET_CHANGED');
  const result = await request(saved.path, saved.method, saved.body, saved.key, 202);
  if (saved.id && saved.id !== result.value.data.id)
    throw new Error('LOCAL_S3_IDEMPOTENCY_CHANGED');
  saved.id = result.value.data.id;
  await save();
  return result.value.data;
}
async function waitTask(type, id, expected = 'succeeded', timeoutMs = 210_000) {
  const deadline = Date.now() + timeoutMs;
  let prior;
  while (Date.now() < deadline) {
    const task = (await request(`/${type}/${id}`)).value.data;
    const signature = `${task.status}/${task.errorCode}`;
    if (signature !== prior)
      console.log(JSON.stringify({ task: id, status: task.status, code: task.errorCode }));
    prior = signature;
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      if (task.status !== expected) {
        const error = new Error('LOCAL_S3_TASK_FAILED');
        error.code = task.errorCode;
        throw error;
      }
      return task;
    }
    await delay(500, undefined, { signal: abort.signal });
  }
  throw new Error('LOCAL_S3_TASK_TIMEOUT');
}
const service = async (key) => (await request(`/services/${state.services[key]}`)).value.data;
const configuration = (key) => ({
  image,
  replicas: 1,
  ports: [{ name: 'http', protocol: 'http', containerPort: 9898, servicePort: 80 }],
  resources: {
    requests: { cpuMillis: 100, memoryMiB: 32 },
    limits: { cpuMillis: 500, memoryMiB: 128 },
  },
  environment: [
    { name: 'PODINFO_UI_MESSAGE', value: `Ozz local ${key.toUpperCase()}` },
    { name: 'OZZ_TEST_SECRET', value: marker, secret: true },
  ],
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
});
async function create(key, target = key) {
  if (state.services[key]) {
    const existing = await service(key);
    if (
      existing.projectId !== registered.projects[target] ||
      existing.clusterId !== registered.clusters[target]
    )
      throw new Error('LOCAL_S3_SAVED_TARGET_CHANGED');
    return existing.id;
  }
  const environments = (
    await request(`/environments?projectId=${registered.projects[target]}&limit=100`)
  ).value.data;
  const environment = environments.find((value) => value.slug === 'production');
  if (!environment) throw new Error('LOCAL_S3_ENVIRONMENT_MISSING');
  const value = (
    await request('/services', 'POST', {
      projectId: registered.projects[target],
      environmentId: environment.id,
      name: key === 'failure-check' ? '故障恢复演示' : `本地应用 ${key.toUpperCase()}`,
      slug: key === target ? 'podinfo' : `podinfo-${key}`,
      description: '真实本地 K3s 产品验收，保留供界面检查。',
      configuration: configuration(key),
    })
  ).value.data;
  state.services[key] = value.id;
  await save();
  await check(
    `${key}: inherited project/environment/cluster and encrypted draft`,
    value.clusterId === registered.clusters[target] &&
      value.projectId === registered.projects[target] &&
      value.configurationState === 'unpublished' &&
      !JSON.stringify(value).includes(marker),
    { serviceId: value.id, clusterId: value.clusterId },
  );
  return value.id;
}
async function publish(key, suffix = '', recoverFailed = false) {
  const before = await service(key);
  const task = await command(
    `deploy-${key}${suffix}`,
    `/services/${before.id}/deployments`,
    'POST',
    {
      revision: before.revision,
    },
  );
  let done;
  const original = (await request(`/deployments/${task.id}`)).value.data;
  if (recoverFailed && original.status === 'failed') {
    if (original.errorCode !== 'WORKLOAD_CONFIGURATION_DRIFT')
      throw new Error('LOCAL_S3_UNEXPECTED_REPAIR_FAILURE');
    const current = await service(key);
    const retry = await command(
      `retry-${key}${suffix}`,
      `/deployments/${original.id}/retry`,
      'POST',
      { revision: current.revision, allowConfigurationRepair: true },
    );
    done = await waitTask('deployments', retry.id);
    await check(
      `${key}: linked retry preserves the original repair target, configuration and digest`,
      done.retryOfId === original.id &&
        JSON.stringify(done.target) === JSON.stringify(original.target) &&
        done.snapshot.configRevision === original.snapshot.configRevision &&
        JSON.stringify(done.snapshot.configuration) ===
          JSON.stringify(original.snapshot.configuration) &&
        done.resolvedImage?.deployReference === original.resolvedImage?.deployReference,
      { originalDeploymentId: original.id, retryDeploymentId: done.id },
    );
  } else {
    done = await waitTask('deployments', task.id);
  }
  const after = await service(key);
  await check(
    `${key}: durable publication reaches real healthy Pods`,
    after.runtimeState === 'running' &&
      after.published?.deploymentId === done.id &&
      after.observation?.pods.some((pod) => pod.ready === true && pod.phase === 'Running'),
    {
      deploymentId: done.id,
      target: done.target,
      resolvedImage: done.resolvedImage,
      stages: done.stages.map((entry) => ({ name: entry.name, status: entry.status })),
    },
  );
  return done.id;
}
async function action(key, verb, name = `${verb}-${key}`) {
  const current = await service(key);
  const task = await command(
    name,
    `/services/${current.id}${verb === 'delete' ? '' : `/${verb}`}`,
    verb === 'delete' ? 'DELETE' : 'POST',
    { revision: current.revision },
  );
  return waitTask('operations', task.id);
}

try {
  await save();
  const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
  const login = await request('/auth/login', 'POST', { username: 'admin', password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  if (!cookie || !csrf) throw new Error('LOCAL_S3_LOGIN_FAILED');
  for (const key of ['a', 'b']) {
    await phase(`create-${key}`, () => create(key));
    await phase(`publish-${key}`, () => publish(key));
  }
  await phase('isolation-and-http', async () => {
    const a = await service('a');
    const b = await service('b');
    await check(
      'A/B retain different project/cluster/namespace/Pod identities',
      a.clusterId !== b.clusterId &&
        a.projectId !== b.projectId &&
        a.observation.pods[0].namespace !== b.observation.pods[0].namespace &&
        a.observation.pods[0].uid !== b.observation.pods[0].uid,
    );
    for (const [key, current] of [
      ['a', a],
      ['b', b],
    ]) {
      const pod = current.observation.pods.find(
        (value) => value.ready === true && value.phase === 'Running',
      );
      const dns = current.observation.serviceDns;
      if (
        ![pod.namespace, pod.name, dns].every(
          (value) => typeof value === 'string' && /^[a-z0-9.-]+$/u.test(value),
        )
      )
        throw new Error('LOCAL_S3_UNSAFE_HTTP_TARGET');
      const output = execFileSync(
        'ssh',
        [
          '-F',
          resolve(lab, 'credentials/ssh_config'),
          `ozz-lab-${key}`,
          'sudo',
          '/usr/local/bin/k3s',
          'kubectl',
          'exec',
          '-n',
          pod.namespace,
          pod.name,
          '-c',
          'app',
          '--',
          'wget',
          '-qO-',
          `http://${dns}/`,
        ],
        {
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 128 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const result = JSON.parse(output);
      await check(
        `${key}: application HTTP responds through private Service DNS`,
        result.hostname === pod.name || result.message === `Ozz local ${key.toUpperCase()}`,
        { serviceDns: dns, podUid: pod.uid },
      );
    }
  });
  await phase('logs', async () => {
    const current = await service('a');
    const pod = current.observation.pods.find((value) => value.ready && value.phase === 'Running');
    const response = await fetch(
      `${api}/services/${current.id}/logs?${new URLSearchParams({ podUid: pod.uid, container: 'app', follow: 'false', tailLines: '200' })}`,
      { headers: { cookie }, signal: globalThis.AbortSignal.timeout(20_000) },
    );
    const text = await response.text();
    await check(
      'real Pod logs use finite SSE and an explicit ending',
      response.ok &&
        response.headers.get('content-type')?.startsWith('text/event-stream') &&
        text.includes('event: log') &&
        text.includes('event: end') &&
        !text.includes(marker),
      { httpStatus: response.status, bytes: Buffer.byteLength(text) },
    );
    const other = (await service('b')).observation.pods.find(
      (value) => value.ready && value.phase === 'Running',
    );
    const denied = await request(
      `/services/${current.id}/logs?${new URLSearchParams({ podUid: other.uid, container: 'app' })}`,
      'GET',
      undefined,
      undefined,
      409,
    );
    await check(
      'a Pod from another service/cluster cannot be used for logs',
      denied.value.code === 'POD_LOGS_TARGET_CHANGED',
    );
  });
  await phase('draft-only', async () => {
    const before = await service('a');
    const next = globalThis.structuredClone(before.configuration);
    next.environment.find((value) => value.name === 'PODINFO_UI_MESSAGE').value =
      'Unpublished draft';
    const after = (
      await request(`/services/${before.id}`, 'PATCH', {
        revision: before.revision,
        configuration: next,
      })
    ).value.data;
    await check(
      'saving a draft keeps the published snapshot and current Pod',
      after.hasUnpublishedChanges &&
        after.published.deploymentId === before.published.deploymentId &&
        after.published.configuration.environment.find(
          (value) => value.name === 'PODINFO_UI_MESSAGE',
        ).value === 'Ozz local A' &&
        after.observation.pods.some(
          (value) => value.uid === before.observation.pods.find((pod) => pod.ready).uid,
        ),
    );
    return { publishedId: after.published.deploymentId };
  });
  await phase('stop', async () => {
    await action('a', 'stop');
    const current = await service('a');
    await check(
      'stop keeps draft and published replicas while scaling runtime to zero',
      current.desiredState === 'stopped' &&
        current.runtimeState === 'stopped' &&
        current.configuration.replicas === 1 &&
        current.published.configuration.replicas === 1 &&
        current.hasUnpublishedChanges,
    );
    const refused = await request(
      `/services/${current.id}/deployments`,
      'POST',
      { revision: current.revision },
      randomUUID(),
      409,
    );
    await check(
      'publication of a stopped service requires explicit start intent',
      refused.value.code === 'DEPLOY_AND_START_REQUIRED',
    );
  });
  await phase('resume', async () => {
    await action('a', 'resume');
    const current = await service('a');
    await check(
      'resume uses the trusted published snapshot and leaves the draft unpublished',
      current.desiredState === 'running' &&
        current.runtimeState === 'running' &&
        current.published.deploymentId === state.completed['draft-only'].publishedId &&
        current.hasUnpublishedChanges,
    );
  });
  await phase('restart', async () => {
    const before = await service('a');
    const beforeUid = before.observation.pods.find(
      (value) => value.ready && value.phase === 'Running',
    ).uid;
    await action('a', 'restart');
    const current = await service('a');
    await check(
      'restart observes a new healthy Pod of the published snapshot',
      current.runtimeState === 'running' &&
        current.observation.pods.some(
          (value) =>
            value.ready &&
            value.phase === 'Running' &&
            value.uid !== beforeUid &&
            value.snapshotId === current.published.deploymentId,
        ),
    );
  });
  await phase('delete-check-create', () => create('delete-check', 'a'));
  await phase('delete-check-publish', () => publish('delete-check'));
  await phase('delete', async () => {
    await action('delete-check', 'delete');
    await request(`/services/${state.services['delete-check']}`, 'GET', undefined, undefined, 404);
    const current = await service('a');
    await check(
      'product deletion removes only its service and preserves a shared environment',
      current.runtimeState === 'running',
    );
  });
  await phase('failure-create', () => create('failure-check', 'b'));
  await phase('failure-initial-publication', () => publish('failure-check'));
  await phase('failure-configuration', async () => {
    const current = await service('failure-check');
    const next = globalThis.structuredClone(current.configuration);
    next.readiness.path = '/ozz-test-not-ready';
    next.healthTimeoutSeconds = 10;
    await request(`/services/${current.id}`, 'PATCH', {
      revision: current.revision,
      configuration: next,
    });
  });
  await phase('failed-health-publication', async () => {
    const current = await service('failure-check');
    const task = await command('deploy-unhealthy', `/services/${current.id}/deployments`, 'POST', {
      revision: current.revision,
    });
    let done = await waitTask('deployments', task.id, 'failed');
    if (
      done.errorCode === 'WORKLOAD_CONFIGURATION_DRIFT' &&
      process.argv.includes('--retry-failed-publication')
    ) {
      const latest = await service('failure-check');
      const recovered = await command(
        'retry-known-inventory-fix',
        `/deployments/${done.id}/retry`,
        'POST',
        {
          revision: latest.revision,
          allowConfigurationRepair: true,
        },
      );
      done = await waitTask('deployments', recovered.id, 'failed');
    }
    const observed = await service('failure-check');
    await check(
      'a failed health wait retains the completely applied publication without reusing old healthy status',
      done.errorCode === 'WORKLOAD_ROLLOUT_TIMEOUT' &&
        Boolean(done.appliedAt) &&
        observed.published?.deploymentId === done.id &&
        observed.lastSuccessfulDeploymentId === state.completed['failure-initial-publication'] &&
        observed.runtimeState !== 'running',
      { deploymentId: done.id, errorCode: done.errorCode, runtimeState: observed.runtimeState },
    );
    return done.id;
  });
  await phase('failure-draft-repair', async () => {
    const current = await service('failure-check');
    const next = globalThis.structuredClone(current.configuration);
    next.readiness.path = '/readyz';
    next.healthTimeoutSeconds = 120;
    await request(`/services/${current.id}`, 'PATCH', {
      revision: current.revision,
      configuration: next,
    });
  });
  await phase('retry-keeps-original-snapshot', async () => {
    const current = await service('failure-check');
    const original = (await request(`/deployments/${state.completed['failed-health-publication']}`))
      .value.data;
    const task = await command('retry-unhealthy', `/deployments/${original.id}/retry`, 'POST', {
      revision: current.revision,
    });
    const done = await waitTask('deployments', task.id, 'failed');
    const observed = await service('failure-check');
    await check(
      'retry preserves original bad probe, target and digest even after draft repair',
      done.errorCode === 'WORKLOAD_ROLLOUT_TIMEOUT' &&
        done.resolvedImage.deployReference === original.resolvedImage.deployReference &&
        JSON.stringify(done.target) === JSON.stringify(original.target) &&
        done.snapshot.configuration.readiness.path === '/ozz-test-not-ready' &&
        observed.configuration.readiness.path === '/readyz' &&
        observed.hasUnpublishedChanges,
      { originalDeploymentId: original.id, retryDeploymentId: done.id },
    );
    return done.id;
  });
  await phase('cancel-after-application', async () => {
    const current = await service('failure-check');
    const originalId = state.completed['retry-keeps-original-snapshot'];
    const task = await command('retry-to-cancel', `/deployments/${originalId}/retry`, 'POST', {
      revision: current.revision,
    });
    const until = Date.now() + 30_000;
    let applying;
    while (Date.now() < until) {
      applying = (await request(`/deployments/${task.id}`)).value.data;
      if (applying.phase === 'waiting_healthy' && applying.status === 'running') break;
      if (['succeeded', 'failed', 'cancelled'].includes(applying.status))
        throw new Error('LOCAL_S3_CANCEL_WINDOW_MISSED');
      await delay(100, undefined, { signal: abort.signal });
    }
    if (applying?.phase !== 'waiting_healthy') throw new Error('LOCAL_S3_CANCEL_WINDOW_TIMEOUT');
    await request(`/deployments/${task.id}/cancel`, 'POST');
    const done = await waitTask('deployments', task.id, 'cancelled');
    const observed = await service('failure-check');
    await check(
      'cancellation after application preserves the applied snapshot and releases the service mutation slot',
      Boolean(done.appliedAt) &&
        observed.published?.deploymentId === done.id &&
        !observed.activeTask,
      { deploymentId: done.id },
    );
  });
  await phase('repaired-publication', async () => {
    const id = await publish(
      'failure-check',
      '-repaired',
      process.argv.includes('--retry-repaired-publication'),
    );
    const current = await service('failure-check');
    await check(
      'explicit fresh publication applies the repaired draft and restores healthy runtime',
      current.runtimeState === 'running' &&
        !current.hasUnpublishedChanges &&
        current.published.configuration.readiness.path === '/readyz' &&
        current.lastSuccessfulDeploymentId === id,
    );
  });
  if (process.argv.includes('--worker-crash')) {
    await phase('worker-create', () => create('worker-check', 'b'));
    await phase('worker-delayed-readiness', async () => {
      const current = await service('worker-check');
      const next = globalThis.structuredClone(current.configuration);
      next.readiness.initialDelaySeconds = 35;
      await request(`/services/${current.id}`, 'PATCH', {
        revision: current.revision,
        configuration: next,
      });
    });
    await phase('worker-crash-and-recovery', async () => {
      const current = await service('worker-check');
      const task = await command(
        'deploy-worker-check',
        `/services/${current.id}/deployments`,
        'POST',
        { revision: current.revision },
      );
      const { PrismaClient } = await import('../../packages/database/dist/index.js');
      const database = new PrismaClient();
      const inventory = () =>
        database.managedResource.findMany({
          where: { serviceId: current.id, deletedAt: null },
          select: { kind: true, namespace: true, name: true, uid: true },
          orderBy: [{ kind: 'asc' }, { name: 'asc' }],
        });
      try {
        if (!state.workerCrash) {
          const deadline = Date.now() + 60_000;
          let waiting = false;
          while (Date.now() < deadline) {
            const latest = (await request(`/deployments/${task.id}`)).value.data;
            if (latest.status === 'running' && latest.phase === 'waiting_healthy') {
              waiting = true;
              state.workerCrashInventory = await inventory();
              await save();
              break;
            }
            if (['succeeded', 'failed', 'cancelled'].includes(latest.status))
              throw new Error('LOCAL_WORKER_CRASH_WINDOW_MISSED');
            await delay(100, undefined, { signal: abort.signal });
          }
          if (!waiting) throw new Error('LOCAL_WORKER_CRASH_WINDOW_TIMEOUT');
        }
        await crashAndRestartLocalWorker({ root, database, state, save, deploymentId: task.id });
        const done = await waitTask('deployments', task.id);
        const after = await service('worker-check');
        const resources = await inventory();
        const logs = (await request(`/deployments/${task.id}/logs`)).value.data;
        const taskCount = await database.deployment.count({ where: { serviceId: current.id } });
        await check(
          'a real Worker SIGKILL resumes the same durable deployment without recreating its resources',
          done.attempts >= 2 &&
            taskCount === 1 &&
            done.stages.some((entry) => entry.errorCode === 'EXECUTION_LEASE_EXPIRED') &&
            logs.some((entry) => entry.code === 'DELIVERY_RECOVERED') &&
            state.workerCrashInventory.length >= 3 &&
            state.workerCrashInventory.every((entry) => Boolean(entry.uid)) &&
            JSON.stringify(resources) === JSON.stringify(state.workerCrashInventory) &&
            after.runtimeState === 'running' &&
            after.published?.deploymentId === task.id &&
            !after.activeTask,
          { deploymentId: task.id, attempts: done.attempts, resources, process: state.workerCrash },
        );
      } finally {
        await database.$disconnect();
      }
    });
    await phase('worker-timeout-configuration', async () => {
      const current = await service('worker-check');
      const next = globalThis.structuredClone(current.configuration);
      next.readiness.initialDelaySeconds = 0;
      next.readiness.path = '/ozz-test-not-ready';
      next.healthTimeoutSeconds = 10;
      await request(`/services/${current.id}`, 'PATCH', {
        revision: current.revision,
        configuration: next,
      });
    });
    await phase('worker-timeout-evidence', async () => {
      const current = await service('worker-check');
      const task = await command(
        'deploy-worker-timeout',
        `/services/${current.id}/deployments`,
        'POST',
        { revision: current.revision },
      );
      const done = await waitTask('deployments', task.id, 'failed');
      await check(
        'a real health timeout keeps bounded historical failure evidence beside the applied result',
        done.errorCode === 'WORKLOAD_ROLLOUT_TIMEOUT' &&
          done.result?.published?.snapshotId === done.id &&
          done.failureObservation?.errorCode === done.errorCode &&
          done.failureObservation?.attempt === done.attempts &&
          done.failureObservation?.pods.length > 0 &&
          done.failureObservation?.pods.length <= 32 &&
          !JSON.stringify(done.failureObservation).includes(marker),
        { deploymentId: done.id, capturedAt: done.failureObservation?.capturedAt },
      );
      return done.id;
    });
    await phase('worker-delete', () => action('worker-check', 'delete'));
  }
  report.workerCrash = {
    requested: process.argv.includes('--worker-crash'),
    completed: Boolean(state.completed['worker-crash-and-recovery']),
  };
  if (process.argv.includes('--publication-race')) {
    await phase('publication-race-create', () => create('race-check', 'a'));
    await phase('publication-race', async () => {
      if (!state.publicationRaceRequests) {
        const current = await service('race-check');
        state.publicationRaceRequests = [0, 1].map(() => ({
          key: randomUUID(),
          path: `/services/${current.id}/deployments`,
          body: { revision: current.revision },
        }));
        await save();
      }
      if (!state.publicationRaceOutcome) {
        const outcomes = await Promise.allSettled(
          state.publicationRaceRequests.map((value) =>
            request(value.path, 'POST', value.body, value.key, 202),
          ),
        );
        const accepted = outcomes.filter((value) => value.status === 'fulfilled');
        const rejected = outcomes.filter((value) => value.status === 'rejected');
        if (
          accepted.length !== 1 ||
          rejected.length !== 1 ||
          rejected[0].reason.status !== 409 ||
          !['SERVICE_OPERATION_ACTIVE', 'REVISION_CONFLICT'].includes(rejected[0].reason.code)
        )
          throw new Error('LOCAL_PUBLICATION_RACE_NOT_FENCED');
        state.publicationRaceOutcome = {
          deploymentId: accepted[0].value.value.data.id,
          rejectionCode: rejected[0].reason.code,
          observedAt: new Date().toISOString(),
        };
        await save();
      }
      const outcome = state.publicationRaceOutcome;
      const done = await waitTask('deployments', outcome.deploymentId);
      const current = await service('race-check');
      const { PrismaClient } = await import('../../packages/database/dist/index.js');
      const database = new PrismaClient();
      try {
        const count = await database.deployment.count({ where: { serviceId: current.id } });
        await check(
          'competing real publication requests admit one durable task and reject the other without a second rollout',
          count === 1 &&
            current.runtimeState === 'running' &&
            !current.activeTask &&
            current.published?.deploymentId === done.id &&
            done.target.clusterId === registered.clusters.a,
          { ...outcome, serviceId: current.id, persistedDeployments: count },
        );
      } finally {
        await database.$disconnect();
      }
    });
    await phase('publication-race-delete', () => action('race-check', 'delete'));
  }
  report.publicationRace = {
    requested: process.argv.includes('--publication-race'),
    completed: Boolean(state.completed['publication-race']),
  };
  report.status = 'passed';
  report.retainedServices = {
    a: state.services.a,
    b: state.services.b,
    failureRecovery: state.services['failure-check'],
  };
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    code: error.code ?? null,
    httpStatus: error.status ?? null,
    message: String(error.message).slice(0, 180),
  };
  // Never retain raw SSH stdout/stderr or HTTP bodies in a failure record.
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  state.pid = null;
  await save();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (report.status === 'failed')
    await writeFile(
      reportFile.replace('.json', `-failure-${Date.now()}.json`),
      JSON.stringify(report, null, 2) + '\n',
    );
}
