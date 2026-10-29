import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { templateImages } from '../../packages/control-plane/dist/templates/image-assets.js';
import {
  boundedRead,
  digestJson,
  entrypoint,
  hashFile,
  identity,
  newTarget,
  privateDirectory,
  privateHandle,
  privateJson,
  publishJson,
  sameIdentity,
  sha256,
  uuid,
  writeNew,
} from '../../scripts/manual-data-core.mjs';
import { verifyBundle, verifyCopyReceipt } from '../../scripts/manual-data-artifact.mjs';
import { executeChannel } from '../../scripts/manual-data-exec.mjs';
import { openManualSession } from '../../scripts/manual-data-runtime.mjs';

// This is an explicitly invoked local acceptance operator, not a product scheduler.
// Run only after the parent probe has completed all three source lifecycle checks.
// No ambient kubectl, host-path reads, source writes, automatic import retry or cleanup.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const stateFile = resolve(lab, 'storage-recovery-state.json');
const reportFile = resolve(root, 'docs/acceptance/s5-recovery-local-results.json');
const apiOrigin = 'http://127.0.0.1:3000';
const engines = ['postgresql', 'redis', 'files'];
const copyLabel = 'local-mac-outside-source-vm';
const requireValue = (value, code) => {
  if (!value) throw Object.assign(new Error(code), { code });
};
const safeCode = (value, fallback = 'S5_RECOVERY_FAILED') =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,99}$/u.test(value) ? value : fallback;
const same = (left, right) => digestJson(left) === digestJson(right);
const probes = {
  postgresql: { tables: [{ schema: 'public', table: 'ozz_s5_probe' }] },
  redis: { database: 0, keys: ['ozz:s5:persistent'] },
  files: {},
};
const fileProgram =
  "const http=require('node:http');const fs=require('node:fs');http.createServer((req,res)=>{res.setHeader('content-type','text/plain');res.end(fs.existsSync('/data/ozz-s5-marker')?fs.readFileSync('/data/ozz-s5-marker'):'S5 recovery target empty')}).listen(8080,'0.0.0.0')";

export function matchesManualRecord(value, { manifest, source, target = null }) {
  return (
    value?.backupId === manifest.backupId &&
    value.type === (target ? 'restore' : 'backup') &&
    value.verificationSource === 'operator_reported' &&
    value.result === 'passed' &&
    value.integrity === 'passed' &&
    value.sha256 === manifest.sha256 &&
    value.sizeBytes === manifest.sizeBytes &&
    sameIdentity(value.source, source) &&
    (target ? sameIdentity(value.target, target) : value.target === null)
  );
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return privateDirectory(path);
}
async function replacePrivate(path, value) {
  const pending = `${path}.pending-${randomUUID()}`;
  await writeNew(pending, value);
  await rename(pending, path);
}

/** A durable CLI boundary: only a never-started intent may spawn a process. */
export async function runRecordedCli({ journal, label, specification, save, recover, execute }) {
  let intent = journal[label];
  if (!intent) {
    intent = journal[label] = {
      ...specification,
      state: 'planned',
      createdAt: new Date().toISOString(),
    };
    await save();
  }
  requireValue(
    intent.id === specification.id &&
      intent.kind === specification.kind &&
      intent.outputParent === specification.outputParent,
    'S5_RECOVERY_CLI_INTENT_CHANGED',
  );
  const previous = await recover(intent);
  if (previous) {
    intent.state = 'succeeded';
    intent.result = previous;
    intent.reconciledAt = new Date().toISOString();
    await save();
    return previous;
  }
  requireValue(intent.state === 'planned', 'S5_RECOVERY_CLI_RECONCILIATION_REQUIRED');
  // A never-started intent may use a newly authenticated context on re-entry.
  intent.args = specification.args;
  intent.state = 'started';
  intent.startedAt = new Date().toISOString();
  await save();
  try {
    await execute(intent);
    const result = await recover(intent);
    requireValue(result, 'S5_RECOVERY_CLI_COMPLETION_MISSING');
    intent.state = 'succeeded';
    intent.result = result;
    intent.completedAt = new Date().toISOString();
    await save();
    return result;
  } catch (error) {
    intent.state = 'failed';
    intent.failure = {
      code: safeCode(error.code),
      observedAt: new Date().toISOString(),
    };
    await save();
    throw error;
  }
}

