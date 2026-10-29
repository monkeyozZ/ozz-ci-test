"""Read-only observation of an explicitly selected, product-registered Builder run.

The SSH caller prepends selector = {kind, id, waitSeconds}. No source, command
line, environment, or credential content is read. Access checks use the live
helper mount namespace and solve UID without changing cgroup membership.
"""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import re
import stat
import subprocess
import time


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def process_snapshot(group):
    ids = set()
    if group.exists():
        for path in group.rglob('cgroup.procs'):
            try:
                ids.update(path.read_text().split())
            except FileNotFoundError:
                pass
            if len(ids) > 512:
                raise RuntimeError('S6_KERNEL_PROCESS_BOUND')
    rows = []
    for pid in sorted(ids, key=int):
        proc = Path('/proc') / pid
        try:
            status = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
            rows.append({
                'pid': int(pid), 'name': status['Name'].strip(),
                'executable': os.readlink(proc / 'exe'),
                'uid': status['Uid'].split(), 'gid': status['Gid'].split(),
                'groups': status['Groups'].split(),
                'noNewPrivs': status['NoNewPrivs'].strip(),
                'capEffective': status['CapEff'].strip(),
                'cgroup': (proc / 'cgroup').read_text().strip(),
                'uidMap': (proc / 'uid_map').read_text().strip(),
                'namespaces': {name: os.readlink(proc / 'ns' / name) for name in ('user', 'mnt', 'net', 'pid')},
            })
        except (FileNotFoundError, ProcessLookupError, PermissionError, KeyError):
            pass
    return rows


def select_run():
    deadline = time.monotonic() + selector['waitSeconds']
    latest = None
    while time.monotonic() < deadline:
        paths = [Path('/var/lib/ozz-builder/host/runs') / selector['id'] / 'state.json']
        if selector['kind'] == 'deployment':
            paths = list(Path('/var/lib/ozz-builder/host/runs').glob('*/state.json'))
        for path in paths:
            try:
                state = json.loads(path.read_text())
            except FileNotFoundError:
                continue
            if selector['kind'] == 'deployment' and state['spec']['deploymentId'] != selector['id']:
                continue
            run_id = path.parent.name
            group = Path('/sys/fs/cgroup') / ('ozz' + run_id.replace('-', '') + '.slice')
            processes = process_snapshot(group)
            helper = next((row for row in processes if row['uid'][0] == '62002' and '/python3' in row['executable'] and row['cgroup'].endswith('-building.service')), None)
            latest = (path, state, group, processes, helper)
            if state.get('closed'):
                if selector['kind'] == 'run':
                    return latest
                continue
            if helper and any(row['executable'].endswith('/buildkitd') for row in processes):
                return latest
        time.sleep(0.2)
    return latest


def access_checks(helper, parent_paths, run_id):
    proc = Path('/proc') / str(helper['pid'])
    read_end, write_end = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(read_end)
        try:
            namespace = os.open(proc / 'ns/mnt', os.O_RDONLY)
            os.setns(namespace, 0)
            os.close(namespace)
            os.setgroups([])
            os.setresgid(62002, 62002, 62002)
            os.setresuid(62002, 62002, 62002)
            guarded = ['/etc/ozz-builder', '/var/lib/ozz-builder/manager', '/var/lib/ozz-builder/host/runs/' + run_id + '/state.json']
            result = {
                'uid': os.getresuid(), 'gid': os.getresgid(),
                'mountNamespaceOfHelper': True, 'credentialContentsRead': False,
                'guardedPaths': [{'path': path, 'readable': os.access(path, os.R_OK, effective_ids=True), 'searchable': os.access(path, os.X_OK, effective_ids=True)} for path in guarded],
                'parentCgroupWrites': [{'path': path, 'writable': os.access(path, os.W_OK, effective_ids=True)} for path in parent_paths],
                'tunDacReadable': os.access('/dev/net/tun', os.R_OK, effective_ids=True),
                'tunDacWritable': os.access('/dev/net/tun', os.W_OK, effective_ids=True),
                'deviceCgroupMembershipUnchanged': True,
            }
        except Exception as error:
            result = {'errorClass': type(error).__name__, 'errno': getattr(error, 'errno', None), 'credentialContentsRead': False}
        os.write(write_end, json.dumps(result).encode())
        os.close(write_end)
        os._exit(0)
    os.close(write_end)
    data = b''
    while True:
        chunk = os.read(read_end, 65536)
        if not chunk:
            break
        data += chunk
    os.close(read_end)
    os.waitpid(child, 0)
    return json.loads(data)


