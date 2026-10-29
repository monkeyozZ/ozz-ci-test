import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createConnection, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

export const owner = 'ozz-g-mvp-recovery-joint-timing-v1';
export const hash = (raw) => createHash('sha256').update(raw).digest('hex');
export const encode = (value) => JSON.stringify(value, null, 2) + '\n';
export const GiB = 1024 ** 3;
export function requireValue(value, code) {
  if (!value) throw new Error('GMVP_JOINT_' + code);
}
export function safeCode(error) {
  return /^(GMVP_JOINT|BUILD|BACKUP|RESTORE|SNAPSHOT)_[A-Z0-9_]+$/u.test(error?.message ?? '')
    ? error.message
    : 'GMVP_JOINT_UNEXPECTED_FAILURE';
}
export async function privateFile(path, maximum = 4 * 1024 * 1024) {
  const info = await lstat(path);
  requireValue(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      info.nlink === 1 &&
      !(info.mode & 0o077) &&
      info.size > 0 &&
      info.size <= maximum &&
      (await realpath(path)) === path,
    'PRIVATE_INPUT_INVALID',
  );
  const raw = await readFile(path);
  requireValue(raw.length === info.size, 'PRIVATE_INPUT_CHANGED');
  return raw;
}
export async function newFile(path, raw) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(raw);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function atomicState(path, value) {
  const parent = dirname(path),
    info = await lstat(parent);
  requireValue(
    info.isDirectory() &&
      info.uid === process.getuid() &&
      !(info.mode & 0o077) &&
      (await realpath(parent)) === parent,
    'STATE_DIRECTORY_UNSAFE',
  );
  const temporary = resolve(parent, `.state-${randomUUID()}.json`);
  await newFile(temporary, encode(value));
  await rename(temporary, path);
  const directory = await open(parent, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export function live(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw new Error('GMVP_JOINT_PROCESS_OBSERVATION_FAILED');
  }
}
export async function waitFor(read, accept, { timeoutMs = 30000, signal } = {}) {
  const start = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - start) / 1e6 < timeoutMs) {
    signal?.throwIfAborted();
    const value = await read();
    if (accept(value)) return value;
    await delay(200, undefined, { signal });
  }
  throw new Error('GMVP_JOINT_OBSERVATION_TIMEOUT');
}
export async function freePort(selected = 0) {
  const server = createServer();
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(selected, '127.0.0.1', accept);
    });
    return server.address().port;
  } finally {
    if (server.listening) await new Promise((accept) => server.close(accept));
  }
}
export async function portState(port) {
  return new Promise((accept, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else accept(value);
    };
    socket.once('connect', () => finish(null, 'open'));
    socket.once('error', (error) =>
      error.code === 'ECONNREFUSED'
        ? finish(null, 'closed')
        : finish(new Error('GMVP_JOINT_PORT_OBSERVATION_UNKNOWN')),
    );
    socket.setTimeout(1500, () => finish(new Error('GMVP_JOINT_PORT_OBSERVATION_TIMEOUT')));
  });
}
export async function requestJson(url, { method = 'GET', body, headers = {}, ca, signal } = {}) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((accept, reject) => {
    const job = (url.startsWith('https:') ? httpsRequest : httpRequest)(
      url,
      {
        method,
        agent: false,
        ca,
        rejectUnauthorized: true,
        signal: signal
          ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(5000)])
          : globalThis.AbortSignal.timeout(5000),
        headers: {
          ...headers,
          ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}),
        },
      },
      (reply) => {
        const chunks = [];
        let size = 0;
        reply.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) reply.destroy(new Error('GMVP_JOINT_HTTP_LIMIT'));
          else chunks.push(chunk);
        });
        reply.once('error', reject);
        reply.once('end', () => {
          try {
            accept({
              status: reply.statusCode,
              headers: reply.headers,
              value: JSON.parse(Buffer.concat(chunks)),
            });
          } catch {
            reject(new Error('GMVP_JOINT_HTTP_INVALID'));
          }
        });
      },
    );
    job.once('error', reject);
    job.end(raw);
  });
}

