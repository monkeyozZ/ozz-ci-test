#!/usr/bin/python3 -I
"""Install the native ARM64 Builder on an explicitly designated, fresh Ubuntu host.

Never run this on a control-plane/Kubernetes/product-packaging host. Source
archives must already exist in --assets, or an operator must supply --fetch.
No existing application VM/service is discovered, stopped, pruned or reused.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import subprocess
import tarfile
import urllib.request
import uuid

BASE = Path(__file__).resolve().parent
ROOT = Path('/var/lib/ozz-builder')
CONFIG = Path('/etc/ozz-builder')
BIN = Path('/opt/ozz-builder/bin')
APT_OPTIONS = ['-o', 'Dir::Etc::sourcelist=/etc/ozz-builder/apt-sources.list',
               '-o', 'Dir::Etc::sourceparts=-', '-o', 'Acquire::AllowInsecureRepositories=false',
               '-o', 'APT::Get::AllowUnauthenticated=false', '-o', 'Acquire::https::Verify-Peer=true']


def run(args, capture=False):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE if capture else None,
                          env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def private_write(path, text, gid=0):
    path.write_text(text)
    os.chown(path, 0, gid)
    os.chmod(path, 0o640 if gid else 0o600)


def checked_build_http_proxy(value):
    # Use the exact validator that the installed root launcher runs before each solve.
    spec = importlib.util.spec_from_file_location('ozz_builder_launcher_policy', BASE / 'launcher.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    return policy.validate_build_http_proxy(value)


def install_archives(lock, directory, fetch):
    BIN.mkdir(mode=0o755, parents=True, exist_ok=True)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for asset in lock['archives']:
        path = directory / Path(asset['url']).name
        if not path.exists():
            if not fetch:
                raise RuntimeError('Required pinned asset missing: ' + asset['name'])
            request = urllib.request.Request(asset['url'], headers={'User-Agent': 'ozz-builder-installer'})
            with urllib.request.urlopen(request, timeout=60) as response, path.open('xb') as output:
                size = 0
                while True:
                    chunk = response.read(1048576)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > asset.get('bytes', 150 * 1024 * 1024):
                        raise RuntimeError('Pinned asset size exceeded')
                    output.write(chunk)
        if sha(path) != asset['sha256'] or ('bytes' in asset and path.stat().st_size != asset['bytes']):
            raise RuntimeError('Pinned asset checksum mismatch: ' + asset['name'])
        if asset.get('file'):
            shutil.copyfile(path, BIN / asset['file'])
        else:
            with tarfile.open(path) as archive:
                for member, output in asset['members'].items():
                    info = archive.getmember(member)
                    if not info.isfile() or info.size > 200 * 1024 * 1024:
                        raise RuntimeError('Pinned archive member invalid')
                    with archive.extractfile(info) as source, (BIN / output).open('wb') as destination:
                        shutil.copyfileobj(source, destination, 1048576)
        for name in [asset['file']] if asset.get('file') else asset['members'].values():
            os.chown(BIN / name, 0, 0)
            os.chmod(BIN / name, 0o755)


def install_distribution(lock):
    # Use only the Ubuntu archive key and origins, regardless of extra host apt sources.
    sources = '\n'.join('deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://ports.ubuntu.com/ubuntu-ports ' + suite + ' main universe'
                        for suite in ('noble', 'noble-updates', 'noble-security')) + '\n'
    private_write(CONFIG / 'apt-sources.list', sources)
    run(['apt-get', *APT_OPTIONS, 'update'])
    receipts = []
    for package in lock['distributionPackages']:
        exact = package['name'] + '=' + package['version']
        control = run(['apt-cache', *APT_OPTIONS, 'show', exact], capture=True).stdout.decode()
        rows = []
        for paragraph in control.strip().split('\n\n'):
            row = dict(line.split(': ', 1) for line in paragraph.splitlines() if ': ' in line and not line.startswith(' '))
            if row.get('Package') == package['name'] and row.get('Version') == package['version'] and row.get('Architecture') in ('arm64', 'all'):
                rows.append(row)
        hashes = {row.get('SHA256') for row in rows}
        if len(hashes) != 1 or not re.fullmatch(r'[0-9a-f]{64}', next(iter(hashes), '') or ''):
            raise RuntimeError('Exact package not present in authenticated Ubuntu metadata: ' + exact)
        receipts.append({**package, 'sha256': rows[0]['SHA256'], 'filename': rows[0]['Filename'], 'verification': 'Ubuntu archive key authenticated apt metadata; apt verifies the downloaded package hash'})
    # Persist package identities before apt performs any download/install.
    private_write(CONFIG / 'distribution-assets.lock.json', json.dumps(receipts, indent=2) + '\n')
    run(['apt-get', *APT_OPTIONS, 'install', '--yes', '--no-install-recommends',
         *[entry['name'] + '=' + entry['version'] for entry in lock['distributionPackages']],
         'git', 'iproute2', 'nftables', 'e2fsprogs', 'util-linux', 'sudo', 'ca-certificates', 'python3', 'openssl', 'apparmor'])
    for package in lock['distributionPackages']:
        version = run(['dpkg-query', '-W', '-f=${Version}', package['name']], capture=True).stdout.decode()
        if version != package['version']:
            raise RuntimeError('Installed distribution package version differs from lock')
    return receipts


def users(config):
    for name, key in [('ozz-builder', 'managerUid'), ('ozz-checkout', 'checkoutUid'), ('ozz-solve', 'solveUid'), ('ozz-upload', 'uploadUid')]:
        uid = config[key]
        try:
            existing = pwd.getpwuid(uid)
            if existing.pw_name != name or existing.pw_gid != uid:
                raise RuntimeError('Reserved Builder UID already belongs to another identity')
        except KeyError:
            run(['groupadd', '--gid', str(uid), name])
            run(['useradd', '--system', '--uid', str(uid), '--gid', str(uid), '--home-dir', '/nonexistent', '--no-create-home', '--shell', '/usr/sbin/nologin', name])
    # Only the solve UID gets subordinate ID ranges; source never maps host UID 0.
    for path in (Path('/etc/subuid'), Path('/etc/subgid')):
        lines = path.read_text().splitlines() if path.exists() else []
        expected = 'ozz-solve:2000000:65536'
        if any(line.startswith('ozz-solve:') and line != expected for line in lines):
            raise RuntimeError('Existing solve subordinate ID mapping differs')
        for line in lines:
            if not line or line.startswith('ozz-solve:'):
                continue
            _, start, count = line.split(':')
            if int(start) < 2065536 and int(start) + int(count) > 2000000:
                raise RuntimeError('Builder subordinate ID range overlaps an existing identity')
        if expected not in lines:
            with path.open('a') as output:
                output.write(expected + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True, help='Private operator configuration; never printed')
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--application-dir', type=Path, required=True, help='Already built Builder+workspace deployment bundle with node_modules')
    parser.add_argument('--designate-dedicated-host', action='store_true', required=True)
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--start', action='store_true')
    args = parser.parse_args()
    if os.getuid() != 0 or platform.machine() != 'aarch64' or 'VERSION_ID="24.04"' not in Path('/etc/os-release').read_text():
        raise RuntimeError('Dedicated Ubuntu 24.04 ARM64 root installation required')
    for service in ('docker', 'containerd', 'k3s', 'k3s-agent'):
        if subprocess.run(['systemctl', 'is-active', '--quiet', service]).returncode == 0:
            raise RuntimeError('A product/container host cannot be reused as the source Builder')
    if not (args.application_dir / 'apps/builder/dist/main.js').is_file():
        raise RuntimeError('A built workspace deployment bundle is required')
    config = json.loads(args.config.read_text())
    build_proxy = checked_build_http_proxy(config['buildHttpProxy']) if 'buildHttpProxy' in config else None
    if type(config.get('generation')) is not int or not 0 <= config['generation'] <= 2147483647:
        raise RuntimeError('Explicit current control-plane generation is required')
    for key in ('installationId', 'instanceId'):
        if str(uuid.UUID(config[key])) != config[key]:
            raise RuntimeError('Builder installation identity must be a canonical UUID')
    lock = json.loads((BASE / 'assets.lock.json').read_text())
    CONFIG.mkdir(mode=0o750, parents=True, exist_ok=True)
    ROOT.mkdir(mode=0o711, parents=True, exist_ok=True)
    host = {'installationId': config['installationId'], 'managerUid': 62000, 'checkoutUid': 62001, 'solveUid': 62002, 'uploadUid': 62003,
            'platform': {'os': 'linux', 'architecture': 'arm64'},
            'profile': {'instanceId': config['instanceId'], 'profileRevision': 1, 'buildkitVersion': 'v0.25.1', 'frontendDigest': lock['frontend']['digest']},
            'limits': config.get('limits', {'cpuMillis': 1000, 'memoryMiB': 1024, 'pids': 256, 'diskBytes': '1073741824', 'timeoutSeconds': 1200}),
            'runtimeMaxBytes': config.get('runtimeMaxBytes', '3221225472'), 'artifactMaxBytes': config.get('artifactMaxBytes', '1073741824'), 'artifactRetentionSeconds': config.get('artifactRetentionSeconds', 1209600), 'cacheRetentionSeconds': config.get('cacheRetentionSeconds', 3600),
            'dnsServer': config.get('dnsServer', '1.1.1.1'), 'trustedCloneOrigins': config.get('trustedCloneOrigins', ['https://github.com']),
            'trustedUploadOrigins': config['trustedUploadOrigins'], 'privateEgress': config.get('privateEgress', {}), 'blockedNetworks': config['blockedNetworks']}
    if build_proxy is not None:
        host['buildHttpProxy'] = build_proxy
    bounds = {'cpuMillis': (100, 64000), 'memoryMiB': (128, 262144), 'pids': (16, 4096), 'timeoutSeconds': (1, 7200)}
    if set(host['limits']) != {*bounds, 'diskBytes'} or any(type(host['limits'][key]) is not int or not lower <= host['limits'][key] <= upper for key, (lower, upper) in bounds.items()):
        raise RuntimeError('Operator build limits invalid')
    if not 1048576 <= int(host['limits']['diskBytes']) <= int(host['runtimeMaxBytes']) or not 1048576 <= int(host['artifactMaxBytes']) <= 1099511627776:
        raise RuntimeError('Operator disk limits invalid')
    memory = os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
    if host['limits']['memoryMiB'] * 1048576 > memory - 384 * 1048576 or host['limits']['cpuMillis'] > os.cpu_count() * 1000:
        raise RuntimeError('Build limits must leave host memory for the manager and operating system')
    if shutil.disk_usage(ROOT).free < int(host['runtimeMaxBytes']) + int(host['artifactMaxBytes']) + 512 * 1048576:
        raise RuntimeError('Configured retention exceeds available host disk capacity')
    if type(host['artifactRetentionSeconds']) is not int or not 60 <= host['artifactRetentionSeconds'] <= 31536000 or type(host['cacheRetentionSeconds']) is not int or not 0 <= host['cacheRetentionSeconds'] <= 604800:
        raise RuntimeError('Operator retention bounds invalid')
    if not host['blockedNetworks']:
        raise RuntimeError('Explicit management network exclusions are required')
    users(host)
    os.chown(CONFIG, 0, host['managerUid'])
    package_receipts = install_distribution(lock)
    install_archives(lock, args.assets, args.fetch)
    for source, destination in [('launcher.py', '/usr/local/libexec/ozz-builder-launch'), ('phase-helper.py', '/usr/local/libexec/ozz-builder-phase'), ('phase-entry.py', '/usr/local/libexec/ozz-builder-enter')]:
        Path(destination).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(BASE / source, destination)
        os.chown(destination, 0, 0)
        os.chmod(destination, 0o755)
    host['tools'] = {name: {'path': str(BIN / name), 'sha256': sha(BIN / name)} for name in ('node', 'buildctl', 'buildkitd', 'rootlesskit', 'runc')}
    for name in ('git', 'skopeo', 'slirp4netns'):
        executable = Path(shutil.which(name)).resolve()
        host['tools'][name] = {'path': str(executable), 'sha256': sha(executable)}
    private_write(CONFIG / 'host.json', json.dumps(host, indent=2) + '\n')
    manager = ROOT / 'manager'
    manager.mkdir(mode=0o700, exist_ok=True)
    os.chown(manager, host['managerUid'], host['managerUid'])
    for name in ('serverCertificate', 'serverPrivateKey', 'clientCa'):
        source = Path(config[name])
        if source.is_symlink() or not source.is_file():
            raise RuntimeError('Explicit regular TLS material files required')
        private_write(CONFIG / (name + '.pem'), source.read_text(), host['managerUid'])
    signing = CONFIG / 'signing-key.pem'
    if not signing.exists():
        run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(signing)])
    os.chown(signing, 0, host['managerUid'])
    os.chmod(signing, 0o640)
    run(['openssl', 'pkey', '-in', str(signing), '-pubout', '-out', str(CONFIG / 'identity-public-key.pem')])
    manager_config = {'installationId': config['installationId'], 'instanceId': config['instanceId'], 'initialGeneration': config['generation'], 'ledgerDirectory': str(manager / 'ledger'), 'signingKeyFile': str(signing),
                      'certificateFile': str(CONFIG / 'serverCertificate.pem'), 'privateKeyFile': str(CONFIG / 'serverPrivateKey.pem'), 'clientCaFile': str(CONFIG / 'clientCa.pem'),
                      'clientFingerprints': config['clientFingerprints'], 'trustedCloneOrigins': host['trustedCloneOrigins'], 'host': config.get('listenHost', '0.0.0.0'), 'port': config.get('listenPort', 9443)}
    private_write(CONFIG / 'manager.json', json.dumps(manager_config, indent=2) + '\n', host['managerUid'])
    rule = 'ozz-builder ALL=(root) NOPASSWD: /usr/local/libexec/ozz-builder-launch *\n'
    sudoers = Path('/etc/sudoers.d/ozz-builder')
    private_write(sudoers, rule)
    os.chmod(sudoers, 0o440)
    run(['visudo', '-cf', str(sudoers)])
    app = args.application_dir.resolve()
    if not re.fullmatch(r'/[A-Za-z0-9._/-]+', str(app)):
        raise RuntimeError('Application installation path contains unsupported systemd characters')
    # Root-owned code, including node_modules, must not be writable by manager/source UIDs.
    for directory, dirs, files in os.walk(app):
        os.chown(directory, 0, 0)
        os.chmod(directory, 0o755)
        for name in dirs + files:
            path = Path(directory, name)
            if path.is_symlink():
                if not path.resolve().is_relative_to(app):
                    raise RuntimeError('Builder application bundle contains an external symlink')
                continue
            if path.is_dir():
                continue
            executable = bool(path.stat().st_mode & 0o111)
            os.chown(path, 0, 0)
            os.chmod(path, 0o755 if executable else 0o644)
    units = Path('/etc/systemd/system')
    (units / 'ozz-builder.service').write_text('[Unit]\nDescription=Ozz isolated Builder manager\nAfter=network-online.target ozz-builder-watchdog.timer\nWants=network-online.target ozz-builder-watchdog.timer\n[Service]\nType=simple\nUser=ozz-builder\nGroup=ozz-builder\nUMask=0077\nMemoryMax=384M\nEnvironment=NODE_OPTIONS=--max-old-space-size=256\nExecStart=/usr/bin/flock -n ' + str(manager / 'manager.lock') + ' ' + str(BIN / 'node') + ' ' + str(app / 'apps/builder/dist/main.js') + '\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\nTimeoutStopSec=40\n[Install]\nWantedBy=multi-user.target\n')
    (units / 'ozz-builder-watchdog.service').write_text('[Unit]\nDescription=Ozz independent Builder lease enforcement\n[Service]\nType=oneshot\nExecStart=/usr/local/libexec/ozz-builder-launch watchdog\nTimeoutStartSec=60\n')
    (units / 'ozz-builder-watchdog.timer').write_text('[Unit]\nDescription=Ozz independent Builder watchdog timer\n[Timer]\nOnBootSec=1s\nOnUnitActiveSec=1s\nAccuracySec=100ms\n[Install]\nWantedBy=timers.target\n')
    Path('/etc/sysctl.d/90-ozz-builder-network.conf').write_text('net.ipv4.ip_forward=1\n')
    run(['sysctl', '-qw', 'net.ipv4.ip_forward=1'])
    if shutil.which('apparmor_parser'):
        profile = Path('/etc/apparmor.d/ozz-builder-rootlesskit')
        profile.write_text('abi <abi/4.0>,\ninclude <tunables/global>\n/opt/ozz-builder/bin/rootlesskit flags=(unconfined) {\n  userns,\n}\n')
        run(['apparmor_parser', '-r', str(profile)])
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'ozz-builder-watchdog.timer'])
    if args.start:
        run(['systemctl', 'enable', '--now', 'ozz-builder.service'])
    receipt = {'version': 1, 'installationId': config['installationId'], 'instanceId': config['instanceId'], 'profile': host['profile'], 'assetLockSha256': sha(BASE / 'assets.lock.json'), 'tools': host['tools'], 'distributionPackages': package_receipts,
               'launcherSha256': sha(Path('/usr/local/libexec/ozz-builder-launch')), 'helperSha256': sha(Path('/usr/local/libexec/ozz-builder-phase')), 'entrySha256': sha(Path('/usr/local/libexec/ozz-builder-enter')),
               'managerStarted': args.start, 'realBuildVerified': False}
    private_write(CONFIG / 'installation-receipt.json', json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'installed': True, 'instanceId': config['instanceId'], 'receipt': str(CONFIG / 'installation-receipt.json'), 'identityPublicKey': str(CONFIG / 'identity-public-key.pem'), 'realBuildVerified': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # In particular, never dump the operator configuration or TLS materials.
        raise SystemExit('BUILDER_INSTALLATION_FAILED; inspect the named step and installed receipt, no credentials were printed')
