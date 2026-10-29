import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { verifyArtifact } from '../infra/local-lab/download.mjs';

// Dedicated source-Builder VM only. Never installs K3s, Docker, or the Builder,
// changes application VMs, mounts the Mac filesystem, or removes retained data.
const root = resolve(import.meta.dirname, '..');
const lab = resolve(root, '.local/local-lab');
const directory = resolve(lab, 'builder');
const limaHome = resolve(directory, 'lima');
const credentials = resolve(directory, 'credentials');
const assets = JSON.parse(
  await readFile(resolve(root, 'infra/local-lab/assets.lock.json'), 'utf8'),
);
const limactl = resolve(lab, `tools/lima-${assets.lima.version}/bin/limactl`);
const instance = 'ozz-build';
const owner = 'ozz-local-source-builder-v1';
const configFile = resolve(directory, 'builder.yaml');
const ownerFile = resolve(directory, 'owner.json');
const knownHostsFile = resolve(credentials, 'known_hosts');
const sshConfigFile = resolve(credentials, 'ssh_config');
const sshPort = 60422;
const builderPort = 49443;
const environment = { ...process.env, LIMA_HOME: limaHome, LIMA_SHELL: '/bin/bash' };
const execute = promisify(execFile);
const GiB = 1024 ** 3;
const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

function requireValue(value, code) {
  if (!value) throw new Error(code);
}

async function run(command, args, options = {}) {
  try {
    const task = execute(command, args, {
      cwd: root,
      env: environment,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      ...options,
    });
    if (options.input !== undefined) task.child.stdin.end(options.input);
    return await task;
  } catch (error) {
    if (options.logFile) {
      await writeFile(options.logFile, `${error.stdout ?? ''}\n${error.stderr ?? ''}`, {
        mode: 0o600,
        flag: 'wx',
      });
    }
    throw new Error('LOCAL_BUILDER_COMMAND_FAILED');
  }
}

function configuration() {
  return {
    minimumLimaVersion: '2.2.1',
    vmType: 'vz',
    arch: 'aarch64',
    os: 'Linux',
    images: [
      {
        location: resolve(lab, 'cache', assets.ubuntu.filename),
        arch: 'aarch64',
        digest: `sha256:${assets.ubuntu.sha256}`,
      },
    ],
    cpus: 2,
    memory: '2048MiB',
    disk: '12GiB',
    mounts: [],
    mountType: 'virtiofs',
    user: { name: 'ozz', uid: 1000, home: '/home/ozz', shell: '/bin/bash', passwordlessSudo: true },
    ssh: {
      localPort: sshPort,
      loadDotSSHPubKeys: false,
      forwardAgent: false,
      forwardX11: false,
      overVsock: false,
    },
    containerd: { system: false, user: false },
    upgradePackages: false,
    propagateProxyEnv: false,
    vmOpts: { vz: { rosetta: { enabled: false, binfmt: false } } },
    portForwards: [
      {
        guestIP: '0.0.0.0',
        guestPort: 9443,
        hostIP: '127.0.0.1',
        hostPort: builderPort,
        proto: 'tcp',
      },
      { guestPortRange: [1, 65535], ignore: true },
    ],
    provision: [
      {
        mode: 'system',
        script: [
          '#!/bin/sh',
          'set -eu',
          `if [ -f /etc/ozz-source-builder-instance ] && [ "$(cat /etc/ozz-source-builder-instance)" != '${instance}' ]; then exit 1; fi`,
          `printf '%s\\n' '${instance}' > /etc/ozz-source-builder-instance`,
          'chmod 0600 /etc/ozz-source-builder-instance',
          'mkdir -p /etc/cloud/cloud.cfg.d',
          "printf '%s\\n' 'ssh_deletekeys: false' > /etc/cloud/cloud.cfg.d/99-ozz-builder-ssh.cfg",
          'chmod 0644 /etc/cloud/cloud.cfg.d/99-ozz-builder-ssh.cfg',
          '',
        ].join('\n'),
      },
    ],
  };
}

async function writePrivate(path, contents) {
  await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
}

