import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ArtifactDownloadError, downloadArtifact, verifyArtifact } from './download.mjs';

class LocalClusterError extends Error {}

const root = resolve(import.meta.dirname, '../..');
const source = import.meta.dirname;
const directory = resolve(root, '.local/local-lab/docker');
const cache = resolve(root, '.local/local-lab/cache');
const execute = promisify(execFile);
const locks = JSON.parse(await readFile(resolve(source, 'assets.lock.json'), 'utf8'));
const config = locks.docker;
const servers = {
  a: { container: 'ozz-local-api-a', port: 16443 },
  b: { container: 'ozz-local-api-b', port: 26443 },
};
const credential = (name) => resolve(directory, `${name}.kubeconfig.json`);
const composeArgs = [
  'compose',
  '--project-name',
  'ozz-local-api',
  '-f',
  resolve(source, 'compose.yaml'),
];

async function run(args, { timeout = 30000 } = {}) {
  try {
    return await execute('docker', args, { cwd: root, timeout, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    throw new LocalClusterError(
      'Docker command failed; no raw container logs or credentials were printed.',
    );
  }
}

async function protectedWrite(file, value) {
  await writeFile(file, value, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function exportCredential(name) {
  const response = await run([
    ...composeArgs,
    'exec',
    '-T',
    name,
    '/bin/k3s',
    'kubectl',
    'config',
    'view',
    '--raw',
    '-o',
    'json',
  ]);
  const data = JSON.parse(response.stdout);
  if (data.clusters?.length !== 1 || data.users?.length !== 1 || data.contexts?.length !== 1)
    throw new LocalClusterError('Unexpected exported local kubeconfig shape.');
  data.clusters[0].cluster.server = `https://127.0.0.1:${servers[name].port}`;
  await protectedWrite(credential(name), JSON.stringify(data, null, 2) + '\n');
}

async function request(name, path, method = 'GET', data) {
  const auth = JSON.parse(await readFile(credential(name), 'utf8'));
  const cluster = auth.clusters[0].cluster;
  const user = auth.users[0].user;
  const endpoint = `https://127.0.0.1:${servers[name].port}`;
  if (cluster.server !== endpoint || cluster['insecure-skip-tls-verify'])
    throw new LocalClusterError('The saved local TLS target changed.');
  const payload = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
  return new Promise((accept, reject) => {
    const req = https.request(
      new URL(path, endpoint),
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
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) req.destroy(new LocalClusterError('Response limit reached'));
          else chunks.push(chunk);
        });
        response.once('error', () =>
          reject(new LocalClusterError('Local API response interrupted')),
        );
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          accept({ status: response.statusCode, body });
        });
      },
    );
    req.once('error', () =>
      reject(new LocalClusterError('Local API connection/TLS validation failed')),
    );
    req.setTimeout(10000, () => req.destroy(new LocalClusterError('Request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function requireImage() {
  const image = JSON.parse((await run(['image', 'inspect', config.image])).stdout)[0];
  if (image.Architecture !== config.architecture || !image.RepoDigests.includes(config.image)) {
    throw new LocalClusterError('The local K3s image does not match the pinned ARM64 digest.');
  }
}

async function assertOwnedResources() {
  const existingContainers = new Set(
    (await run(['container', 'ls', '--all', '--format', '{{.Names}}'])).stdout.trim().split('\n'),
  );
  for (const value of Object.values(servers)) {
    if (!existingContainers.has(value.container)) continue;
    const labels = JSON.parse(
      (await run(['inspect', '--format', '{{json .Config.Labels}}', value.container])).stdout,
    );
    if (
      labels?.['dev.ozz.owner'] !== 'local-lab' ||
      labels?.['com.docker.compose.project'] !== 'ozz-local-api'
    ) {
      throw new LocalClusterError(
        'A matching container name belongs to another owner; no container was changed.',
      );
    }
  }
  for (const kind of ['volume', 'network']) {
    const names = (await run([kind, 'ls', '--format', '{{.Name}}'])).stdout
      .trim()
      .split('\n')
      .filter((name) => name.startsWith('ozz-local-api_'));
    for (const name of names) {
      const labels = JSON.parse(
        (await run([kind, 'inspect', '--format', '{{json .Labels}}', name])).stdout,
      );
      if (labels?.['dev.ozz.owner'] !== 'local-lab')
        throw new LocalClusterError(
          'A matching lab network or volume belongs to another owner; no resource was changed.',
        );
    }
  }
}

async function injectImages() {
  const archive = await verifyArtifact(config.images, cache);
  for (const name of Object.keys(servers)) {
    await run([
      ...composeArgs,
      'exec',
      '-T',
      name,
      'mkdir',
      '-p',
      '/var/lib/rancher/k3s/agent/images',
    ]);
    await run(
      [
        'cp',
        archive,
        `${servers[name].container}:/var/lib/rancher/k3s/agent/images/ozz-airgap-images.tar.zst`,
      ],
      { timeout: 120000 },
    );
    // K3s periodically imports archives in this watched directory. Credentials
    // and application data from other local projects are never reused.
  }
  console.log(JSON.stringify({ status: 'verified-airgap-images-copied', version: config.version }));
}

async function start() {
  await requireImage();
  await assertOwnedResources();
  // Sequential startup bounds peak CPU and makes failure ownership clear.
  for (const name of Object.keys(servers)) {
    console.log(JSON.stringify({ action: 'start-local-cluster', name, memoryMiB: 2048, cpus: 2 }));
    await run([...composeArgs, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '240', name], {
      timeout: 270000,
    });
    await exportCredential(name);
  }
  console.log(
    JSON.stringify({
      status: 'local-apis-started',
      endpoints: Object.values(servers).map(({ port }) => `https://127.0.0.1:${port}`),
      credentialFiles: Object.keys(servers).map(credential),
    }),
  );
}

async function inspect(name) {
  const version = await request(name, '/version');
  const namespace = await request(name, '/api/v1/namespaces/kube-system');
  const nodes = await request(name, '/api/v1/nodes');
  const pods = await request(name, '/api/v1/namespaces/kube-system/pods');
  const metrics = await request(name, '/apis/metrics.k8s.io/v1beta1/nodes');
  if ([version, namespace, nodes, pods].some((result) => result.status !== 200))
    throw new LocalClusterError(`Cluster ${name} API inspection failed.`);
  const node = nodes.body.items[0];
  const image = JSON.parse((await run(['inspect', servers[name].container])).stdout)[0];
  const aliases = Object.entries(image.NetworkSettings.Ports ?? {}).flatMap(([port, bindings]) =>
    (bindings ?? []).map((binding) => ({
      containerPort: port,
      hostIp: binding.HostIp,
      hostPort: binding.HostPort,
    })),
  );
  if (
    aliases.some(({ hostIp }) => hostIp !== '127.0.0.1') ||
    image.Mounts.some((mount) => mount.Type === 'bind')
  )
    throw new LocalClusterError('Unexpected host exposure in local cluster container.');
  const encryption = (
    await run([...composeArgs, 'exec', '-T', name, '/bin/k3s', 'secrets-encrypt', 'status'])
  ).stdout;
  const credentialData = JSON.parse(await readFile(credential(name), 'utf8'));
  return {
    name,
    apiEndpoint: `https://127.0.0.1:${servers[name].port}`,
    version: version.body.gitVersion,
    kubeSystemUid: namespace.body.metadata.uid,
    caSha256: createHash('sha256')
      .update(
        Buffer.from(credentialData.clusters[0].cluster['certificate-authority-data'], 'base64'),
      )
      .digest('hex'),
    node: {
      name: node?.metadata.name,
      uid: node?.metadata.uid,
      architecture: node?.status.nodeInfo.architecture,
      ready:
        node?.status.conditions.some((item) => item.type === 'Ready' && item.status === 'True') ??
        false,
    },
    pods: pods.body.items.map((pod) => ({
      name: pod.metadata.name,
      phase: pod.status.phase,
      ready:
        pod.status.conditions?.some((item) => item.type === 'Ready' && item.status === 'True') ??
        false,
      waitingReasons: (pod.status.containerStatuses ?? []).flatMap((status) =>
        status.state.waiting?.reason ? [status.state.waiting.reason] : [],
      ),
    })),
    metricsAvailable: metrics.status === 200 && (metrics.body.items?.length ?? 0) > 0,
    secretEncryptionEnabled: encryption.includes('Encryption Status: Enabled'),
    networkNames: Object.keys(image.NetworkSettings.Networks),
    publishedPorts: aliases,
    limits: { memoryBytes: image.HostConfig.Memory, nanoCpus: image.HostConfig.NanoCpus },
    dataVolumes: image.Mounts.filter((mount) => mount.Type === 'volume').map((mount) => ({
      name: mount.Name,
      destination: mount.Destination,
    })),
  };
}

async function verify() {
  for (const name of Object.keys(servers)) await exportCredential(name);
  const results = [];
  for (const name of Object.keys(servers)) results.push(await inspect(name));
  if (
    results.some(
      (result) =>
        result.version !== config.version || !result.node.ready || !result.secretEncryptionEnabled,
    )
  )
    throw new LocalClusterError(
      'The local node version/readiness or Secret encryption check failed.',
    );
  if (
    results[0].kubeSystemUid === results[1].kubeSystemUid ||
    results[0].node.uid === results[1].node.uid ||
    results[0].caSha256 === results[1].caSha256
  )
    throw new LocalClusterError('Independent cluster identity check failed.');
  if (
    results[0].node.name !== results[1].node.name ||
    results[0].networkNames.some((name) => results[1].networkNames.includes(name))
  )
    throw new LocalClusterError(
      'Same-name-node / network isolation fixture is not configured correctly.',
    );
  const testName = 'ozz-local-lab-isolation';
  for (const name of Object.keys(servers)) {
    const created = await request(name, '/api/v1/namespaces', 'POST', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: testName, labels: { 'app.kubernetes.io/managed-by': 'ozz-local-lab' } },
    });
    if (![201, 409].includes(created.status))
      throw new LocalClusterError('Could not prepare the local isolation namespace.');
    const item = await request(name, `/api/v1/namespaces/${testName}`);
    if (item.body.metadata.labels?.['app.kubernetes.io/managed-by'] !== 'ozz-local-lab')
      throw new LocalClusterError('Existing namespace is not owned by this local fixture.');
    results.find((result) => result.name === name).isolationNamespaceUid = item.body.metadata.uid;
  }
  if (results[0].isolationNamespaceUid === results[1].isolationNamespaceUid)
    throw new LocalClusterError('The same namespace resolved to both APIs.');
  const report = {
    verifiedAt: new Date().toISOString(),
    status: 'verified-independent-local-kubernetes-apis',
    scope:
      'Docker Desktop Linux ARM64 with separate K3s servers; SSH/systemd/VPS installation, cloud networking, public certificates and Oracle capacity remain unverified.',
    image: config.image,
    clusters: results,
  };
  await protectedWrite(
    resolve(directory, 'verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      status: report.status,
      reportFile: resolve(directory, 'verification.json'),
      clusterCount: results.length,
      systemPodsReady: results.every(
        (result) =>
          ['coredns-', 'metrics-server-', 'local-path-provisioner-', 'traefik-'].every((prefix) =>
            result.pods.some((pod) => pod.name.startsWith(prefix) && pod.ready),
          ) && result.pods.every((pod) => pod.ready || pod.phase === 'Succeeded'),
      ),
      metricsAvailable: results.every((result) => result.metricsAvailable),
    }),
  );
}

