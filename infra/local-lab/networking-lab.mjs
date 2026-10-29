import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ensureNetworkLabAssets } from './networking-assets.mjs';

// These are local test authorities. The fixture never writes Kubernetes objects,
// system resolver settings, or a system trust store. It does not perform issuance.
process.umask(0o077);
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const directory = resolve(lab, 'networking-lab');
const sshConfig = resolve(lab, 'credentials/ssh_config');
const owner = 'ozz-local-networking-lab-v1';
const stateFile = resolve(directory, 'state.json');
const markerFile = resolve(directory, '.ozz-fixture');
const probeName = 'networking-fixture.apps.example.test';
const guests = ['a', 'b'];
let phase = 'arguments';

class LabError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
function requireCondition(value, code) {
  if (!value) throw new LabError(code);
}
function run(command, args, input, { timeout = 30_000, allowStatusOne = false } = {}) {
  try {
    return execFileSync(command, args, {
      input,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowStatusOne && error.status === 1) return Buffer.alloc(0);
    const controlled = String(error.stderr ?? '').match(/NETWORK_LAB_[A-Z_]+/u)?.[0];
    throw new LabError(
      controlled ?? `NETWORK_LAB_${basename(command).toUpperCase().replaceAll('-', '_')}_FAILED`,
    );
  }
}
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function safeDirectory(path) {
  if (existsSync(path))
    requireCondition(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      'NETWORK_LAB_UNSAFE_DIRECTORY',
    );
  else mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
function save(path, value, mode = 0o600) {
  if (existsSync(path))
    requireCondition(
      lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
      'NETWORK_LAB_UNSAFE_FILE',
    );
  const pending = `${path}.pending`;
  requireCondition(
    !existsSync(pending) || (lstatSync(pending).isFile() && !lstatSync(pending).isSymbolicLink()),
    'NETWORK_LAB_UNSAFE_FILE',
  );
  writeFileSync(pending, value, { mode });
  chmodSync(pending, mode);
  renameSync(pending, path);
}
function saveJson(path, value) {
  save(path, `${JSON.stringify(value, null, 2)}\n`);
}
function readState() {
  if (!existsSync(directory)) return null;
  requireCondition(
    lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
    'NETWORK_LAB_UNSAFE_DIRECTORY',
  );
  if (!existsSync(markerFile)) {
    requireCondition(readdirSync(directory).length === 0, 'NETWORK_LAB_DIRECTORY_NOT_OWNED');
    return null;
  }
  requireCondition(
    readFileSync(markerFile, 'utf8').trim() === owner,
    'NETWORK_LAB_DIRECTORY_NOT_OWNED',
  );
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
}
function remoteBase(guest) {
  return `/var/lib/ozz-local-lab/${guest}/networking-v1`;
}
function unitNames(guest) {
  return ['dns', 'staging', 'production'].map(
    (kind) => `ozz-local-networking-${guest}-${kind}.service`,
  );
}
function remotePython(guest, source, input) {
  requireCondition(guests.includes(guest), 'NETWORK_LAB_UNKNOWN_GUEST');
  return JSON.parse(
    run(
      'ssh',
      ['-F', sshConfig, `ozz-lab-${guest}`, `sudo python3 -c ${quote(source)}`],
      JSON.stringify(input),
    ).toString(),
  );
}

const inspectSource = String.raw`
import hashlib, json, subprocess, sys
from pathlib import Path
request = json.load(sys.stdin)
def kubectl(*args):
    return json.loads(subprocess.check_output(['k3s', 'kubectl', *args, '-o', 'json'], stderr=subprocess.PIPE))
instance = Path('/etc/ozz-local-lab-instance').read_text().strip()
if instance != request['instance']:
    raise RuntimeError('NETWORK_LAB_INSTANCE_MISMATCH')
namespace = kubectl('get', 'namespace', 'kube-system')
nodes = kubectl('get', 'nodes')['items']
resources = kubectl('get', 'namespaces,deployments.apps,statefulsets.apps,daemonsets.apps,services,persistentvolumeclaims,ingresses.networking.k8s.io', '-A')['items']
configs = {}
for filename in ['/etc/resolv.conf', '/etc/rancher/k3s/config.yaml', '/var/lib/rancher/k3s/server/manifests/traefik.yaml', '/etc/ssl/certs/ca-certificates.crt']:
    path = Path(filename)
    configs[filename] = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
print(json.dumps({
    'instance': instance, 'kubeSystemUid': namespace['metadata']['uid'],
    'nodes': [{'name': item['metadata']['name'], 'uid': item['metadata']['uid'], 'internalIPs': [entry['address'] for entry in item['status']['addresses'] if entry['type'] == 'InternalIP']} for item in nodes],
    'resources': sorted([{'kind': item['kind'], 'namespace': item['metadata'].get('namespace', ''), 'name': item['metadata']['name'], 'uid': item['metadata']['uid']} for item in resources], key=lambda item: (item['kind'], item['namespace'], item['name'])),
    'configurationHashes': configs
}))
`;

function inspectGuests(previous) {
  const verified = JSON.parse(readFileSync(resolve(lab, 'verification.json'), 'utf8'));
  const identities = {};
  for (const guest of guests) {
    const current = remotePython(guest, inspectSource, { instance: `ozz-lab-${guest}` });
    const trusted = verified.clusters.find((cluster) => cluster.instance === current.instance);
    requireCondition(
      trusted?.kubeSystemUid === current.kubeSystemUid,
      'NETWORK_LAB_CLUSTER_IDENTITY_MISMATCH',
    );
    requireCondition(
      current.nodes.length === 1 &&
        current.nodes[0].internalIPs.length === 1 &&
        /^192\.168\.\d{1,3}\.\d{1,3}$/u.test(current.nodes[0].internalIPs[0]),
      'NETWORK_LAB_UNEXPECTED_NODE_ADDRESS',
    );
    if (previous?.identities[guest]) {
      const baseline = previous.identities[guest];
      requireCondition(
        baseline.kubeSystemUid === current.kubeSystemUid &&
          JSON.stringify(baseline.nodes) === JSON.stringify(current.nodes),
        'NETWORK_LAB_CLUSTER_IDENTITY_CHANGED',
      );
      requireCondition(
        Object.entries(baseline.configurationHashes).every(
          ([path, checksum]) =>
            // Ubuntu may update its public CA package between lab runs. The fixture
            // uses its own pinned transport CA and checks default-trust rejection
            // below; a public trust-store update must not prevent its restart.
            path === '/etc/ssl/certs/ca-certificates.crt' ||
            current.configurationHashes[path] === checksum,
        ),
        'NETWORK_LAB_SHARED_CONFIGURATION_CHANGED',
      );
      const currentResources = new Map(
        current.resources.map((item) => [`${item.kind}/${item.namespace}/${item.name}`, item.uid]),
      );
      requireCondition(
        baseline.resources.every(
          (item) =>
            currentResources.get(`${item.kind}/${item.namespace}/${item.name}`) === item.uid,
        ),
        'NETWORK_LAB_EXISTING_RESOURCE_CHANGED',
      );
    }
    identities[guest] = current;
  }
  requireCondition(
    identities.a.nodes[0].internalIPs[0] === identities.b.nodes[0].internalIPs[0],
    'NETWORK_LAB_DISTINCT_NODE_IPS_REQUIRE_MAPPING',
  );
  return identities;
}

function verifyKeyPair(certPath, keyPath, authority) {
  const certificate = new X509Certificate(readFileSync(certPath));
  const key = createPublicKey(readFileSync(keyPath)).export({ format: 'der', type: 'spki' });
  requireCondition(
    certificate.publicKey.export({ format: 'der', type: 'spki' }).equals(key),
    'NETWORK_LAB_KEY_PAIR_MISMATCH',
  );
  requireCondition(
    Date.parse(certificate.validFrom) <= Date.now() &&
      Date.parse(certificate.validTo) > Date.now() + 86_400_000,
    'NETWORK_LAB_TRANSPORT_CERTIFICATE_EXPIRED',
  );
  if (authority)
    requireCondition(certificate.verify(authority.publicKey), 'NETWORK_LAB_TRANSPORT_CA_MISMATCH');
  return certificate;
}
function preparePki(ip) {
  const pki = resolve(directory, 'pki');
  safeDirectory(pki);
  const caFile = resolve(pki, 'ca.pem');
  const caKey = resolve(pki, 'ca.key');
  requireCondition(existsSync(caFile) === existsSync(caKey), 'NETWORK_LAB_INCOMPLETE_CA');
  if (!existsSync(caFile))
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      caFile,
      '-days',
      '30',
      '-subj',
      '/CN=Ozz Local ACME Transport CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
  const ca = verifyKeyPair(caFile, caKey);
  requireCondition(ca.ca, 'NETWORK_LAB_CA_CONSTRAINT_MISSING');
  for (const guest of guests) {
    const base = resolve(pki, guest);
    safeDirectory(base);
    const cert = resolve(base, 'server.pem');
    const key = resolve(base, 'server.key');
    requireCondition(
      existsSync(cert) === existsSync(key),
      'NETWORK_LAB_INCOMPLETE_SERVER_CERTIFICATE',
    );
    if (!existsSync(cert)) {
      run('openssl', [
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        key,
        '-out',
        resolve(base, 'server.csr'),
        '-subj',
        `/CN=ozz-lab-${guest} local ACME transport`,
      ]);
      save(
        resolve(base, 'server.ext'),
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost\n`,
      );
      run('openssl', [
        'x509',
        '-req',
        '-in',
        resolve(base, 'server.csr'),
        '-CA',
        caFile,
        '-CAkey',
        caKey,
        '-set_serial',
        `0x${randomBytes(16).toString('hex')}`,
        '-out',
        cert,
        '-days',
        '14',
        '-sha256',
        '-extfile',
        resolve(base, 'server.ext'),
      ]);
    }
    const leaf = verifyKeyPair(cert, key, ca);
    requireCondition(
      leaf.checkIP(ip) === ip && leaf.checkIP('127.0.0.1') === '127.0.0.1',
      'NETWORK_LAB_SERVER_SAN_MISMATCH',
    );
    for (const name of readdirSync(base)) chmodSync(resolve(base, name), 0o600);
  }
  chmodSync(caFile, 0o600);
  chmodSync(caKey, 0o600);
  return { pki, caFile, fingerprint: ca.fingerprint256 };
}

function extractBinary(archive, member, target) {
  const binary = run('tar', ['-xOzf', archive, member]);
  if (existsSync(target))
    requireCondition(hash(readFileSync(target)) === hash(binary), 'NETWORK_LAB_BINARY_CHANGED');
  else save(target, binary, 0o700);
  chmodSync(target, 0o700);
  return target;
}
function dnsArgs(address, management, ip) {
  return [
    '-http01',
    '',
    '-https01',
    '',
    '-tlsalpn01',
    '',
    '-doh',
    '',
    '-dnsserver',
    address,
    '-management',
    management,
    '-defaultIPv4',
    ip,
    '-defaultIPv6',
    '',
  ];
}
function unit(guest, kind, ip) {
  const base = remoteBase(guest);
  const command =
    kind === 'dns'
      ? `${base}/pebble-challtestsrv ${dnsArgs('0.0.0.0:1053', '127.0.0.1:8055', ip)
          .map((arg) => (arg === '' ? '""' : arg))
          .join(' ')}`
      : `${base}/pebble -config ${base}/${kind}.json -dnsserver 127.0.0.1:1053`;
  const dependencies =
    kind === 'dns'
      ? ''
      : `Requires=ozz-local-networking-${guest}-dns.service\nAfter=ozz-local-networking-${guest}-dns.service\n`;
  return `# Owner: ${owner}\n[Unit]\nDescription=Ozz local ${guest.toUpperCase()} ${kind} network fixture\nAfter=network.target\n${dependencies}\n[Service]\nType=simple\nExecStart=${command}\nWorkingDirectory=${base}\nEnvironment=GOMAXPROCS=1\nUnsetEnvironment=HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy\n${kind === 'dns' ? '' : 'Environment=PEBBLE_VA_NOSLEEP=1\nEnvironment=PEBBLE_AUTHZREUSE=0\nEnvironment=PEBBLE_WFE_NONCEREJECT=0\nUnsetEnvironment=PEBBLE_VA_ALWAYS_VALID\n'}Restart=on-failure\nRestartSec=2\nTimeoutStopSec=5\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nProtectKernelTunables=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\nCapabilityBoundingSet=\nReadWritePaths=${base}\nMemoryMax=${kind === 'dns' ? '96M' : '192M'}\nTasksMax=64\nStandardOutput=append:${base}/${kind}.log\nStandardError=append:${base}/${kind}.log\n`;
}
function pebbleConfiguration(guest, mode, seconds) {
  const base = remoteBase(guest);
  return {
    pebble: {
      listenAddress: `0.0.0.0:${mode === 'staging' ? 14000 : 14100}`,
      managementListenAddress: `127.0.0.1:${mode === 'staging' ? 15000 : 15100}`,
      certificate: `${base}/server.pem`,
      privateKey: `${base}/server.key`,
      httpPort: 80,
      tlsPort: 443,
      ocspResponderURL: '',
      externalAccountBindingRequired: false,
      domainBlocklist: ['blocked-domain.example'],
      retryAfter: { authz: 1, order: 1 },
      keyAlgorithm: 'ecdsa',
      profiles: {
        default: {
          description: 'Ozz local test certificate; not publicly trusted',
          validityPeriod: seconds,
        },
      },
    },
  };
}

const installSource = String.raw`
import base64, hashlib, json, os, subprocess, sys
from pathlib import Path
os.umask(0o077)
request = json.load(sys.stdin)
base = Path(request['base'])
if Path('/etc/ozz-local-lab-instance').read_text().strip() != request['instance']:
    raise RuntimeError('NETWORK_LAB_INSTANCE_MISMATCH')
namespace = json.loads(subprocess.check_output(['k3s','kubectl','get','namespace','kube-system','-o','json'], stderr=subprocess.PIPE))
if namespace['metadata']['uid'] != request['kubeSystemUid']:
    raise RuntimeError('NETWORK_LAB_CLUSTER_IDENTITY_MISMATCH')
marker = base / '.ozz-fixture'
if base.exists() and (base.is_symlink() or not marker.is_file() or marker.read_text() != request['owner']):
    raise RuntimeError('NETWORK_LAB_DIRECTORY_NOT_OWNED')
for name in request['units']:
    unit = Path('/etc/systemd/system') / name
    if unit.exists() and (unit.is_symlink() or not unit.read_text().startswith('# Owner: ' + request['owner'] + '\n') or str(base) not in unit.read_text()):
        raise RuntimeError('NETWORK_LAB_UNIT_NOT_OWNED')
files = {name: base64.b64decode(value) for name, value in request['files'].items()}
active = [name for name in request['units'] if subprocess.run(['systemctl','is-active','--quiet',name], stdout=subprocess.PIPE, stderr=subprocess.PIPE).returncode == 0]
changed = [name for name, content in files.items() if not (base / name).exists() or (base / name).read_bytes() != content]
if active and changed:
    raise RuntimeError('NETWORK_LAB_STOP_BEFORE_CONFIGURATION_CHANGE')
owned_pids = set()
for name in active:
    pid = subprocess.check_output(['systemctl','show',name,'--property=MainPID','--value']).decode().strip()
    if pid and pid != '0': owned_pids.add(pid)
for command in [['ss','-H','-ltnp'], ['ss','-H','-lunp']]:
    for line in subprocess.check_output(command).decode().splitlines():
        fields = line.split()
        if len(fields) < 5: continue
        try: port = int(fields[3].rsplit(':',1)[1])
        except ValueError: continue
        if port in [1053,8055,14000,14100,15000,15100] and not any(('pid=' + pid + ',') in line for pid in owned_pids):
            raise RuntimeError('NETWORK_LAB_GUEST_PORT_IN_USE')
base.mkdir(parents=True, exist_ok=True, mode=0o700)
base.chmod(0o700)
marker.write_text(request['owner'])
marker.chmod(0o600)
for name, content in files.items():
    if '/' in name or name in ['.', '..']:
        raise RuntimeError('NETWORK_LAB_INVALID_BUNDLE_PATH')
    path = base / name
    if path.is_symlink(): raise RuntimeError('NETWORK_LAB_UNSAFE_FILE')
    if name in changed:
        pending = base / (name + '.pending')
        if pending.is_symlink(): raise RuntimeError('NETWORK_LAB_UNSAFE_FILE')
        pending.write_bytes(content)
        pending.chmod(0o700 if name in ['pebble','pebble-challtestsrv'] else 0o600)
        pending.replace(path)
for kind in ['dns','staging','production']:
    path = base / (kind + '.log')
    if path.is_symlink(): raise RuntimeError('NETWORK_LAB_UNSAFE_FILE')
    with path.open('ab'): pass
    path.chmod(0o600)
for name in request['units']:
    path = Path('/etc/systemd/system') / name
    content = files[name]
    if not path.exists() or path.read_bytes() != content:
        path.write_bytes(content)
        path.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
subprocess.run(['systemctl','start',*request['units']], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
print(json.dumps({'instance':request['instance'], 'units':request['units'], 'filesChanged':changed, 'previouslyActive':active}))
`;

function installGuest(guest, identity, files) {
  return remotePython(guest, installSource, {
    owner,
    instance: identity.instance,
    kubeSystemUid: identity.kubeSystemUid,
    base: remoteBase(guest),
    units: unitNames(guest),
    files: Object.fromEntries(
      Object.entries(files).map(([name, value]) => [name, Buffer.from(value).toString('base64')]),
    ),
  });
}

const statusSource = String.raw`
import hashlib, json, socket, ssl, struct, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path
request = json.load(sys.stdin)
base = Path(request['base'])
if Path('/etc/ozz-local-lab-instance').read_text().strip() != request['instance']:
    raise RuntimeError('NETWORK_LAB_INSTANCE_MISMATCH')
if not base.exists():
    print(json.dumps({'instance':request['instance'],'state':'absent'})); sys.exit(0)
if base.is_symlink() or (base / '.ozz-fixture').read_text() != request['owner']:
    raise RuntimeError('NETWORK_LAB_DIRECTORY_NOT_OWNED')
units = []
for name in request['units']:
    path = Path('/etc/systemd/system') / name
    if not path.exists() or not path.read_text().startswith('# Owner: ' + request['owner'] + '\n') or str(base) not in path.read_text():
        raise RuntimeError('NETWORK_LAB_UNIT_NOT_OWNED')
    properties = subprocess.check_output(['systemctl','show',name,'--property=ActiveState,SubState,MainPID,FragmentPath']).decode()
    values = dict(line.split('=',1) for line in properties.splitlines() if '=' in line)
    units.append({'name':name, **values})
active = [item for item in units if item['ActiveState'] == 'active']
if len(active) != 3:
    print(json.dumps({'instance':request['instance'],'state':'stopped' if not active else 'partial','units':units})); sys.exit(0)
listeners = []
for command in [['ss','-H','-ltnp'],['ss','-H','-lunp']]:
    for line in subprocess.check_output(command).decode().splitlines():
        for item in units:
            if ('pid=' + item['MainPID'] + ',') in line:
                listeners.append({'unit':item['name'],'protocol':'udp' if '-lunp' in command else 'tcp','address':line.split()[3]})
expected_ports = {1053,8055,14000,14100,15000,15100}
for item in listeners:
    address, port = item['address'].rsplit(':',1)
    if int(port) not in expected_ports or (int(port) in [8055,15000,15100] and address != '127.0.0.1'):
        raise RuntimeError('NETWORK_LAB_UNEXPECTED_GUEST_LISTENER')
if set(int(item['address'].rsplit(':',1)[1]) for item in listeners) != expected_ports:
    raise RuntimeError('NETWORK_LAB_MISSING_GUEST_LISTENER')
for item in units:
    environ = (Path('/proc') / item['MainPID'] / 'environ').read_bytes().split(b'\0')
    values = dict(value.split(b'=',1) for value in environ if b'=' in value)
    if any(name in values for name in [b'HTTP_PROXY',b'HTTPS_PROXY',b'ALL_PROXY',b'http_proxy',b'https_proxy',b'all_proxy']):
        raise RuntimeError('NETWORK_LAB_VALIDATION_PROXY_ENABLED')
    if item['name'].endswith('-dns.service'): continue
    if b'PEBBLE_VA_ALWAYS_VALID' in values or values.get(b'PEBBLE_VA_NOSLEEP') != b'1' or values.get(b'PEBBLE_AUTHZREUSE') != b'0':
        raise RuntimeError('NETWORK_LAB_VALIDATION_BYPASS_OR_REUSE')
def dns_query(record_type, tcp=False):
    name = b''.join(bytes([len(part)]) + part.encode() for part in request['probeName'].split('.')) + b'\0'
    packet = struct.pack('!HHHHHH',45001,256,1,0,0,0) + name + struct.pack('!HH',record_type,1)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM) as client:
        client.settimeout(3)
        client.connect((request['ip'] if tcp else '127.0.0.1',1053))
        if tcp:
            client.sendall(struct.pack('!H',len(packet))+packet)
            header = client.recv(2)
            wanted = struct.unpack('!H',header)[0]
            response = b''
            while len(response) < wanted:
                chunk = client.recv(wanted-len(response))
                if not chunk: raise RuntimeError('NETWORK_LAB_DNS_RESPONSE_TRUNCATED')
                response += chunk
        else:
            client.send(packet); response = client.recv(4096)
    identifier,flags,questions,answers,_,_ = struct.unpack('!HHHHHH',response[:12])
    if identifier != 45001 or flags & 15: raise RuntimeError('NETWORK_LAB_DNS_RESPONSE_INVALID')
    def skip_name(offset):
        while response[offset]:
            if response[offset] & 192 == 192: return offset+2
            offset += response[offset]+1
        return offset+1
    offset = 12
    for _ in range(questions): offset = skip_name(offset)+4
    values = []
    for _ in range(answers):
        offset = skip_name(offset)
        kind,_,_,length = struct.unpack('!HHIH',response[offset:offset+10]); offset += 10
        if kind == record_type and kind in [1,28]: values.append(socket.inet_ntop(socket.AF_INET if kind == 1 else socket.AF_INET6,response[offset:offset+length]))
        offset += length
    return values
dns = {'udpA':dns_query(1), 'tcpA':dns_query(1,True), 'udpAAAA':dns_query(28)}
if dns['udpA'] != [request['ip']] or dns['tcpA'] != [request['ip']] or dns['udpAAAA']:
    raise RuntimeError('NETWORK_LAB_DNS_ANSWER_MISMATCH')
context = ssl.create_default_context(cafile=str(base / 'ca.pem'))
secure = urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context))
system_trust = urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ssl.create_default_context()))
directories = []
for kind,port,management in [('staging',14000,15000),('production',14100,15100)]:
    config = json.loads((base / (kind+'.json')).read_text())['pebble']
    if config['httpPort'] != 80 or config['tlsPort'] != 443 or config['managementListenAddress'] != '127.0.0.1:'+str(management):
        raise RuntimeError('NETWORK_LAB_CHALLENGE_PORT_MISMATCH')
    url = 'https://'+request['ip']+':'+str(port)+'/dir'
    with secure.open(url,timeout=3) as response:
        data = json.loads(response.read()); status = response.status
    fields = ['newNonce','newAccount','newOrder','revokeCert','keyChange']
    if status != 200 or not all(isinstance(data.get(field),str) for field in fields):
        raise RuntimeError('NETWORK_LAB_ACME_DIRECTORY_INVALID')
    untrusted = False
    try:
        with system_trust.open(url,timeout=3): pass
    except urllib.error.URLError as error:
        untrusted = isinstance(error.reason,ssl.SSLCertVerificationError)
    if not untrusted: raise RuntimeError('NETWORK_LAB_UNEXPECTED_SYSTEM_TRUST')
    with secure.open('https://127.0.0.1:'+str(management)+'/roots/0',timeout=3) as response:
        signing_root = response.read()
    (base / (kind+'-signing-root.pem')).write_bytes(signing_root)
    (base / (kind+'-signing-root.pem')).chmod(0o600)
    directories.append({'environment':kind,'url':url,'status':status,'tlsVerifiedWithExplicitCA':True,'defaultTrustRejected':True,'directoryFields':fields,'leafValiditySeconds':config['profiles']['default']['validityPeriod'],'signingRootSha256':hashlib.sha256(signing_root).hexdigest()})
for path in ['/add-http01','/add-tlsalpn01']:
    try:
        secure.open('http://127.0.0.1:8055'+path,timeout=3)
        raise RuntimeError('NETWORK_LAB_HTTP_CHALLENGE_MOCK_ENABLED')
    except urllib.error.HTTPError as error:
        if error.code != 404: raise RuntimeError('NETWORK_LAB_HTTP_CHALLENGE_MOCK_ENABLED')
print(json.dumps({'instance':request['instance'],'state':'ready','units':units,'listeners':listeners,'dns':dns,'directories':directories,'httpChallengeMocksDisabled':True,'validationBypassEnabled':False,'validationProxyEnabled':False}))
`;

function guestStatus(guest, identity) {
  return remotePython(guest, statusSource, {
    owner,
    instance: identity.instance,
    base: remoteBase(guest),
    units: unitNames(guest),
    ip: identity.nodes[0].internalIPs[0],
    probeName,
  });
}
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  const value = run(
    'ps',
    ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='],
    undefined,
    { allowStatusOne: true },
  )
    .toString()
    .trim();
  return value ? { hash: hash(value), command: value } : null;
}
function macOwned(state) {
  if (!state.macProcess) return false;
  const actual = processIdentity(state.macProcess.pid);
  if (!actual) return false;
  requireCondition(
    actual.hash === state.macProcess.identityHash &&
      actual.command.includes(resolve(directory, 'bin/dns-darwin-arm64')),
    'NETWORK_LAB_MAC_PID_IDENTITY_CHANGED',
  );
  return true;
}
function listenerOutput(args) {
  return run('lsof', ['-nP', ...args, '-Fpn'], undefined, { allowStatusOne: true }).toString();
}
function requireFreeMacPorts() {
  for (const args of [
    ['-iTCP:10553', '-sTCP:LISTEN'],
    ['-iUDP:10553'],
    ['-iTCP:18055', '-sTCP:LISTEN'],
  ])
    requireCondition(!listenerOutput(args).trim(), 'NETWORK_LAB_MAC_PORT_IN_USE');
}
async function startMac(state) {
  if (macOwned(state)) return;
  requireFreeMacPorts();
  const binary = resolve(directory, 'bin/dns-darwin-arm64');
  const output = openSync(resolve(directory, 'mac-dns.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(binary, dnsArgs('127.0.0.1:10553', '127.0.0.1:18055', state.ip), {
      detached: true,
      stdio: ['ignore', output, output],
      env: { PATH: process.env.PATH, GOMAXPROCS: '1' },
    });
    await new Promise((resolveSpawn, reject) => {
      child.once('spawn', resolveSpawn);
      child.once('error', () => reject(new LabError('NETWORK_LAB_MAC_START_FAILED')));
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  let identity;
  for (let attempt = 0; attempt < 20; attempt++) {
    identity = processIdentity(child.pid);
    if (identity?.command.includes(binary)) break;
    await delay(100);
  }
  requireCondition(identity?.command.includes(binary), 'NETWORK_LAB_MAC_START_FAILED');
  state.macProcess = {
    pid: child.pid,
    identityHash: identity.hash,
    startedAt: new Date().toISOString(),
  };
  saveJson(stateFile, state);
}
async function macStatus(state) {
  if (!macOwned(state)) return { state: 'stopped' };
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers(['127.0.0.1:10553']);
  const addresses = await resolver.resolve4(probeName);
  let ipv6 = [];
  try {
    ipv6 = await resolver.resolve6(probeName);
  } catch (error) {
    if (!['ENODATA', 'ENOTFOUND'].includes(error.code))
      throw new LabError('NETWORK_LAB_MAC_DNS_FAILED');
  }
  requireCondition(
    JSON.stringify(addresses) === JSON.stringify([state.ip]) && ipv6.length === 0,
    'NETWORK_LAB_MAC_DNS_ANSWER_MISMATCH',
  );
  const listeners = [
    listenerOutput(['-a', '-p', String(state.macProcess.pid), '-iTCP', '-sTCP:LISTEN']),
    listenerOutput(['-a', '-p', String(state.macProcess.pid), '-iUDP']),
  ].flatMap((text) =>
    text
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1)),
  );
  requireCondition(
    listeners.length === 3 &&
      listeners.every((address) => ['127.0.0.1:10553', '127.0.0.1:18055'].includes(address)),
    'NETWORK_LAB_UNEXPECTED_MAC_LISTENER',
  );
  for (const path of ['/add-http01', '/add-tlsalpn01']) {
    const response = await fetch(`http://127.0.0.1:18055${path}`, {
      signal: globalThis.AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    requireCondition(response.status === 404, 'NETWORK_LAB_HTTP_CHALLENGE_MOCK_ENABLED');
  }
  return {
    state: 'ready',
    pid: state.macProcess.pid,
    listeners,
    resolver: '127.0.0.1:10553',
    probeName,
    addresses,
    ipv6,
    httpChallengeMocksDisabled: true,
  };
}

const stopSource = String.raw`
import json, subprocess, sys
from pathlib import Path
request = json.load(sys.stdin)
base = Path(request['base'])
if Path('/etc/ozz-local-lab-instance').read_text().strip() != request['instance']:
    raise RuntimeError('NETWORK_LAB_INSTANCE_MISMATCH')
if not base.exists():
    print(json.dumps({'instance':request['instance'],'state':'absent'})); sys.exit(0)
if base.is_symlink() or (base / '.ozz-fixture').read_text() != request['owner']:
    raise RuntimeError('NETWORK_LAB_DIRECTORY_NOT_OWNED')
for name in request['units']:
    path = Path('/etc/systemd/system') / name
    if not path.exists() or not path.read_text().startswith('# Owner: '+request['owner']+'\n') or str(base) not in path.read_text():
        raise RuntimeError('NETWORK_LAB_UNIT_NOT_OWNED')
subprocess.run(['systemctl','stop',*request['units']],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
print(json.dumps({'instance':request['instance'],'state':'stopped','retainedDirectory':str(base),'units':request['units']}))
`;

async function status(state) {
  const identities = inspectGuests(state);
  const result = {
    owner,
    checkedAt: new Date().toISOString(),
    authority: 'local_test',
    identitiesUnchanged: true,
    existingResourcesUnchanged: state ? true : null,
    sharedConfigurationHashesUnchanged: state
      ? guests.every(
          (guest) =>
            JSON.stringify(state.identities[guest].configurationHashes) ===
            JSON.stringify(identities[guest].configurationHashes),
        )
      : null,
    systemCaBundles: Object.fromEntries(
      guests.map((guest) => [
        guest,
        {
          initialSha256:
            state?.identities[guest]?.configurationHashes['/etc/ssl/certs/ca-certificates.crt'] ??
            null,
          currentSha256:
            identities[guest].configurationHashes['/etc/ssl/certs/ca-certificates.crt'],
          usedToTrustFixture: false,
        },
      ]),
    ),
    identities: Object.fromEntries(
      guests.map((guest) => [
        guest,
        {
          instance: identities[guest].instance,
          kubeSystemUid: identities[guest].kubeSystemUid,
          nodes: identities[guest].nodes,
          baselineResourceCount: state?.identities[guest]?.resources.length ?? null,
        },
      ]),
    ),
    guests: Object.fromEntries(
      guests.map((guest) => [guest, guestStatus(guest, identities[guest])]),
    ),
    mac: state ? await macStatus(state) : { state: 'absent' },
    workerConfiguration: state ? resolve(directory, 'worker-test-config.json') : null,
    systemDnsModified: false,
    systemTrustModified: false,
    kubernetesWrites: false,
    issuanceVerified: false,
    http01Verified: false,
  };
  if (state) saveJson(resolve(directory, 'status.json'), result);
  return result;
}

async function start(state, seconds) {
  phase = 'verify-existing-identities';
  requireCondition(
    process.platform === 'darwin' && process.arch === 'arm64',
    'NETWORK_LAB_MAC_ARM64_REQUIRED',
  );
  const identities = inspectGuests(state);
  const ip = identities.a.nodes[0].internalIPs[0];
  safeDirectory(directory);
  if (!existsSync(markerFile)) save(markerFile, owner);
  state ??= { version: 1, owner, createdAt: new Date().toISOString(), identities, ip };
  saveJson(stateFile, state);
  phase = 'verify-pinned-assets';
  const assets = await ensureNetworkLabAssets({ verifyOnly: true });
  safeDirectory(resolve(directory, 'bin'));
  const binaries = {
    pebble: extractBinary(
      assets.paths.pebbleLinuxArm64,
      'pebble-linux-arm64/linux/arm64/pebble',
      resolve(directory, 'bin/pebble-linux-arm64'),
    ),
    dnsLinux: extractBinary(
      assets.paths.dnsLinuxArm64,
      'pebble-challtestsrv-linux-arm64/linux/arm64/pebble-challtestsrv',
      resolve(directory, 'bin/dns-linux-arm64'),
    ),
    dnsMac: extractBinary(
      assets.paths.dnsDarwinArm64,
      'pebble-challtestsrv-darwin-arm64/darwin/arm64/pebble-challtestsrv',
      resolve(directory, 'bin/dns-darwin-arm64'),
    ),
  };
  phase = 'prepare-local-transport-ca';
  const pki = preparePki(ip);
  state.pebbleVersion = assets.version;
  state.caFingerprint = pki.fingerprint;
  state.leafValiditySeconds = seconds;
  saveJson(stateFile, state);
  for (const guest of guests) {
    phase = `start-guest-${guest}`;
    const bundle = {
      pebble: readFileSync(binaries.pebble),
      'pebble-challtestsrv': readFileSync(binaries.dnsLinux),
      'ca.pem': readFileSync(pki.caFile),
      'ca.key': readFileSync(resolve(pki.pki, 'ca.key')),
      'server.pem': readFileSync(resolve(pki.pki, guest, 'server.pem')),
      'server.key': readFileSync(resolve(pki.pki, guest, 'server.key')),
      'staging.json': JSON.stringify(pebbleConfiguration(guest, 'staging', seconds), null, 2),
      'production.json': JSON.stringify(pebbleConfiguration(guest, 'production', seconds), null, 2),
      ...Object.fromEntries(
        ['dns', 'staging', 'production'].map((kind) => [
          `ozz-local-networking-${guest}-${kind}.service`,
          unit(guest, kind, ip),
        ]),
      ),
    };
    console.log(JSON.stringify({ phase, ...installGuest(guest, identities[guest], bundle) }));
  }
  phase = 'start-mac-dns';
  await startMac(state);
  saveJson(resolve(directory, 'worker-test-config.json'), {
    version: 1,
    stagingUrl: `https://${ip}:14000/dir`,
    productionUrl: `https://${ip}:14100/dir`,
    caBundle: readFileSync(pki.caFile, 'utf8'),
    solverNameservers: [`${ip}:1053`],
  });
  phase = 'verify-fixture';
  let evidence;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      evidence = await status(state);
      if (
        evidence.mac.state === 'ready' &&
        Object.values(evidence.guests).every((guest) => guest.state === 'ready')
      )
        break;
    } catch (error) {
      if (
        ![
          'NETWORK_LAB_MISSING_GUEST_LISTENER',
          'NETWORK_LAB_SSH_FAILED',
          'ECONNREFUSED',
          'ETIMEOUT',
        ].includes(error.code)
      )
        throw error;
    }
    await delay(300);
  }
  requireCondition(
    evidence?.mac.state === 'ready' &&
      Object.values(evidence.guests).every((guest) => guest.state === 'ready'),
    'NETWORK_LAB_NOT_READY',
  );
  saveJson(resolve(directory, 'last-start.json'), {
    ...evidence,
    startedAt: new Date().toISOString(),
    caFingerprint: state.caFingerprint,
    leafValiditySeconds: seconds,
  });
  return evidence;
}

async function stop(state) {
  phase = 'verify-stop-ownership';
  const identities = inspectGuests(state);
  const stopped = {};
  if (state && macOwned(state)) {
    process.kill(state.macProcess.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 30 && macOwned(state); attempt++) await delay(100);
    requireCondition(!macOwned(state), 'NETWORK_LAB_MAC_STOP_TIMEOUT');
    state.macProcess = null;
    saveJson(stateFile, state);
  }
  for (const guest of guests)
    stopped[guest] = remotePython(guest, stopSource, {
      owner,
      instance: identities[guest].instance,
      base: remoteBase(guest),
      units: unitNames(guest).toReversed(),
    });
  const result = {
    owner,
    stoppedAt: new Date().toISOString(),
    guests: stopped,
    dataRetained: true,
    identitiesUnchanged: true,
  };
  if (state) saveJson(resolve(directory, 'last-stop.json'), result);
  return result;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'leaf-seconds': { type: 'string', default: '240' } },
  });
  requireCondition(
    positionals.length === 1 && ['start', 'status', 'stop'].includes(positionals[0]),
    'NETWORK_LAB_USAGE_START_STATUS_STOP',
  );
  const seconds = Number(values['leaf-seconds']);
  requireCondition(
    Number.isSafeInteger(seconds) && seconds >= 180 && seconds <= 300,
    'NETWORK_LAB_LEAF_SECONDS_RANGE',
  );
  const state = readState();
  const result =
    positionals[0] === 'start'
      ? await start(state, seconds)
      : positionals[0] === 'stop'
        ? await stop(state)
        : await status(state);
  console.log(JSON.stringify({ action: positionals[0], ...result }));
} catch (error) {
  const result = { phase, status: 'failed', code: error.code ?? 'NETWORK_LAB_UNEXPECTED_FAILURE' };
  if (existsSync(markerFile) && readFileSync(markerFile, 'utf8').trim() === owner)
    saveJson(resolve(directory, 'last-error.json'), { ...result, at: new Date().toISOString() });
  console.error(JSON.stringify(result));
  process.exitCode = 1;
}
