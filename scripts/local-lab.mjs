import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify, parseArgs } from 'node:util';
import { downloadArtifact, verifyArtifact } from '../infra/local-lab/download.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, '.local/local-lab');
const cache = resolve(directory, 'cache');
const limaHome = resolve(directory, 'lima');
const credentials = resolve(directory, 'credentials');
const source = resolve(root, 'infra/local-lab');
const assets = JSON.parse(await readFile(resolve(source, 'assets.lock.json'), 'utf8'));
const toolDirectory = resolve(directory, `tools/lima-${assets.lima.version}`);
const limactl = resolve(toolDirectory, 'bin/limactl');
const execute = promisify(execFile);
const instances = {
  a: { name: 'ozz-lab-a', sshPort: 60122, apiPort: 16443, httpPort: 18080, httpsPort: 18443 },
  b: { name: 'ozz-lab-b', sshPort: 60222, apiPort: 26443, httpPort: 28080, httpsPort: 28443 },
  c: { name: 'ozz-lab-c', sshPort: 60322, apiPort: 36443, httpPort: 38080, httpsPort: 38443 },
};
const environment = { ...process.env, LIMA_HOME: limaHome, LIMA_SHELL: '/bin/bash' };

class LabError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new LabError(code, message);
}
function instance(key) {
  if (!Object.hasOwn(instances, key)) fail('INVALID_INSTANCE', 'Choose local lab a, b or c.');
  return instances[key];
}
const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );
const fileFor = (asset) => resolve(cache, asset.filename);
const configFile = (key) => resolve(directory, `${key}.yaml`);
const kubeFile = (key) => resolve(credentials, `${key}.kubeconfig.json`);
const knownHostsFile = resolve(credentials, 'known_hosts');
const sshConfigFile = resolve(credentials, 'ssh_config');