export class RecoveryProbe {
  constructor(options = {}) {
    this.options = options;
    this.selected = options.engine ? [options.engine] : engines;
    this.invocationId = randomUUID();
    this.origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
    this.abort = new globalThis.AbortController();
    this.contexts = new Map();
    this.stage = 'preflight';
    this.report = {
      version: 1,
      status: 'running',
      invocationId: this.invocationId,
      startedAt: new Date().toISOString(),
      scope:
        'Real local ARM64 K3s A to fresh K3s B targets through product API/Worker and the manual-data CLIs. Existing fixed-image cache assistance; no cloud or physical off-host disaster-recovery claim.',
      copyLocation: {
        label: copyLabel,
        outsideSourceVm: true,
        samePhysicalMac: true,
        physicalLocationVerification: 'operator_reported',
      },
      selectedEngines: this.selected,
      node: process.version,
    };
  }
  async save() {
    await replacePrivate(stateFile, this.state);
  }
  async check(name, details = {}) {
    const value = { name, passed: true, observedAt: new Date().toISOString(), ...details };
    const previous = this.state.checks.findIndex((item) => item.name === name);
    if (previous < 0) this.state.checks.push(value);
    else this.state.checks[previous] = value;
    await this.save();
    console.log(JSON.stringify({ check: name, passed: true }));
  }
  async phase(label, work) {
    this.stage = label;
    if (Object.hasOwn(this.state.completed, label)) return this.state.completed[label];
    console.log(JSON.stringify({ stage: label }));
    const result = (await work()) ?? true;
    this.state.completed[label] = result;
    await this.save();
    return result;
  }
  async request(path, method = 'GET', body, key, expected = 200) {
    requireValue(path.startsWith('/') && !path.startsWith('//'), 'S5_RECOVERY_API_PATH');
    if (method !== 'GET' && path !== '/auth/login') {
      const auth = await this.data('/auth/me');
      requireValue(auth.user && auth.restoreMode === false, 'S5_RECOVERY_PLATFORM_LOCKED');
      this.csrf = auth.csrfToken;
    }
    const response = await fetch(`${apiOrigin}/api${path}`, {
      method,
      redirect: 'error',
      headers: {
        origin: this.origin,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: globalThis.AbortSignal.any([
        this.abort.signal,
        globalThis.AbortSignal.timeout(20_000),
      ]),
    });
    const chunks = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        requireValue(size <= 4 * 1024 * 1024, 'S5_RECOVERY_API_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
    let value;
    try {
      value = response.status === 204 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('S5_RECOVERY_API_RESPONSE_INVALID'), {
        code: 'S5_RECOVERY_API_RESPONSE_INVALID',
      });
    }
    if (response.status !== expected)
      throw Object.assign(new Error('S5_RECOVERY_API_FAILED'), {
        code: safeCode(value?.code, 'S5_RECOVERY_API_FAILED'),
        httpStatus: response.status,
      });
    return { value, response };
  }
  async data(path) {
    return (await this.request(path)).value.data;
  }
  async command(label, path, body, expected = 202) {
    const existing = this.state.commands[label];
    this.state.commands[label] ??= {
      path,
      body,
      key: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const intent = this.state.commands[label];
    requireValue(intent.path === path, 'S5_RECOVERY_COMMAND_TARGET_CHANGED');
    if (existing?.result) return existing.result;
    await this.save();
    const result = (await this.request(path, 'POST', intent.body, intent.key, expected)).value.data;
    requireValue(uuid(result.operation?.id ?? result.id), 'S5_RECOVERY_COMMAND_ID_INVALID');
    intent.result = result;
    await this.save();
    return result;
  }
  async until(read, predicate, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (predicate(value)) return value;
      await delay(1000, undefined, { signal: this.abort.signal });
    }
    throw Object.assign(new Error('S5_RECOVERY_OBSERVATION_TIMEOUT'), {
      code: 'S5_RECOVERY_OBSERVATION_TIMEOUT',
    });
  }
  async waitTask(type, initial) {
    let previous;
    const task = await this.until(
      async () => {
        const value = await this.data(`/${type}/${initial.id}`);
        const signature = `${value.status}:${value.phase}:${value.errorCode}`;
        if (signature !== previous) {
          console.log(
            JSON.stringify({
              taskId: value.id,
              status: value.status,
              phase: value.phase,
              code: value.errorCode ? safeCode(value.errorCode) : null,
            }),
          );
          previous = signature;
        }
        return value;
      },
      (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
      600_000,
    );
    if (task.status !== 'succeeded')
      throw Object.assign(new Error('S5_RECOVERY_TASK_FAILED'), {
        code: safeCode(task.errorCode, 'S5_RECOVERY_TASK_FAILED'),
        taskId: task.id,
      });
    return task;
  }
  async initialize() {
    requireValue(process.version === 'v24.22.1', 'S5_RECOVERY_NODE_24_REQUIRED');
    requireValue(process.platform === 'darwin', 'S5_RECOVERY_MAC_LAB_REQUIRED');
    await privateDirectory(lab);
    this.lock = await open(`${stateFile}.lock`, 'wx', 0o600);
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, nonce: this.invocationId }));
    await this.lock.sync();
    this.parent = await privateJson(resolve(lab, 'storage-product-state.json'));
    this.registered = await privateJson(resolve(lab, 'product-state.json'));
    const parent = this.parent;
    requireValue(parent.version === 1 && uuid(parent.runId), 'S5_RECOVERY_PARENT_INVALID');
    for (const engine of engines)
      requireValue(
        uuid(parent.services[engine]) &&
          uuid(parent.volumes[engine]) &&
          parent.completed[`write:${engine}`] &&
          parent.completed[`stop-resume:${engine}`],
        'S5_RECOVERY_SOURCE_NOT_READY',
      );
    const topology = {
      sourceRunId: parent.runId,
      source: {
        projectId: parent.projects.a,
        environmentId: parent.environments.a,
        clusterId: this.registered.clusters.a,
        services: Object.fromEntries(engines.map((key) => [key, parent.services[key]])),
        volumes: Object.fromEntries(engines.map((key) => [key, parent.volumes[key]])),
      },
      target: {
        projectId: parent.projects.b,
        environmentId: parent.environments.b,
        clusterId: this.registered.clusters.b,
      },
    };
    requireValue(
      [
        topology.source.projectId,
        topology.source.environmentId,
        topology.source.clusterId,
        ...Object.values(topology.target),
      ].every(uuid) && topology.source.clusterId !== topology.target.clusterId,
      'S5_RECOVERY_TOPOLOGY_INVALID',
    );
    this.state = (await exists(stateFile))
      ? await privateJson(stateFile)
      : {
          version: 1,
          runId: randomUUID(),
          startedAt: new Date().toISOString(),
          topology,
          engines: {},
          commands: {},
          cli: {},
          completed: {},
          checks: [],
        };
    requireValue(
      this.state.version === 1 && uuid(this.state.runId) && same(this.state.topology, topology),
      'S5_RECOVERY_STATE_TARGET_CHANGED',
    );
    this.runDirectory = await directory(resolve(lab, 's5-recovery', this.state.runId));
    this.authDirectory = await directory(resolve(this.runDirectory, 'contexts', this.invocationId));
    this.report.runId = this.state.runId;
    this.report.sourceRunId = parent.runId;
    await this.save();
    const handle = await privateHandle(resolve(root, '.secrets/admin-password'), 4096);
    let password;
    try {
      password = (await boundedRead(handle, 4096)).toString('utf8').trim();
    } finally {
      await handle.close();
    }
    const login = await this.request('/auth/login', 'POST', { username: 'admin', password });
    password = undefined;
    this.cookie = login.response.headers
      .getSetCookie()
      .find((value) => value.startsWith('ozz_session='))
      ?.split(';')[0];
    this.csrf = login.value.data.csrfToken;
    requireValue(this.cookie && this.csrf, 'S5_RECOVERY_LOGIN_FAILED');
    await writeNew(resolve(this.authDirectory, 'session.json'), { cookie: this.cookie });
    for (const guest of ['a', 'b']) {
      const input = await privateHandle(
        resolve(lab, `credentials/${guest}.kubeconfig.json`),
        256 * 1024,
      );
      try {
        await writeNew(
          resolve(this.authDirectory, `${guest}.kubeconfig.json`),
          await boundedRead(input, 256 * 1024),
        );
      } finally {
        await input.close();
      }
    }
    for (const engine of this.selected) await this.source(engine);
  }
  async source(engine) {
    const serviceId = this.parent.services[engine],
      volumeId = this.parent.volumes[engine];
    const [service, volume] = await Promise.all([
      this.data(`/services/${serviceId}`),
      this.data(`/volumes/${volumeId}`),
    ]);
    requireValue(
      service.id === serviceId &&
        volume.id === volumeId &&
        service.projectId === this.state.topology.source.projectId &&
        service.environmentId === this.state.topology.source.environmentId &&
        service.clusterId === this.state.topology.source.clusterId &&
        uuid(service.published?.deploymentId) &&
        !volume.destroyedAt,
      'S5_RECOVERY_SOURCE_CHANGED',
    );
    identity(volume.manualDataIdentity);
    const ref = {
      serviceId,
      volumeId,
      identity: volume.manualDataIdentity,
      deploymentId: service.published.deploymentId,
      requestedBytes: volume.requestedBytes,
      projectId: service.projectId,
      environmentId: service.environmentId,
      clusterId: service.clusterId,
    };
    const entry = (this.state.engines[engine] ??= { source: ref, targets: [] });
    requireValue(same(entry.source, ref), 'S5_RECOVERY_SOURCE_CHANGED');
    await this.save();
    return entry.source;
  }
  async current(ref) {
    const [service, volume] = await Promise.all([
      this.data(`/services/${ref.serviceId}`),
      this.data(`/volumes/${ref.volumeId}`),
    ]);
    requireValue(
      service.id === ref.serviceId &&
        volume.id === ref.volumeId &&
        volume.project?.id === ref.projectId &&
        volume.environment?.id === ref.environmentId &&
        volume.cluster?.id === ref.clusterId &&
        service.projectId === ref.projectId &&
        service.environmentId === ref.environmentId &&
        service.clusterId === ref.clusterId &&
        !volume.destroyedAt &&
        (!ref.identity || sameIdentity(volume.manualDataIdentity, ref.identity)) &&
        (!ref.deploymentId || service.published?.deploymentId === ref.deploymentId),
      'S5_RECOVERY_FIXED_TARGET_CHANGED',
    );
    return { service, volume };
  }
  async context(engine, ref, guest) {
    identity(ref.identity);
    const key = `${guest}:${ref.serviceId}`;
    if (this.contexts.has(key)) return this.contexts.get(key);
    const file = resolve(this.authDirectory, `${guest}-${engine}-${ref.serviceId}.json`);
    await writeNew(file, {
      apiOrigin,
      appOrigin: this.origin,
      sessionFile: 'session.json',
      kubeconfigFile: `${guest}.kubeconfig.json`,
      serviceId: ref.serviceId,
      engine,
      expectedIdentity: ref.identity,
      probes: probes[engine],
    });
    this.contexts.set(key, file);
    return file;
  }
  async online(engine, ref, guest) {
    await this.current(ref);
    const session = await openManualSession(await this.context(engine, ref, guest));
    try {
      return await session.checkpoint('formal');
    } finally {
      session.close();
    }
  }
  async marker(engine, ref, guest) {
    await this.current(ref);
    const session = await openManualSession(await this.context(engine, ref, guest));
    try {
      const before = await session.checkpoint('formal');
      const marker = this.parent.runId;
      requireValue(uuid(marker), 'S5_RECOVERY_MARKER_INVALID');
      let command;
      if (engine === 'postgresql') {
        const sql = `SELECT count(*) = 1 AND bool_and(value = '${marker}') FROM public.ozz_s5_probe WHERE id = 'persistent';`;
        command = [
          'sh',
          '-c',
          'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "$1"',
          'sh',
          sql,
        ];
      } else if (engine === 'redis') {
        command = [
          'sh',
          '-c',
          'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --raw -h 127.0.0.1 -n 0 EVAL "$1" 1 ozz:s5:persistent "$2"',
          'sh',
          "return redis.call('GET',KEYS[1]) == ARGV[1] and 1 or 0",
          marker,
        ];
      } else {
        command = [
          'node',
          '-e',
          "const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');const hash=b=>crypto.createHash('sha256').update(b).digest('hex');const file=fs.readFileSync('/data/ozz-s5-marker');if(file.length>1024)process.exit(3);const req=http.get('http://127.0.0.1:8080/',res=>{const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>1024)req.destroy(new Error('LIMIT'));else chunks.push(b)});res.on('end',()=>{console.log(JSON.stringify({status:res.statusCode,fileSha256:hash(file),httpSha256:hash(Buffer.concat(chunks))}))})});req.setTimeout(10000,()=>req.destroy(new Error('TIMEOUT')));req.on('error',()=>process.exit(4))",
        ];
      }
      const result = await executeChannel(
        session.connection,
        { namespace: before.fence.namespace, name: before.pod.metadata.name },
        command,
        { maximum: 8192, timeoutMs: 20_000 },
      );
      const after = await session.checkpoint('formal');
      requireValue(
        after.pod.metadata.uid === before.pod.metadata.uid,
        'S5_RECOVERY_MARKER_POD_CHANGED',
      );
      let details = {};
      if (engine === 'files') {
        const value = JSON.parse(result.stdout.toString('utf8'));
        requireValue(
          value.status === 200 &&
            value.fileSha256 === sha256(marker) &&
            value.httpSha256 === sha256(marker),
          'S5_RECOVERY_FILES_MARKER_MISMATCH',
        );
        details = {
          fileSha256: value.fileSha256,
          httpSha256: value.httpSha256,
          httpStatus: value.status,
        };
      } else {
        requireValue(
          result.stdout.toString('utf8').trim() === (engine === 'postgresql' ? 't' : '1'),
          'S5_RECOVERY_DATABASE_MARKER_MISMATCH',
        );
      }
      return { verified: true, podUid: before.pod.metadata.uid, fence: before.fence, ...details };
    } finally {
      session.close();
    }
  }
  async serviceAction(ref, verb, label) {
    const { service } = await this.current(ref);
    const task = await this.command(label, `/services/${ref.serviceId}/${verb}`, {
      revision: service.revision,
    });
    await this.waitTask('operations', task);
    await this.until(
      () => this.current(ref),
      ({ service: current }) =>
        !current.activeTask &&
        current.desiredState === (verb === 'stop' ? 'stopped' : 'running') &&
        current.runtimeState === (verb === 'stop' ? 'stopped' : 'running'),
    );
  }
  async enterMaintenance(ref, purpose, label) {
    const { service, volume } = await this.current(ref);
    requireValue(service.runtimeState === 'stopped', 'S5_RECOVERY_SERVICE_NOT_STOPPED');
    const task = await this.command(label, `/volumes/${ref.volumeId}/maintenance/enter`, {
      revision: volume.revision,
      purpose,
    });
    await this.waitTask('operations', task);
    const after = await this.until(
      () => this.current(ref),
      ({ volume: value }) =>
        !value.activeTask &&
        value.maintenance?.state === 'active' &&
        value.maintenance.purpose === purpose &&
        !value.maintenance.overdue,
    );
    return after.volume.maintenance.id;
  }
  async exitMaintenance(ref, maintenanceId, label) {
    const { volume } = await this.current(ref);
    requireValue(
      volume.maintenance?.id === maintenanceId || this.state.commands[label]?.result,
      'S5_RECOVERY_MAINTENANCE_CHANGED',
    );
    const task = await this.command(label, `/volumes/${ref.volumeId}/maintenance/exit`, {
      revision: volume.revision,
      maintenanceId,
    });
    await this.waitTask('operations', task);
    await this.until(
      () => this.current(ref),
      ({ volume: value }) =>
        !value.activeTask && (!value.maintenance || value.maintenance.state === 'closed'),
    );
  }
  async reports(parent, name) {
    const found = [];
    if (!(await exists(parent))) return found;
    await privateDirectory(parent);
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!uuid(entry.name)) continue;
      requireValue(
        entry.isDirectory() && !entry.isSymbolicLink(),
        'S5_RECOVERY_OUTPUT_DIRECTORY_CHANGED',
      );
      const child = await privateDirectory(resolve(parent, entry.name));
      const file = resolve(child, name);
      if (await exists(file))
        found.push({ directory: child, file, value: await privateJson(file) });
    }
    requireValue(found.length <= 1, 'S5_RECOVERY_MULTIPLE_CLI_COMPLETIONS');
    return found;
  }
  async executeCli(intent) {
    return new Promise((accept, reject) => {
      let buffer = '';
      const child = execFile(
        process.execPath,
        [resolve(root, `scripts/manual-data-${intent.kind}.mjs`), ...intent.args],
        {
          cwd: root,
          timeout: 20 * 60_000,
          maxBuffer: 2 * 1024 * 1024,
          signal: this.abort.signal,
        },
        (error, stdout, stderr) => {
          globalThis.clearInterval(heartbeat);
          intent.process = {
            exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
            stdoutSha256: sha256(stdout),
            stderrBytes: Buffer.byteLength(stderr),
            completedAt: new Date().toISOString(),
          };
          if (!error) return accept();
          let code;
          for (const line of stderr.trim().split('\n')) {
            try {
              code = JSON.parse(line).code ?? code;
            } catch {
              /* Raw diagnostics are never retained. */
            }
          }
          reject(
            Object.assign(new Error('S5_RECOVERY_CLI_FAILED'), {
              code: safeCode(code, 'S5_RECOVERY_CLI_FAILED'),
            }),
          );
        },
      );
      const heartbeat = globalThis.setInterval(
        () =>
          console.log(JSON.stringify({ stage: this.stage, cli: intent.kind, status: 'running' })),
        30_000,
      );
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const progress = JSON.parse(line);
            if (typeof progress.stage === 'string' && /^[a-z0-9:_-]{1,100}$/u.test(progress.stage))
              console.log(JSON.stringify({ cli: intent.kind, stage: progress.stage }));
          } catch {
            /* Only structured stage names reach the terminal. */
          }
        }
      });
    });
  }
  async cli(label, kind, args, recover) {
    this.stage = label;
    const id = this.state.cli[label]?.id ?? randomUUID();
    const parent = await directory(resolve(this.runDirectory, 'cli', id));
    const specification = { id, kind, outputParent: parent, args: args(parent) };
    return runRecordedCli({
      journal: this.state.cli,
      label,
      specification,
      save: () => this.save(),
      recover,
      execute: (intent) => this.executeCli(intent),
    });
  }
  async backup(engine, source) {
    const context = await this.context(engine, source, 'a');
    return this.cli(
      `backup:${engine}`,
      'backup',
      (parent) => ['--context', context, '--output', parent],
      async (intent) => {
        const [found] = await this.reports(intent.outputParent, 'manifest.json');
        if (!found) return null;
        const bundle = await verifyBundle(found.directory);
        requireValue(
          bundle.manifest.engine === engine &&
            bundle.manifest.sourceServiceId === source.serviceId &&
            sameIdentity(bundle.manifest.source, source.identity),
          'S5_RECOVERY_BACKUP_SOURCE_CHANGED',
        );
        return {
          directory: bundle.directory,
          manifestSha256: bundle.manifestSha256,
          manifest: bundle.manifest,
        };
      },
    );
  }
  async copy(engine, backup) {
    const copy = await this.cli(
      `copy:${engine}`,
      'artifact',
      (parent) => [
        '--bundle',
        backup.directory,
        '--copy-to',
        parent,
        '--location-label',
        copyLabel,
      ],
      async (intent) => {
        const destination = resolve(intent.outputParent, backup.manifest.backupId);
        if (!(await exists(resolve(destination, 'manifest.json')))) return null;
        const bundle = await verifyBundle(destination);
        const receipts = (await readdir(destination)).filter((name) =>
          /^copy-receipt-[a-f0-9-]{36}\.json$/u.test(name),
        );
        requireValue(receipts.length <= 1, 'S5_RECOVERY_MULTIPLE_COPY_RECEIPTS');
        if (!receipts.length) return null;
        const receiptFile = resolve(destination, receipts[0]);
        const receipt = await verifyCopyReceipt(bundle, receiptFile);
        requireValue(
          bundle.manifestSha256 === backup.manifestSha256 && receipt.locationLabel === copyLabel,
          'S5_RECOVERY_COPY_CHANGED',
        );
        return {
          directory: bundle.directory,
          receiptFile,
          receipt,
          manifestSha256: bundle.manifestSha256,
        };
      },
    );
    await this.executeCli({ kind: 'artifact', args: ['--bundle', copy.directory] });
    return copy;
  }
  async record(engine, source, backup, copy, restored = null) {
    const label = restored
      ? `record:restore:${engine}:${restored.operationId}`
      : `record:backup:${engine}`;
    const context = await this.context(engine, source, 'a');
    const matches = (value) =>
      matchesManualRecord(value, {
        manifest: backup.manifest,
        source: source.identity,
        target: restored?.target ?? null,
      });
    return this.cli(
      label,
      'record',
      (parent) => [
        '--context',
        context,
        '--bundle',
        copy.directory,
        '--copy-receipt',
        copy.receiptFile,
        '--output',
        parent,
        ...(restored ? ['--restore-report', restored.reportFile] : []),
      ],
      async (intent) => {
        const [found] = await this.reports(intent.outputParent, 'manual-record-receipt.json');
        if (found) {
          requireValue(matches(found.value), 'S5_RECOVERY_RECORD_RECEIPT_CHANGED');
          return {
            id: found.value.id,
            verificationSource: 'operator_reported',
            receiptFile: found.file,
          };
        }
        if (intent.state === 'planned') return null;
        // A lost POST response is reconciled by reading the source ledger, never by replaying POST.
        const response = (
          await this.request(
            `/volumes/${source.volumeId}/manual-data-records?limit=100&type=${restored ? 'restore' : 'backup'}`,
          )
        ).value;
        requireValue(!response.page.hasMore, 'S5_RECOVERY_RECORD_LOOKUP_TRUNCATED');
        const records = response.data.filter(matches);
        requireValue(records.length <= 1, 'S5_RECOVERY_DUPLICATE_RECORDS');
        if (!records.length) return null;
        const file = resolve(intent.outputParent, `reconciled-${records[0].id}.json`);
        if (!(await exists(file))) await publishJson(file, records[0]);
        return {
          id: records[0].id,
          verificationSource: 'operator_reported',
          receiptFile: file,
          reconciled: true,
        };
      },
    );
  }
  async target(engine, backup) {
    const entry = this.state.engines[engine];
    let target = entry.targets.at(-1);
    if (this.options.newTargetFor) {
      requireValue(this.selected.length === 1, 'S5_RECOVERY_NEW_TARGET_ENGINE_REQUIRED');
      if (target?.id === this.options.newTargetFor) {
        requireValue(target.failure, 'S5_RECOVERY_NEW_TARGET_REQUIRES_FAILED_ATTEMPT');
        target = null;
      } else
        requireValue(
          target?.replaces === this.options.newTargetFor,
          'S5_RECOVERY_REPLACED_ATTEMPT_MISMATCH',
        );
    }
    if (!target) {
      requireValue(
        Date.now() > Date.parse(backup.manifest.completedAt),
        'S5_RECOVERY_TARGET_TOO_EARLY',
      );
      target = {
        id: randomUUID(),
        replaces: this.options.newTargetFor ?? null,
        backupId: backup.manifest.backupId,
        startedAt: new Date().toISOString(),
        ...this.state.topology.target,
      };
      entry.targets.push(target);
      await this.save();
    }
    requireValue(target.backupId === backup.manifest.backupId, 'S5_RECOVERY_TARGET_BACKUP_CHANGED');
    this.activeTarget = target;
    requireValue(!target.failureHold, 'S5_RECOVERY_FAILED_TARGET_REQUIRES_NEW_ATTEMPT');
    const prefix = `target:${engine}:${target.id}`;
    await this.phase(`${prefix}:create`, async () => {
      const parameters =
        engine === 'files'
          ? { image: templateImages['node-example'].deployReference, port: 8080 }
          : {
              requestedBytes: entry.source.requestedBytes,
              ...(engine === 'redis' ? { redisDatabase: 0 } : {}),
            };
      const created = await this.command(
        `${prefix}:service`,
        '/services',
        {
          projectId: target.projectId,
          environmentId: target.environmentId,
          name: `S5 恢复 ${engine}`,
          slug: `s5-restore-${engine}-${target.id.slice(0, 8)}`,
          template: { id: engine === 'files' ? 'docker' : engine, version: '1.0.0', parameters },
        },
        201,
      );
      target.serviceId = created.id;
      if (engine === 'files') {
        const result = await this.command(`${prefix}:volume`, '/volumes', {
          environmentId: target.environmentId,
          name: 'S5 恢复文件',
          slug: `s5-restore-files-${target.id.slice(0, 8)}`,
          storageClassName: 'local-path',
          requestedBytes: entry.source.requestedBytes,
        });
        target.volumeId = result.volumeId;
        await this.save();
        await this.waitTask('operations', result.operation);
        await this.configureFiles(target);
      } else {
        const database = await this.data(`/services/${target.serviceId}/database`);
        target.volumeId = database.dataVolume.id;
        requireValue(
          !database.consumersTruncated && database.consumers.length === 0,
          'S5_RECOVERY_TARGET_HAS_CONSUMERS',
        );
      }
      const current = await this.current(target);
      requireValue(
        Date.parse(current.service.createdAt) > Date.parse(backup.manifest.completedAt) &&
          Date.parse(current.volume.createdAt) > Date.parse(backup.manifest.completedAt),
        'S5_RECOVERY_TARGET_NOT_NEW',
      );
      target.serviceCreatedAt = current.service.createdAt;
      target.volumeCreatedAt = current.volume.createdAt;
      await this.save();
    });
    await this.phase(`${prefix}:initialize`, async () => {
      const current = await this.current(target);
      const deployment = await this.command(
        `${prefix}:publish`,
        `/services/${target.serviceId}/deployments`,
        { revision: current.service.revision },
      );
      const completed = await this.waitTask('deployments', deployment);
      target.deploymentId = completed.id;
      await this.until(
        () => this.current(target),
        ({ service, volume }) =>
          service.runtimeState === 'running' &&
          !service.activeTask &&
          volume.pvc.uid &&
          volume.observation?.state === 'ready' &&
          !volume.observation.stale,
      );
      if (engine !== 'files')
        await this.until(
          () => this.data(`/services/${target.serviceId}/database`),
          (value) => value.databaseReady && !value.observationStale,
        );
      const after = await this.current(target);
      target.identity = after.volume.manualDataIdentity;
      newTarget(entry.source.identity, target.identity, entry.source.serviceId, target.serviceId);
      target.initialFence = (await this.online(engine, target, 'b')).fence;
      await this.save();
    });
    await this.current(target);
    return target;
  }
  async configureFiles(target) {
    let current = await this.current(target);
    const response = (await this.request(`/services/${target.serviceId}/volume-mounts`)).value;
    const mounts = response.data.filter((value) => value.desired);
    requireValue(
      mounts.length <= 1 &&
        mounts.every(
          (value) =>
            value.volumeId === target.volumeId && value.mountPath === '/data' && !value.readOnly,
        ),
      'S5_RECOVERY_FILE_MOUNT_CHANGED',
    );
    if (!mounts.length) {
      target.mountIntent ??= {
        revision: current.service.revision,
        volumeId: target.volumeId,
        volumeRevision: current.volume.revision,
        mountPath: '/data',
        readOnly: false,
      };
      await this.save();
      await this.request(`/services/${target.serviceId}/volume-mounts`, 'POST', target.mountIntent);
    }
    current = await this.current(target);
    target.configurationIntent ??= {
      revision: current.service.revision,
      configuration: {
        ...current.service.configuration,
        command: ['node'],
        args: ['-e', fileProgram],
        resources: {
          requests: { cpuMillis: 25, memoryMiB: 32 },
          limits: { cpuMillis: 250, memoryMiB: 128 },
        },
      },
    };
    await this.save();
    if (!same(current.service.configuration, target.configurationIntent.configuration))
      await this.request(`/services/${target.serviceId}`, 'PATCH', target.configurationIntent);
  }
  async restore(engine, target, backup, copy) {
    const context = await this.context(engine, target, 'b');
    return this.cli(
      `restore:${engine}:${target.id}`,
      'restore',
      (parent) => [
        '--context',
        context,
        '--bundle',
        copy.directory,
        '--copy-receipt',
        copy.receiptFile,
        '--output',
        parent,
      ],
      async (intent) => {
        const [found] = await this.reports(intent.outputParent, 'restore-prepared.json');
        if (!found) return null;
        const value = found.value;
        requireValue(
          value.state === 'awaiting-formal-verification' &&
            value.result === 'incomplete' &&
            value.helperRemoved === true &&
            value.maintenanceReleased === false &&
            value.backupId === backup.manifest.backupId &&
            value.targetServiceId === target.serviceId &&
            sameIdentity(value.source, backup.manifest.source) &&
            sameIdentity(value.target, target.identity) &&
            value.manifestSha256 === backup.manifestSha256,
          'S5_RECOVERY_PREPARED_REPORT_CHANGED',
        );
        return { ...value, directory: found.directory, reportFile: found.file };
      },
    );
  }
  async verify(engine, target, prepared, backup, copy) {
    const context = await this.context(engine, target, 'b');
    return this.cli(
      `verify:${engine}:${target.id}`,
      'verify',
      () => [
        '--context',
        context,
        '--bundle',
        copy.directory,
        '--copy-receipt',
        copy.receiptFile,
        '--prepared',
        prepared.reportFile,
      ],
      async () => {
        const file = resolve(prepared.directory, 'restore-complete.json');
        if (!(await exists(file))) return null;
        const value = await privateJson(file);
        requireValue(
          value.state === 'complete' &&
            value.result === 'passed' &&
            value.helperRemoved &&
            value.maintenanceReleased &&
            value.backupId === backup.manifest.backupId &&
            value.targetServiceId === target.serviceId &&
            value.operationId === prepared.operationId &&
            sameIdentity(value.target, target.identity) &&
            value.manifestSha256 === backup.manifestSha256,
          'S5_RECOVERY_COMPLETE_REPORT_CHANGED',
        );
        return { ...value, directory: prepared.directory, reportFile: file };
      },
    );
  }
  async runEngine(engine) {
    this.activeEngine = engine;
    this.activeTarget = null;
    const entry = this.state.engines[engine],
      source = await this.source(engine);
    await this.phase(`source:${engine}:marker`, async () => {
      const result = await this.marker(engine, source, 'a');
      await this.check(`${engine}: source marker verified before backup`, {
        serviceId: source.serviceId,
        volumeId: source.volumeId,
        podUid: result.podUid,
      });
      return result;
    });
    if (engine === 'files') {
      await this.phase('source:files:stop', () =>
        this.serviceAction(source, 'stop', 'source:files:stop'),
      );
      entry.sourceMaintenanceId = await this.phase('source:files:maintenance', () =>
        this.enterMaintenance(source, 'backup', 'source:files:maintenance'),
      );
    }
    const backup = await this.backup(engine, source);
    entry.backup = backup;
    const copy = await this.copy(engine, backup);
    entry.copy = copy;
    await this.check(`${engine}: immutable backup and Mac copy verified`, {
      backupId: backup.manifest.backupId,
      sha256: backup.manifest.sha256,
      sizeBytes: backup.manifest.sizeBytes,
      manifestSha256: backup.manifestSha256,
      copyId: copy.receipt.copyId,
    });
    if (engine === 'files') {
      await this.phase('source:files:exit', () =>
        this.exitMaintenance(source, entry.sourceMaintenanceId, 'source:files:exit'),
      );
      await this.phase('source:files:resume', () =>
        this.serviceAction(source, 'resume', 'source:files:resume'),
      );
    }
    await this.marker(engine, source, 'a');
    entry.backupRecord = await this.record(engine, source, backup, copy);
    const target = await this.target(engine, backup);
    const prefix = `target:${engine}:${target.id}`;
    await this.phase(`${prefix}:stop`, () => this.serviceAction(target, 'stop', `${prefix}:stop`));
    target.maintenanceId = await this.phase(`${prefix}:maintenance`, () =>
      this.enterMaintenance(target, 'restore', `${prefix}:maintenance`),
    );
    await this.save();
    const prepared = await this.restore(engine, target, backup, copy);
    target.prepared = prepared;
    this.formalWindow = true;
    await this.phase(`${prefix}:exit`, () =>
      this.exitMaintenance(target, target.maintenanceId, `${prefix}:exit`),
    );
    await this.phase(`${prefix}:resume`, () =>
      this.serviceAction(target, 'resume', `${prefix}:resume`),
    );
    if (engine !== 'files')
      await this.until(
        () => this.data(`/services/${target.serviceId}/database`),
        (value) => value.databaseReady && !value.observationStale,
      );
    target.complete = await this.verify(engine, target, prepared, backup, copy);
    this.stage = `${prefix}:business-marker`;
    target.business = await this.marker(engine, target, 'b');
    this.formalWindow = false;
    target.restoreRecord = await this.record(engine, source, backup, copy, target.complete);
    target.sourceRetained = await this.marker(engine, source, 'a');
    target.completedAt = new Date().toISOString();
    await this.check(
      `${engine}: fresh B target restored and formal data verified; source retained`,
      {
        backupId: backup.manifest.backupId,
        source: source.identity,
        target: target.identity,
        sourceServiceId: source.serviceId,
        targetServiceId: target.serviceId,
        durationMs: target.complete.durationMs,
        backupRecordId: entry.backupRecord.id,
        restoreRecordId: target.restoreRecord.id,
        verificationSource: 'operator_reported',
        ...(engine === 'files' ? { httpSha256: target.business.httpSha256 } : {}),
      },
    );
    await this.save();
  }
  async holdFailedFormalTarget() {
    if (!this.formalWindow || !this.activeTarget) return;
    const target = this.activeTarget;
    const prefix = `hold:${target.id}:${this.invocationId}`;
    try {
      await this.serviceAction(target, 'stop', `${prefix}:stop`);
      const maintenanceId = await this.enterMaintenance(target, 'restore', `${prefix}:maintenance`);
      target.failureHold = {
        state: 'stopped-and-maintained',
        maintenanceId,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      target.failureHold = {
        state: 'not-confirmed',
        code: safeCode(error.code),
        observedAt: new Date().toISOString(),
      };
    }
    await this.save();
  }
  async finish() {
    if (!this.lock) return;
    try {
      this.report.completedAt = new Date().toISOString();
      if (this.state) {
        this.report.checks = this.state.checks;
        this.report.resources = Object.fromEntries(
          Object.entries(this.state.engines).map(([engine, value]) => [
            engine,
            {
              source: value.source,
              backup: value.backup
                ? {
                    backupId: value.backup.manifest.backupId,
                    sha256: value.backup.manifest.sha256,
                    sizeBytes: value.backup.manifest.sizeBytes,
                    completedAt: value.backup.manifest.completedAt,
                    manifestSha256: value.backup.manifestSha256,
                  }
                : null,
              copy: value.copy?.receipt ?? null,
              backupRecordId: value.backupRecord?.id ?? null,
              targets: value.targets.map((target) => ({
                attemptId: target.id,
                serviceId: target.serviceId,
                volumeId: target.volumeId,
                identity: target.identity,
                deploymentId: target.deploymentId,
                serviceCreatedAt: target.serviceCreatedAt,
                volumeCreatedAt: target.volumeCreatedAt,
                restoreOperationId: target.prepared?.operationId,
                result: target.completedAt ? 'passed' : 'incomplete',
                durationMs: target.complete?.durationMs,
                restoreRecordId: target.restoreRecord?.id,
                sourceRetained: target.sourceRetained?.verified === true,
                business: target.business
                  ? {
                      verified: target.business.verified,
                      podUid: target.business.podUid,
                      fileSha256: target.business.fileSha256,
                      httpSha256: target.business.httpSha256,
                    }
                  : null,
                failure: target.failure ?? null,
                failureHold: target.failureHold ?? null,
                replaces: target.replaces,
              })),
            },
          ]),
        );
        const evidence = [];
        for (const intent of Object.values(this.state.cli)) {
          const result = intent.result;
          for (const path of [
            result?.reportFile,
            result?.receiptFile,
            result?.directory && intent.kind === 'backup'
              ? resolve(result.directory, 'manifest.json')
              : null,
          ])
            if (path && (await exists(path)))
              evidence.push({
                path: relative(root, path),
                ...(await hashFile(path, 16 * 1024 * 1024)),
              });
        }
        this.report.evidence = evidence;
        this.report.cliAttempts = Object.entries(this.state.cli).map(([label, value]) => ({
          label,
          id: value.id,
          kind: value.kind,
          state: value.state,
          process: value.process ?? null,
          failure: value.failure ?? null,
        }));
        await this.save();
      }
      const immutable = resolve(
        root,
        `docs/acceptance/s5-recovery-local-results-${this.invocationId}.json`,
      );
      await publishJson(immutable, this.report);
      await replacePrivate(reportFile, this.report);
    } finally {
      await this.lock.close();
      const owner = await privateJson(`${stateFile}.lock`);
      if (owner.nonce === this.invocationId) await unlink(`${stateFile}.lock`);
    }
  }
  async run() {
    const stop = () => this.abort.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await this.initialize();
      for (const engine of this.selected) await this.runEngine(engine);
      this.report.status = engines.every(
        (engine) => this.state.engines[engine]?.targets.at(-1)?.completedAt,
      )
        ? 'passed'
        : 'partial';
    } catch (error) {
      this.report.status = 'failed';
      this.report.failure = {
        stage: this.stage,
        code: safeCode(error.code ?? error.message),
        taskId: error.taskId ?? null,
        httpStatus: error.httpStatus ?? null,
      };
      if (this.activeTarget) {
        this.activeTarget.failure = {
          ...this.report.failure,
          observedAt: new Date().toISOString(),
        };
        await this.holdFailedFormalTarget();
      }
      console.error(JSON.stringify(this.report.failure));
      process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await this.finish();
    }
  }
}

