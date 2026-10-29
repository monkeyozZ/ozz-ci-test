"""Explicit, bounded fault controls for the dedicated local Builder only.

The product probe supplies parameters through SSH stdin after authenticating
the selected deployment. No control-plane records or execution units are made
here. Configuration backups stay private; output contains hashes and selected
non-secret state only. This file is prepared code, not an execution receipt.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import time
import uuid

CONFIG = Path('/etc/ozz-builder/host.json')
RUNS = Path('/var/lib/ozz-builder/host/runs')
LEDGER = Path('/var/lib/ozz-builder/manager/ledger')
PROC = Path('/proc')
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'


def require(value, code):
    if not value:
        raise RuntimeError('S6_FAULT_' + code)


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def regular(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
            'HOST_FILE_UNTRUSTED')
    require(info.st_size <= 1024 * 1024, 'HOST_FILE_LIMIT')
    return path.read_bytes()


def atomic(path, content):
    temporary = path.with_name(path.name + '.s6-' + parameters['sessionId'] + '-' + uuid.uuid4().hex)
    with temporary.open('xb') as file:
        os.chmod(temporary, 0o600)
        file.write(content)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def host_runs():
    paths = list(RUNS.glob('*/state.json'))
    require(len(paths) <= 1000, 'RUN_INVENTORY_LIMIT')
    return [(path.parent.name, json.loads(regular(path))) for path in paths]


def idle():
    require(all(state.get('closed') and state.get('terminationConfirmed')
                for _, state in host_runs()), 'HOST_HAS_OPEN_RUN')
    for path in LEDGER.glob('*.json'):
        if re.fullmatch(UUID, path.stem):
            # Manager-owned records are inspected, never modified.
            record = json.loads(path.read_bytes())
            require(record['observation'].get('proof') is not None, 'MANAGER_HAS_OPEN_RUN')


def manager_identity(config):
    raw = subprocess.run(['systemctl', 'show', 'ozz-builder.service', '--property=MainPID', '--value'],
                         check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5).stdout
    unit_pid = int(raw.strip())
    require(unit_pid > 1, 'MANAGER_NOT_RUNNING')
    unit = PROC / str(unit_pid)
    unit_group = (unit / 'cgroup').read_text()
    pending, visited, candidates = [unit_pid], set(), []
    while pending:
        pid = pending.pop()
        if pid in visited:
            continue
        visited.add(pid)
        require(len(visited) <= 64, 'MANAGER_PROCESS_BOUND')
        proc = PROC / str(pid)
        try:
            if (proc / 'cgroup').read_text() != unit_group:
                continue
            status = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
            if (status['Uid'].split() == [str(config['managerUid'])] * 4 and
                    os.readlink(proc / 'exe') == config['tools']['node']['path']):
                candidates.append(pid)
            pending.extend(int(value) for value in (proc / 'task' / str(pid) / 'children').read_text().split())
        except FileNotFoundError:
            continue
    require(len(candidates) == 1, 'MANAGER_IDENTITY_CHANGED')
    pid = candidates[0]
    proc = PROC / str(pid)
    fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
    status = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
    require(status['Uid'].split() == [str(config['managerUid'])] * 4 and
            os.readlink(proc / 'exe') == config['tools']['node']['path'], 'MANAGER_IDENTITY_CHANGED')
    return {'pid': pid, 'unitMainPid': unit_pid, 'startTicks': fields[19], 'state': fields[0],
            'executable': os.readlink(proc / 'exe'), 'cgroup': unit_group.strip()}


def same_manager(identity):
    try:
        proc = PROC / str(identity['pid'])
        fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
        return fields[19] == identity['startTicks'] and os.readlink(proc / 'exe') == identity['executable']
    except FileNotFoundError:
        return False


def snapshot(config):
    filesystem = os.statvfs('/var/lib/ozz-builder')
    return {'at': now(), 'hostSha256': sha(regular(CONFIG)), 'limits': config['limits'],
            'builderFilesystemAvailableBytes': filesystem.f_bavail * filesystem.f_frsize,
            'launcherSha256': sha(regular(Path('/usr/local/libexec/ozz-builder-launch'))),
            'helperSha256': sha(regular(Path('/usr/local/libexec/ozz-builder-phase'))),
            'openRuns': [{'runId': run_id, 'deploymentId': state['spec']['deploymentId']}
                         for run_id, state in host_runs() if not state.get('terminationConfirmed')],
            'manager': manager_identity(config)}


def limits(config, restore):
    idle()
    backup = CONFIG.parent / ('s6-fault-limits-' + parameters['sessionId'])
    original = backup / 'host-before.json'
    receipt_path = backup / 'receipt.json'
    current = regular(CONFIG)
    if restore:
        require(backup.is_dir() and not backup.is_symlink(), 'LIMIT_BACKUP_MISSING')
        receipt = json.loads(regular(receipt_path))
        before = regular(original)
        require(sha(before) == receipt['beforeSha256'], 'LIMIT_BACKUP_CHANGED')
        manager_unchanged = same_manager(receipt['manager'])
        if sha(current) != receipt['beforeSha256']:
            require(sha(current) == receipt['duringSha256'], 'LIMIT_CONFIG_CHANGED')
            atomic(CONFIG, before)
        return {'at': now(), 'action': 'limits-restore', 'restored': True,
                'hostSha256': sha(regular(CONFIG)), 'originalSha256': receipt['beforeSha256'],
                'managerIdentityUnchanged': manager_unchanged,
                'managerRefreshRequired': not manager_unchanged}
    require(parameters.get('expectedHostSha256') == sha(current), 'HOST_CONFIG_CHANGED')
    require(config['limits']['timeoutSeconds'] > 40, 'TIMEOUT_NOT_LONGER_THAN_WINDOW')
    require(not backup.exists(), 'LIMIT_WINDOW_ALREADY_EXISTS')
    identity = manager_identity(config)
    changed = {**config, 'limits': {**config['limits'], 'timeoutSeconds': 40}}
    content = (json.dumps(changed, sort_keys=True, separators=(',', ':')) + '\n').encode()
    backup.mkdir(mode=0o700)
    atomic(original, current)
    receipt = {'at': now(), 'action': 'limits-begin', 'beforeSha256': sha(current),
               'duringSha256': sha(content), 'manager': identity, 'timeoutSeconds': 40,
               'otherConfigurationUnchanged': True}
    atomic(receipt_path, (json.dumps(receipt, indent=2) + '\n').encode())
    atomic(CONFIG, content)
    return receipt


def selected_state():
    state = json.loads(regular(RUNS / parameters['runId'] / 'state.json'))
    require(state['spec']['runId'] == parameters['runId'] and
            state['spec']['deploymentId'] == parameters['deploymentId'], 'RUN_IDENTITY_CHANGED')
    return state


def disconnect(config):
    state = selected_state()
    require(not state['closed'] and not state['terminationConfirmed'] and
            'building' in state['started'] and 'building' not in state['completed'], 'RUN_NOT_BUILDING')
    require([run_id for run_id, value in host_runs() if not value.get('terminationConfirmed')]
            == [parameters['runId']], 'ANOTHER_OPEN_RUN')
    require(state['spec']['limits']['timeoutSeconds'] > 60, 'DISCONNECT_NEEDS_NORMAL_DEADLINE')
    subprocess.run(['systemctl', 'is-active', '--quiet', 'ozz-builder-watchdog.timer'],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
    identity = manager_identity(config)
    require(identity['state'] not in ('T', 't'), 'MANAGER_ALREADY_STOPPED')
    guardian = os.fork()
    if guardian == 0:
        os.setsid()
        for descriptor in (0, 1, 2):
            os.close(descriptor)
        time.sleep(50)
        if same_manager(identity):
            os.kill(identity['pid'], signal.SIGCONT)
        os._exit(0)
    result = {'startedAt': now(), 'action': 'disconnect', 'runId': parameters['runId'],
              'deploymentId': parameters['deploymentId'], 'manager': identity,
              'leaseUntilBefore': state['leaseUntil'], 'watchdogKeptRunning': True,
              'maximumPauseSeconds': 50, 'samples': []}
    try:
        os.kill(identity['pid'], signal.SIGSTOP)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            state = selected_state()
            result['samples'].append({'at': now(), 'hostClosed': state['closed'],
                                      'hostTerminationConfirmed': state['terminationConfirmed'],
                                      'leaseUntil': state['leaseUntil']})
            if state['terminationConfirmed']:
                break
            time.sleep(0.5)
        result['hostClosedWhileManagerStopped'] = bool(state['closed'] and state['terminationConfirmed'])
    finally:
        if same_manager(identity):
            os.kill(identity['pid'], signal.SIGCONT)
            result['managerResumedAt'] = now()
        os.kill(guardian, signal.SIGTERM)
        os.waitpid(guardian, 0)
    return result


def main():
    require(os.getuid() == 0 and re.fullmatch(UUID, parameters.get('sessionId', '')), 'SELECTOR_INVALID')
    require(Path('/etc/ozz-source-builder-instance').read_text().strip() == 'ozz-build', 'WRONG_HOST')
    action = parameters.get('action')
    require(action in ('inspect', 'run-inspect', 'limits-begin', 'limits-restore', 'disconnect'), 'ACTION_INVALID')
    config = json.loads(regular(CONFIG))
    if action == 'inspect':
        return snapshot(config)
    if action in ('limits-begin', 'limits-restore'):
        return limits(config, action == 'limits-restore')
    require(re.fullmatch(UUID, parameters.get('runId', '')) and
            re.fullmatch(UUID, parameters.get('deploymentId', '')), 'SELECTOR_INVALID')
    if action == 'run-inspect':
        state = selected_state()
        ledger_path = LEDGER / (parameters['runId'] + '.json')
        metadata = ledger_path.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == config['managerUid'] and
                not metadata.st_mode & 0o022 and metadata.st_size <= 1024 * 1024, 'RUN_LEDGER_UNTRUSTED')
        ledger = json.loads(ledger_path.read_bytes())
        require(ledger['observation']['runId'] == parameters['runId'] and
                ledger['observation']['specHash'] == state['specHash'], 'RUN_LEDGER_CHANGED')
        group = Path('/sys/fs/cgroup') / ('ozz' + parameters['runId'].replace('-', '') + '.slice')
        events = (group / 'cgroup.events').read_text().strip() if (group / 'cgroup.events').exists() else None
        return {'at': now(), 'runId': parameters['runId'], 'deploymentId': parameters['deploymentId'],
                'specHash': state['specHash'], 'action': state['spec']['action'],
                'commitSha': state['spec']['source']['commitSha'], 'limits': state['spec']['limits'],
                'deadlineAt': state['spec']['deadlineAt'], 'leaseUntil': state['leaseUntil'],
                'started': state['started'], 'completed': state['completed'],
                'closed': state['closed'], 'terminationConfirmed': state['terminationConfirmed'],
                'cgroupExists': group.exists(), 'cgroupEvents': events,
                'signedProof': ledger['observation'].get('proof')}
    return disconnect(config)


if __name__ == '__main__':
    try:
        print(json.dumps({'version': 1, 'source': 'live Linux host control and observations', **main()}))
    except Exception as error:
        code = str(error)
        raise SystemExit(code if re.fullmatch(r'S6_FAULT_[A-Z_]+', code) else 'S6_FAULT_HOST_CONTROL_FAILED')