async function run(command, args, options = {}) {
  try {
    const execution = execute(command, args, {
      cwd: root,
      env: environment,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
    if (options.input !== undefined) execution.child.stdin.end(options.input);
    return await execution;
  } catch (error) {
    if (options.logFile) {
      await writeFile(options.logFile, `${error.stdout ?? ''}\n${error.stderr ?? ''}`, {
        mode: 0o600,
      });
    }
    // Child stderr can contain guest diagnostics; never echo kubeconfig,
    // private keys, raw command input or generic error objects to the terminal.
    fail(
      'COMMAND_FAILED',
      `${options.label ?? command.split('/').at(-1)} failed (${error.code ?? error.signal ?? 'unknown'}).${options.logFile ? ` Protected log: ${options.logFile}` : ''}`,
    );
  }
}

async function writeProtected(file, content) {
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function verifyAsset(asset) {
  try {
    return await verifyArtifact(asset, cache);
  } catch {
    fail('ASSET_NOT_PREPARED', `Prepare and verify the pinned ${asset.filename} first.`);
  }
}

async function download(asset) {
  try {
    return await downloadArtifact(asset, cache);
  } catch {
    fail(
      'DOWNLOAD_FAILED',
      `Official download or checksum failed for ${asset.filename}; downloaded chunks remain in the project cache for retry.`,
    );
  }
}

async function hostCheck() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('UNSUPPORTED_HOST', 'This pinned local lab currently supports macOS ARM64 only.');
  }
  const version = (await run('sw_vers', ['-productVersion'])).stdout.trim();
  if (Number(version.split('.')[0]) < 14)
    fail('UNSUPPORTED_MACOS', 'macOS 14 or newer is required by this lab configuration.');
  if ((await run('sysctl', ['-n', 'kern.hv_support'])).stdout.trim() !== '1') {
    fail('VIRTUALIZATION_UNAVAILABLE', 'Hardware virtualization is unavailable.');
  }
  return { platform: process.platform, architecture: process.arch, macOS: version };
}

function configuration(key) {
  const value = instance(key);
  return {
    minimumLimaVersion: '2.2.1',
    vmType: 'vz',
    arch: 'aarch64',
    os: 'Linux',
    images: [
      {
        location: fileFor(assets.ubuntu),
        arch: 'aarch64',
        digest: `sha256:${assets.ubuntu.sha256}`,
      },
    ],
    cpus: 2,
    memory: '2304MiB',
    disk: '20GiB',
    mounts: [],
    mountType: 'virtiofs',
    user: { name: 'ozz', uid: 1000, home: '/home/ozz', shell: '/bin/bash', passwordlessSudo: true },
    ssh: {
      localPort: value.sshPort,
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
      ...[
        [6443, value.apiPort],
        [80, value.httpPort],
        [443, value.httpsPort],
      ].map(([guestPort, hostPort]) => ({
        guestIP: '0.0.0.0',
        guestPort,
        hostIP: '127.0.0.1',
        hostPort,
        proto: 'tcp',
      })),
      { guestPortRange: [1, 65535], ignore: true },
    ],
    provision: [
      {
        mode: 'system',
        // Lima refreshes the NoCloud instance-id on restart. Preserve this
        // guest's generated SSH host keys when cloud-init reruns its SSH module.
        script: [
          '#!/bin/sh',
          'set -eu',
          `if [ -f /etc/ozz-local-lab-instance ] && [ "$(cat /etc/ozz-local-lab-instance)" != '${value.name}' ]; then exit 1; fi`,
          `printf '%s\\n' '${value.name}' > /etc/ozz-local-lab-instance`,
          'chmod 0600 /etc/ozz-local-lab-instance',
          'mkdir -p /etc/cloud/cloud.cfg.d',
          "printf '%s\\n' '# Ozz local lab: preserve SSH trust across Lima restarts.' 'ssh_deletekeys: false' > /etc/cloud/cloud.cfg.d/99-ozz-local-lab-ssh.cfg",
          'chmod 0644 /etc/cloud/cloud.cfg.d/99-ozz-local-lab-ssh.cfg',
          '',
        ].join('\n'),
      },
    ],
  };
}

async function prepare(toolsOnly) {
  await hostCheck();
  const archive = await download(assets.lima);
  if (!(await exists(limactl))) {
    const entries = (await run('tar', ['-tzf', archive])).stdout.split('\n').filter(Boolean);
    if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..')))
      fail('UNSAFE_ARCHIVE', 'The tool archive has an unexpected path.');
    await mkdir(toolDirectory, { recursive: true, mode: 0o700 });
    await run('tar', ['-xzf', archive, '-C', toolDirectory]);
  }
  const version = (await run(limactl, ['--version'])).stdout.trim();
  if (!version.includes(assets.lima.version))
    fail('TOOL_VERSION_MISMATCH', 'Unexpected project-local Lima version.');
  if (!toolsOnly) {
    for (const asset of [assets.ubuntu, assets.k3s.binary, assets.k3s.images])
      await download(asset);
  }
  for (const key of Object.keys(instances)) {
    await writeProtected(configFile(key), JSON.stringify(configuration(key), null, 2) + '\n');
    await run(limactl, ['validate', configFile(key)]);
  }
  console.log(
    JSON.stringify({
      status: 'prepared',
      toolsOnly,
      lima: version,
      directory,
      vmMemoryMiB: 2304,
      vmCount: 3,
    }),
  );
}

async function list() {
  if (!(await exists(limactl))) return [];
  const output = (await run(limactl, ['list', '--json'])).stdout.trim();
  return output
    ? output
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

async function assertAvailable(port) {
  const socket = createServer();
  try {
    await new Promise((accept, reject) => {
      socket.once('error', reject);
      socket.listen(port, '127.0.0.1', accept);
    });
  } catch {
    fail('PORT_IN_USE', `Loopback port ${port} is in use; no other process was stopped.`);
  } finally {
    await new Promise((accept) => socket.close(accept));
  }
}

async function bindSshTrust(key) {
  const value = instance(key);
  // This public host key comes from our freshly booted VZ guest over Lima's
  // bootstrap channel, not from unauthenticated network ssh-keyscan output.
  const publicKey = (
    await run(
      limactl,
      ['shell', '--workdir', '/', value.name, 'sudo', 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'],
      { label: 'Guest host-key inspection' },
    )
  ).stdout.trim();
  const fields = publicKey.split(/\s+/);
  if (fields[0] !== 'ssh-ed25519' || !/^[A-Za-z0-9+/]+=*$/.test(fields[1] ?? ''))
    fail('INVALID_HOST_KEY', 'Guest returned an invalid public SSH host key.');
  const entry = `${value.name} ${fields[0]} ${fields[1]}`;
  let existing = (await exists(knownHostsFile))
    ? (await readFile(knownHostsFile, 'utf8')).trim().split('\n').filter(Boolean)
    : [];
  const previous = existing.find((line) => line.startsWith(value.name + ' '));
  if (previous && previous !== entry)
    fail(
      'SSH_HOST_KEY_CHANGED',
      'The saved lab SSH host key changed; trust was not replaced automatically.',
    );
  if (!previous) existing = [...existing, entry];
  await writeProtected(knownHostsFile, existing.join('\n') + '\n');
  const privateKey = resolve(limaHome, '_config/user');
  if (!(await exists(privateKey)))
    fail('SSH_IDENTITY_MISSING', 'Project-local Lima SSH identity is missing.');
  await chmod(privateKey, 0o600);
  const lines = Object.values(instances).flatMap((item) => [
    `Host ${item.name}`,
    '  HostName 127.0.0.1',
    `  Port ${item.sshPort}`,
    '  User ozz',
    `  HostKeyAlias ${item.name}`,
    `  IdentityFile ${JSON.stringify(privateKey)}`,
    `  UserKnownHostsFile ${JSON.stringify(knownHostsFile)}`,
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
  ]);
  await writeProtected(sshConfigFile, lines.join('\n'));
  return (
    'SHA256:' +
    createHash('sha256')
      .update(Buffer.from(fields[1], 'base64'))
      .digest('base64')
      .replace(/=+$/, '')
  );
}

async function ssh(key, args, options = {}) {
  return run('ssh', ['-F', sshConfigFile, instance(key).name, ...args], {
    label: 'Pinned-host SSH command',
    ...options,
  });
}

async function start(key) {
  const value = instance(key);
  await hostCheck();
  if (key === 'c') {
    const builderHome = resolve(directory, 'builder/lima');
    if (await exists(builderHome)) {
      const builders = (
        await run(limactl, ['list', '--json'], {
          env: { ...environment, LIMA_HOME: builderHome },
        })
      ).stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (builders.some((item) => item.status === 'Running'))
        fail(
          'BUILDER_USES_MEMORY_SLOT',
          'Stop the dedicated source Builder before starting C; all VM disks remain preserved.',
        );
    }
  }
  await verifyAsset(assets.lima);
  await verifyAsset(assets.ubuntu);
  if (!(await exists(configFile(key)))) {
    await writeProtected(configFile(key), JSON.stringify(configuration(key), null, 2) + '\n');
    await run(limactl, ['validate', configFile(key)]);
  }
  const found = (await list()).find((item) => item.name === value.name);
  if (found?.status !== 'Running') {
    for (const port of [value.sshPort, value.apiPort, value.httpPort, value.httpsPort])
      await assertAvailable(port);
    const args = found
      ? ['start', '--tty=false', value.name]
      : ['start', '--tty=false', `--name=${value.name}`, configFile(key)];
    console.log(
      JSON.stringify({ action: 'start-vm', instance: value.name, memoryMiB: 2304, cpus: 2 }),
    );
    await run(limactl, args, {
      timeout: 600000,
      logFile: resolve(directory, `${key}.start.log`),
      label: 'Local VZ VM startup',
    });
  }
  const fingerprint = await bindSshTrust(key);
  console.log(
    JSON.stringify({
      status: 'running',
      instance: value.name,
      sshHost: '127.0.0.1',
      sshPort: value.sshPort,
      sshFingerprint: fingerprint,
    }),
  );
}

async function inspectGuest(key) {
  const script = await readFile(resolve(source, 'preflight.py'), 'utf8');
  const result = JSON.parse((await ssh(key, ['python3', '-'], { input: script })).stdout);
  if (
    result.os !== 'ubuntu' ||
    result.version !== assets.ubuntu.version ||
    result.architecture !== 'aarch64' ||
    result.init !== 'systemd' ||
    !result.labOwned
  ) {
    fail('UNEXPECTED_GUEST', 'The local guest identity/OS does not match this lab.');
  }
  return result;
}

async function install(key) {
  if (key === 'c')
    fail(
      'PRODUCT_INSTALL_REQUIRED',
      'VM C is reserved for initialization through the product SSH Adapter.',
    );
  const value = instance(key);
  await inspectGuest(key);
  const binary = await verifyAsset(assets.k3s.binary);
  const images = await verifyAsset(assets.k3s.images);
  const remote = '/home/ozz/ozz-lab-assets';
  await ssh(key, ['mkdir', '-p', remote]);
  for (const [file, name] of [
    [binary, 'k3s'],
    [images, 'images.tar.zst'],
    [resolve(source, 'install-k3s.sh'), 'install-k3s.sh'],
  ]) {
    await run('scp', ['-q', '-F', sshConfigFile, file, `${value.name}:${remote}/${name}`], {
      timeout: 180000,
      label: 'Copy verified K3s bootstrap asset',
    });
  }
  console.log(
    JSON.stringify({ action: 'install-k3s', instance: value.name, version: assets.k3s.version }),
  );
  await ssh(
    key,
    [
      'sudo',
      'sh',
      `${remote}/install-k3s.sh`,
      value.name,
      assets.k3s.version,
      assets.k3s.binary.sha256,
      assets.k3s.images.sha256,
    ],
    {
      timeout: 600000,
      logFile: resolve(directory, `${key}.install.log`),
      label: 'Local K3s bootstrap',
    },
  );
  await exportCredential(key);
  console.log(
    JSON.stringify({
      status: 'k3s-installed',
      instance: value.name,
      kubeconfigFile: kubeFile(key),
    }),
  );
}

async function cacheBootstrapAssets(key) {
  if (key !== 'c')
    fail('PRODUCT_CACHE_RESERVED', 'The product bootstrap cache is reserved for clean VM C.');
  const value = instance(key);
  const inspection = await inspectGuest(key);
  if (inspection.k3sInstalled)
    fail(
      'PRODUCT_ALREADY_INSTALLED',
      'VM C already has K3s; cache preparation will not change it.',
    );
  const remote = '/home/ozz/ozz-product-assets';
  await ssh(key, ['mkdir', '-p', remote]);
  for (const asset of [assets.k3s.binary, assets.k3s.images]) {
    if (
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0
    )
      fail('INVALID_ASSET_LOCK', 'The fixed product bootstrap asset identity is invalid.');
    const file = await verifyAsset(asset);
    await run('scp', ['-q', '-F', sshConfigFile, file, `${value.name}:${remote}/${asset.sha256}`], {
      timeout: 180000,
      label: 'Copy pinned product bootstrap cache',
    });
    const encoded = Buffer.from(
      JSON.stringify({ sha256: asset.sha256, bytes: asset.bytes }),
    ).toString('base64');
    const script =
      `import base64,hashlib,json,os,shutil,stat,uuid\nasset=json.loads(base64.b64decode('${encoded}'))\n` +
      String.raw`
assert os.geteuid() == 0
with open('/etc/ozz-local-lab-instance', encoding='utf-8') as handle:
    assert handle.read().strip() == 'ozz-lab-c'
assert not any(os.path.lexists(path) for path in ('/usr/local/bin/k3s', '/etc/rancher/k3s', '/var/lib/rancher/k3s'))
for path in ('/var', '/var/cache', '/var/cache/ozz', '/var/cache/ozz/k3s'):
    if not os.path.lexists(path):
        os.mkdir(path, 0o700)
    metadata = os.lstat(path)
    assert stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0 and not metadata.st_mode & 0o022
source = '/home/ozz/ozz-product-assets/' + asset['sha256']
target = '/var/cache/ozz/k3s/' + asset['sha256']
def verify(path, root_owned=False):
    metadata = os.lstat(path)
    assert stat.S_ISREG(metadata.st_mode) and metadata.st_size == asset['bytes']
    if root_owned:
        assert metadata.st_uid == 0 and stat.S_IMODE(metadata.st_mode) == 0o600
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    assert digest.hexdigest() == asset['sha256']
verify(source)
if not os.path.lexists(target):
    temporary = target + '.copy-' + uuid.uuid4().hex
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as writer, open(source, 'rb') as reader:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        verify(temporary, True)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
verify(target, True)
os.unlink(source)
print(json.dumps({'cached': True, 'verified': True, 'installed': False}))
`;
    await ssh(key, ['sudo', 'python3', '-'], {
      input: script,
      label: 'Verify protected product asset cache',
    });
  }
  console.log(
    JSON.stringify({
      status: 'product-assets-cached',
      instance: value.name,
      installed: false,
      sha256Verified: true,
      rootOwned: true,
      fileMode: '0600',
    }),
  );
}

async function exportCredential(key) {
  const value = instance(key);
  const result = await ssh(key, [
    'sudo',
    '/usr/local/bin/k3s',
    'kubectl',
    'config',
    'view',
    '--raw',
    '-o',
    'json',
  ]);
  const config = JSON.parse(result.stdout);
  if (config.clusters?.length !== 1 || config.users?.length !== 1 || config.contexts?.length !== 1)
    fail('UNEXPECTED_KUBECONFIG', 'The guest returned an unexpected kubeconfig shape.');
  config.clusters[0].cluster.server = `https://127.0.0.1:${value.apiPort}`;
  await writeProtected(kubeFile(key), JSON.stringify(config, null, 2) + '\n');
}

async function request(key, path, method = 'GET', body) {
  const config = JSON.parse(await readFile(kubeFile(key), 'utf8'));
  const cluster = config.clusters[0].cluster;
  const user = config.users[0].user;
  const expected = `https://127.0.0.1:${instance(key).apiPort}`;
  if (cluster.server !== expected || cluster['insecure-skip-tls-verify'])
    fail('INVALID_API_TARGET', 'The local kubeconfig target or TLS settings changed.');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((accept, reject) => {
    const req = https.request(
      new URL(path, expected),
      {
        method,
        ca: Buffer.from(cluster['certificate-authority-data'], 'base64'),
        cert: Buffer.from(user['client-certificate-data'], 'base64'),
        key: Buffer.from(user['client-key-data'], 'base64'),
        rejectUnauthorized: true,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
          : {},
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) req.destroy(new Error('bounded response exceeded'));
          else chunks.push(chunk);
        });
        response.once('error', () =>
          reject(new LabError('API_READ_FAILED', 'Local cluster response was interrupted.')),
        );
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            accept({ status: response.statusCode, data: JSON.parse(text) });
          } catch {
            accept({ status: response.statusCode, data: text });
          }
        });
      },
    );
    req.once('error', () =>
      reject(
        new LabError('API_REQUEST_FAILED', 'Local cluster connection or TLS verification failed.'),
      ),
    );
    req.setTimeout(15000, () => req.destroy(new Error('bounded timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function verify() {
  const results = [];
  for (const key of ['a', 'b']) {
    const machine = await inspectGuest(key);
    const ready = await request(key, '/readyz');
    if (ready.status !== 200 || ready.data !== 'ok')
      fail('API_NOT_READY', `Cluster ${key} is not ready.`);
    const version = await request(key, '/version');
    const nodes = await request(key, '/api/v1/nodes');
    const namespace = await request(key, '/api/v1/namespaces/kube-system');
    const pods = await request(key, '/api/v1/namespaces/kube-system/pods');
    if ([version, nodes, namespace, pods].some((result) => result.status !== 200))
      fail('API_INSPECTION_FAILED', `Cluster ${key} inspection failed.`);
    if (
      version.data.gitVersion !== assets.k3s.version ||
      nodes.data.items.length !== 1 ||
      !nodes.data.items[0].status.conditions.some(
        (item) => item.type === 'Ready' && item.status === 'True',
      )
    ) {
      fail('UNEXPECTED_CLUSTER', `Cluster ${key} version or node readiness is unexpected.`);
    }
    const encryption = await ssh(key, ['sudo', '/usr/local/bin/k3s', 'secrets-encrypt', 'status']);
    if (!encryption.stdout.includes('Encryption Status: Enabled'))
      fail('ENCRYPTION_NOT_ENABLED', `Cluster ${key} has not enabled Secret encryption.`);
    const metrics = await request(key, '/apis/metrics.k8s.io/v1beta1/nodes');
    const node = nodes.data.items[0];
    const credentialData = JSON.parse(await readFile(kubeFile(key), 'utf8'));
    const testName = 'ozz-local-lab-isolation';
    const created = await request(key, '/api/v1/namespaces', 'POST', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: testName, labels: { 'app.kubernetes.io/managed-by': 'ozz-local-lab' } },
    });
    if (![201, 409].includes(created.status))
      fail('ISOLATION_FIXTURE_FAILED', `Could not prepare the cluster ${key} isolation namespace.`);
    const isolated = await request(key, `/api/v1/namespaces/${testName}`);
    if (
      isolated.status !== 200 ||
      isolated.data.metadata.labels?.['app.kubernetes.io/managed-by'] !== 'ozz-local-lab'
    )
      fail('ISOLATION_FIXTURE_NOT_OWNED', 'The isolation namespace belongs to another owner.');
    results.push({
      instance: instance(key).name,
      apiEndpoint: `https://127.0.0.1:${instance(key).apiPort}`,
      version: version.data.gitVersion,
      kubeSystemUid: namespace.data.metadata.uid,
      isolationNamespaceUid: isolated.data.metadata.uid,
      caSha256: createHash('sha256')
        .update(
          Buffer.from(credentialData.clusters[0].cluster['certificate-authority-data'], 'base64'),
        )
        .digest('hex'),
      node: {
        name: node.metadata.name,
        uid: node.metadata.uid,
        architecture: node.status.nodeInfo.architecture,
        ready: true,
      },
      pods: pods.data.items.map((pod) => ({
        name: pod.metadata.name,
        phase: pod.status.phase,
        ready:
          pod.status.conditions?.some((item) => item.type === 'Ready' && item.status === 'True') ??
          false,
        waitingReasons: (pod.status.containerStatuses ?? []).flatMap((status) =>
          status.state.waiting?.reason ? [status.state.waiting.reason] : [],
        ),
      })),
      secretEncryptionEnabled: true,
      metricsAvailable: metrics.status === 200 && (metrics.data.items?.length ?? 0) > 0,
      machine,
    });
  }
  if (
    results[0].kubeSystemUid === results[1].kubeSystemUid ||
    results[0].node.uid === results[1].node.uid ||
    results[0].caSha256 === results[1].caSha256 ||
    results[0].isolationNamespaceUid === results[1].isolationNamespaceUid
  ) {
    fail('CLUSTER_IDENTITY_COLLISION', 'A and B resolved to the same cluster or node identity.');
  }
  if (results[0].node.name !== results[1].node.name)
    fail('NODE_NAME_FIXTURE_CHANGED', 'The intentional same-name node fixture changed.');
  const report = {
    verifiedAt: new Date().toISOString(),
    host: await hostCheck(),
    status: 'verified-local-api-and-ssh',
    scope:
      'Two actual local Linux VMs and independent K3s APIs; no claim of product S2, public ingress, DNS/ACME, cloud firewall or Oracle capacity acceptance.',
    clusters: results,
  };
  const reportFile = resolve(directory, 'verification.json');
  await writeProtected(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: report.status,
      reportFile,
      systemPodsReady: results.every(
        (result) =>
          ['coredns-', 'metrics-server-', 'local-path-provisioner-', 'traefik-'].every((prefix) =>
            result.pods.some((pod) => pod.name.startsWith(prefix) && pod.ready),
          ) && result.pods.every((pod) => pod.ready || pod.phase === 'Succeeded'),
      ),
      clusters: results.map(({ instance, version, node, metricsAvailable }) => ({
        instance,
        version,
        node,
        metricsAvailable,
      })),
    }),
  );
}