async function prepare() {
  requireValue(
    Buffer.byteLength(resolve(limaHome, instance, 'ssh.sock.1234567890123456')) < 104,
    'LOCAL_BUILDER_SOCKET_PATH_TOO_LONG',
  );
  requireValue(
    process.platform === 'darwin' && process.arch === 'arm64',
    'LOCAL_BUILDER_UNSUPPORTED_HOST',
  );
  for (const asset of [assets.lima, assets.ubuntu])
    await verifyArtifact(asset, resolve(lab, 'cache'));
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await mkdir(limaHome, { recursive: true, mode: 0o700 });
  const expected = `${JSON.stringify(configuration(), null, 2)}\n`;
  if (await exists(configFile)) {
    requireValue(
      (await readFile(configFile, 'utf8')) === expected,
      'LOCAL_BUILDER_CONFIGURATION_CHANGED',
    );
  } else await writePrivate(configFile, expected);
  await run(limactl, ['validate', configFile]);
  const recorded = {
    owner,
    instance,
    configSha256: createHash('sha256').update(expected).digest('hex'),
    cpus: 2,
    memoryBytes: 2 * GiB,
    logicalDiskBytes: 12 * GiB,
    mounts: [],
    sharedApplicationLimaHome: false,
  };
  if (await exists(ownerFile)) {
    requireValue(
      JSON.stringify(JSON.parse(await readFile(ownerFile, 'utf8'))) === JSON.stringify(recorded),
      'LOCAL_BUILDER_OWNER_CHANGED',
    );
  } else await writePrivate(ownerFile, `${JSON.stringify(recorded, null, 2)}\n`);
  return recorded;
}