def capture(selected):
    if selected is None:
        return {'status': 'run_not_observed', 'observedAt': timestamp()}
    path, state, group, processes, helper = selected
    run_id = path.parent.name
    before = {key: state.get(key) for key in ('closed', 'terminationConfirmed', 'started', 'completed', 'specHash')}
    result = {
        'runId': run_id, 'deploymentId': state['spec']['deploymentId'],
        'observedAt': timestamp(), 'stateBefore': before,
        'status': 'run_already_closed' if state.get('closed') else 'live_sample' if helper else 'helper_not_observed',
        'requestedLimits': state['spec']['limits'], 'processes': processes,
        'hostNamespaces': {name: os.readlink('/proc/1/ns/' + name) for name in ('user', 'mnt', 'net', 'pid')},
    }
    if state.get('closed') or not helper:
        return result
    names = ['cpu.max', 'memory.max', 'memory.swap.max', 'pids.max', 'memory.current', 'pids.current', 'cgroup.events']
    values = {name: (group / name).read_text().strip() for name in names}
    parent_paths = [str(group), str(group / 'cgroup.procs'), str(group / 'cgroup.subtree_control'), *[str(group / name) for name in names[:4]]]
    ownership = []
    for text in parent_paths:
        info = Path(text).stat()
        ownership.append({'path': text, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': oct(info.st_mode & 0o777)})
    result['parentCgroup'] = {'path': str(group), 'values': values, 'ownership': ownership}
    disk = path.parent / 'disk'
    vfs = os.statvfs(disk)
    result['executionFilesystem'] = {
        'mounted': os.path.ismount(disk), 'capacityBytes': vfs.f_blocks * vfs.f_frsize,
        'availableBytes': vfs.f_bavail * vfs.f_frsize,
        'imageBytes': (path.parent / 'execution.ext4').stat().st_size,
        'mount': next(line for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == str(disk)),
    }
    proc = Path('/proc') / str(helper['pid'])
    result['helperPid'] = helper['pid']
    network = subprocess.run(['nft', '-n', 'list', 'table', 'inet', 'ozz' + run_id.replace('-', '')],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
    result['networkRules'] = network.stdout.decode() if network.returncode == 0 else None
    result['helperMounts'] = [line for line in (proc / 'mountinfo').read_text().splitlines() if line.split()[4] in ['/etc/ozz-builder', '/var/lib/ozz-builder/manager', '/sys/fs/cgroup', str(disk)] or line.split()[4].startswith('/dev')]
    root = proc / 'root'
    devices = []
    def walk(directory, depth=0):
        if depth > 3 or len(devices) >= 64:
            return
        for entry in directory.iterdir():
            info = entry.lstat()
            if stat.S_ISCHR(info.st_mode) or stat.S_ISBLK(info.st_mode):
                devices.append({'path': '/dev/' + str(entry.relative_to(root / 'dev')), 'kind': 'character' if stat.S_ISCHR(info.st_mode) else 'block', 'major': os.major(info.st_rdev), 'minor': os.minor(info.st_rdev), 'mode': oct(info.st_mode & 0o777)})
            elif stat.S_ISDIR(info.st_mode):
                walk(entry, depth + 1)
    walk(root / 'dev')
    result['privateDevices'] = devices
    result['solveUidAccess'] = access_checks(helper, parent_paths, run_id)
    after = json.loads(path.read_text())
    result['stateAfter'] = {key: after.get(key) for key in ('closed', 'terminationConfirmed', 'started', 'completed')}
    result['finishedAt'] = timestamp()
    return result


def timeline(run_id, seconds):
    """Raw kernel counters only; workload assertions are recorded elsewhere."""
    group = Path('/sys/fs/cgroup') / ('ozz' + run_id.replace('-', '') + '.slice')
    directory = Path('/var/lib/ozz-builder/host/runs') / run_id
    deadline = time.monotonic() + seconds
    samples = []
    source_processes = []
    process_check = 0
    while time.monotonic() < deadline:
        if not source_processes and time.monotonic() >= process_check:
            source_processes = [row for row in process_snapshot(group) if row['name'] == 's6-workload'][:16]
            process_check = time.monotonic() + 1
        values = {}
        for name in ('cpu.stat', 'memory.events', 'pids.events', 'memory.current', 'pids.current',
                     'cpu.max', 'memory.max', 'memory.swap.max', 'pids.max', 'cgroup.events'):
            try:
                values[name] = (group / name).read_text().strip()
            except FileNotFoundError:
                values[name] = None
        # The fork rejection can be accounted to the requesting descendant
        # even when the shared parent is the cgroup whose PID limit is full.
        # Keep each raw counter and its path instead of inferring an event
        # from pids.current or the controlled workload's EAGAIN marker.
        descendant_pids_events = []
        for event_path in group.rglob('pids.events'):
            if event_path.parent == group:
                continue
            try:
                descendant_pids_events.append({'cgroup': str(event_path.parent.relative_to(group)),
                                               'events': event_path.read_text().strip()})
            except FileNotFoundError:
                pass
            if len(descendant_pids_events) >= 64:
                raise RuntimeError('S6_KERNEL_CGROUP_BOUND')
        state = json.loads((directory / 'state.json').read_text())
        mounted = os.path.ismount(directory / 'disk')
        available = None
        if mounted:
            disk = os.statvfs(directory / 'disk')
            available = disk.f_bavail * disk.f_frsize
        samples.append({'at': timestamp(), 'kernel': values, 'descendantPidsEvents': descendant_pids_events,
                        'diskMounted': mounted,
                        'diskAvailableBytes': available, 'hostClosed': state.get('closed'),
                        'hostTerminationConfirmed': state.get('terminationConfirmed')})
        if state.get('terminationConfirmed') or len(samples) >= 1200:
            break
        time.sleep(0.1)
    return {'samples': samples, 'sourceProcesses': source_processes}


if os.getuid() != 0 or selector['kind'] not in ('run', 'deployment') or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', selector['id']) or not 1 <= selector['waitSeconds'] <= 120 or not 0 <= selector.get('timelineSeconds', 0) <= 120:
    raise SystemExit('S6_KERNEL_SELECTOR_INVALID')
try:
    observation = capture(select_run())
    if observation.get('status') == 'live_sample' and selector.get('timelineSeconds', 0):
        observation['cgroupTimeline'] = timeline(observation['runId'], selector['timelineSeconds'])
except (FileNotFoundError, ProcessLookupError) as error:
    observation = {'status': 'run_changed_during_sample', 'observedAt': timestamp(), 'errorClass': type(error).__name__}
print(json.dumps({'version': 1, 'selector': selector, 'scope': 'Read-only kernel values, device metadata and DAC/mount access checks; no stress test, credential reads, unit changes or new build execution.', **observation}))
