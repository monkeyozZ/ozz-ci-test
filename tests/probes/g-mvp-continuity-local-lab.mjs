import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, statfs } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs, parseEnv, promisify } from 'node:util';

// Only local evidence is written. No product API, restore CLI, lifecycle command
// or Kubernetes mutation is used. Run baseline before root stops the runtime.
const owner = 'ozz-g-mvp-continuity-v1';
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const directory = resolve(lab, 'g-mvp-recovery-continuity');
const recoveryPath = resolve(lab, 'g-mvp-recovery/state.json');
const runtimePath = resolve(root, '.local/s3-runtime.json');
const sourcePath = resolve(import.meta.dirname, 'support/g-mvp-continuity-k3s.py');
const sshConfig = resolve(lab, 'credentials/ssh_config');
const sshKey = resolve(lab, 'lima/_config/user');
const knownHosts = resolve(lab, 'credentials/known_hosts');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const execute = promisify(execFile);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const timestamp = () => new Date().toISOString();
const attempt = `${timestamp().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
const attemptDirectory = resolve(directory, attempt);
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const childEnv = { PATH: process.env.PATH, LC_ALL: 'C' };
const report = { version: 1, owner, attempt, startedAt: timestamp(), rounds: [] };
let journal;
let pendingWrites = Promise.resolve();
let journalFailed = false;

function requireValue(value, code) {
  if (!value) throw new Error('GMVP_CONTINUITY_' + code);
}
function code(error) {
  return /^GMVP_CONTINUITY_[A-Z_]+$/u.test(error?.message ?? '')
    ? error.message
    : error?.name === 'AbortError'
      ? 'GMVP_CONTINUITY_INTERRUPTED'
      : 'GMVP_CONTINUITY_LOCAL_READ_FAILED';
}
async function read(path, privateMode = true) {
  requireValue((await realpath(path)) === path, 'INPUT_SYMLINK_REJECTED');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    requireValue(
      metadata.isFile() &&
        metadata.size <= 4 * 1024 * 1024 &&
        metadata.uid === process.getuid() &&
        (metadata.mode & (privateMode ? 0o077 : 0o022)) === 0,
      'INPUT_PERMISSIONS_OR_SIZE_INVALID',
    );
    return await file.readFile();
  } finally {
    await file.close();
  }
}
const json = async (path, privateMode = true) => JSON.parse(await read(path, privateMode));
async function writeNew(path, value) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}
function record(event) {
  pendingWrites = pendingWrites
    .then(async () => {
      await journal.write(JSON.stringify({ at: timestamp(), ...event }) + '\n');
      await journal.sync();
    })
    .catch(() => {
      journalFailed = true;
      abort.abort();
    });
  return pendingWrites;
}
async function disk(minimum) {
  const filesystem = await statfs(root);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  await record({ type: 'host-disk', availableBytes, minimumBytes: minimum * 1024 ** 3 });
  requireValue(availableBytes >= minimum * 1024 ** 3, 'HOST_DISK_RESERVE_REQUIRED');
}

async function inputs(sourceEnv, selections) {
  const paths = [
    sourceEnv,
    resolve(lab, 'product-state.json'),
    resolve(lab, 'networking-product-state.json'),
    resolve(lab, 'networking-lab/state.json'),
    resolve(lab, 'storage-product-state.json'),
    resolve(lab, 'storage-recovery-state.json'),
    sshConfig,
    sshKey,
    knownHosts,
    resolve(import.meta.filename),
    sourcePath,
  ];
  const contents = await Promise.all(paths.map((path, index) => read(path, index < 9)));
  const protectedInputs = paths.map((path, index) => ({
    path,
    sha256: sha(contents[index]),
    privateMode: index < 9,
  }));
  const env = parseEnv(contents[0].toString());
  const registered = JSON.parse(contents[1]);
  const networking = JSON.parse(contents[2]);
  const fixture = JSON.parse(contents[3]);
  const storage = JSON.parse(contents[4]);
  const recovered = JSON.parse(contents[5]);
  const recovery = await json(recoveryPath);
  const redis = new URL(env.REDIS_URL);
  requireValue(
    env.HOST === '127.0.0.1' &&
      redis.protocol === 'redis:' &&
      ['127.0.0.1', 'localhost'].includes(redis.hostname) &&
      recovery.owner === 'ozz-g-mvp-recovery-local-v1' &&
      uuid.test(recovery.id) &&
      recovery.sourceEnvFile === sourceEnv &&
      recovery.completed?.['capture-final'],
    'SOURCE_OR_FINAL_CAPTURE_INVALID',
  );
  requireValue(
    fixture.owner === 'ozz-local-networking-lab-v1' &&
      fixture.ip === '192.168.5.15' &&
      uuid.test(storage.runId) &&
      recovered.topology?.sourceRunId === storage.runId,
    'FIXTURE_SOURCE_INVALID',
  );
  requireValue(
    !/^\s*(?:Include|Match|ProxyCommand|ProxyJump|LocalCommand|RemoteCommand)\s/imu.test(
      contents[6].toString(),
    ),
    'SSH_EXECUTABLE_DIRECTIVE_REJECTED',
  );
  const installationId = recovered.engines?.postgresql?.source?.identity?.installationId;
  requireValue(
    uuid.test(installationId) && installationId === recovery.identities?.installationId,
    'INSTALLATION_CHANGED',
  );
  const targets = [];
  function target(guest, kind, row) {
    const identity = fixture.identities[guest];
    const value = {
      key: kind === 'application' ? `application-${guest}` : kind,
      kind,
      guest,
      installationId,
      clusterId: registered.clusters[guest],
      kubeSystemUid: identity.kubeSystemUid,
      nodeName: identity.nodes[0].name,
      nodeUid: identity.nodes[0].uid,
      projectId: row.projectId,
      environmentId: row.environmentId,
      serviceId: row.serviceId,
      namespace: `ozz-e-${row.environmentId.replaceAll('-', '')}`,
      serviceName: `ozz-s-${row.serviceId.replaceAll('-', '')}`,
    };
    requireValue(
      identity.instance === `ozz-lab-${guest}` &&
        identity.nodes.length === 1 &&
        [
          'installationId',
          'clusterId',
          'kubeSystemUid',
          'nodeUid',
          'projectId',
          'environmentId',
          'serviceId',
        ].every((key) => uuid.test(value[key])),
      'TARGET_IDENTITY_INVALID',
    );
    return value;
  }
  for (const guest of ['a', 'b']) {
    const domainId = networking.domains[guest];
    requireValue(uuid.test(domainId), 'APPLICATION_DOMAIN_INVALID');
    targets.push({
      ...target(guest, 'application', {
        serviceId: networking.services[guest],
        projectId: networking.projects[guest],
        environmentId: networking.environments[guest],
      }),
      domainId,
      domainName: `ozz-d-${domainId.replaceAll('-', '')}`,
      hostname: `podinfo-${domainId.replaceAll('-', '').slice(0, 12)}.${guest}.apps.ozz.test`,
      ingressIp: fixture.ip,
      messageSha256: sha(`Ozz S4 ${guest.toUpperCase()}`),
    });
  }
  for (const kind of ['postgresql', 'redis']) {
    const guest = selections[kind];
    requireValue(['a', 'b'].includes(guest), 'DATABASE_SELECTION_INVALID');
    const engine = recovered.engines[kind];
    const candidates =
      guest === 'a' ? [engine.source] : engine.targets.filter((row) => row.completedAt);
    requireValue(candidates.length === 1, 'DATABASE_SAMPLE_NOT_UNIQUE');
    const row = candidates[0];
    requireValue(
      row.clusterId === registered.clusters[guest] &&
        row.identity.installationId === installationId &&
        row.identity.kubeSystemUid === fixture.identities[guest].kubeSystemUid &&
        row.identity.volumeId === row.volumeId &&
        uuid.test(row.volumeId) &&
        uuid.test(row.identity.pvcUid) &&
        (guest === 'b' ||
          (row.serviceId === storage.services[kind] && row.volumeId === storage.volumes[kind])),
      'DATABASE_SOURCE_CHANGED',
    );
    targets.push({
      ...target(guest, kind, row),
      volumeId: row.volumeId,
      pvcName: `ozz-v-${row.volumeId.replaceAll('-', '')}`,
      pvcUid: row.identity.pvcUid,
      markerSha256: sha(storage.runId),
    });
  }
  requireValue(targets[0].clusterId !== targets[1].clusterId, 'CLUSTERS_NOT_INDEPENDENT');
  const ports = {
    api: Number(env.PORT ?? 3000),
    worker: Number(env.WORKER_HEALTH_PORT ?? 3001),
    redis: Number(redis.port || 6379),
  };
  requireValue(
    Object.values(ports).every((port) => Number.isInteger(port) && port > 1024 && port <= 65535),
    'ORIGINAL_PORTS_INVALID',
  );
  return { sourceEnv, selections, recoveryId: recovery.id, ports, targets, protectedInputs };
}

async function unchanged(plan) {
  for (const input of plan.protectedInputs)
    requireValue(
      sha(await read(input.path, input.privateMode)) === input.sha256,
      'PROTECTED_INPUT_CHANGED',
    );
}
async function portState(port) {
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (status) => {
      socket.destroy();
      accept({ host: '127.0.0.1', port, status });
    };
    socket.once('connect', () => finish('open'));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
    socket.setTimeout(1000, () => finish('unknown'));
  });
}
async function processState(pid, name, profile) {
  requireValue(Number.isInteger(pid) && pid > 1, 'ORIGINAL_PID_INVALID');
  const options = { env: childEnv, timeout: 4000, maxBuffer: 65536 };
  let started;
  try {
    started = (await execute('ps', ['-p', String(pid), '-o', 'lstart='], options)).stdout.trim();
  } catch (error) {
    if (error.code === 1) return { pid, running: false };
    return { pid, running: null, code: 'GMVP_CONTINUITY_PROCESS_INSPECTION_FAILED' };
  }
  if (!started) return { pid, running: false };
  try {
    const command = (
      await execute('ps', ['-p', String(pid), '-o', 'args='], options)
    ).stdout.trim();
    const cwd = (await execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], options))
      .stdout;
    const entry =
      profile === 's6-github' ? `tests/probes/s6-product-${name}.mjs` : `apps/${name}/dist/main.js`;
    return {
      pid,
      running: true,
      started,
      commandSha256: sha(command),
      owned: command.endsWith(`--env-file=.env ${entry}`) && cwd.split('\n').includes(`n${root}`),
    };
  } catch {
    // A failed ownership inspection is not evidence that a live PID stopped.
    return { pid, running: null, code: 'GMVP_CONTINUITY_PROCESS_INSPECTION_FAILED' };
  }
}
async function host(plan, phase, baseline) {
  const startedAt = timestamp();
  try {
    const runtime = await json(runtimePath, false);
    requireValue(
      ['standard', 's6-github'].includes(runtime.profile ?? 'standard'),
      'RUNTIME_PROFILE_INVALID',
    );
    const [api, worker, ports, recovery] = await Promise.all([
      processState(runtime.api, 'api', runtime.profile),
      processState(runtime.worker, 'worker', runtime.profile),
      Promise.all(
        [...Object.values(plan.ports), 53580, 53581, 53582, 53590, 53591, 53592].map(portState),
      ),
      json(recoveryPath),
    ]);
    const online = ['baseline', 'restarted'].includes(phase);
    const pidsMatch =
      !baseline ||
      (runtime.api === baseline.originalRuntime.api.pid &&
        runtime.worker === baseline.originalRuntime.worker.pid);
    const recoveryMatches =
      recovery.id === plan.recoveryId &&
      (['baseline', 'all-off'].includes(phase)
        ? Boolean(recovery.completed?.['capture-final']) && !recovery.originalLockIntent
        : Boolean(recovery.completed?.['return-original']) &&
          recovery.originalNeedsReconcile === false);
    const ok =
      recoveryMatches &&
      (online || pidsMatch) &&
      (online
        ? api.running && api.owned && worker.running && worker.owned
        : api.running === false && worker.running === false) &&
      ports.slice(0, 3).every((value) => value.status === (online ? 'open' : 'closed')) &&
      ports.slice(3).every((value) => value.status === 'closed');
    return {
      startedAt,
      finishedAt: timestamp(),
      ok: Boolean(ok),
      phase,
      api,
      worker,
      ports,
      pidsMatch,
      recoveryMatches,
      recovery: {
        id: recovery.id,
        originalLockAttempted: Boolean(recovery.originalLockIntent),
        originalNeedsReconcile: recovery.originalNeedsReconcile ?? false,
        returned: Boolean(recovery.completed?.['return-original']),
      },
      ...(ok ? {} : { code: 'GMVP_CONTINUITY_CONTROL_PLANE_WINDOW_MISMATCH' }),
    };
  } catch (error) {
    return { startedAt, finishedAt: timestamp(), ok: false, code: code(error) };
  }
}

async function observe(target, expectedIdentity, source, round) {
  const startedAt = timestamp();
  const partialSteps = [];
  let result,
    invalid = false,
    pending = '',
    bytes = 0;
  const error = await new Promise((accept) => {
    const child = execFile(
      'ssh',
      [
        '-F',
        sshConfig,
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${knownHosts}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'PermitLocalCommand=no',
        '-o',
        'RequestTTY=no',
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-o',
        'ConnectTimeout=4',
        '-o',
        'ConnectionAttempts=1',
        '-o',
        'ServerAliveInterval=2',
        '-o',
        'ServerAliveCountMax=2',
        `ozz-lab-${target.guest}`,
        'sudo -n /usr/bin/python3 -I -B -u -',
      ],
      {
        cwd: root,
        env: childEnv,
        encoding: 'utf8',
        timeout: 45_000,
        maxBuffer: 256 * 1024,
        signal: abort.signal,
      },
      accept,
    );
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      pending += chunk;
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n');
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          requireValue(
            bytes <= 256 * 1024 && line.length < 64 * 1024 && partialSteps.length < 20,
            'REMOTE_OUTPUT_LIMIT',
          );
          const value = JSON.parse(line);
          requireValue(
            value.version === 1 &&
              value.key === target.key &&
              Boolean(value.step) !== Boolean(value.result),
            'REMOTE_RESPONSE_INVALID',
          );
          if (value.step) {
            partialSteps.push(value.step);
            record({
              type: 'remote-step',
              round,
              guest: target.guest,
              key: target.key,
              step: value.step,
            });
          } else {
            requireValue(
              !result &&
                value.result.version === 1 &&
                value.result.key === target.key &&
                value.result.guest === target.guest &&
                typeof value.result.ok === 'boolean' &&
                isDeepStrictEqual(value.result.steps, partialSteps),
              'REMOTE_RESPONSE_INVALID',
            );
            result = value.result;
          }
        } catch {
          invalid = true;
        }
      }
    });
    child.stdin.on('error', () => {
      /* A failed SSH request is recorded by its completion. */
    });
    const payload = Buffer.from(JSON.stringify({ target, expectedIdentity })).toString('base64');
    child.stdin.end(
      `import json,base64\nparameters=json.loads(base64.b64decode('${payload}'))\n${source}`,
    );
  });
  await pendingWrites;
  if (!error && !invalid && result && !pending.trim()) return result;
  return {
    version: 1,
    key: target.key,
    guest: target.guest,
    startedAt,
    finishedAt: timestamp(),
    ok: false,
    code: abort.signal.aborted
      ? 'GMVP_CONTINUITY_INTERRUPTED'
      : invalid
        ? 'GMVP_CONTINUITY_REMOTE_RESPONSE_INVALID'
        : error?.killed
          ? 'GMVP_CONTINUITY_SSH_TIMEOUT'
          : 'GMVP_CONTINUITY_SSH_FAILED',
    steps: partialSteps,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      baseline: { type: 'string' },
      'source-env': { type: 'string' },
      postgresql: { type: 'string' },
      redis: { type: 'string' },
      phase: { type: 'string' },
    },
    allowPositionals: true,
  });
  const mode = positionals[0];
  const phase = mode === 'baseline' ? 'baseline' : (values.phase ?? 'all-off');
  requireValue(
    positionals.length === 1 &&
      ['baseline', 'sample'].includes(mode) &&
      (mode === 'baseline' || ['all-off', 'returned', 'restarted'].includes(phase)) &&
      (mode === 'baseline'
        ? !values.phase
        : !values['source-env'] && !values.postgresql && !values.redis),
    'COMMAND_INVALID',
  );
  const baselinePath = resolve(
    root,
    values.baseline ?? '.local/local-lab/g-mvp-recovery-continuity/baseline.json',
  );
  requireValue(dirname(baselinePath) === directory, 'BASELINE_PATH_OUTSIDE_EVIDENCE_DIRECTORY');
  Object.assign(report, { mode, phase, baselinePath });
  await disk(10);
  let baseline, plan;
  if (mode === 'baseline') {
    try {
      await read(baselinePath);
      throw new Error('GMVP_CONTINUITY_BASELINE_ALREADY_EXISTS');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    plan = await inputs(resolve(root, values['source-env'] ?? '.env'), {
      postgresql: values.postgresql ?? 'a',
      redis: values.redis ?? 'a',
    });
  } else {
    const content = await read(baselinePath);
    baseline = JSON.parse(content);
    report.baselineSha256 = sha(content);
    requireValue(
      baseline.version === 1 && baseline.owner === owner && baseline.status === 'passed',
      'SUCCESSFUL_BASELINE_REQUIRED',
    );
    plan = await inputs(baseline.plan.sourceEnv, baseline.plan.selections);
    requireValue(isDeepStrictEqual(plan, baseline.plan), 'BASELINE_INPUTS_CHANGED');
    const ageMs = Date.now() - Date.parse(baseline.finishedAt);
    requireValue(
      phase !== 'all-off' || (ageMs >= 0 && ageMs <= 15 * 60_000),
      'FRESH_BASELINE_REQUIRED',
    );
  }
  report.targets = plan.targets.map(({ key, guest, serviceId }) => ({ key, guest, serviceId }));
  const source = (await read(sourcePath, false)).toString();
  const rounds = mode === 'baseline' ? 1 : 7;
  const start = performance.now();
  let previousStart;
  for (let index = 0; index < rounds; index += 1) {
    if (abort.signal.aborted) break;
    if (previousStart !== undefined) {
      while (performance.now() < previousStart + 5000)
        await delay(Math.ceil(previousStart + 5000 - performance.now()), undefined, {
          signal: abort.signal,
        });
    }
    previousStart = performance.now();
    const round = {
      index: index + 1,
      startedAt: timestamp(),
      startOffsetMs: previousStart - start,
    };
    report.rounds.push(round);
    await record({ type: 'round-start', round: round.index, ...round });
    console.log(JSON.stringify({ mode, phase, round: round.index, rounds, status: 'sampling' }));
    await disk(8);
    round.hostBefore = await host(plan, phase, baseline);
    await record({ type: 'host-before', round: round.index, observation: round.hostBefore });
    try {
      await unchanged(plan);
      round.targets = await Promise.all(
        plan.targets.map((target) =>
          observe(target, baseline?.identities[target.key], source, round.index),
        ),
      );
      await unchanged(plan);
    } catch (error) {
      round.code = code(error);
    }
    round.hostAfter = await host(plan, phase, baseline);
    round.finishedAt = timestamp();
    round.ok =
      !round.code &&
      round.hostBefore.ok &&
      round.hostAfter.ok &&
      round.targets?.length === 4 &&
      round.targets.every((value) => value.ok);
    await record({ type: 'round-complete', round });
    await writeNew(
      resolve(attemptDirectory, `round-${String(round.index).padStart(2, '0')}.json`),
      round,
    );
  }
  report.sampleSpanMs = report.rounds.at(-1).startOffsetMs - report.rounds[0].startOffsetMs;
  report.finishedAt = timestamp();
  report.status =
    report.rounds.length === rounds &&
    report.rounds.every((round) => round.ok) &&
    !journalFailed &&
    (mode === 'baseline' || report.sampleSpanMs >= 30_000)
      ? 'passed'
      : 'failed';
  if (mode === 'baseline' && report.status === 'passed') {
    const first = report.rounds[0];
    await writeNew(baselinePath, {
      version: 1,
      owner,
      status: 'passed',
      finishedAt: report.finishedAt,
      attempt,
      evidenceDirectory: attemptDirectory,
      plan,
      originalRuntime: { api: first.hostAfter.api, worker: first.hostAfter.worker },
      identities: Object.fromEntries(
        first.targets.map((value) => [
          value.key,
          value.steps.find((step) => step.step === 'identity-before').facts.identity,
        ]),
      ),
    });
    report.baselineSha256 = sha(await read(baselinePath));
  }
}

try {
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  requireValue((await realpath(directory)) === directory, 'EVIDENCE_SYMLINK_REJECTED');
  const evidenceDirectory = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await evidenceDirectory.stat();
    requireValue(
      metadata.isDirectory() && metadata.uid === process.getuid() && (metadata.mode & 0o077) === 0,
      'EVIDENCE_DIRECTORY_NOT_PRIVATE',
    );
  } finally {
    await evidenceDirectory.close();
  }
  await mkdir(attemptDirectory, { mode: 0o700 });
  journal = await open(resolve(attemptDirectory, 'events.jsonl'), 'wx', 0o600);
  await main();
} catch (error) {
  report.status = 'failed';
  report.code = code(error);
} finally {
  report.finishedAt ??= timestamp();
  if (journal) {
    await pendingWrites;
    if (journalFailed) {
      report.status = 'failed';
      report.code = 'GMVP_CONTINUITY_EVIDENCE_WRITE_FAILED';
    }
    await writeNew(resolve(attemptDirectory, 'report.json'), report);
    await journal.close();
  }
  console.log(
    JSON.stringify({
      mode: report.mode,
      phase: report.phase,
      status: report.status,
      code: report.code,
      baseline: report.status === 'passed' ? report.baselinePath : undefined,
      report: journal ? resolve(attemptDirectory, 'report.json') : undefined,
      sampleSpanMs: report.sampleSpanMs,
    }),
  );
  if (report.status !== 'passed') process.exitCode = 1;
}