async function faultCheck() {
  await verify();
  const reportFile = resolve(directory, 'verification.json');
  const before = JSON.parse(await readFile(reportFile, 'utf8'));
  await stop(['a']);
  let outageError;
  let recovered = false;
  try {
    let refused = false;
    try {
      await request('a', '/readyz');
    } catch {
      refused = true;
    }
    if (!refused || (await request('b', '/readyz')).status !== 200)
      fail('OUTAGE_NOT_ISOLATED', 'Stopping local VM A unexpectedly affected the independent API.');
  } catch (error) {
    outageError = error;
  } finally {
    await start('a');
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try {
        const ready = await request('a', '/readyz');
        const nodes = await request('a', '/api/v1/nodes');
        recovered =
          ready.status === 200 &&
          nodes.status === 200 &&
          nodes.data.items.some((node) =>
            node.status.conditions.some((item) => item.type === 'Ready' && item.status === 'True'),
          );
      } catch {
        // A preserved VM may need time to restart K3s and restore port forwards.
      }
      if (recovered) break;
      await delay(1000);
    }
  }
  if (!recovered) fail('VM_DID_NOT_RECOVER', 'Local VM A did not restore its ready API in time.');
  if (outageError) throw outageError;
  await verify();
  const after = JSON.parse(await readFile(reportFile, 'utf8'));
  if (
    before.clusters.some((old) => {
      const current = after.clusters.find((item) => item.instance === old.instance);
      return (
        current.kubeSystemUid !== old.kubeSystemUid ||
        current.node.uid !== old.node.uid ||
        current.isolationNamespaceUid !== old.isolationNamespaceUid ||
        current.caSha256 !== old.caSha256
      );
    })
  )
    fail('RESTART_IDENTITY_CHANGED', 'A preserved local VM restart changed its cluster identity.');
  after.faultCheck = {
    oneVmOutageIsolated: true,
    restartPreservedClusterIdentity: true,
    restartedVmSshTrustPreserved: true,
    checkedAt: new Date().toISOString(),
  };
  await writeProtected(reportFile, JSON.stringify(after, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'one-vm-outage-isolated-and-recovered', reportFile }));
}

