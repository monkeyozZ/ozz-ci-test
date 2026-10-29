/** Fixed read-only program, transported on stdin. No credential or host enters a shell command. */
export const pythonCommon = String.raw`
import base64
import hashlib
import json
import os
import platform
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time

os.environ.clear()
os.environ.update({'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
MARKER = '/var/lib/ozz/bootstrap/k3s-installation.json'
K3S_PATHS = (
    '/usr/local/bin/k3s', '/usr/bin/k3s', '/etc/rancher/k3s', '/var/lib/rancher/k3s',
    '/etc/systemd/system/k3s.service', '/usr/lib/systemd/system/k3s.service',
    '/etc/systemd/system/k3s-agent.service', '/usr/lib/systemd/system/k3s-agent.service',
    '/etc/kubernetes', '/var/lib/kubelet',
)

class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code

def stop_signal(_signal, _frame):
    # Raise through run_checked so its owned subprocess group is also reaped.
    raise SafeFailure('SSH_CANCELLED')

signal.signal(signal.SIGTERM, stop_signal)
signal.signal(signal.SIGHUP, stop_signal)
signal.signal(signal.SIGINT, stop_signal)

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

def read_text(path, limit=65536):
    with open(path, encoding='utf-8') as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise SafeFailure('SSH_INVALID_RESPONSE')
    return value.strip()

def run_checked(args, timeout=8):
    # Only fixed programs and typed values use this helper. Never invoke a shell.
    child = None
    try:
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        output = bytearray()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return 124, ''
                for key, _events in selector.select(min(remaining, 0.2)):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                        break
                    output.extend(block)
                    if len(output) > 262144:
                        raise SafeFailure('SSH_OUTPUT_LIMIT')
        try:
            status = child.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            return 124, ''
        return status, output.decode('utf-8', errors='replace')
    except OSError:
        return 127, ''
    finally:
        if child is not None:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=1)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait(timeout=1)
            child.stdout.close()

def safe_owned_file(path):
    value = os.lstat(path)
    return stat.S_ISREG(value.st_mode) and value.st_uid == 0 and not value.st_mode & 0o022

def read_marker():
    if not os.path.lexists(MARKER):
        return None
    if not safe_owned_file(MARKER):
        raise SafeFailure('SSH_INSTALLATION_CONFLICT')
    value = json.loads(read_text(MARKER, 8192))
    if not isinstance(value, dict) or not isinstance(value.get('intent'), dict) or value.get('phase') not in ('prepared', 'installed', 'ready'):
        raise SafeFailure('SSH_INSTALLATION_CONFLICT')
    return value

def architecture():
    return {'aarch64': 'arm64', 'x86_64': 'amd64'}.get(platform.machine(), 'unsupported')

def port_observation():
    listeners = {'tcp': set(), 'udp': set()}
    for protocol in listeners:
        for family in ('', '6'):
            path = '/proc/net/' + protocol + family
            if not os.path.exists(path):
                continue
            with open(path, encoding='ascii') as stream:
                next(stream)
                for line in stream:
                    fields = line.split()
                    if len(fields) >= 4 and (protocol == 'udp' or fields[3] == '0A'):
                        listeners[protocol].add(int(fields[1].rsplit(':', 1)[1], 16))
    return [{'protocol': protocol, 'port': port, 'listening': port in listeners[protocol]}
            for protocol, ports in (('tcp', (22, 80, 443, 6443, 10250)), ('udp', (8472,)))
            for port in ports]

def memory_cgroup():
    if os.path.isfile('/sys/fs/cgroup/cgroup.controllers'):
        return 'memory' in read_text('/sys/fs/cgroup/cgroup.controllers').split()
    return any(line.split()[0] == 'memory' and line.split()[-1] == '1'
               for line in read_text('/proc/cgroups').splitlines() if line and not line.startswith('#'))

def encryption_observation():
    if os.geteuid() != 0 or not os.path.isfile('/usr/local/bin/k3s'):
        return 'unknown'
    code, output = run_checked(['/usr/local/bin/k3s', 'secrets-encrypt', 'status', '--output', 'json'])
    if code != 0:
        return 'unknown'
    try:
        status = json.loads(output)
        if not isinstance(status, dict):
            return 'unknown'
        if status.get('enable') is True:
            return 'enabled'
        if status.get('enable') is False:
            return 'disabled'
    except (ValueError, TypeError):
        pass
    return 'unknown'

def inspect_host():
    release = {}
    for line in read_text('/etc/os-release').splitlines():
        key, separator, value = line.partition('=')
        if separator:
            release[key] = value.strip('"')
    memory = {}
    for line in read_text('/proc/meminfo').splitlines():
        key, value = line.split(':', 1)
        memory[key] = int(value.strip().split()[0]) * 1024
    root_disk = shutil.disk_usage('/')
    data_path = '/var/lib/rancher/k3s'
    while not os.path.isdir(data_path):
        data_path = os.path.dirname(data_path)
    data_disk = shutil.disk_usage(data_path)
    installed = any(os.path.lexists(path) for path in K3S_PATHS)
    marker = read_marker() if os.geteuid() == 0 else None
    version = None
    binary = shutil.which('k3s')
    if binary:
        code, output = run_checked([binary, '--version'])
        match = re.search(r'^k3s version (v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+)(?:\s|$)', output, re.MULTILINE)
        if code == 0 and match:
            version = match.group(1)
    firewall = 'unknown'
    if os.geteuid() == 0 and os.path.isfile('/usr/sbin/ufw'):
        code, output = run_checked(['/usr/sbin/ufw', 'status'], 5)
        if code == 0:
            if output.startswith('Status: active'):
                firewall = 'active'
            elif output.startswith('Status: inactive'):
                firewall = 'inactive'
    result = {
        'machineId': read_text('/etc/machine-id', 128),
        'hostname': platform.node(), 'os': release.get('ID', 'unknown'),
        'osVersion': release.get('VERSION_ID', 'unknown'), 'architecture': architecture(),
        'kernel': platform.release(), 'init': read_text('/proc/1/comm', 128),
        'cpuCount': os.cpu_count() or 0,
        'memoryBytes': memory.get('MemTotal', 0), 'memoryAvailableBytes': memory.get('MemAvailable', 0),
        'rootDiskBytes': root_disk.total, 'rootDiskAvailableBytes': root_disk.free,
        'dataDiskBytes': data_disk.total, 'dataDiskAvailableBytes': data_disk.free,
        'privileged': os.geteuid() == 0, 'memoryCgroupAvailable': memory_cgroup(),
        'systemdAvailable': os.path.isfile('/usr/bin/systemctl') and os.path.isdir('/run/systemd/system'),
        'ports': port_observation(), 'firewall': firewall,
        'k3s': {'installed': installed, 'version': version,
                'installationId': marker['intent'].get('installationId') if marker else None,
                'installationPhase': marker['phase'] if marker else None,
                'secretsEncryption': encryption_observation() if installed else 'unknown'},
    }
    result['blockers'] = installation_blockers(result)
    result['warnings'] = ['cloud_firewall_unknown']
    if result['memoryBytes'] < 4 * 1024 ** 3:
        result['warnings'].append('low_memory_headroom')
    if result['dataDiskAvailableBytes'] < 20 * 1024 ** 3:
        result['warnings'].append('low_disk_headroom')
    if firewall != 'inactive':
        result['warnings'].append('firewall_requires_review')
    if installed:
        result['warnings'].append('existing_k3s')
    return result

def installation_blockers(result):
    blockers = []
    checks = (
        (result['os'] != 'ubuntu' or result['osVersion'] != '24.04', 'unsupported_os'),
        (result['architecture'] not in ('arm64', 'amd64'), 'unsupported_architecture'),
        (result['init'] != 'systemd' or not result['systemdAvailable'], 'systemd_required'),
        (not result['privileged'], 'privilege_required'),
        (not result['memoryCgroupAvailable'], 'memory_cgroup_required'),
        (result['cpuCount'] < 2, 'insufficient_cpu'),
        (result['memoryBytes'] < 2000000000, 'insufficient_memory'),
        (result['dataDiskAvailableBytes'] < 8 * 1024 ** 3, 'insufficient_disk'),
        (not result['k3s']['installed'] and any(value['listening'] and value['port'] != 22 for value in result['ports']), 'ports_in_use'),
    )
    for failed, code in checks:
        if failed:
            blockers.append(code)
    return blockers
`;

export const preflightScript =
  pythonCommon +
  String.raw`
try:
    emit({'type': 'preflight', 'data': inspect_host()})
except SafeFailure as error:
    emit({'type': 'error', 'code': error.code})
    sys.exit(1)
except Exception:
    emit({'type': 'error', 'code': 'SSH_REMOTE_FAILED'})
    sys.exit(1)
`;

// Read an explicit byte count instead of waiting for stdin EOF. ssh2 only sends
// channel signals while its write side remains open, including after script upload.
// The loader and command are fixed; no target, credential or option enters the shell.
const pythonLoader =
  'import sys; size=int(sys.stdin.buffer.readline(32)); assert 0<size<=262144; source=sys.stdin.buffer.read(size); assert len(source)==size; exec(compile(source,"<reviewed-script>","exec"))';
const pythonInvocation = `/usr/bin/python3 -c '${pythonLoader}'`;
export const pythonCommand = `if [ "$(/usr/bin/id -u)" = 0 ]; then exec ${pythonInvocation}; elif /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then exec /usr/bin/sudo -n ${pythonInvocation}; else exec ${pythonInvocation}; fi`;