async function faultCheck() {
  await verify();
  await run([...composeArgs, 'stop', 'a'], { timeout: 90000 });
  let outageError;
  let ready = false;
  try {
    let refused = false;
    try {
      await request('a', '/readyz');
    } catch {
      refused = true;
    }
    if (!refused || (await request('b', '/readyz')).status !== 200)
      throw new LocalClusterError('One-cluster outage affected the independent API unexpectedly.');
  } catch (error) {
    outageError = error;
  } finally {
    await run([...composeArgs, 'start', 'a']);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        ready = (await request('a', '/readyz')).status === 200;
      } catch {
        /* scoped restart */
      }
      if (ready) break;
      await delay(1000);
    }
  }
  if (!ready) throw new LocalClusterError('Cluster A did not recover after the scoped stop/start.');
  if (outageError) throw outageError;
  const before = JSON.parse(await readFile(resolve(directory, 'verification.json'), 'utf8'));
  await verify();
  const after = JSON.parse(await readFile(resolve(directory, 'verification.json'), 'utf8'));
  if (
    before.clusters.some(
      (old) =>
        after.clusters.find((current) => current.name === old.name).kubeSystemUid !==
        old.kubeSystemUid,
    )
  )
    throw new LocalClusterError('Cluster identity changed across a preserved-volume restart.');
  after.faultCheck = {
    oneClusterOutageIsolated: true,
    restartPreservedClusterIdentity: true,
    checkedAt: new Date().toISOString(),
  };
  await protectedWrite(
    resolve(directory, 'verification.json'),
    JSON.stringify(after, null, 2) + '\n',
  );
  console.log(JSON.stringify({ status: 'one-cluster-outage-isolated-and-recovered' }));
}