async function stop(keys) {
  const found = await list();
  for (const key of keys) {
    const value = instance(key);
    const current = found.find((item) => item.name === value.name);
    if (current?.status === 'Running')
      await run(limactl, ['stop', value.name], {
        timeout: 120000,
        label: 'Graceful local VM stop',
      });
    console.log(
      JSON.stringify({
        instance: value.name,
        status: 'stopped-or-not-created',
        disksPreserved: true,
      }),
    );
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean' }, 'tools-only': { type: 'boolean' } },
  });
  const [command, key] = positionals;
  if (values.help || !command) {
    console.log(
      'Usage: pnpm exec node scripts/local-lab.mjs <prepare [--tools-only]|start a|start b|start c|preflight a|install a|install b|cache-assets c|export a|verify|fault-check|status|stop a|stop b|stop c|stop all|paths>',
    );
    console.log(
      'Project-local macOS ARM64 Lima VZ lab. Each VM: 2 CPU, 2304 MiB RAM, 20 GiB sparse disk. No host home mounts or global configuration changes.',
    );
    return;
  }
  for (const path of [directory, cache, limaHome, credentials])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const lockFile = resolve(directory, 'operation.lock');
  let lock;
  if (!['status', 'paths', 'preflight'].includes(command)) {
    try {
      lock = await open(lockFile, 'wx', 0o600);
    } catch {
      fail(
        'LAB_BUSY',
        'A lab operation is already running or its lock remains after interruption. Check only this project lab before clearing operation.lock.',
      );
    }
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }),
    );
  }
  try {
    if (command === 'prepare') await prepare(values['tools-only'] ?? false);
    else if (command === 'start') await start(key);
    else if (command === 'install') await install(key);
    else if (command === 'cache-assets') await cacheBootstrapAssets(key);
    else if (command === 'preflight') console.log(JSON.stringify(await inspectGuest(key)));
    else if (command === 'export') {
      await exportCredential(key);
      console.log(JSON.stringify({ kubeconfigFile: kubeFile(key) }));
    } else if (command === 'verify') await verify();
    else if (command === 'fault-check') await faultCheck();
    else if (command === 'stop') await stop(key === 'all' ? Object.keys(instances) : [key]);
    else if (command === 'status')
      console.log(
        JSON.stringify(
          (await list()).map(({ name, status, cpus, memory, disk, sshLocalPort }) => ({
            name,
            status,
            cpus,
            memory,
            disk,
            sshLocalPort,
          })),
          null,
          2,
        ),
      );
    else if (command === 'paths')
      console.log(
        JSON.stringify(
          {
            limaHome,
            sshConfigFile,
            sshIdentityFile: resolve(limaHome, '_config/user'),
            knownHostsFile,
            kubeconfigs: Object.keys(instances).map(kubeFile),
          },
          null,
          2,
        ),
      );
    else fail('INVALID_COMMAND', 'Unknown command; use --help.');
  } finally {
    await lock?.close();
    if (lock) await rm(lockFile);
  }
}

// Keep a single controlled entrypoint; never log arbitrary exception objects.
void main().catch((error) => {
  console.error(
    JSON.stringify({
      code: error instanceof LabError ? error.code : 'LOCAL_LAB_FAILED',
      message:
        error instanceof LabError
          ? error.message
          : 'Local lab operation failed. Inspect the protected project-local files and prerequisites.',
    }),
  );
  process.exitCode = 1;
});
