import { K3S_VERSION, k3sAssets } from './assets.js';
import { pythonCommon } from './preflight-script.js';

interface InstallationIntent {
  installationId: string;
  machineId: string;
  nodeName: string;
  apiEndpoint: string;
  apiHostname: string;
  timeoutSeconds: number;
}

export function initializeScript(intent: InstallationIntent): string {
  const encoded = Buffer.from(
    JSON.stringify({ ...intent, version: K3S_VERSION, assets: k3sAssets }),
  ).toString('base64');
  return (
    pythonCommon +
    `\nINTENT = json.loads(base64.b64decode('${encoded}'))\n` +
    String.raw`
import fcntl
import signal
import ssl
import tempfile
import urllib.request
import uuid

STARTED = time.monotonic()
DEADLINE = STARTED + INTENT['timeoutSeconds']
CACHE = '/var/cache/ozz/k3s'
STATE = '/var/lib/ozz/bootstrap'

UNIT = '''[Unit]
Description=Ozz managed K3s server
Documentation=https://docs.k3s.io/
Wants=network-online.target
After=network-online.target
Conflicts=shutdown.target

[Service]
Type=notify
KillMode=process
Delegate=yes
Restart=always
RestartSec=5s
LimitNOFILE=1048576
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
TimeoutStartSec=0
ExecStartPre=-/sbin/modprobe br_netfilter
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/local/bin/k3s server --config /etc/rancher/k3s/config.yaml

[Install]
WantedBy=multi-user.target
'''

def check_deadline():
    if time.monotonic() >= DEADLINE:
        raise SafeFailure('SSH_TIMEOUT')

def progress(stage):
    check_deadline()
    emit({'type': 'progress', 'stage': stage})

def owned_directory(path, create=False):
    # Do not follow links into another directory, or use a path writable by another account.
    current = '/'
    for part in path.strip('/').split('/'):
        current = os.path.join(current, part)
        if not os.path.lexists(current):
            if not create:
                raise SafeFailure('SSH_INSTALLATION_CONFLICT')
            os.mkdir(current, 0o700)
        value = os.lstat(current)
        if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
            raise SafeFailure('SSH_INSTALLATION_CONFLICT')

def atomic_file(path, content, mode):
    owned_directory(os.path.dirname(path), create=True)
    if os.path.lexists(path) and not safe_owned_file(path):
        raise SafeFailure('SSH_INSTALLATION_CONFLICT')
    temporary = path + '.ozz-' + uuid.uuid4().hex
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def digest_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        while True:
            check_deadline()
            block = stream.read(1024 * 1024)
            if not block:
                return digest.hexdigest()
            digest.update(block)

def matches_asset(path, asset):
    return (os.path.lexists(path) and safe_owned_file(path) and os.stat(path).st_size == asset['bytes']
            and digest_file(path) == asset['sha256'])

def fetch_asset(asset):
    check_deadline()
    owned_directory(CACHE, create=True)
    target = os.path.join(CACHE, asset['sha256'])
    if os.path.lexists(target):
        if matches_asset(target, asset):
            return target
        # Preserve a mismatched cache entry for explicit review; never execute it.
        raise SafeFailure('SSH_ASSET_VERIFY_FAILED')
    for address in (asset['url'], asset['apiUrl']):
        check_deadline()
        temporary = os.path.join(CACHE, '.download-' + uuid.uuid4().hex)
        try:
            request = urllib.request.Request(address, headers={
                'Accept': 'application/octet-stream', 'User-Agent': 'ozz-pinned-k3s-installer/1',
                'X-GitHub-Api-Version': '2022-11-28',
            })
            digest = hashlib.sha256()
            received = 0
            with urllib.request.urlopen(request, timeout=20, context=ssl.create_default_context()) as response:
                if not response.url.startswith('https://'):
                    raise SafeFailure('SSH_ASSET_DOWNLOAD_FAILED')
                advertised = response.headers.get('Content-Length')
                if advertised and int(advertised) != asset['bytes']:
                    raise SafeFailure('SSH_ASSET_VERIFY_FAILED')
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, 'wb') as stream:
                    while True:
                        check_deadline()
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        received += len(block)
                        if received > asset['bytes']:
                            raise SafeFailure('SSH_ASSET_VERIFY_FAILED')
                        stream.write(block)
                        digest.update(block)
                    stream.flush()
                    os.fsync(stream.fileno())
            if received != asset['bytes'] or digest.hexdigest() != asset['sha256']:
                raise SafeFailure('SSH_ASSET_VERIFY_FAILED')
            os.replace(temporary, target)
            return target
        except SafeFailure:
            raise
        except Exception:
            # Retry only the other pinned official location; never print transport exceptions.
            pass
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    raise SafeFailure('SSH_ASSET_DOWNLOAD_FAILED')

def place_asset(source, target, asset, mode):
    owned_directory(os.path.dirname(target), create=True)
    if os.path.lexists(target):
        if not matches_asset(target, asset):
            raise SafeFailure('SSH_INSTALLATION_CONFLICT')
        return
    temporary = target + '.ozz-' + uuid.uuid4().hex
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with open(source, 'rb') as reader, os.fdopen(descriptor, 'wb') as writer:
            while True:
                check_deadline()
                block = reader.read(1024 * 1024)
                if not block:
                    break
                writer.write(block)
            writer.flush()
            os.fsync(writer.fileno())
        if not matches_asset(temporary, asset):
            raise SafeFailure('SSH_ASSET_VERIFY_FAILED')
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def place_config(path, content, mode):
    encoded = content.encode('utf-8')
    if os.path.lexists(path):
        if not safe_owned_file(path) or read_text(path) != content.strip():
            raise SafeFailure('SSH_INSTALLATION_CONFLICT')
    else:
        atomic_file(path, encoded, mode)

def save_marker(marker, phase):
    marker['phase'] = phase
    atomic_file(MARKER, (json.dumps(marker, sort_keys=True) + '\n').encode('utf-8'), 0o600)

def require_systemctl(args):
    check_deadline()
    code, _output = run_checked(['/usr/bin/systemctl'] + args, 20)
    if code != 0:
        raise SafeFailure('SSH_INSTALL_VERIFY_FAILED')

def wait_ready():
    ready_deadline = min(DEADLINE, time.monotonic() + 240)
    while time.monotonic() < ready_deadline:
        check_deadline()
        base = ['/usr/local/bin/k3s', 'kubectl', '--kubeconfig', '/etc/rancher/k3s/k3s.yaml', '--request-timeout=5s']
        code, output = run_checked(base + ['get', '--raw=/readyz'])
        if code == 0 and output.strip() == 'ok':
            code, output = run_checked(base + ['get', 'node', INTENT['nodeName'], '-o', 'json'])
            if code == 0:
                try:
                    node = json.loads(output)
                    if any(condition.get('type') == 'Ready' and condition.get('status') == 'True'
                           for condition in node.get('status', {}).get('conditions', [])):
                        return
                except (ValueError, AttributeError, TypeError):
                    pass
        time.sleep(2)
    raise SafeFailure('SSH_NOT_READY')

def wait_encryption():
    # Kubernetes Node readiness can precede the supervisor's encryption-status
    # endpoint on first boot. Observe a bounded interval without changing config.
    deadline = min(DEADLINE, time.monotonic() + 30)
    while time.monotonic() < deadline:
        check_deadline()
        if encryption_observation() == 'enabled':
            return
        time.sleep(1)
    raise SafeFailure('SSH_ENCRYPTION_NOT_ENABLED')

def initialize():
    if os.geteuid() != 0:
        raise SafeFailure('SSH_PRIVILEGE_REQUIRED')
    observation = inspect_host()
    if observation['machineId'] != INTENT['machineId']:
        raise SafeFailure('SSH_IDENTITY_CHANGED')
    if observation['blockers']:
        raise SafeFailure('SSH_PREFLIGHT_BLOCKED')
    before_marker = read_marker()
    if observation['k3s']['installed'] and before_marker is None:
        raise SafeFailure('SSH_K3S_ALREADY_INSTALLED')
    owned_directory(STATE, create=True)
    lock_path = os.path.join(STATE, 'k3s-install.lock')
    if os.path.lexists(lock_path) and not safe_owned_file(lock_path):
        raise SafeFailure('SSH_INSTALLATION_CONFLICT')
    lock = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SafeFailure('SSH_INSTALL_BUSY')
        # Repeat identity and installation checks while holding a host-local lock.
        observation = inspect_host()
        if observation['machineId'] != INTENT['machineId']:
            raise SafeFailure('SSH_IDENTITY_CHANGED')
        if observation['blockers']:
            raise SafeFailure('SSH_PREFLIGHT_BLOCKED')
        marker = read_marker()
        if observation['k3s']['installed'] and marker is None:
            raise SafeFailure('SSH_K3S_ALREADY_INSTALLED')
        # A matching primary file must not hide additional, unowned configuration.
        if any(os.path.lexists(path) for path in (
                '/etc/rancher/k3s/config.yaml.d',
                '/etc/systemd/system/k3s.service.d', '/run/systemd/system/k3s.service.d',
                '/usr/lib/systemd/system/k3s.service.d')):
            raise SafeFailure('SSH_INSTALLATION_CONFLICT')
        assets = INTENT['assets'][observation['architecture']]
        config = json.dumps({'node-name': INTENT['nodeName'], 'write-kubeconfig-mode': '0600',
                             'secrets-encryption': True, 'tls-san': sorted(set([INTENT['apiHostname'], '127.0.0.1']))},
                            sort_keys=True, indent=2) + '\n'
        expected = {
            'scriptVersion': 1, 'installationId': INTENT['installationId'],
            'machineId': INTENT['machineId'], 'version': INTENT['version'],
            'nodeName': INTENT['nodeName'], 'apiEndpoint': INTENT['apiEndpoint'],
            'architecture': observation['architecture'],
            'binarySha256': assets['binary']['sha256'], 'imagesSha256': assets['images']['sha256'],
            'configSha256': hashlib.sha256(config.encode('utf-8')).hexdigest(),
            'unitSha256': hashlib.sha256(UNIT.encode('utf-8')).hexdigest(),
        }
        resumed = marker is not None
        if marker is not None and marker['intent'] != expected:
            raise SafeFailure('SSH_INSTALLATION_CONFLICT')
        if marker is None:
            marker = {'intent': expected, 'phase': 'prepared', 'createdAt': int(time.time())}
            save_marker(marker, 'prepared')
        # Existing files must match before any downloads or configuration changes.
        for path, asset in (('/usr/local/bin/k3s', assets['binary']),
                            ('/var/lib/rancher/k3s/agent/images/ozz-pinned-images.tar.zst', assets['images'])):
            if os.path.lexists(path) and not matches_asset(path, asset):
                raise SafeFailure('SSH_INSTALLATION_CONFLICT')
        for path, content in (('/etc/rancher/k3s/config.yaml', config), ('/etc/systemd/system/k3s.service', UNIT)):
            if os.path.lexists(path) and (not safe_owned_file(path) or read_text(path) != content.strip()):
                raise SafeFailure('SSH_INSTALLATION_CONFLICT')
        progress('downloading')
        binary = fetch_asset(assets['binary'])
        images = fetch_asset(assets['images'])
        progress('installing')
        place_asset(binary, '/usr/local/bin/k3s', assets['binary'], 0o755)
        place_asset(images, '/var/lib/rancher/k3s/agent/images/ozz-pinned-images.tar.zst', assets['images'], 0o600)
        place_config('/etc/rancher/k3s/config.yaml', config, 0o600)
        place_config('/etc/systemd/system/k3s.service', UNIT, 0o644)
        if marker['phase'] != 'ready':
            save_marker(marker, 'installed')
        progress('starting')
        require_systemctl(['daemon-reload'])
        require_systemctl(['enable', 'k3s'])
        require_systemctl(['start', '--no-block', 'k3s'])
        progress('waiting_ready')
        wait_ready()
        progress('verifying_encryption')
        wait_encryption()
        code, output = run_checked(['/usr/local/bin/k3s', '--version'])
        if code != 0 or not output.startswith('k3s version ' + INTENT['version'] + ' '):
            raise SafeFailure('SSH_INSTALL_VERIFY_FAILED')
        code, output = run_checked(['/usr/local/bin/k3s', 'kubectl', '--kubeconfig', '/etc/rancher/k3s/k3s.yaml',
                                    'config', 'view', '--raw', '--flatten', '-o', 'json'])
        if code != 0:
            raise SafeFailure('SSH_INSTALL_VERIFY_FAILED')
        credential = json.loads(output)
        if any(len(credential.get(key, [])) != 1 for key in ('clusters', 'contexts', 'users')):
            raise SafeFailure('SSH_INVALID_RESPONSE')
        credential['clusters'][0]['cluster']['server'] = INTENT['apiEndpoint']
        save_marker(marker, 'ready')
        # This frame is consumed only by the adapter's required encryption callback.
        emit({'type': 'credential', 'kubeconfig': credential})
        emit({'type': 'initialized', 'data': {
            'installationId': INTENT['installationId'], 'machineId': INTENT['machineId'],
            'architecture': observation['architecture'], 'version': INTENT['version'],
            'nodeName': INTENT['nodeName'], 'apiEndpoint': INTENT['apiEndpoint'],
            'secretsEncryption': 'enabled', 'resumed': resumed,
        }})
    finally:
        os.close(lock)

try:
    initialize()
except SafeFailure as error:
    emit({'type': 'error', 'code': error.code})
    sys.exit(1)
except Exception:
    emit({'type': 'error', 'code': 'SSH_REMOTE_FAILED'})
    sys.exit(1)
`
  );
}
