import { execFileSync, spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function live(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function assertProjectWorker(root, pid) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error('LOCAL_WORKER_PID_INVALID');
  const command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (
    !command.endsWith('--env-file=.env apps/worker/dist/main.js') ||
    !cwd.split('\n').includes(`n${root}`)
  )
    throw new Error('LOCAL_WORKER_PROCESS_NOT_OWNED');
}

/** Only the registered worker in this workspace can receive the test SIGKILL. */
export async function crashAndRestartLocalWorker({
  root,
  database,
  state,
  save,
  deploymentId,
  operationId,
  domainId,
}) {
  if (Boolean(deploymentId) === Boolean(operationId))
    throw new Error('LOCAL_WORKER_TASK_ID_REQUIRED');
  const runtimeFile = resolve(root, '.local/s3-runtime.json');
  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  if (!state.workerCrash) {
    if (operationId) {
      if (!domainId || !Object.values(state.domains ?? {}).includes(domainId))
        throw new Error('LOCAL_WORKER_DOMAIN_NOT_OWNED');
      const [deployments, otherOperations, task] = await Promise.all([
        database.deployment.count({ where: { status: { in: ['queued', 'running'] } } }),
        database.operation.count({
          where: { status: { in: ['queued', 'running'] }, id: { not: operationId } },
        }),
        database.operation.findUnique({
          where: { id: operationId },
          select: { status: true, kind: true, input: true },
        }),
      ]);
      if (deployments || otherOperations) throw new Error('LOCAL_WORKER_OTHER_TASKS_ACTIVE');
      if (
        task?.status !== 'running' ||
        task.kind !== 'domain_reconcile' ||
        task.input?.domainId !== domainId
      )
        throw new Error('LOCAL_WORKER_CRASH_WINDOW_MISSED');
      const written = await database.networkManagedResource.count({
        where: {
          domainId,
          revision: task.input.domainRevision,
          uid: { not: null },
          deletedAt: null,
        },
      });
      if (!written) throw new Error('LOCAL_WORKER_NETWORK_WRITE_NOT_CONFIRMED');
      assertProjectWorker(root, runtime.worker);
      state.workerCrash = {
        operationId,
        domainId,
        confirmedResources: written,
        originalPid: runtime.worker,
        preparedAt: new Date().toISOString(),
      };
      await save();
    } else {
      const [otherDeployments, operations, task] = await Promise.all([
        database.deployment.count({
          where: { status: { in: ['queued', 'running'] }, id: { not: deploymentId } },
        }),
        database.operation.count({ where: { status: { in: ['queued', 'running'] } } }),
        database.deployment.findUnique({
          where: { id: deploymentId },
          select: { status: true, phase: true, appliedAt: true },
        }),
      ]);
      if (otherDeployments || operations) throw new Error('LOCAL_WORKER_OTHER_TASKS_ACTIVE');
      if (task?.status !== 'running' || task.phase !== 'waiting_healthy' || !task.appliedAt)
        throw new Error('LOCAL_WORKER_CRASH_WINDOW_MISSED');
      assertProjectWorker(root, runtime.worker);
      state.workerCrash = {
        deploymentId,
        originalPid: runtime.worker,
        preparedAt: new Date().toISOString(),
      };
      await save();
    }
  }
  const crash = state.workerCrash;
  if (
    crash.deploymentId !== deploymentId ||
    crash.operationId !== operationId ||
    crash.domainId !== domainId
  )
    throw new Error('LOCAL_WORKER_CRASH_TARGET_CHANGED');
  if (!crash.signalledAt) {
    if (runtime.worker !== crash.originalPid) throw new Error('LOCAL_WORKER_PID_CHANGED');
    assertProjectWorker(root, runtime.worker);
    process.kill(runtime.worker, 'SIGKILL');
    crash.signalledAt = new Date().toISOString();
    await save();
  }
  // A resumed probe never kills the replacement process or creates a second worker.
  const current = JSON.parse(await readFile(runtimeFile, 'utf8'));
  if (current.worker !== crash.originalPid && live(current.worker)) {
    assertProjectWorker(root, current.worker);
    crash.restartedPid = current.worker;
  } else {
    const until = Date.now() + 5000;
    while (live(crash.originalPid) && Date.now() < until) await delay(50);
    if (live(crash.originalPid)) throw new Error('LOCAL_WORKER_DID_NOT_EXIT');
    const log = await open(resolve(root, '.local/s3-worker.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, ['--env-file=.env', 'apps/worker/dist/main.js'], {
        cwd: root,
        env: process.env,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolveSpawn, reject) => {
        child.once('spawn', resolveSpawn);
        child.once('error', () => reject(new Error('LOCAL_WORKER_RESTART_FAILED')));
      });
      child.unref();
      current.worker = child.pid;
      crash.restartedPid = child.pid;
      await writeFile(runtimeFile, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
    } finally {
      await log.close();
    }
  }
  await save();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:3001/health/ready', {
        signal: globalThis.AbortSignal.timeout(1000),
      });
      if (response.ok) {
        crash.readyAt = new Date().toISOString();
        await save();
        return;
      }
    } catch {
      // Wait for the replacement worker to connect to its existing dependencies.
    }
    await delay(200);
  }
  throw new Error('LOCAL_WORKER_READINESS_TIMEOUT');
}
