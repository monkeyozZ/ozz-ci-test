#!/usr/bin/env python3
"""Prepare a project-owned Docker daemon on the existing Ozz C guest.

Run on C as root after copying this file and its adjacent asset lock. Debian
packages are extracted into the fixture directory; package hooks never run.
Nothing is installed into the guest's global binary directories or into K3s.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import pwd
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

BASE = pathlib.Path('/var/lib/ozz-local-lab/c/linux-build-s3')
OWNER = 'ozz-linux-build-c-s3-v1'
UNIT = 'ozz-s3-docker-c.service'
RUNTIME = pathlib.Path('/run/ozz-s3-docker-c')
SOCKET = RUNTIME / 'docker.sock'
DOCKER = BASE / 'tools/docker-28.5.2'
NODE = BASE / 'tools/node-24.22.1'
LOCK = pathlib.Path(__file__).with_name('linux-build-c.assets.lock.json')


def run(args, **options):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60, **options)
    if result.returncode:
        raise RuntimeError('C_FIXTURE_COMMAND_FAILED: ' + pathlib.Path(args[0]).name)
    return result.stdout.strip()


def write(path, value, mode=0o600):
    path.write_text(value)
    path.chmod(mode)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def identity():
    if os.geteuid() != 0 or platform.machine() != 'aarch64':
        raise RuntimeError('C_FIXTURE_REQUIRES_ROOT_ON_ARM64')
    if pathlib.Path('/etc/ozz-local-lab-instance').read_text().strip() != 'ozz-lab-c':
        raise RuntimeError('C_FIXTURE_WRONG_GUEST')
    if BASE.exists() and (BASE / '.owner').read_text() != OWNER:
        raise RuntimeError('C_FIXTURE_OWNER_MISMATCH')


def key_files():
    return {str(path): digest(path) for path in map(pathlib.Path, [
        '/etc/machine-id', '/etc/rancher/k3s/config.yaml', '/etc/systemd/system/k3s.service',
    ]) if path.exists()}


def status():
    disk = shutil.disk_usage('/')
    return {
        'observedAt': datetime.now(timezone.utc).isoformat(),
        'instance': 'ozz-lab-c', 'diskFreeBytes': disk.free,
        'k3sFiles': key_files(), 'dataRoot': str(BASE / 'data'),
        'socket': str(SOCKET), 'socketExists': SOCKET.exists(),
        'unit': UNIT,
    }


def download(asset):
    if not re.fullmatch(r'[A-Za-z0-9._+~-]+', asset['filename']):
        raise RuntimeError('C_FIXTURE_INVALID_ASSET_NAME')
    if not re.fullmatch(r'[a-f0-9]{64}', asset['sha256']):
        raise RuntimeError('C_FIXTURE_INVALID_ASSET_DIGEST')
    if not asset['url'].startswith(('https://download.docker.com/', 'https://nodejs.org/')):
        raise RuntimeError('C_FIXTURE_INVALID_ASSET_ORIGIN')
    target = BASE / 'assets' / asset['filename']
    if not target.exists():
        partial = target.with_name(target.name + '.part')
        result = subprocess.run([
            'curl', '--fail', '--location', '--proto', '=https', '--silent', '--show-error',
            '--connect-timeout', '20', '--max-time', '300', '--retry', '1',
            '--continue-at', '-', '--output', str(partial), asset['url'],
        ], capture_output=True, timeout=650)
        if result.returncode:
            raise RuntimeError('C_FIXTURE_ASSET_DOWNLOAD_FAILED')
        if digest(partial) != asset['sha256'] or (asset.get('bytes') and partial.stat().st_size != asset['bytes']):
            raise RuntimeError('C_FIXTURE_ASSET_CHECKSUM_FAILED')
        partial.rename(target)
        target.chmod(0o600)
    if digest(target) != asset['sha256'] or (asset.get('bytes') and target.stat().st_size != asset['bytes']):
        raise RuntimeError('C_FIXTURE_CACHED_ASSET_CHANGED')
    return target


def environment():
    return {
        **os.environ,
        'PATH': f'{NODE}/bin:{DOCKER}/usr/bin:{DOCKER}/usr/libexec/docker:/usr/sbin:/usr/bin:/sbin:/bin',
        'DOCKER_HOST': f'unix://{SOCKET}',
        'DOCKER_CONFIG': str(BASE / 'client'),
    }


def prepare():
    if SOCKET.exists():
        raise RuntimeError('C_FIXTURE_STOP_OWN_DAEMON_BEFORE_PREPARE')
    before = key_files()
    user = pwd.getpwnam('ozz')
    if user.pw_uid != 1000:
        raise RuntimeError('C_FIXTURE_UNEXPECTED_GUEST_USER')
    BASE.mkdir(parents=True, exist_ok=True, mode=0o750)
    os.chown(BASE, 0, user.pw_gid)
    BASE.chmod(0o750)
    write(BASE / '.owner', OWNER)
    for path in [BASE / 'assets', BASE / 'data', BASE / 'tmp']:
        path.mkdir(exist_ok=True, mode=0o700)
    for path in [BASE / 'tools', DOCKER, NODE]:
        path.mkdir(parents=True, exist_ok=True, mode=0o755)
    for path in [BASE / 'client', BASE / 'workspaces', BASE / 'exports']:
        path.mkdir(exist_ok=True, mode=0o700)
        os.chown(path, user.pw_uid, user.pw_gid)
    lock = json.loads(LOCK.read_text())
    for asset in lock['docker']:
        archive = download(asset)
        run(['dpkg-deb', '--extract', str(archive), str(DOCKER)])
    archive = download(lock['node'])
    run(['tar', '-xzf', str(archive), '-C', str(NODE), '--strip-components=1'])
    binaries = {}
    for name in ['docker', 'dockerd', 'containerd', 'runc', 'docker-init', 'docker-proxy']:
        path = shutil.which(name, path=environment()['PATH'])
        if not path or not pathlib.Path(path).is_relative_to(DOCKER):
            raise RuntimeError('C_FIXTURE_BINARY_MISSING: ' + name)
        binaries[name] = path
    for name in ['iptables', 'nft']:
        if not shutil.which(name):
            raise RuntimeError('C_FIXTURE_HOST_PREREQUISITE_MISSING: ' + name)
    client = {'cliPluginsExtraDirs': [str(DOCKER / 'usr/libexec/docker/cli-plugins')]}
    write(BASE / 'client/config.json', json.dumps(client, indent=2) + '\n')
    os.chown(BASE / 'client/config.json', user.pw_uid, user.pw_gid)
    configuration = {
        'data-root': str(BASE / 'data'), 'exec-root': str(RUNTIME / 'exec'),
        'hosts': [f'unix://{SOCKET}'], 'pidfile': str(RUNTIME / 'dockerd.pid'),
        'group': 'ozz', 'bip': '172.28.254.1/24',
        'default-address-pools': [{'base': '172.29.0.0/16', 'size': 24}],
        'iptables': True, 'ip6tables': False, 'ip-forward-no-drop': True,
        'storage-driver': 'overlay2', 'features': {'containerd-snapshotter': False},
        'init-path': binaries['docker-init'], 'userland-proxy-path': binaries['docker-proxy'],
        'log-level': 'warn', 'log-driver': 'json-file',
        'log-opts': {'max-size': '10m', 'max-file': '3'},
        'labels': ['dev.ozz.owner=' + OWNER],
    }
    write(BASE / 'daemon.json', json.dumps(configuration, indent=2) + '\n')
    run([binaries['dockerd'], '--validate', '--config-file', str(BASE / 'daemon.json')], env=environment())
    unit_path = pathlib.Path('/etc/systemd/system') / UNIT
    if unit_path.exists() and OWNER not in unit_path.read_text():
        raise RuntimeError('C_FIXTURE_UNIT_OWNER_MISMATCH')
    unit = f'''# {OWNER}
[Unit]
Description=Ozz S3 isolated Docker build and Compose proof on C
After=network.target

[Service]
Type=notify
Group=ozz
Environment=PATH={environment()['PATH']}
Environment=DOCKER_TMPDIR={BASE}/tmp
ExecStart={binaries['dockerd']} --config-file={BASE}/daemon.json
RuntimeDirectory={RUNTIME.name}
RuntimeDirectoryMode=0750
Delegate=yes
KillMode=process
TimeoutStartSec=90
TasksMax=4096
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
'''
    write(unit_path, unit, 0o644)
    run(['systemctl', 'daemon-reload'])
    shell = '\n'.join([
        '# Ozz C fixture only; source in the current command process.',
        f'export PATH={environment()["PATH"]}',
        f'export DOCKER_HOST=unix://{SOCKET}',
        f'export DOCKER_CONFIG={BASE}/client', '',
    ])
    write(BASE / 'environment.sh', shell, 0o644)
    versions = {
        'node': run([str(NODE / 'bin/node'), '--version']),
        'docker': run([binaries['docker'], '--version'], env=environment()),
        'dockerd': run([binaries['dockerd'], '--version'], env=environment()),
        'containerd': run([binaries['containerd'], '--version'], env=environment()),
        'compose': run([binaries['docker'], 'compose', 'version', '--short'], env=environment()),
    }
    if versions['node'] != 'v24.22.1' or versions['compose'] != '2.40.3':
        raise RuntimeError('C_FIXTURE_TOOL_VERSION_MISMATCH')
    if '28.5.2' not in versions['docker'] or '28.5.2' not in versions['dockerd'] or '1.7.28' not in versions['containerd']:
        raise RuntimeError('C_FIXTURE_DOCKER_VERSION_MISMATCH')
    if key_files() != before:
        raise RuntimeError('C_FIXTURE_K3S_CONFIGURATION_CHANGED')
    result = {**status(), 'status': 'prepared-daemon-not-started', 'versions': versions,
              'assetLockSha256': digest(LOCK), 'k3sConfigurationUnchanged': True,
              'systemPackagesInstalled': False, 'globalBinaryPathsModified': False}
    write(BASE / 'prepared.json', json.dumps(result, indent=2) + '\n')
    return result


def start():
    if not (BASE / 'prepared.json').exists():
        raise RuntimeError('C_FIXTURE_PREPARE_FIRST')
    before = key_files()
    run(['systemctl', 'start', UNIT])
    ready = None
    for _ in range(30):
        try:
            ready = json.loads(run([str(DOCKER / 'usr/bin/docker'), 'info', '--format', '{{json .}}'], env=environment()))
            break
        except RuntimeError:
            time.sleep(0.5)
    if not ready or ready['DockerRootDir'] != str(BASE / 'data'):
        raise RuntimeError('C_FIXTURE_DAEMON_NOT_READY')
    if key_files() != before:
        raise RuntimeError('C_FIXTURE_K3S_CONFIGURATION_CHANGED')
    return {**status(), 'status': 'running', 'serverVersion': ready['ServerVersion'],
            'driver': ready['Driver'], 'k3sConfigurationUnchanged': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'prepare', 'start', 'stop'])
    action = parser.parse_args().action
    identity()
    if action == 'prepare':
        value = prepare()
    elif action == 'start':
        value = start()
    elif action == 'stop':
        run(['systemctl', 'stop', UNIT])
        value = {**status(), 'status': 'stopped-data-retained'}
    else:
        value = status()
    print(json.dumps(value, indent=2))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'code': str(error) if isinstance(error, RuntimeError) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