async function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help') {
    console.log(
      'Usage: pnpm exec node infra/local-lab/clusters.mjs <start|verify|fault-check|status|stop|prepare-images|inject-images|paths>',
    );
    console.log(
      'Two actual K3s APIs in isolated Docker Desktop containers. Does not perform or claim VPS/SSH initialization.',
    );
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = resolve(directory, 'operation.lock');
  let lock;
  if (!['status', 'paths'].includes(command)) {
    try {
      lock = await open(lockFile, 'wx', 0o600);
    } catch {
      throw new LocalClusterError(
        'Another local cluster operation is running or left an interruption lock; inspect only this project lab.',
      );
    }
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }),
    );
  }
  try {
    if (command === 'start') await start();
    else if (command === 'verify') await verify();
    else if (command === 'fault-check') await faultCheck();
    else if (command === 'status') {
      const data = (await run([...composeArgs, 'ps', '--all', '--format', 'json'])).stdout.trim();
      console.log(data || '[]');
    } else if (command === 'stop') {
      await assertOwnedResources();
      await run([...composeArgs, 'stop'], { timeout: 120000 });
      console.log(JSON.stringify({ status: 'stopped', containersAndVolumesPreserved: true }));
    } else if (command === 'prepare-images') {
      await downloadArtifact(config.images, cache);
      console.log(
        JSON.stringify({
          status: 'airgap-verified',
          version: config.version,
          bytes: config.images.bytes,
        }),
      );
    } else if (command === 'inject-images') await injectImages();
    else if (command === 'paths')
      console.log(
        JSON.stringify({
          credentialFiles: Object.keys(servers).map(credential),
          composeFile: resolve(source, 'compose.yaml'),
          reportFile: resolve(directory, 'verification.json'),
        }),
      );
    else throw new LocalClusterError('Unknown local-cluster command.');
  } finally {
    await lock?.close();
    if (lock) await rm(lockFile);
  }
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      status: 'failed',
      message:
        error instanceof LocalClusterError || error instanceof ArtifactDownloadError
          ? error.message
          : 'Local cluster operation failed; inspect the protected project-local files and prerequisites.',
    }),
  );
  process.exitCode = 1;
});
