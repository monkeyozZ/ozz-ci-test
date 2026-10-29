import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureRegistryRelease } from './private-registry-assets.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/local-lab/private-registry-b');
const lab = resolve(directory, '..');
const cache = resolve(lab, 'cache/registry-3.1.2');
const sshConfig = resolve(lab, 'credentials/ssh_config');
const credentialsFile = resolve(lab, 'credentials/registry-b.json');
const rotatedCredentialsFile = resolve(lab, 'credentials/registry-b-rotated.json');
const remote = '/var/lib/ozz-local-lab/b/registry-3.1.2';
const registry = '127.0.0.1:50443';
const owner = 'ozz-local-private-registry-b-v1';
const socket = resolve(directory, 'tunnel.sock');
let phase = 'verify-release';

function run(command, args, input) {
  return execFileSync(command, args, {
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
    timeout: 60_000,
  });
}
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function remotePython(code, input) {
  return run('ssh', ['-F', sshConfig, 'ozz-lab-b', `sudo python3 -c ${quote(code)}`], input);
}
function save(path, value, mode = 0o600) {
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
}
function request(ca) {
  return new Promise((resolveResult, reject) => {
    const request = https.get(
      `https://${registry}/v2/`,
      { ca, rejectUnauthorized: true, agent: false },
      (response) => {
        response.resume();
        response.once('end', () => resolveResult(response.statusCode));
      },
    );
    request.setTimeout(2000, () => request.destroy(new Error('REGISTRY_FIXTURE_TIMEOUT')));
    request.once('error', reject);
  });
}