/** Subprocess output stays private. Abort waits for actual exit before returning. */
export function commandRunner({ root, signal, event }) {
  const running = new Set();
  async function command(label, binary, args, options = {}) {
    const started = process.hrtime.bigint();
    const activeSignal = options.cleanup ? undefined : signal;
    activeSignal?.throwIfAborted();
    const child = spawn(binary, args, {
      cwd: root,
      env: options.env ?? {
        PATH: process.env.PATH,
        LANG: 'en_US.UTF-8',
        NODE_OPTIONS: '--max-old-space-size=512',
      },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry = { label, pid: null, exited: false };
    running.add(entry);
    let stdout = '',
      stderr = '',
      aborted = false,
      timedOut = false,
      exceeded = false,
      spawnFailed = false;
    let killTimer;
    const stop = () => {
      if (entry.exited) return;
      const kill = (name) => {
        try {
          if (process.platform === 'win32') child.kill(name);
          else if (child.pid) process.kill(-child.pid, name);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      };
      kill('SIGTERM');
      killTimer ??= setTimeout(() => {
        if (!entry.exited) kill('SIGKILL');
      }, 5000);
    };
    const cancel = () => {
      aborted = true;
      stop();
    };
    activeSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 60000);
    const collect = (name, chunk) => {
      if (exceeded) return;
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length >
        (options.maximumBytes ?? 4 * 1024 * 1024)
      ) {
        exceeded = true;
        stop();
        return;
      }
      if (name === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    const completion = new Promise((accept) => {
      child.once('error', () => {
        spawnFailed = true;
      });
      child.once('close', (code, endingSignal) => accept({ code, signal: endingSignal }));
    });
    const spawned = new Promise((accept) => {
      child.once('spawn', () => {
        entry.pid = child.pid;
        accept(true);
      });
      child.once('error', () => accept(false));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    let persistenceFailure;
    if (await spawned) {
      try {
        await options.onSpawn?.(child.pid);
      } catch (error) {
        persistenceFailure = error;
        stop();
      }
    }
    const result = await completion;
    entry.exited = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    activeSignal?.removeEventListener('abort', cancel);
    let groupClosed = true;
    if (entry.pid && process.platform !== 'win32') {
      const groupAlive = () => {
        try {
          process.kill(-entry.pid, 0);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      };
      if (groupAlive()) {
        // The leader has exited, but a descendant must not outlive an aborted
        // restore or a source start/stop command. This is our own fresh group.
        for (const name of ['SIGTERM', 'SIGKILL']) {
          try {
            process.kill(-entry.pid, name);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
          try {
            await waitFor(groupAlive, (value) => !value, { timeoutMs: 5000 });
            break;
          } catch {
            /* Try KILL, then leave this command unconfirmed if necessary. */
          }
        }
        groupClosed = !groupAlive();
      }
    }
    if (groupClosed) running.delete(entry);
    let evidenceFailure;
    try {
      await event('command', {
        label,
        pid: entry.pid,
        exitCode: result.code,
        signal: result.signal,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        aborted,
        timedOut,
        outputLimited: exceeded,
        processGroupClosed: groupClosed,
      });
    } catch (error) {
      if (!options.cleanup) evidenceFailure = error;
    }
    if (persistenceFailure || evidenceFailure || !groupClosed) {
      const error =
        persistenceFailure ??
        evidenceFailure ??
        new Error('GMVP_JOINT_COMMAND_GROUP_STILL_RUNNING');
      error.commandClosed = groupClosed;
      throw error;
    }
    if (result.code !== 0 || aborted || timedOut || exceeded || spawnFailed) {
      const error = new Error('GMVP_JOINT_COMMAND_FAILED');
      // Only callers performing exact missing-object checks inspect these in memory.
      error.privateStderr = stderr;
      error.privateStdout = stdout;
      error.exitCode = result.code;
      error.endingSignal = result.signal;
      error.wasInterrupted = aborted || timedOut || exceeded || spawnFailed;
      error.commandClosed = true;
      throw error;
    }
    return stdout.trim();
  }
  return {
    command,
    assertClosed: () => requireValue(running.size === 0, 'COMMAND_EXIT_UNCONFIRMED'),
  };
}

export function ownedRuntime({ root, directory, state, save, command, signal }) {
  const sample = () => state.target;
  async function locate(record, toleratePersistenceFailure = false) {
    if (!record) return null;
    requireValue(
      record.envFile.startsWith(directory + '/') &&
        ['tests/probes/s6-product-api.mjs', 'tests/probes/s6-product-worker.mjs'].includes(
          record.entry,
        ),
      'PROCESS_INTENT_INVALID',
    );
    const tail = `--env-file=${record.envFile} ${resolve(root, record.entry)}`;
    const rows = (
      await command('find-owned-target-process', 'ps', ['-axo', 'pid=,command='], {
        cleanup: true,
        timeoutMs: 5000,
      })
    )
      .split('\n')
      .filter((line) => line.trimEnd().endsWith(tail));
    requireValue(rows.length <= 1, 'OWNED_PROCESS_AMBIGUOUS');
    if (!rows.length) {
      requireValue(record.stoppedAt || !live(record.pid), 'SAVED_PROCESS_IDENTITY_CHANGED');
      return null;
    }
    const pid = Number(rows[0].trim().split(/\s+/u)[0]);
    const cwd = await command(
      'owned-process-cwd',
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { cleanup: true, timeoutMs: 5000 },
    );
    const start = await command('owned-process-start', 'ps', ['-p', String(pid), '-o', 'lstart='], {
      cleanup: true,
      timeoutMs: 5000,
    });
    requireValue(
      cwd.split('\n').includes(`n${root}`) &&
        (!record.pid || record.pid === pid) &&
        (!record.processStart || record.processStart === start),
      'OWNED_PROCESS_IDENTITY_CHANGED',
    );
    record.pid = pid;
    record.processStart = start;
    try {
      await save();
    } catch (error) {
      if (!toleratePersistenceFailure) throw error;
    }
    return pid;
  }
  async function inspect(kind, name, cleanup = false) {
    try {
      return JSON.parse(
        await command(
          'inspect-owned-' + kind,
          'docker',
          [kind, 'inspect', name, '--format', '{{json .}}'],
          { cleanup },
        ),
      );
    } catch (error) {
      const expected = [
        `Error response from daemon: No such ${kind}: ${name}`,
        `Error: No such ${kind}: ${name}`,
        `Error: No such object: ${name}`,
        `Error response from daemon: get ${name}: no such volume`,
      ];
      if (
        error.exitCode === 1 &&
        !error.wasInterrupted &&
        !error.endingSignal &&
        typeof error.privateStdout === 'string' &&
        ['', '[]'].includes(error.privateStdout.trim()) &&
        expected.some(
          (message) => message.toLowerCase() === error.privateStderr?.trim().toLowerCase(),
        )
      )
        return null;
      throw error;
    }
  }
  function assertOwned(value, kind) {
    const labels = kind === 'volume' ? value?.Labels : value?.Config?.Labels;
    requireValue(
      labels?.['ozz.joint.owner'] === owner && labels?.['ozz.joint.session'] === state.id,
      'REDIS_OWNERSHIP_CHANGED',
    );
    if (kind === 'container')
      requireValue(
        value.Name === '/' + sample().redisName &&
          (!sample().redisContainerId || value.Id === sample().redisContainerId) &&
          value.Config.User === 'redis:redis' &&
          value.Config.Image === sample().redisImage &&
          value.HostConfig.ReadonlyRootfs === true &&
          value.HostConfig.Memory === 128 * 1024 * 1024 &&
          value.HostConfig.NanoCpus === 250000000 &&
          value.HostConfig.CapDrop?.length === 1 &&
          value.HostConfig.CapDrop[0] === 'ALL' &&
          value.HostConfig.SecurityOpt?.includes('no-new-privileges:true') &&
          value.HostConfig.PortBindings?.['6379/tcp']?.length === 1 &&
          value.HostConfig.PortBindings['6379/tcp'][0].HostIp === '127.0.0.1' &&
          value.HostConfig.PortBindings['6379/tcp'][0].HostPort === String(sample().ports.redis) &&
          value.Mounts.filter((mount) => mount.Destination === '/data').length === 1 &&
          value.Mounts.some(
            (mount) =>
              mount.Type === 'volume' &&
              mount.Name === sample().volumeName &&
              mount.Destination === '/data' &&
              mount.RW,
          ),
        'REDIS_IDENTITY_OR_CONFIGURATION_CHANGED',
      );
  }
  async function startRedis() {
    const target = sample();
    const labels = [
      '--label',
      `ozz.joint.owner=${owner}`,
      '--label',
      `ozz.joint.session=${state.id}`,
    ];
    let volume = await inspect('volume', target.volumeName);
    if (!volume) {
      requireValue(!target.volumeCreated, 'OWNED_VOLUME_DISAPPEARED');
      target.volumeIntent = true;
      await save();
      await command('create-owned-redis-volume', 'docker', [
        'volume',
        'create',
        ...labels,
        target.volumeName,
      ]);
      volume = await inspect('volume', target.volumeName);
    }
    assertOwned(volume, 'volume');
    target.volumeCreated = true;
    await save();
    let container = await inspect('container', target.redisName);
    if (!container) {
      requireValue(!target.redisContainerId, 'OWNED_REDIS_DISAPPEARED');
      await freePort(target.ports.redis);
      const password = (await privateFile(target.passwordFile)).toString('utf8').trim();
      target.redisCreateIntent = true;
      await save();
      await command(
        'create-owned-redis',
        'docker',
        [
          'container',
          'create',
          '--pull=never',
          '--name',
          target.redisName,
          ...labels,
          '--memory=128m',
          '--cpus=0.25',
          '--read-only',
          '--user',
          'redis:redis',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges:true',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=16m',
          '--mount',
          `type=volume,src=${target.volumeName},dst=/data`,
          '--publish',
          `127.0.0.1:${target.ports.redis}:6379`,
          '--env',
          'REDIS_PASSWORD',
          '--env',
          'REDISCLI_AUTH',
          target.redisImage,
          'sh',
          '-c',
          'exec redis-server --appendonly yes --save "" --maxmemory 64mb --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD"',
        ],
        { env: { PATH: process.env.PATH, REDIS_PASSWORD: password, REDISCLI_AUTH: password } },
      );
      container = await inspect('container', target.redisName);
    }
    assertOwned(container, 'container');
    target.redisContainerId = container.Id;
    await save();
    if (!container.State.Running)
      await command('start-owned-redis', 'docker', ['container', 'start', container.Id]);
    await waitFor(
      async () => {
        const current = await inspect('container', target.redisName);
        assertOwned(current, 'container');
        requireValue(current.State.Running, 'OWNED_REDIS_EXITED');
        try {
          return (
            (await command(
              'owned-redis-ping',
              'docker',
              ['exec', container.Id, 'redis-cli', 'ping'],
              { timeoutMs: 3000 },
            )) === 'PONG'
          );
        } catch {
          return false;
        }
      },
      Boolean,
      { signal },
    );
  }
  async function startNodes(locked) {
    const target = sample(),
      envFile = locked ? target.envLocked : target.envWritable;
    for (const name of ['api', 'worker']) {
      requireValue(!(await locate(target.runtime[name])), 'TARGET_PROCESS_ALREADY_RUNNING');
      await freePort(target.ports[name]);
      const record = {
        entry: `tests/probes/s6-product-${name}.mjs`,
        envFile,
        intendedAt: new Date().toISOString(),
      };
      (target.runtimeHistory ??= []).push(target.runtime[name]);
      target.runtime[name] = record;
      await save();
      const log = await open(
        resolve(directory, `${name}-${randomUUID()}.private.log`),
        'wx',
        0o600,
      );
      try {
        const child = spawn(
          process.execPath,
          [`--env-file=${envFile}`, resolve(root, record.entry)],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              LANG: 'en_US.UTF-8',
              NODE_OPTIONS: '--max-old-space-size=512',
            },
            detached: true,
            stdio: ['ignore', log.fd, log.fd],
          },
        );
        await new Promise((accept, reject) => {
          child.once('spawn', accept);
          child.once('error', reject);
        });
        child.unref();
        record.pid = child.pid;
        await save();
        await locate(record);
      } finally {
        await log.close();
      }
    }
  }
  async function stopNodes() {
    const failures = [];
    for (const record of Object.values(sample()?.runtime ?? {})) {
      if (!record) continue;
      try {
        const pid = await locate(record, true);
        if (pid) {
          process.kill(pid, 'SIGTERM');
          try {
            await waitFor(
              () => live(pid),
              (value) => !value,
              { timeoutMs: 15000 },
            );
          } catch {
            if (await locate(record, true)) process.kill(pid, 'SIGKILL');
            await waitFor(
              () => live(pid),
              (value) => !value,
              { timeoutMs: 5000 },
            );
          }
        }
        record.stoppedAt = new Date().toISOString();
        await save();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }
  async function stopAll() {
    let failure;
    try {
      await stopNodes();
    } catch (error) {
      failure = error;
    }
    if (!sample()) return;
    try {
      const container = await inspect('container', sample().redisName, true);
      if (container) {
        assertOwned(container, 'container');
        if (container.State.Running)
          await command(
            'stop-owned-redis',
            'docker',
            ['container', 'stop', '--time', '10', container.Id],
            { cleanup: true, timeoutMs: 20000 },
          );
        const after = await inspect('container', sample().redisName, true);
        assertOwned(after, 'container');
        requireValue(!after.State.Running, 'OWNED_REDIS_STILL_RUNNING');
      }
      for (const port of Object.values(sample().ports))
        requireValue((await portState(port)) === 'closed', 'TARGET_PORT_STILL_OPEN');
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
  return { startRedis, startNodes, stopNodes, stopAll, locate };
}
