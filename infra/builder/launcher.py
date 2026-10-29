#!/usr/bin/python3 -I
"""Constrained root launcher for a *dedicated* Builder Linux host.

Only the manager UID may invoke this through the installed sudo rule. A fixed
root-owned configuration selects tools, identities and egress policy. Root
does not execute source: git, rootless BuildKit and skopeo run in three distinct
unprivileged systemd services with a fixed-size ext4 execution filesystem.
"""
import contextlib
import codecs
import datetime
import fcntl
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse
import uuid

CONFIG = Path('/etc/ozz-builder/host.json')
ROOT = Path('/var/lib/ozz-builder/host')
RUNTIME = ROOT / 'runs'
ARTIFACTS = ROOT / 'artifacts'
HELPER = '/usr/local/libexec/ozz-builder-phase'
ENTRY = '/usr/local/libexec/ozz-builder-enter'
PHASES = {'checkout': 'checkoutUid', 'building': 'solveUid', 'pushing': 'uploadUid'}
MEDIA_MANIFEST = {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'}
MEDIA_INDEX = {'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def remaining_runtime(deadline):
    # systemd accepts microseconds. Never round down to whole seconds: that can
    # kill the phase before the manager's deadline and sign an ordinary failure
    # instead of a timeout. The independent watchdog still enforces the deadline.
    return str(max(1, math.ceil((timestamp(deadline) - time.time()) * 1000000))) + 'us'


def canonical(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True, ensure_ascii=False)


def digest_file(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def run(argv, *, input=None, check=True, timeout=30):
    return subprocess.run(argv, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=check, timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})


def secure_read(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('BUILD_HOST_CONFIGURATION_UNTRUSTED')
    return json.loads(path.read_text())


def atomic(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name('.' + str(uuid.uuid4()) + '.tmp')
    with temporary.open('x') as handle:
        os.chmod(temporary, 0o600)
        handle.write(canonical(value))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def lock(path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.open('a') as handle:
        os.chmod(path, 0o600)
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def run_paths(run_id):
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', run_id):
        raise RuntimeError('BUILD_RUN_INVALID')
    directory = RUNTIME / run_id
    return directory, directory / 'state.json', 'ozz' + run_id.replace('-', '')


def validate_build_http_proxy(value, resolver=None):
    if type(value) is not dict or set(value) != {'url', 'addresses'}:
        raise RuntimeError('BUILD_HTTP_PROXY_CONFIGURATION_INVALID')
    url, addresses = value['url'], value['addresses']
    if (type(url) is not str or not 1 <= len(url) <= 512 or
            any(ord(character) < 33 or ord(character) > 126 for character in url) or
            type(addresses) is not list or not 1 <= len(addresses) <= 8):
        raise RuntimeError('BUILD_HTTP_PROXY_CONFIGURATION_INVALID')
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
        hostname = parsed.hostname
    except ValueError:
        raise RuntimeError('BUILD_HTTP_PROXY_CONFIGURATION_INVALID') from None
    if (parsed.scheme != 'http' or parsed.username is not None or parsed.password is not None or
            parsed.path or parsed.query or parsed.fragment or not port or
            not hostname or len(hostname) > 253 or
            any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in hostname.split('.')) or
            parsed.netloc != hostname + ':' + str(port) or url != 'http://' + hostname + ':' + str(port)):
        raise RuntimeError('BUILD_HTTP_PROXY_CONFIGURATION_INVALID')
    if re.fullmatch(r'[0-9.]+', hostname):
        try:
            if str(ipaddress.IPv4Address(hostname)) != hostname:
                raise ValueError()
        except ValueError:
            raise RuntimeError('BUILD_HTTP_PROXY_CONFIGURATION_INVALID') from None
    private = tuple(ipaddress.IPv4Network(network) for network in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
    approved = set()
    for address in addresses:
        try:
            ip = ipaddress.IPv4Address(address) if type(address) is str else None
        except ValueError:
            ip = None
        if (ip is None or str(ip) != address or address in approved or
                ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified or
                not (ip.is_global or any(ip in network for network in private))):
            raise RuntimeError('BUILD_HTTP_PROXY_ADDRESS_INVALID')
        approved.add(address)
    try:
        resolved = {item[4][0] for item in (resolver or socket.getaddrinfo)(hostname, port, socket.AF_INET, socket.SOCK_STREAM)}
    except (OSError, ValueError):
        raise RuntimeError('BUILD_HTTP_PROXY_DNS_FAILED') from None
    if resolved != approved:
        raise RuntimeError('BUILD_HTTP_PROXY_ADDRESS_CHANGED')
    return {'url': url, 'addresses': sorted(approved)}


def load_request(run_id, request, config):
    spec = request['spec']
    if spec['runId'] != run_id or spec['installationId'] != config['installationId'] or spec['profile'] != config['profile']:
        raise RuntimeError('BUILD_IDENTITY_MISMATCH')
    if spec['action'] not in ('build_and_push', 'push_existing') or not re.fullmatch(r'[0-9a-f]{40}', spec['source']['commitSha']):
        raise RuntimeError('BUILD_SPEC_INVALID')
    if spec['source']['platforms'] != [config['platform']]:
        # Native-only profile: no unverified emulation/binfmt setup is accepted.
        raise RuntimeError('BUILD_PLATFORM_UNSUPPORTED')
    for key in ('cpuMillis', 'memoryMiB', 'pids', 'timeoutSeconds'):
        if not isinstance(spec['limits'][key], int) or spec['limits'][key] <= 0 or spec['limits'][key] > config['limits'][key]:
            raise RuntimeError('BUILD_LIMIT_EXCEEDED')
    if not 1048576 <= int(spec['limits']['diskBytes']) <= int(config['limits']['diskBytes']):
        raise RuntimeError('BUILD_LIMIT_EXCEEDED')
    if not re.fullmatch(r'[a-z0-9.-]+(?::[1-9][0-9]{0,4})?', spec['destination']['authority']) or not re.fullmatch(r'[a-z0-9][a-z0-9._/-]{0,254}', spec['destination']['repository']):
        raise RuntimeError('BUILD_DESTINATION_INVALID')
    return spec, hashlib.sha256(canonical(spec).encode()).hexdigest()


def check_tools(config):
    for tool in config['tools'].values():
        path = Path(tool['path'])
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or digest_file(path) != tool['sha256']:
            raise RuntimeError('BUILD_TOOL_IDENTITY_MISMATCH')


def preflight(config):
    if platform.system() != 'Linux' or Path('/sys/fs/cgroup/cgroup.controllers').read_text().split().count('memory') != 1:
        raise RuntimeError('BUILD_CGROUP_V2_REQUIRED')
    for controller in ('cpu', 'memory', 'pids'):
        if controller not in Path('/sys/fs/cgroup/cgroup.controllers').read_text().split():
            raise RuntimeError('BUILD_RESOURCE_CONTROLLER_REQUIRED')
    ids = [config[key] for key in ('managerUid', 'checkoutUid', 'solveUid', 'uploadUid')]
    if len(set(ids)) != 4 or any(value < 1000 for value in ids):
        raise RuntimeError('BUILD_SEPARATE_UIDS_REQUIRED')
    if not Path('/dev/loop-control').exists() or 'ext4' not in Path('/proc/filesystems').read_text():
        raise RuntimeError('BUILD_HARD_DISK_QUOTA_REQUIRED')
    check_tools(config)
    if 'buildHttpProxy' in config:
        validate_build_http_proxy(config['buildHttpProxy'])
    run(['nft', 'list', 'tables'])
    run(['systemctl', 'is-active', '--quiet', 'ozz-builder-watchdog.timer'])
    name = pwd.getpwuid(config['solveUid']).pw_name
    # A real user namespace/pid namespace probe, not merely a sysctl check.
    probe = run(['runuser', '-u', name, '--', config['tools']['rootlesskit']['path'],
                 '--net=none', '--pidns', '/usr/bin/cat', '/proc/self/uid_map'], timeout=15).stdout.decode()
    maps = [[int(number) for number in line.split()] for line in probe.strip().splitlines()]
    if not maps or any(outer == 0 for _, outer, _ in maps):
        raise RuntimeError('BUILD_ROOTLESS_REQUIRED')
    return {'profile': config['profile'], 'platform': config['platform'], 'limits': config['limits'],
            'maxConcurrency': 1, 'isolation': {key: True for key in (
                'rootless', 'processSandbox', 'separateUids', 'cgroupV2',
                'hardDiskQuota', 'egressPolicy', 'independentWatchdog')}}


def network_rules(prefix, phase, spec, credentials, config):
    device = 'v' + prefix[3:14]
    proxy = validate_build_http_proxy(config['buildHttpProxy']) if phase == 'building' and 'buildHttpProxy' in config else None
    origins = []
    if phase == 'checkout':
        parsed = urllib.parse.urlsplit(credentials['cloneUrl'])
        origin = parsed.scheme + '://' + parsed.netloc
        if origin not in config['trustedCloneOrigins'] or parsed.path != '/' + credentials['fullName'] + '.git' or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise RuntimeError('BUILD_CLONE_ORIGIN_REJECTED')
        origins = [origin]
    elif phase == 'pushing':
        origins = ['https://' + spec['destination']['authority'], *credentials.get('tokenServiceOrigins', [])]
        if any(origin not in config['trustedUploadOrigins'] for origin in origins):
            raise RuntimeError('BUILD_UPLOAD_ORIGIN_REJECTED')
    allowed = []
    for origin in origins:
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.path not in ('', '/'):
            raise RuntimeError('BUILD_EGRESS_ORIGIN_INVALID')
        addresses = sorted({info[4][0] for info in socket.getaddrinfo(parsed.hostname, parsed.port or 443, socket.AF_INET, socket.SOCK_STREAM)})
        for address in addresses:
            ip = ipaddress.ip_address(address)
            approved = config.get('privateEgress', {}).get(origin, [])
            if not ip.is_global and address not in approved:
                raise RuntimeError('BUILD_PRIVATE_EGRESS_REJECTED')
            allowed.append(f'iifname "{device}" ip daddr {ip} tcp dport {parsed.port or 443} accept')
    proxy_url = None
    if proxy:
        port = urllib.parse.urlsplit(proxy['url']).port
        allowed += [f'iifname "{device}" ip daddr {address} tcp dport {port} accept' for address in proxy['addresses']]
        # The helper connects to a pinned address; it cannot resolve the proxy hostname again.
        proxy_url = 'http://' + proxy['addresses'][0] + ':' + str(port)
    blocked = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
               '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4']
    for network in config.get('blockedNetworks', []):
        blocked.append(str(ipaddress.IPv4Network(network)))
    blocked = [str(network) for network in ipaddress.collapse_addresses(ipaddress.IPv4Network(value) for value in blocked)]
    dns_ip = str(ipaddress.IPv4Address(config['dnsServer']))
    table = prefix
    dns_rules = [] if proxy else [f'iifname "{device}" ip daddr {dns_ip} udp dport 53 accept',
                                 f'iifname "{device}" ip daddr {dns_ip} tcp dport 53 accept']
    rules = [f'table inet {table} {{ chain input {{ type filter hook input priority -10; policy accept;',
             *allowed, f'iifname "{device}" drop', '}',
             'chain forward { type filter hook forward priority -10; policy accept;',
             *dns_rules, *allowed,
             f'iifname "{device}" ip daddr {{ ' + ', '.join(blocked) + ' } drop']
    if phase == 'building' and not proxy:
        rules.append(f'iifname "{device}" meta nfproto ipv4 tcp dport {{ 80, 443 }} accept')
    rules += [f'iifname "{device}" drop', f'oifname "{device}" ct state established,related accept',
              f'oifname "{device}" drop', '}', '}',
              f'table ip {table} {{',
              'chain postrouting { type nat hook postrouting priority srcnat; policy accept;',
              'ip saddr 10.203.0.2 masquerade', '}', '}']
    return ('\n'.join(rules) + '\n').encode(), proxy_url


def configure_network(prefix, phase, spec, credentials, config):
    rules, proxy_url = network_rules(prefix, phase, spec, credentials, config)
    namespace = prefix
    device = 'v' + prefix[3:14]
    peer = 'p' + prefix[3:14]
    if not Path('/run/netns', namespace).exists():
        run(['ip', 'netns', 'add', namespace])
        run(['ip', 'link', 'add', device, 'type', 'veth', 'peer', 'name', peer])
        run(['ip', 'link', 'set', peer, 'netns', namespace])
        run(['ip', 'addr', 'add', '10.203.0.1/30', 'dev', device])
        run(['ip', 'link', 'set', device, 'up'])
        for args in (['link', 'set', 'lo', 'up'], ['addr', 'add', '10.203.0.2/30', 'dev', peer],
                     ['link', 'set', peer, 'up'], ['route', 'add', 'default', 'via', '10.203.0.1']):
            run(['ip', '-n', namespace] + args)
        run(['ip', 'netns', 'exec', namespace, 'sysctl', '-qw', 'net.ipv6.conf.all.disable_ipv6=1'])
        dns = Path('/etc/netns', namespace)
        dns.mkdir(mode=0o755, parents=True, exist_ok=True)
        (dns / 'resolv.conf').write_text('nameserver ' + config['dnsServer'] + '\n')
    run(['nft', 'delete', 'table', 'inet', prefix], check=False)
    run(['nft', 'delete', 'table', 'ip', prefix], check=False)
    run(['nft', '-f', '-'], input=rules)
    return proxy_url


def prepare(run_id, request, config):
    directory, state_path, prefix = run_paths(run_id)
    spec, spec_hash = load_request(run_id, request, config)
    with lock(ROOT / 'admission.lock'), lock(directory / 'lock'):
        if state_path.exists():
            state = secure_read(state_path)
            if state['specHash'] != spec_hash or state['closed']:
                raise RuntimeError('BUILD_RUN_CLOSED_OR_CONFLICT')
            return {'prepared': True}
        for path in RUNTIME.glob('*/state.json'):
            if not secure_read(path).get('terminationConfirmed', False):
                raise RuntimeError('BUILD_BUSY')
        if timestamp(request['leaseUntil']) > min(time.time() + 61, timestamp(spec['deadlineAt'])) or timestamp(request['leaseUntil']) <= time.time():
            raise RuntimeError('BUILD_LEASE_INVALID')
        allocated = sum(path.stat().st_size for path in RUNTIME.glob('*/execution.ext4'))
        if allocated + int(spec['limits']['diskBytes']) > int(config['runtimeMaxBytes']):
            raise RuntimeError('BUILD_RUNTIME_RETENTION_FULL')
        directory.mkdir(mode=0o711, parents=True, exist_ok=True)
        os.chmod(directory, 0o711)
        state = {'specHash': spec_hash, 'spec': spec, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                 'closed': False, 'terminationConfirmed': False, 'leaseUntil': request['leaseUntil'], 'started': [], 'completed': [], 'diskMounted': False}
        atomic(state_path, state)
        image, disk = directory / 'execution.ext4', directory / 'disk'
        run(['fallocate', '-l', spec['limits']['diskBytes'], str(image)])
        os.chmod(image, 0o600)
        run(['mkfs.ext4', '-q', '-F', '-m', '0', str(image)], timeout=60)
        disk.mkdir(mode=0o711)
        run(['mount', '-o', 'loop,nodev,nosuid', str(image), str(disk)])
        if os.statvfs(disk).f_blocks * os.statvfs(disk).f_frsize > int(spec['limits']['diskBytes']):
            raise RuntimeError('BUILD_DISK_BOUND_INVALID')
        for phase, uid_key in PHASES.items():
            work = disk / phase
            work.mkdir(mode=0o700)
            os.chown(work, config[uid_key], config[uid_key])
            temporary = work / 'tmp'
            temporary.mkdir(mode=0o700)
            os.chown(temporary, config[uid_key], config[uid_key])
        unit = Path('/run/systemd/system', prefix + '.slice')
        unit.write_text('[Unit]\nDescription=Ozz isolated build\n[Slice]\nCPUAccounting=yes\nMemoryAccounting=yes\nTasksAccounting=yes\nCPUQuota=' + str(spec['limits']['cpuMillis'] / 10) + '%\nMemoryMax=' + str(spec['limits']['memoryMiB']) + 'M\nMemorySwapMax=0\nTasksMax=' + str(spec['limits']['pids']) + '\n')
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'start', prefix + '.slice'])
        group = Path('/sys/fs/cgroup', prefix + '.slice')
        if int((group / 'memory.max').read_text()) != spec['limits']['memoryMiB'] * 1048576 or int((group / 'pids.max').read_text()) != spec['limits']['pids']:
            raise RuntimeError('BUILD_CGROUP_LIMIT_NOT_ENFORCED')
        cpu_quota, cpu_period = (group / 'cpu.max').read_text().split()
        if cpu_quota == 'max' or int(cpu_quota) * 1000 > spec['limits']['cpuMillis'] * int(cpu_period):
            raise RuntimeError('BUILD_CPU_LIMIT_NOT_ENFORCED')
        state['diskMounted'] = True
        atomic(state_path, state)
        return {'prepared': True}


def group_empty(prefix):
    events = Path('/sys/fs/cgroup', prefix + '.slice', 'cgroup.events')
    return events.exists() and 'populated 0' in events.read_text().splitlines()


def phase(run_id, request, config):
    directory, state_path, prefix = run_paths(run_id)
    spec, spec_hash = load_request(run_id, request, config)
    phase_name = request['phase']
    if phase_name not in PHASES:
        raise RuntimeError('BUILD_PHASE_INVALID')
    secret_dir = Path('/run/ozz-builder-credentials', run_id, phase_name)
    with lock(directory / 'lock'):
        state = secure_read(state_path)
        if state['specHash'] != spec_hash or state['closed'] or time.time() >= min(timestamp(state['leaseUntil']), timestamp(spec['deadlineAt'])) or phase_name in state['started']:
            raise RuntimeError('BUILD_PHASE_FENCED')
        if phase_name == 'building' and 'checkout' not in state['completed']:
            raise RuntimeError('BUILD_CHECKOUT_REQUIRED')
        if phase_name == 'pushing' and (not group_empty(prefix) or (spec['action'] == 'build_and_push' and 'building' not in state['completed'])):
            raise RuntimeError('BUILD_SOLVE_TERMINATION_REQUIRED')
        if not group_empty(prefix):
            raise RuntimeError('BUILD_PHASE_OVERLAP_REJECTED')
        build_proxy = configure_network(prefix, phase_name, spec, request['credentials'], config)
        uid = config[PHASES[phase_name]]
        work = directory / 'disk' / phase_name
        secret_dir.parent.parent.mkdir(mode=0o711, parents=True, exist_ok=True)
        secret_dir.parent.mkdir(mode=0o711, exist_ok=True)
        os.chmod(secret_dir.parent.parent, 0o711)
        os.chmod(secret_dir.parent, 0o711)
        secret_dir.mkdir(mode=0o700, exist_ok=True)
        run(['mount', '-t', 'tmpfs', '-o', f'size=4m,nodev,nosuid,noexec,mode=0700,uid={uid},gid={uid}', 'tmpfs', str(secret_dir)])
        source = directory / 'disk' / 'checkout' / 'source'
        helper_request = {**request, 'tools': {key: value['path'] for key, value in config['tools'].items()},
                          'workDirectory': str(work), 'secretDirectory': str(secret_dir), 'sourceDirectory': str(source),
                          'buildHttpProxy': build_proxy}
        if phase_name == 'pushing':
            artifact = checked_artifact(request['artifact'], config)
            helper_request['archivePath'] = str(ARTIFACTS / artifact['archive']['handle'] / 'image.oci.tar')
        state['started'].append(phase_name)
        entry_nonce = str(uuid.uuid4())
        state.setdefault('phaseEntries', {})[phase_name] = {'nonce': entry_nonce, 'uid': uid, 'specHash': spec_hash}
        atomic(state_path, state)
        unit = prefix + '-' + phase_name + '.service'
        args = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + unit,
                '--slice=' + prefix + '.slice', '--property=User=root', '--property=Group=root',
                '--property=Delegate=yes', '--property=KillMode=control-group', '--property=OOMPolicy=kill',
                '--property=RuntimeMaxSec=' + remaining_runtime(spec['deadlineAt']),
                '--property=TimeoutStopSec=10', '--property=SendSIGKILL=yes', '--property=ProtectSystem=strict',
                '--property=ProtectHome=yes', '--property=PrivateDevices=yes',
                # RootlessKit configures its tap through netlink inside the run's network namespace.
                '--property=RestrictAddressFamilies=AF_UNIX AF_INET' + (' AF_NETLINK' if phase_name == 'building' else ''),
                '--property=NetworkNamespacePath=/run/netns/' + prefix,
                '--property=ReadWritePaths=' + str(work) + ' ' + str(secret_dir),
                # Keep a private /dev; only the solve UID needs the TUN character device.
                '--property=BindPaths=' + str(work / 'tmp') + ':/tmp' + (' /dev/net/tun:/dev/net/tun' if phase_name == 'building' else ''),
                *(['--property=DeviceAllow=/dev/net/tun rw'] if phase_name == 'building' else []),
                '--property=BindReadOnlyPaths=/etc/netns/' + prefix + '/resolv.conf:/etc/resolv.conf',
                '--property=InaccessiblePaths=/etc/ozz-builder /var/lib/ozz-builder/manager -/run/docker.sock -/var/run/docker.sock',
                '--property=UMask=0077', ENTRY, run_id, phase_name, entry_nonce]
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        # The service's root-owned ExecStart gate takes this same lock before dropping UID.
        # A late DBus request can therefore never execute source after the durable close fence.
    decoder = codecs.getincrementaldecoder('utf8')(errors='replace')
    try:
        # Outside the lock: large stdin cannot deadlock against the service entry gate.
        process.stdin.write(json.dumps(helper_request).encode())
        process.stdin.close()
        while True:
            chunk = process.stdout.read1(4096)
            if not chunk:
                break
            emit({'type': 'log', 'text': decoder.decode(chunk)})
        tail = decoder.decode(b'', final=True)
        if tail:
            emit({'type': 'log', 'text': tail})
        code = process.wait(timeout=15)
    finally:
        run(['systemctl', 'stop', unit], check=False)
        run(['umount', str(secret_dir)], check=False)
    with lock(directory / 'lock'):
        state = secure_read(state_path)
        if not group_empty(prefix):
            raise RuntimeError('BUILD_PHASE_PROCESS_REMAINS')
        if code or state['closed']:
            raise RuntimeError('BUILD_PHASE_FAILED')
        if phase_name == 'checkout':
            validate_checkout(source, spec, config)
        state['completed'].append(phase_name)
        atomic(state_path, state)
    return {'completed': phase_name}


def validate_checkout(source, spec, config):
    shutil.rmtree(source / '.git')
    root = source.resolve(strict=True)
    for name, is_directory in ((spec['source']['dockerfilePath'], False), (spec['source']['contextPath'], True)):
        parts = name.split('/')
        if name != '.' and (name.startswith('/') or '\\' in name or any(part in ('', '.', '..') for part in parts)):
            raise RuntimeError('BUILD_PATH_INVALID')
        target = (root / name).resolve(strict=True)
        if not target.is_relative_to(root) or (is_directory and not target.is_dir()) or (not is_directory and not target.is_file()):
            raise RuntimeError('BUILD_PATH_ESCAPES_CHECKOUT')
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory, name)
            if path.is_symlink() and not path.resolve().is_relative_to(root):
                raise RuntimeError('BUILD_SYMLINK_ESCAPES_CHECKOUT')
            if not path.is_symlink():
                info = path.stat()
                if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):
                    raise RuntimeError('BUILD_SPECIAL_FILE_REJECTED')
                os.chown(path, 0, config['solveUid'])
                # COPY preserves these modes in the image. Keep Git's executable
                # distinction while root ownership prevents solve-side writes.
                os.chmod(path, 0o755 if path.is_dir() or info.st_mode & 0o111 else 0o644)
    dockerfile = root / spec['source']['dockerfilePath']
    if dockerfile.stat().st_size > 524288:
        raise RuntimeError('BUILD_DOCKERFILE_TOO_LARGE')
    for syntax in re.findall(r'^\s*#\s*syntax\s*=\s*(.+?)\s*$', dockerfile.read_text(), re.MULTILINE | re.IGNORECASE):
        if syntax != 'docker/dockerfile@' + spec['profile']['frontendDigest']:
            raise RuntimeError('BUILD_FRONTEND_REJECTED')
    os.chown(root, 0, config['solveUid'])
    os.chmod(root, 0o755)
    # This parent gates checkout/upload UIDs; the building service also sees
    # checkout under ProtectSystem=strict, outside its own ReadWritePaths.
    # The checkout UID no longer owns any parent through which it could rename source.
    os.chown(root.parent, 0, config['solveUid'])
    os.chmod(root.parent, 0o550)