try {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const provenance = await ensureRegistryRelease();
  const archive = readFileSync(resolve(cache, 'registry_3.1.2_linux_arm64.tar.gz'));
  if (createHash('sha256').update(archive).digest('hex') !== provenance.sha256)
    throw new Error('REGISTRY_RELEASE_DIGEST_MISMATCH');
  const binary = resolve(cache, 'registry');
  if (!existsSync(binary))
    run('tar', [
      '-xzf',
      resolve(cache, 'registry_3.1.2_linux_arm64.tar.gz'),
      '-C',
      cache,
      'registry',
    ]);
  const expectedBinary = run('tar', [
    '-xOzf',
    resolve(cache, 'registry_3.1.2_linux_arm64.tar.gz'),
    'registry',
  ]);
  if (
    createHash('sha256').update(readFileSync(binary)).digest('hex') !==
    createHash('sha256').update(expectedBinary).digest('hex')
  )
    throw new Error('REGISTRY_RELEASE_BINARY_MISMATCH');
  chmodSync(binary, 0o755);
  console.log(JSON.stringify({ phase, passed: true, version: provenance.version }));

  phase = 'prepare-protected-fixture';
  const pki = resolve(directory, 'pki');
  const bundle = resolve(directory, 'bundle');
  mkdirSync(pki, { recursive: true, mode: 0o700 });
  mkdirSync(bundle, { recursive: true, mode: 0o700 });
  if (!existsSync(resolve(pki, 'server.crt'))) {
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      resolve(pki, 'ca.key'),
      '-out',
      resolve(pki, 'ca.crt'),
      '-days',
      '14',
      '-subj',
      '/CN=Ozz Local Registry B CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    run('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      resolve(pki, 'server.key'),
      '-out',
      resolve(pki, 'server.csr'),
      '-subj',
      '/CN=localhost',
    ]);
    save(
      resolve(pki, 'server.ext'),
      'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n',
    );
    run('openssl', [
      'x509',
      '-req',
      '-in',
      resolve(pki, 'server.csr'),
      '-CA',
      resolve(pki, 'ca.crt'),
      '-CAkey',
      resolve(pki, 'ca.key'),
      '-CAcreateserial',
      '-out',
      resolve(pki, 'server.crt'),
      '-days',
      '7',
      '-extfile',
      resolve(pki, 'server.ext'),
    ]);
  }
  for (const name of ['ca.key', 'server.key', 'server.csr', 'ca.srl'])
    if (existsSync(resolve(pki, name))) chmodSync(resolve(pki, name), 0o600);
  const ca = readFileSync(resolve(pki, 'ca.crt'), 'utf8');
  const credentials = existsSync(credentialsFile)
    ? JSON.parse(readFileSync(credentialsFile, 'utf8'))
    : {
        registry,
        username: 'ozz-local-b',
        password: randomBytes(32).toString('base64url'),
        caCertificate: ca,
      };
  if (credentials.registry !== registry || credentials.caCertificate !== ca)
    throw new Error('REGISTRY_FIXTURE_IDENTITY_CHANGED');
  save(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`);
  const rotated = existsSync(rotatedCredentialsFile)
    ? JSON.parse(readFileSync(rotatedCredentialsFile, 'utf8'))
    : {
        registry,
        username: 'ozz-local-b-rotated',
        password: randomBytes(32).toString('base64url'),
        caCertificate: ca,
      };
  if (
    rotated.registry !== registry ||
    rotated.caCertificate !== ca ||
    rotated.username === credentials.username ||
    rotated.password === credentials.password
  )
    throw new Error('REGISTRY_FIXTURE_ROTATED_IDENTITY_CHANGED');
  save(rotatedCredentialsFile, `${JSON.stringify(rotated, null, 2)}\n`);
  let hashes = existsSync(resolve(bundle, 'htpasswd'))
    ? readFileSync(resolve(bundle, 'htpasswd'), 'utf8')
    : '';
  for (const identity of [credentials, rotated]) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(identity.username) ||
      typeof identity.password !== 'string' ||
      /[\r\n]/.test(identity.password)
    )
      throw new Error('REGISTRY_FIXTURE_CREDENTIAL_INVALID');
    if (hashes.split('\n').some((line) => line.startsWith(`${identity.username}:`))) continue;
    const hash = run(
      '/usr/sbin/htpasswd',
      ['-Bni', '-C', '10', identity.username],
      `${identity.password}\n`,
    );
    hashes += `${hash.toString('utf8').trim()}\n`;
  }
  save(resolve(bundle, 'htpasswd'), hashes);
  copyFileSync(binary, resolve(bundle, 'registry'));
  chmodSync(resolve(bundle, 'registry'), 0o755);
  for (const name of ['ca.crt', 'server.crt', 'server.key']) {
    copyFileSync(resolve(pki, name), resolve(bundle, name));
    chmodSync(resolve(bundle, name), name.endsWith('.key') ? 0o600 : 0o644);
  }
  const configurationPath = resolve(bundle, 'config.yml');
  if (!existsSync(configurationPath)) {
    save(
      configurationPath,
      `${JSON.stringify(
        {
          version: 0.1,
          log: { level: 'info', formatter: 'json' },
          storage: { filesystem: { rootdirectory: `${remote}/data` }, delete: { enabled: false } },
          http: {
            addr: registry,
            host: `https://${registry}`,
            secret: randomBytes(32).toString('hex'),
            tls: { certificate: `${remote}/server.crt`, key: `${remote}/server.key` },
          },
          auth: { htpasswd: { realm: 'Ozz local B fixture', path: `${remote}/htpasswd` } },
        },
        null,
        2,
      )}\n`,
    );
  }
  const currentConfiguration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  currentConfiguration.log.level = 'info';
  save(configurationPath, `${JSON.stringify(currentConfiguration, null, 2)}\n`);
  save(
    resolve(bundle, 'log-sanitize.py'),
    `import json, os, sys\nfrom pathlib import Path\nfrom urllib.parse import urlsplit\nos.umask(0o077)\nbase = Path(__file__).resolve().parent\nfor line in sys.stdin:\n    try:\n        value = json.loads(line)\n        uri = value.get('http.request.uri')\n        status = value.get('http.response.status')\n        if not isinstance(uri, str) or not isinstance(status, int):\n            continue\n        entry = {'time': value.get('time'), 'path': urlsplit(uri).path[:1024], 'status': status}\n        encoded = json.dumps(entry, separators=(',', ':'))\n        with (base / 'access.jsonl').open('a') as output:\n            output.write(encoded + '\\n')\n        if 'containerd' in str(value.get('http.request.useragent', '')).lower() and value.get('http.request.method') == 'GET':\n            with (base / 'runtime-access.jsonl').open('a') as output:\n                output.write(encoded + '\\n')\n        print(encoded, flush=True)\n    except Exception:\n        continue\n`,
  );
  save(
    resolve(bundle, 'ozz-local-registry-b.service'),
    `[Unit]\nDescription=Ozz local B private registry fixture\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/bash -o pipefail -c '${remote}/registry serve ${remote}/config.yml 2>&1 | /usr/bin/python3 ${remote}/log-sanitize.py'\nWorkingDirectory=${remote}\nEnvironment=OTEL_TRACES_EXPORTER=none\nEnvironment=OTEL_METRICS_EXPORTER=none\nEnvironment=OTEL_LOGS_EXPORTER=none\nEnvironment=GOMAXPROCS=1\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=${remote}\nMemoryMax=256M\nTasksMax=64\n\n[Install]\nWantedBy=multi-user.target\n`,
  );

  phase = 'install-B-only-fixture';
  remotePython(
    `from pathlib import Path\np = Path(${JSON.stringify(remote)})\nassert Path('/etc/ozz-local-lab-instance').read_text().strip() == 'ozz-lab-b'\nmarker = p / '.ozz-fixture'\nassert not p.exists() or (marker.exists() and marker.read_text() == ${JSON.stringify(owner)})\np.mkdir(parents=True, exist_ok=True, mode=0o700)\np.chmod(0o700)\nmarker.write_text(${JSON.stringify(owner)})\nmarker.chmod(0o600)\n`,
  );
  const payload = run('tar', [
    '-czf',
    '-',
    '-C',
    bundle,
    'registry',
    'config.yml',
    'htpasswd',
    'ca.crt',
    'server.crt',
    'server.key',
    'log-sanitize.py',
    'ozz-local-registry-b.service',
  ]);
  run('ssh', ['-F', sshConfig, 'ozz-lab-b', `sudo tar -xzf - -C ${remote}`], payload);
  remotePython(
    `from pathlib import Path\nimport shutil, subprocess\nbase = Path(${JSON.stringify(remote)})\nhosts = Path('/var/lib/rancher/k3s/agent/etc/containerd/certs.d/127.0.0.1:50443')\nmarker = hosts / '.ozz-fixture'\nassert not hosts.exists() or (marker.exists() and marker.read_text() == ${JSON.stringify(owner)})\nhosts.mkdir(parents=True, exist_ok=True, mode=0o755)\nmarker.write_text(${JSON.stringify(owner)})\nmarker.chmod(0o600)\nshutil.copyfile(base / 'ca.crt', hosts / 'ca.crt')\n(hosts / 'ca.crt').chmod(0o644)\n(hosts / 'hosts.toml').write_text('server = "https://127.0.0.1:50443"\\n\\n[host."https://127.0.0.1:50443"]\\n  capabilities = ["pull", "resolve"]\\n  ca = "/var/lib/rancher/k3s/agent/etc/containerd/certs.d/127.0.0.1:50443/ca.crt"\\n')\n(hosts / 'hosts.toml').chmod(0o644)\nshutil.copyfile(base / 'ozz-local-registry-b.service', '/etc/systemd/system/ozz-local-registry-b.service')\nPath('/etc/systemd/system/ozz-local-registry-b.service').chmod(0o644)\nsubprocess.run(['systemctl','daemon-reload'], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)\nsubprocess.run(['systemctl','restart','ozz-local-registry-b.service'], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)\n`,
  );
  console.log(
    JSON.stringify({ phase, passed: true, endpoint: `https://${registry}`, k3sRestarted: false }),
  );

  phase = 'forward-loopback';
  let activeTunnel = false;
  try {
    run('ssh', ['-F', sshConfig, '-S', socket, '-O', 'check', 'ozz-lab-b']);
    activeTunnel = true;
  } catch {
    /* first launch */
  }
  if (!activeTunnel)
    run('ssh', [
      '-F',
      sshConfig,
      '-M',
      '-S',
      socket,
      '-fNT',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `127.0.0.1:50443:127.0.0.1:50443`,
      'ozz-lab-b',
    ]);
  let status;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      status = await request(ca);
      if (status === 401) break;
    } catch {
      /* bounded startup */
    }
    await delay(250);
  }
  if (status !== 401) throw new Error('REGISTRY_FIXTURE_NOT_READY');
  const result = {
    fixture: owner,
    preparedAt: new Date().toISOString(),
    registry,
    serverVersion: provenance.version,
    releaseSha256: provenance.sha256,
    caFingerprint: new X509Certificate(ca).fingerprint256,
    credentialsFile,
    caFile: resolve(pki, 'ca.crt'),
    sshConfig,
    tunnelSocket: socket,
    remoteDirectory: remote,
    remoteUnit: 'ozz-local-registry-b.service',
    nodeCaDirectory: '/var/lib/rancher/k3s/agent/etc/containerd/certs.d/127.0.0.1:50443',
    unauthenticatedStatus: status,
    k3sRestarted: false,
    globalTrustModified: false,
  };
  save(resolve(directory, 'setup.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      phase: 'ready',
      passed: true,
      registry,
      unauthenticatedStatus: status,
      credentialsFile,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      phase,
      failed: true,
      code: error.code ?? error.name,
      status: error.status ?? null,
    }),
  );
  process.exitCode = 1;
}