async function list(home = limaHome) {
  if (!(await exists(home))) return [];
  const result = await run(limactl, ['list', '--json'], {
    env: { ...environment, LIMA_HOME: home },
  });
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function assertPortsFree() {
  for (const port of [sshPort, builderPort]) {
    const listener = createServer();
    try {
      await new Promise((accept, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', accept);
      });
    } catch {
      throw new Error('LOCAL_BUILDER_PORT_OCCUPIED');
    } finally {
      if (listener.listening) await new Promise((accept) => listener.close(accept));
    }
  }
}

async function bindTrust() {
  const value = (
    await run(limactl, [
      'shell',
      '--workdir',
      '/',
      instance,
      'sudo',
      'cat',
      '/etc/ssh/ssh_host_ed25519_key.pub',
    ])
  ).stdout
    .trim()
    .split(/\s+/u);
  requireValue(
    value[0] === 'ssh-ed25519' && /^[A-Za-z0-9+/]+=*$/u.test(value[1]),
    'LOCAL_BUILDER_HOST_KEY_INVALID',
  );
  const line = `${instance} ${value[0]} ${value[1]}\n`;
  if (await exists(knownHostsFile))
    requireValue(
      (await readFile(knownHostsFile, 'utf8')) === line,
      'LOCAL_BUILDER_HOST_KEY_CHANGED',
    );
  else await writePrivate(knownHostsFile, line);
  const identityFile = resolve(limaHome, '_config/user');
  requireValue(await exists(identityFile), 'LOCAL_BUILDER_IDENTITY_MISSING');
  await chmod(identityFile, 0o600);
  const contents = [
    `Host ${instance}`,
    '  HostName 127.0.0.1',
    `  Port ${sshPort}`,
    '  User ozz',
    `  HostKeyAlias ${instance}`,
    `  IdentityFile "${identityFile}"`,
    `  UserKnownHostsFile "${knownHostsFile}"`,
    '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking yes',
    '  IdentitiesOnly yes',
    '  PasswordAuthentication no',
    '  KbdInteractiveAuthentication no',
    '  BatchMode yes',
    '  ConnectTimeout 10',
    '  ServerAliveInterval 5',
    '  ServerAliveCountMax 3',
    '',
  ].join('\n');
  if (await exists(sshConfigFile))
    requireValue(
      (await readFile(sshConfigFile, 'utf8')) === contents,
      'LOCAL_BUILDER_SSH_CONFIGURATION_CHANGED',
    );
  else await writePrivate(sshConfigFile, contents);
  return `SHA256:${createHash('sha256').update(Buffer.from(value[1], 'base64')).digest('base64').replace(/=+$/u, '')}`;
}

async function inspect() {
  requireValue(await exists(sshConfigFile), 'LOCAL_BUILDER_NOT_PREPARED');
  const script = [
    'import json, os, platform, shutil',
    'from pathlib import Path',
    `assert Path('/etc/ozz-source-builder-instance').read_text().strip() == '${instance}'`,
    'release = dict(line.strip().split("=",1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)',
    'memory = dict((key, int(value.split()[0])*1024) for key,value in (line.split(":",1) for line in Path("/proc/meminfo").read_text().splitlines()))',
    'disk=shutil.disk_usage("/")',
    'print(json.dumps({"os":release["ID"].strip(chr(34)),"version":release["VERSION_ID"].strip(chr(34)),"architecture":platform.machine(),"memoryBytes":memory["MemTotal"],"diskBytes":disk.total,"diskFreeBytes":disk.free,"cpus":os.cpu_count(),"machineId":Path("/etc/machine-id").read_text().strip(),"k3sInstalled":bool(shutil.which("k3s")),"dockerInstalled":bool(shutil.which("docker")),"containerdInstalled":bool(shutil.which("containerd"))}))',
    '',
  ].join('\n');
  const value = JSON.parse(
    (await run('ssh', ['-F', sshConfigFile, instance, 'sudo', 'python3', '-'], { input: script }))
      .stdout,
  );
  requireValue(
    value.os === 'ubuntu' &&
      value.version === '24.04' &&
      value.architecture === 'aarch64' &&
      !value.k3sInstalled &&
      !value.dockerInstalled &&
      !value.containerdInstalled,
    'LOCAL_BUILDER_HOST_NOT_DEDICATED',
  );
  requireValue(value.diskFreeBytes >= 2 * GiB, 'LOCAL_BUILDER_GUEST_RESERVE_LOW');
  return value;
}

async function start() {
  const prepared = await prepare();
  const applicationVms = await list(resolve(lab, 'lima'));
  requireValue(
    applicationVms.find((item) => item.name === 'ozz-lab-c')?.status !== 'Running',
    'LOCAL_BUILDER_STOP_C_TO_RELEASE_MEMORY',
  );
  const candidates = await list();
  requireValue(
    candidates.every((item) => item.name === instance),
    'LOCAL_BUILDER_FOREIGN_INSTANCE',
  );
  const found = candidates.find((item) => item.name === instance);
  if (found)
    requireValue(
      found.cpus === 2 && found.memory === 2 * GiB && found.disk === 12 * GiB,
      'LOCAL_BUILDER_VM_CONFIGURATION_CHANGED',
    );
  const capacity = await statfs(root);
  const free = capacity.bavail * capacity.bsize;
  requireValue(free >= (found ? 10 : 14) * GiB, 'LOCAL_BUILDER_HOST_RESERVE_LOW');
  const runId = `start-${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
  if (found?.status !== 'Running') {
    await assertPortsFree();
    console.log(
      JSON.stringify({
        action: 'start-dedicated-builder-vm',
        cpus: 2,
        memoryMiB: 2048,
        hostFreeBytes: free,
      }),
    );
    await run(
      limactl,
      found
        ? ['start', '--tty=false', instance]
        : ['start', '--tty=false', `--name=${instance}`, configFile],
      {
        timeout: 480_000,
        logFile: resolve(directory, `${runId}.log`),
      },
    );
  }
  const fingerprint = await bindTrust();
  const guest = await inspect();
  const after = await statfs(root);
  const receipt = {
    ...prepared,
    action: 'started',
    timestamp: new Date().toISOString(),
    fingerprint,
    guest,
    hostFreeBytes: after.bavail * after.bsize,
    builderInstalledByThisCommand: false,
  };
  await writePrivate(resolve(directory, `${runId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  requireValue(receipt.hostFreeBytes >= 8 * GiB, 'LOCAL_BUILDER_HOST_RESERVE_LOW');
  return receipt;
}

const command = process.argv[2] ?? 'status';
let operationLock;
try {
  requireValue(
    ['prepare', 'start', 'stop', 'status', 'inspect', 'paths'].includes(command),
    'LOCAL_BUILDER_COMMAND_INVALID',
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (['prepare', 'start', 'stop'].includes(command)) {
    operationLock = await open(resolve(directory, 'operation.lock'), 'wx', 0o600);
    await operationLock.writeFile(JSON.stringify({ pid: process.pid, command }));
  }
  if (command === 'prepare')
    console.log(JSON.stringify({ status: 'prepared', ...(await prepare()) }));
  else if (command === 'start') console.log(JSON.stringify(await start()));
  else if (command === 'inspect') console.log(JSON.stringify(await inspect()));
  else if (command === 'paths')
    console.log(
      JSON.stringify({ directory, limaHome, configFile, ownerFile, sshConfigFile, knownHostsFile }),
    );
  else if (command === 'stop') {
    const recorded = JSON.parse(await readFile(ownerFile, 'utf8'));
    requireValue(
      recorded.owner === owner && recorded.instance === instance,
      'LOCAL_BUILDER_OWNER_CHANGED',
    );
    const found = (await list()).find((item) => item.name === instance);
    if (found?.status === 'Running') await run(limactl, ['stop', instance], { timeout: 120_000 });
    console.log(JSON.stringify({ status: 'stopped-and-retained', instance }));
  } else {
    const values = await list();
    const capacity = await statfs(root);
    console.log(
      JSON.stringify({
        instances: values.map(({ name, status, cpus, memory, disk }) => ({
          name,
          status,
          cpus,
          memory,
          disk,
        })),
        hostFreeBytes: capacity.bavail * capacity.bsize,
      }),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      code: /^LOCAL_BUILDER_[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : 'LOCAL_BUILDER_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  if (operationLock) {
    await operationLock.close();
    // This command removes only its own process lock, never a VM or retained file.
    const { unlink } = await import('node:fs/promises');
    await unlink(resolve(directory, 'operation.lock'));
  }
}