def inspect_oci(source, spec):
    """Bounded, uncompressed OCI tar reader; no extraction or extension allocation.

    OCI member names fit ordinary ustar headers. Rejecting PAX/GNU/sparse
    extensions before parsing their bodies avoids attacker-sized metadata
    allocations in Python's general-purpose tar reader.
    """
    source.seek(0, os.SEEK_END)
    archive_size = source.tell()
    if not 1024 <= archive_size <= int(spec['limits']['diskBytes']):
        raise RuntimeError('BUILD_OCI_ARCHIVE_LIMIT')
    entries, names, offset, count = {}, set(), 0, 0
    while True:
        source.seek(offset)
        header = source.read(512)
        if len(header) != 512:
            raise RuntimeError('BUILD_OCI_ARCHIVE_TRUNCATED')
        if header == bytes(512):
            if source.read(512) != bytes(512):
                raise RuntimeError('BUILD_OCI_ARCHIVE_TRUNCATED')
            while chunk := source.read(1048576):
                if any(chunk):
                    raise RuntimeError('BUILD_OCI_ARCHIVE_TRAILING_DATA')
            break
        count += 1
        if count > 16384:
            raise RuntimeError('BUILD_OCI_ENTRY_LIMIT')
        entry = tarfile.TarInfo.frombuf(header, encoding='utf8', errors='strict')
        name = entry.name.removeprefix('./').rstrip('/')
        if name in names or entry.size < 0 or offset + 512 + entry.size > archive_size:
            raise RuntimeError('BUILD_OCI_ARCHIVE_INVALID')
        names.add(name)
        if entry.type == tarfile.DIRTYPE and name in ('', '.', 'blobs', 'blobs/sha256') and entry.size == 0:
            pass
        elif entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or not (name in ('index.json', 'oci-layout') or re.fullmatch(r'blobs/sha256/[0-9a-f]{64}', name)):
            raise RuntimeError('BUILD_OCI_ARCHIVE_INVALID')
        else:
            entries[name] = (offset + 512, entry.size)
        offset += 512 + ((entry.size + 511) // 512) * 512

    verified = set()
    def verify_blob(name):
        if name in verified:
            return
        start, size = entries[name]
        source.seek(start)
        checksum, remaining = hashlib.sha256(), size
        while remaining:
            chunk = source.read(min(1048576, remaining))
            if not chunk:
                raise RuntimeError('BUILD_OCI_ARCHIVE_TRUNCATED')
            checksum.update(chunk)
            remaining -= len(chunk)
        if name.startswith('blobs/') and checksum.hexdigest() != name.rsplit('/', 1)[-1]:
            raise RuntimeError('BUILD_OCI_DIGEST_MISMATCH')
        verified.add(name)

    def json_blob(name):
        start, size = entries[name]
        if size > 4 * 1024 * 1024:
            raise RuntimeError('BUILD_OCI_DESCRIPTOR_LIMIT')
        verify_blob(name)
        source.seek(start)
        result = json.loads(source.read(size))
        if not isinstance(result, dict):
            raise RuntimeError('BUILD_OCI_DESCRIPTOR_INVALID')
        return result

    expected = spec['source']['platforms'][0]
    def platform_identity(value):
        if not isinstance(value, dict) or value.get('os') != 'linux' or value.get('architecture') not in ('arm64', 'amd64'):
            raise RuntimeError('BUILD_OCI_PLATFORM_MISMATCH')
        variant = value.get('variant', 'v8' if value['architecture'] == 'arm64' else 'v1')
        if not isinstance(variant, str) or not re.fullmatch(r'v[1-9][0-9]?', variant):
            raise RuntimeError('BUILD_OCI_PLATFORM_MISMATCH')
        return value['os'], value['architecture'], variant

    wanted = platform_identity(expected)
    def descriptor_file(descriptor, allowed):
        if (not isinstance(descriptor, dict) or not re.fullmatch(r'sha256:[0-9a-f]{64}', descriptor.get('digest', '')) or
                type(descriptor.get('size')) is not int or descriptor['size'] <= 0 or
                descriptor.get('mediaType') not in allowed or descriptor.get('urls') or descriptor.get('artifactType')):
            raise RuntimeError('BUILD_OCI_DESCRIPTOR_INVALID')
        name = 'blobs/sha256/' + descriptor['digest'][7:]
        if name not in entries or entries[name][1] != descriptor['size']:
            raise RuntimeError('BUILD_OCI_DESCRIPTOR_SIZE_MISMATCH')
        if descriptor.get('platform') and platform_identity(descriptor['platform']) != wanted:
            raise RuntimeError('BUILD_OCI_PLATFORM_MISMATCH')
        return name

    if json_blob('oci-layout') != {'imageLayoutVersion': '1.0.0'}:
        raise RuntimeError('BUILD_OCI_LAYOUT_INVALID')
    index = json_blob('index.json')
    if index.get('schemaVersion') != 2 or index.get('mediaType', 'application/vnd.oci.image.index.v1+json') != 'application/vnd.oci.image.index.v1+json' or not isinstance(index.get('manifests'), list) or len(index['manifests']) != 1:
        raise RuntimeError('BUILD_OCI_ROOT_AMBIGUOUS')
    root, platforms, visited = index['manifests'][0], [], set()
    def inspect(descriptor, depth=0):
        name = descriptor_file(descriptor, MEDIA_INDEX | MEDIA_MANIFEST)
        if depth > 3 or name in visited or len(visited) >= 64:
            raise RuntimeError('BUILD_OCI_DESCRIPTOR_LIMIT')
        visited.add(name)
        manifest = json_blob(name)
        if manifest.get('schemaVersion') != 2 or manifest.get('mediaType', descriptor['mediaType']) != descriptor['mediaType']:
            raise RuntimeError('BUILD_OCI_DESCRIPTOR_INVALID')
        if descriptor['mediaType'] in MEDIA_INDEX:
            children = manifest.get('manifests')
            if not isinstance(children, list) or not 1 <= len(children) <= 8:
                raise RuntimeError('BUILD_OCI_DESCRIPTOR_LIMIT')
            for child in children:
                inspect(child, depth + 1)
            return
        config_media = ('application/vnd.oci.image.config.v1+json' if descriptor['mediaType'].startswith('application/vnd.oci.') else 'application/vnd.docker.container.image.v1+json')
        config_descriptor = manifest.get('config')
        config_blob = json_blob(descriptor_file(config_descriptor, {config_media}))
        if platform_identity(config_blob) != wanted:
            raise RuntimeError('BUILD_OCI_PLATFORM_MISMATCH')
        layers = manifest.get('layers')
        diff_ids = config_blob.get('rootfs', {}).get('diff_ids')
        if (not isinstance(layers, list) or len(layers) > 2048 or config_blob.get('rootfs', {}).get('type') != 'layers' or
                not isinstance(diff_ids, list) or len(diff_ids) != len(layers) or
                any(not isinstance(value, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value) for value in diff_ids)):
            raise RuntimeError('BUILD_OCI_CONFIG_INVALID')
        layer_media = {'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar.gzip'}
        for layer in layers:
            verify_blob(descriptor_file(layer, layer_media))
        platforms.append({'os': 'linux', 'architecture': config_blob['architecture'],
                          **({'variant': config_blob['variant']} if config_blob.get('variant') else {}),
                          'manifestDigest': descriptor['digest'], 'manifestMediaType': descriptor['mediaType'], 'configDigest': config_descriptor['digest']})
    inspect(root)
    for name in entries:
        verify_blob(name)
    if len(platforms) != 1:
        raise RuntimeError('BUILD_OCI_PLATFORM_AMBIGUOUS')
    return root, platforms


@contextlib.contextmanager
def checked_archive_fd(parent, name, solve_uid):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid not in (0, solve_uid):
            raise RuntimeError('BUILD_OCI_SOURCE_INVALID')
        yield source


@contextlib.contextmanager
def archive_source(directory, config):
    """Pin every parent and the archive inode before root reads or changes metadata."""
    path = directory / 'disk' / 'building' / 'result.oci.tar'
    current = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for index, part in enumerate(path.parts[1:-1]):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
            os.close(current)
            current = child
            info = os.fstat(current)
            expected_uid = config['solveUid'] if index == len(path.parts[1:-1]) - 1 else 0
            if info.st_uid != expected_uid or (expected_uid == 0 and info.st_mode & 0o022):
                raise RuntimeError('BUILD_OCI_PARENT_UNTRUSTED')
        with checked_archive_fd(current, path.name, config['solveUid']) as source:
            yield source
    finally:
        os.close(current)


def collect(run_id, request, config):
    directory, state_path, prefix = run_paths(run_id)
    spec, spec_hash = load_request(run_id, request, config)
    with lock(ROOT / 'admission.lock'), lock(directory / 'lock'), lock(ROOT / 'artifacts.lock'):
        state = secure_read(state_path)
        if state['specHash'] != spec_hash or 'building' not in state['completed'] or not group_empty(prefix):
            raise RuntimeError('BUILD_OCI_NOT_CONFIRMED')
        if state.get('artifact'):
            return checked_artifact_identity(state['artifact'], config)
        if any(path != state_path and not secure_read(path).get('terminationConfirmed', False) for path in RUNTIME.glob('*/state.json')):
            raise RuntimeError('BUILD_OCI_OTHER_EXECUTION_ACTIVE')
        with archive_source(directory, config) as source:
            root, platforms = inspect_oci(source, spec)
            size = os.fstat(source.fileno()).st_size
            retained = sum(path.stat().st_size for path in ARTIFACTS.glob('*/image.oci.tar'))
            if retained + size > int(config['artifactMaxBytes']):
                raise RuntimeError('BUILD_ARTIFACT_RETENTION_FULL')
            os.fchown(source.fileno(), 0, 0)
            os.fchmod(source.fileno(), 0o400)
            artifact_id = str(uuid.uuid4())
            destination = ARTIFACTS / artifact_id
            destination.mkdir(mode=0o710, parents=True)
            os.chown(destination, 0, config['uploadUid'])
            target = destination / 'image.oci.tar'
            source.seek(0)
            with target.open('xb') as out:
                shutil.copyfileobj(source, out, 1048576)
                out.flush()
                os.fsync(out.fileno())
        os.chown(target, 0, config['uploadUid'])
        os.chmod(target, 0o440)
        artifact = {'id': artifact_id, 'producedByRunId': run_id,
                    'contentHash': hashlib.sha256(canonical({'version': 1, 'source': spec['source'], 'profile': spec['profile']}).encode()).hexdigest(),
                    'commitSha': spec['source']['commitSha'], 'recipeHash': spec['source']['recipeHash'],
                    'rootDigest': root['digest'], 'rootMediaType': root['mediaType'], 'platforms': platforms,
                    'archive': {'builderInstanceId': config['profile']['instanceId'], 'handle': artifact_id,
                                'sha256': digest_file(target), 'bytes': str(size),
                                'expiresAt': datetime.datetime.fromtimestamp(time.time() + config['artifactRetentionSeconds'], datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')},
                    'producedAt': now()}
        atomic(destination / 'identity.json', artifact)
        state['artifact'] = artifact
        atomic(state_path, state)
        return artifact


def checked_artifact_identity(artifact, config):
    handle = artifact['archive']['handle']
    if str(uuid.UUID(handle)) != handle or artifact['archive']['builderInstanceId'] != config['profile']['instanceId']:
        raise RuntimeError('BUILD_ARTIFACT_IDENTITY_INVALID')
    directory = ARTIFACTS / handle
    recorded = secure_read(directory / 'identity.json')
    if canonical(recorded) != canonical(artifact):
        raise RuntimeError('BUILD_ARTIFACT_IDENTITY_INVALID')
    return artifact


def checked_artifact(artifact, config):
    # Byte availability is checked at actual upload, separately from retained identity.
    checked_artifact_identity(artifact, config)
    directory = ARTIFACTS / artifact['archive']['handle']
    path = directory / 'image.oci.tar'
    if not path.is_file() or path.stat().st_size != int(artifact['archive']['bytes']) or digest_file(path) != artifact['archive']['sha256'] or time.time() >= timestamp(artifact['archive']['expiresAt']):
        raise RuntimeError('BUILD_ARTIFACT_MISSING_OR_INVALID')
    return artifact


def artifact(run_id, request, config):
    directory, state_path, _ = run_paths(run_id)
    spec, _ = load_request(run_id, request, config)
    if request.get('artifact'):
        return checked_artifact_identity(request['artifact'], config)
    if spec['action'] == 'push_existing':
        return checked_artifact_identity(spec['artifact'], config)
    if not state_path.exists():
        return None
    state = secure_read(state_path)
    if state.get('artifact'):
        return checked_artifact_identity(state['artifact'], config)
    if 'building' in state['completed']:
        return collect(run_id, request, config)
    return None  # Trusted ledger confirms there was no completed solve/export.


def stop(run_id, request, config):
    directory, state_path, prefix = run_paths(run_id)
    spec, spec_hash = load_request(run_id, request, config)
    with lock(directory / 'lock'):
        if not state_path.exists():
            # Persist a root tombstone too, so an already spawned delayed prepare cannot start.
            atomic(state_path, {'spec': spec, 'specHash': spec_hash, 'closed': True, 'terminationConfirmed': True, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'started': [], 'completed': [], 'leaseUntil': now(), 'diskMounted': False})
            return {'kind': 'never_started'}
        state = secure_read(state_path)
        if state['specHash'] != spec_hash:
            raise RuntimeError('BUILD_SPEC_CONFLICT')
        if state.get('terminationEvidence'):
            return state['terminationEvidence']
        state['closed'] = True
        atomic(state_path, state)
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        if state['bootId'] != boot:
            evidence = {'kind': 'host_rebooted', 'executionBootId': state['bootId'], 'observedBootId': boot}
            state.update({'terminationConfirmed': True, 'terminationEvidence': evidence, 'closedAt': now()})
            atomic(state_path, state)
            cleanup_network(prefix)
            return evidence
        for phase_name in state['started']:
            run(['systemctl', 'stop', prefix + '-' + phase_name + '.service'], check=False)
        if not state['started'] and not state['diskMounted']:
            evidence = {'kind': 'never_started'}
            state.update({'terminationConfirmed': True, 'terminationEvidence': evidence, 'closedAt': now()})
            atomic(state_path, state)
            cleanup_network(prefix)
            return evidence
        if not group_empty(prefix):
            raise RuntimeError('BUILD_EXECUTION_STILL_POPULATED')
        evidence = {'kind': 'cgroup_empty', 'executionGroupId': prefix + '.slice', 'bootId': boot}
        state.update({'terminationConfirmed': True, 'terminationEvidence': evidence, 'closedAt': now()})
        atomic(state_path, state)
        cleanup_network(prefix)
        return evidence


def renew(run_id, request, config):
    directory, state_path, _ = run_paths(run_id)
    spec, spec_hash = load_request(run_id, request, config)
    with lock(directory / 'lock'):
        if not state_path.exists():
            return {'pendingPreparation': True}
        state = secure_read(state_path)
        if state['specHash'] != spec_hash or state['closed'] or timestamp(request['leaseUntil']) > min(time.time() + 61, timestamp(spec['deadlineAt'])) or timestamp(request['leaseUntil']) <= time.time():
            raise RuntimeError('BUILD_RENEW_FENCED')
        state['leaseUntil'] = request['leaseUntil']
        atomic(state_path, state)
        return {'renewed': True}


def cleanup_network(prefix):
    # Only this launcher's named namespace/table/link are removed.
    run(['ip', 'netns', 'delete', prefix], check=False)
    run(['ip', 'link', 'delete', 'v' + prefix[3:14]], check=False)
    run(['nft', 'delete', 'table', 'inet', prefix], check=False)
    run(['nft', 'delete', 'table', 'ip', prefix], check=False)
    directory = Path('/etc/netns', prefix)
    if directory.exists():
        shutil.rmtree(directory)


def collect_garbage(config):
    for path in RUNTIME.glob('*/state.json'):
        with lock(path.parent / 'lock'):
            state = secure_read(path)
            if not state.get('terminationConfirmed') or not state.get('closedAt') or state.get('cacheRemovedAt'):
                continue
            if time.time() < timestamp(state['closedAt']) + config['cacheRetentionSeconds']:
                continue
            # A completed export awaiting trusted promotion is never cache garbage.
            if 'building' in state['completed'] and not state.get('artifact'):
                continue
            prefix = 'ozz' + path.parent.name.replace('-', '')
            run(['systemctl', 'stop', prefix + '.slice'], check=False)
            disk = path.parent / 'disk'
            if os.path.ismount(disk):
                run(['umount', str(disk)])
            image = path.parent / 'execution.ext4'
            if image.exists():
                image.unlink()
            state['cacheRemovedAt'] = now()
            atomic(path, state)
    # Keep every artifact identity; expiration removes only unreferenced archive bytes.
    active_handles = set()
    for path in RUNTIME.glob('*/state.json'):
        state = secure_read(path)
        if not state.get('terminationConfirmed'):
            selected = state.get('artifact') or state['spec'].get('artifact')
            if selected:
                active_handles.add(selected['archive']['handle'])
    with lock(ROOT / 'artifacts.lock'):
        for path in ARTIFACTS.glob('*/identity.json'):
            artifact = secure_read(path)
            archive = path.parent / 'image.oci.tar'
            if artifact['archive']['handle'] not in active_handles and time.time() >= timestamp(artifact['archive']['expiresAt']) and archive.exists():
                archive.unlink()


def watchdog(config):
    # Runs as an independent systemd timer even if the API manager is killed.
    for path in RUNTIME.glob('*/state.json'):
        state = secure_read(path)
        if not state.get('terminationConfirmed', False) and (state['closed'] or time.time() >= min(timestamp(state['leaseUntil']), timestamp(state['spec']['deadlineAt']))):
            stop(path.parent.name, {'spec': state['spec']}, config)
    collect_garbage(config)
    return {'checkedAt': now()}


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def main():
    if os.getuid() != 0:
        raise RuntimeError('BUILD_LAUNCHER_REQUIRES_ROOT')
    config = secure_read(CONFIG)
    if os.environ.get('SUDO_UID') and int(os.environ['SUDO_UID']) != config['managerUid']:
        raise RuntimeError('BUILD_MANAGER_UID_REQUIRED')
    ROOT.mkdir(mode=0o711, parents=True, exist_ok=True)
    RUNTIME.mkdir(mode=0o711, exist_ok=True)
    ARTIFACTS.mkdir(mode=0o711, exist_ok=True)
    action = sys.argv[1]
    if action == 'preflight' and len(sys.argv) == 2:
        result = preflight(config)
    elif action == 'watchdog' and len(sys.argv) == 2 and not os.environ.get('SUDO_UID'):
        result = watchdog(config)
    elif action in ('prepare', 'phase', 'collect', 'artifact', 'stop', 'renew') and len(sys.argv) == 3:
        raw = sys.stdin.buffer.read(524289)
        if len(raw) > 524288:
            raise RuntimeError('BUILD_REQUEST_TOO_LARGE')
        result = globals()[action](sys.argv[2], json.loads(raw), config)
    else:
        raise RuntimeError('BUILD_LAUNCHER_ACTION_INVALID')
    emit({'type': 'result', 'value': result})


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('BUILD_LAUNCHER_FAILED\n')
        sys.exit(1)
