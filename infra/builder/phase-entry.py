#!/usr/bin/python3 -I
"""Trusted ExecStart gate. No source or credentials are interpreted before UID drop.

A delayed StartTransientUnit may arrive after the launcher has confirmed an
empty group. It still enters here, sees the permanent root tombstone, and
cannot start source. The lock spans validation, UID drop and exec in one PID.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

ROOT = Path('/var/lib/ozz-builder/host/runs')
HELPER = '/usr/local/libexec/ozz-builder-phase'
PHASES = {'checkout', 'building', 'pushing'}


def private_fd(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
        os.close(descriptor)
        raise RuntimeError('BUILD_ENTRY_LEDGER_UNTRUSTED')
    return descriptor


def allowed_entry(state, run_id, phase, nonce, boot_id, cgroup):
    entry = state.get('phaseEntries', {}).get(phase)
    prefix = 'ozz' + run_id.replace('-', '')
    expected_group = '/' + prefix + '.slice/' + prefix + '-' + phase + '.service'
    if (state.get('closed') or state.get('terminationConfirmed') or state.get('bootId') != boot_id or
            not entry or entry.get('nonce') != nonce or entry.get('specHash') != state.get('specHash') or
            state['spec']['runId'] != run_id or phase not in state['started'] or phase in state['completed'] or
            not cgroup.rstrip().endswith('0::' + expected_group) or
            not isinstance(entry.get('uid'), int) or entry['uid'] < 1000):
        raise RuntimeError('BUILD_ENTRY_FENCED')
    deadline = min(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
                   for value in (state['leaseUntil'], state['spec']['deadlineAt']))
    if time.time() >= deadline:
        raise RuntimeError('BUILD_ENTRY_FENCED')
    return entry['uid'], expected_group


def main():
    if os.getuid() != 0 or len(sys.argv) != 4:
        raise RuntimeError('BUILD_ENTRY_ROOT_REQUIRED')
    run_id, phase, nonce = sys.argv[1:]
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', run_id) or phase not in PHASES or not re.fullmatch(r'[0-9a-f-]{36}', nonce):
        raise RuntimeError('BUILD_ENTRY_ARGUMENT_INVALID')
    directory = ROOT / run_id
    lock_fd = private_fd(directory / 'lock')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        state_fd = private_fd(directory / 'state.json')
        with os.fdopen(state_fd, 'rb') as source:
            raw = source.read(1048577)
        if len(raw) > 1048576:
            raise RuntimeError('BUILD_ENTRY_LEDGER_LIMIT')
        state = json.loads(raw)
        uid, group = allowed_entry(state, run_id, phase, nonce,
                                   Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                                   Path('/proc/self/cgroup').read_text())
        # Only the verified current service subtree is delegated; its parent limits stay root-owned.
        cgroup = Path('/sys/fs/cgroup' + group)
        for name in ('', 'cgroup.procs', 'cgroup.threads', 'cgroup.subtree_control'):
            path = cgroup / name
            if path.exists():
                os.chown(path, uid, uid, follow_symlinks=False)
        os.setgroups([])
        os.setresgid(uid, uid, uid)
        os.setresuid(uid, uid, uid)
        if os.getresuid() != (uid, uid, uid) or os.getresgid() != (uid, uid, uid):
            raise RuntimeError('BUILD_ENTRY_UID_INVALID')
        # close-on-exec releases the root lock only when this process becomes the unprivileged helper.
        os.execve(HELPER, [HELPER], {'PATH': '/opt/ozz-builder/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    finally:
        os.close(lock_fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('BUILD_ENTRY_FENCED\n')
        sys.exit(1)
