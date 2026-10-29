import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ensureRegistryRelease } from './private-registry-assets.mjs';
import { sha256File } from './download.mjs';
import { loadTokenFixture } from '../../tests/probes/support/s6-registry-token-issuer.mjs';

// Separate S6 repository-scope fixture. S3 Registry, K3s and Pebble are untouched.
// JWT signing/passwords stay on the Mac; Distribution on B receives only JWKS.
const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/local-lab/s6-registry');
const bundle = resolve(directory, 'bundle');
const sshConfig = resolve(root, '.local/local-lab/credentials/ssh_config');
const socket = resolve(directory, 'b.sock');
const remote = '/var/lib/ozz-local-lab/b/s6-registry';
const owner = 'ozz-s6-registry-scope-fixture-v1';
const tokenOwner = 'ozz-s6-registry-token-fixture-v1';
const authority = 'host.lima.internal:50444';
const tokenOrigin = 'https://host.lima.internal:51445';
const service = 'ozz-s6-registry';
const issuer = 'ozz-s6-local';
const repositories = ['ozz-s6/application', 'ozz-s6/probe'];
const execute = promisify(execFile);
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
let stage = 'preflight';

function requireValue(value, code) {
  if (!value) throw new Error(code);
}

async function run(command, args, input) {
  const job = execute(command, args, { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (input !== undefined) job.child.stdin.end(input);
  try {
    return await job;
  } catch {
    throw new Error('S6_REGISTRY_FIXTURE_COMMAND_FAILED');
  }
}

async function ssh(code) {
  return JSON.parse(
    (await run('ssh', ['-F', sshConfig, 'ozz-lab-b', 'sudo', 'python3', '-'], code)).stdout,
  );
}

async function save(path, value) {
  await writeFile(path, value, { mode: 0o600, flag: 'wx' });
}

function call(port, path, ca) {
  return new Promise((accept, reject) => {
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        servername: 'host.lima.internal',
        port,
        path,
        ca,
        rejectUnauthorized: true,
        agent: false,
        signal: globalThis.AbortSignal.timeout(3000),
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 8192) response.destroy(new Error('S6_REGISTRY_FIXTURE_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () =>
          accept({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}

async function main() {
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  const ownerPath = resolve(directory, 'owner.json');
  let identity;
  if (await exists(ownerPath)) {
    identity = JSON.parse(await readFile(ownerPath, 'utf8'));
    requireValue(
      identity.owner === owner &&
        identity.authority === authority &&
        identity.tokenOrigin === tokenOrigin,
      'S6_REGISTRY_FIXTURE_OWNER_CHANGED',
    );
  } else {
    identity = { owner, fixtureId: `s6-registry-${randomUUID()}`, authority, tokenOrigin };
    await save(ownerPath, `${JSON.stringify(identity, null, 2)}\n`);
  }
  const guest = await ssh(
    `import json,shutil,socket\nfrom pathlib import Path\nbase=Path(${JSON.stringify(remote)})\nassert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-b'\nassert not base.exists() or (base/'.owner').read_text()==${JSON.stringify(owner)}\ndisk=shutil.disk_usage('/')\nassert disk.free>2*1024**3\nprint(json.dumps({'diskFreeBytes':disk.free,'ownerVerified':True}))\n`,
  );
  stage = 'official-distribution-binary';
  const release = await ensureRegistryRelease({ verifyOnly: true });
  const binary = resolve(bundle, 'registry');
  if (!(await exists(binary))) {
    await run('python3', [
      '-c',
      "import tarfile,sys,shutil,os\nwith tarfile.open(sys.argv[1]) as t:\n e=t.getmember('registry')\n assert e.isfile() and e.size<128*1024*1024\n with t.extractfile(e) as src,open(sys.argv[2],'xb') as out: shutil.copyfileobj(src,out)\nos.chmod(sys.argv[2],0o700)",
      release.artifact,
      binary,
    ]);
  }
  const binaryHash = await sha256File(binary);
  const verified = await run('python3', [
    '-c',
    "import tarfile,hashlib,sys\nwith tarfile.open(sys.argv[1]) as t: print(hashlib.file_digest(t.extractfile('registry'),'sha256').hexdigest())",
    release.artifact,
  ]);
  requireValue(binaryHash === verified.stdout.trim(), 'S6_REGISTRY_BINARY_HASH_CHANGED');

  stage = 'protected-tls-and-credentials';
  const caPath = resolve(directory, 'ca.crt');
  if (!(await exists(resolve(directory, 'server.crt')))) {
    for (const [name, contents] of Object.entries({
      'ca.cnf':
        '[req]\ndistinguished_name=dn\nx509_extensions=ca_ext\nprompt=no\n[dn]\nCN=Ozz S6 Registry Fixture CA\n[ca_ext]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
      'server.cnf':
        '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=host.lima.internal\n[server_ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:host.lima.internal,IP:127.0.0.1\n',
    }))
      if (!(await exists(resolve(directory, name)))) await save(resolve(directory, name), contents);
    if (!(await exists(caPath)))
      await run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '14',
        '-config',
        resolve(directory, 'ca.cnf'),
        '-keyout',
        resolve(directory, 'ca.key'),
        '-out',
        caPath,
      ]);
    await run('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-config',
      resolve(directory, 'server.cnf'),
      '-keyout',
      resolve(directory, 'server.key'),
      '-out',
      resolve(directory, 'server.csr'),
    ]);
    await run('openssl', [
      'x509',
      '-req',
      '-sha256',
      '-days',
      '7',
      '-in',
      resolve(directory, 'server.csr'),
      '-CA',
      caPath,
      '-CAkey',
      resolve(directory, 'ca.key'),
      '-CAcreateserial',
      '-extfile',
      resolve(directory, 'server.cnf'),
      '-extensions',
      'server_ext',
      '-out',
      resolve(directory, 'server.crt'),
    ]);
  }
  for (const name of ['ca.key', 'ca.crt', 'server.key', 'server.crt', 'server.csr'])
    await chmod(resolve(directory, name), 0o600);
  const credentialsFile = resolve(directory, 'users.json');
  if (!(await exists(credentialsFile)))
    await save(
      credentialsFile,
      `${JSON.stringify(
        {
          owner: tokenOwner,
          users: [
            {
              username: 'ozz-s6-push',
              password: randomBytes(36).toString('base64url'),
              repositories: repositories.map((name) => ({ name, actions: ['pull', 'push'] })),
            },
            {
              username: 'ozz-s6-pull',
              password: randomBytes(36).toString('base64url'),
              repositories: repositories.map((name) => ({ name, actions: ['pull'] })),
            },
            {
              username: 'ozz-s6-maintenance',
              password: randomBytes(36).toString('base64url'),
              repositories: repositories.map((name) => ({
                name,
                actions: ['pull', 'push', 'delete'],
              })),
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  const signingKeyFile = resolve(directory, 'token-signing.key');
  if (!(await exists(signingKeyFile))) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await save(signingKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  const tokenConfigFile = resolve(directory, 'token.json');
  if (!(await exists(tokenConfigFile)))
    await save(
      tokenConfigFile,
      `${JSON.stringify({ owner: tokenOwner, fixtureId: identity.fixtureId, issuer, service, listenHost: '127.0.0.1', listenPort: 51445, tlsKeyFile: 'server.key', tlsCertificateFile: 'server.crt', signingKeyFile: 'token-signing.key', credentialsFile: 'users.json' }, null, 2)}\n`,
    );
  const tokenConfiguration = await loadTokenFixture(tokenConfigFile);
  for (const name of ['server.crt', 'server.key', 'ca.crt']) {
    const target = resolve(bundle, name);
    if (await exists(target))
      requireValue(
        (await sha256File(target)) === (await sha256File(resolve(directory, name))),
        'S6_REGISTRY_BUNDLE_IDENTITY_CHANGED',
      );
    else await copyFile(resolve(directory, name), target);
    await chmod(target, 0o600);
  }
  const configuration = {
    version: 0.1,
    log: { level: 'info', formatter: 'json' },
    storage: { filesystem: { rootdirectory: `${remote}/data` }, delete: { enabled: true } },
    http: {
      addr: '127.0.0.1:50444',
      secret: randomBytes(36).toString('base64url'),
      tls: { certificate: `${remote}/server.crt`, key: `${remote}/server.key` },
    },
    auth: {
      token: { realm: `${tokenOrigin}/token`, service, issuer, jwks: `${remote}/jwks.json` },
    },
    health: { storagedriver: { enabled: true, interval: '10s', threshold: 3 } },
  };
  const files = {
    '.owner': owner,
    'jwks.json': `${JSON.stringify(tokenConfiguration.publicJwks)}\n`,
    'registry.json': `${JSON.stringify(configuration, null, 2)}\n`,
    'sanitize.py': `import json,sys,os\nfrom pathlib import Path\nfrom urllib.parse import urlsplit\nos.umask(0o077)\nbase=Path(__file__).resolve().parent\nfor line in sys.stdin:\n try:\n  item=json.loads(line)\n  uri=item.get('http.request.uri')\n  status=item.get('http.response.status')\n  if not isinstance(uri,str) or not isinstance(status,int): continue\n  entry={'time':item.get('time'),'path':urlsplit(uri).path[:1024],'method':item.get('http.request.method'),'status':status,'runtime':'containerd' in str(item.get('http.request.useragent','')).lower()}\n  target=base/'access.jsonl'\n  if target.exists() and target.stat().st_size>4*1024*1024: continue\n  with target.open('a') as out: out.write(json.dumps(entry,separators=(',',':'))+'\\n')\n except Exception: pass\n`,
    'ozz-s6-registry.service': `[Unit]\nDescription=Ozz S6 local repository-scope Registry fixture\nAfter=network-online.target\n[Service]\nType=simple\nUMask=0077\nExecStart=/bin/sh -c '${remote}/registry serve ${remote}/registry.json 2>&1 | /usr/bin/python3 ${remote}/sanitize.py'\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\nTimeoutStopSec=15\nMemoryMax=192M\nTasksMax=128\nCPUQuota=50%\n[Install]\nWantedBy=multi-user.target\n`,
  };
  for (const [name, contents] of Object.entries(files)) {
    const target = resolve(bundle, name);
    if (await exists(target)) {
      if (name !== 'registry.json')
        requireValue(
          (await readFile(target, 'utf8')) === contents,
          'S6_REGISTRY_BUNDLE_IDENTITY_CHANGED',
        );
    } else await save(target, contents);
  }
  stage = 'install-new-fixture-on-b';
  const upload = `/home/ozz/.local/ozz-s6-registry-${randomUUID()}`;
  await run('ssh', ['-F', sshConfig, 'ozz-lab-b', 'mkdir', '-p', '-m', '700', upload]);
  const names = ['registry', 'server.crt', 'server.key', 'ca.crt', ...Object.keys(files)];
  for (const name of names)
    await run('scp', ['-q', '-F', sshConfig, resolve(bundle, name), `ozz-lab-b:${upload}/${name}`]);
  const hashes = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await sha256File(resolve(bundle, name))])),
  );
  const installation = await ssh(
    `import json,hashlib,os,shutil,subprocess\nfrom pathlib import Path\nbase=Path(${JSON.stringify(remote)})\nupload=Path(${JSON.stringify(upload)})\nexpected=${JSON.stringify(hashes)}\nassert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-b'\nassert not base.exists() or (base/'.owner').read_text()==${JSON.stringify(owner)}\nbase.mkdir(mode=0o700,parents=True,exist_ok=True)\nchanged=False\nfor name,checksum in expected.items():\n src=upload/name\n assert src.is_file() and not src.is_symlink()\n assert hashlib.sha256(src.read_bytes()).hexdigest()==checksum\n dst=base/name\n if dst.exists(): assert dst.is_file() and not dst.is_symlink() and hashlib.sha256(dst.read_bytes()).hexdigest()==checksum\n else:\n  shutil.copyfile(src,dst)\n  os.chmod(dst,0o700 if name=='registry' else 0o600)\n  changed=True\n(base/'data').mkdir(mode=0o700,exist_ok=True)\nunit=Path('/etc/systemd/system/ozz-s6-registry.service')\nif unit.exists(): assert unit.read_bytes()==(base/unit.name).read_bytes()\nelse:\n shutil.copyfile(base/unit.name,unit)\n os.chmod(unit,0o644)\n changed=True\nhosts=Path('/var/lib/rancher/k3s/agent/etc/containerd/certs.d/${authority}')\nassert not hosts.exists() or (hosts/'.ozz-s6-fixture').read_text()==${JSON.stringify(owner)}\nhosts.mkdir(mode=0o755,parents=True,exist_ok=True)\n(hosts/'.ozz-s6-fixture').write_text(${JSON.stringify(owner)})\n(hosts/'.ozz-s6-fixture').chmod(0o600)\nshutil.copyfile(base/'ca.crt',hosts/'ca.crt')\n(hosts/'ca.crt').chmod(0o644)\n(hosts/'hosts.toml').write_text('server = "https://${authority}"\\n\\n[host."https://${authority}"]\\n  capabilities = ["pull", "resolve"]\\n  ca = "'+str(hosts/'ca.crt')+'"\\n')\n(hosts/'hosts.toml').chmod(0o644)\nif changed: subprocess.run(['systemctl','daemon-reload'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nsubprocess.run(['systemctl','start','ozz-s6-registry.service'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nprint(json.dumps({'newFilesInstalled':changed,'binarySha256':expected['registry'],'k3sRestarted':False,'previousRegistryModified':False,'nodeCaDirectory':str(hosts)}))\n`,
  );

  stage = 'mac-token-server';
  const ca = await readFile(caPath);
  let tokenHealth;
  try {
    tokenHealth = await call(51445, '/healthz', ca);
  } catch {
    /* No owned listener has started yet. */
  }
  if (tokenHealth) {
    const health = JSON.parse(tokenHealth.body);
    requireValue(
      tokenHealth.status === 200 && health.fixtureId === identity.fixtureId,
      'S6_TOKEN_PORT_OWNERSHIP_CHANGED',
    );
  } else {
    const descriptor = await open(resolve(directory, `token-${Date.now()}.log`), 'ax', 0o600);
    const tokenChild = spawn(
      process.execPath,
      [
        resolve(root, 'tests/probes/support/s6-registry-token-issuer.mjs'),
        'serve',
        tokenConfigFile,
      ],
      { cwd: root, detached: true, stdio: ['ignore', descriptor.fd, descriptor.fd] },
    );
    tokenChild.unref();
    await descriptor.close();
    await save(
      resolve(directory, `token-process-${Date.now()}.json`),
      `${JSON.stringify({ owner, fixtureId: identity.fixtureId, pid: tokenChild.pid })}\n`,
    );
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const health = await call(51445, '/healthz', ca);
        ready = health.status === 200 && JSON.parse(health.body).fixtureId === identity.fixtureId;
      } catch {
        /* Bounded startup. */
      }
      if (ready) break;
      await delay(100);
    }
    requireValue(ready, 'S6_TOKEN_SERVER_NOT_READY');
  }
  stage = 'registry-ssh-forward';
  let tunnel = false;
  if (await exists(socket)) {
    try {
      await run('ssh', ['-F', sshConfig, '-S', socket, '-O', 'check', 'ozz-lab-b']);
      tunnel = true;
    } catch {
      throw new Error('S6_REGISTRY_EXISTING_TUNNEL_UNAVAILABLE');
    }
  }
  if (!tunnel)
    await run('ssh', [
      '-F',
      sshConfig,
      '-M',
      '-S',
      socket,
      '-o',
      'ControlPersist=no',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      '127.0.0.1:50444:127.0.0.1:50444',
      '-N',
      '-f',
      'ozz-lab-b',
    ]);
  let registryReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await call(50444, '/v2/', ca);
      registryReady =
        response.status === 401 &&
        response.headers['www-authenticate']?.includes(`${tokenOrigin}/token`);
    } catch {
      /* Bounded startup. */
    }
    if (registryReady) break;
    await delay(250);
  }
  requireValue(registryReady, 'S6_REGISTRY_SERVER_NOT_READY');
  const result = {
    owner,
    fixtureId: identity.fixtureId,
    status: 'fixture_ready',
    timestamp: new Date().toISOString(),
    authority,
    tokenOrigin,
    service,
    issuer,
    repositories,
    localRegistryPort: 50444,
    localTokenPort: 51445,
    caFile: caPath,
    credentialsFile,
    tokenConfigFile,
    remote,
    guest,
    installation,
    scope:
      'TLS/token/Distribution fixture prepared; repository scope enforcement and image delivery still require protocol/product probes.',
  };
  const resultPath = resolve(directory, `setup-${Date.now()}.json`);
  await save(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: result.status,
      result: resultPath,
      authority,
      tokenOrigin,
      scope: result.scope,
    }),
  );
}

main().catch(async (error) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const failure = {
    status: 'failed',
    stage,
    errorCode: /^S6_[A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : 'S6_REGISTRY_FIXTURE_FAILED',
    timestamp: new Date().toISOString(),
  };
  const path = resolve(directory, `failed-${Date.now()}.json`);
  await save(path, `${JSON.stringify(failure, null, 2)}\n`);
  console.error(JSON.stringify({ ...failure, report: path }));
  process.exitCode = 1;
});