if (entrypoint(import.meta.url)) {
  try {
    const args = parseArgs({
      options: {
        help: { type: 'boolean' },
        engine: { type: 'string' },
        'new-target-for': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (args.values.help) {
      console.log(
        'pnpm exec node --env-file=.env tests/probes/s5-recovery-local-lab.mjs run [--engine=postgresql|redis|files] [--new-target-for=FAILED_TARGET_ATTEMPT_UUID]',
      );
      console.log(
        'Run only after root source-ready. Completed CLIs are reconciled; started/failed imports never run twice. A fresh target requires the exact failed attempt UUID. Failed backups/copies/record POSTs require explicit reconciliation. All prior data and reports are retained.',
      );
    } else {
      requireValue(
        args.positionals.length === 1 && args.positionals[0] === 'run',
        'S5_RECOVERY_EXPLICIT_RUN_REQUIRED',
      );
      requireValue(
        !args.values.engine || engines.includes(args.values.engine),
        'S5_RECOVERY_ENGINE_INVALID',
      );
      requireValue(
        !args.values['new-target-for'] ||
          (uuid(args.values['new-target-for']) && args.values.engine),
        'S5_RECOVERY_NEW_TARGET_ARGUMENT_INVALID',
      );
      await new RecoveryProbe({
        engine: args.values.engine,
        newTargetFor: args.values['new-target-for'],
      }).run();
    }
  } catch (error) {
    console.error(JSON.stringify({ code: safeCode(error.code ?? error.message) }));
    process.exitCode = 1;
  }
}
