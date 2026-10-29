#!/usr/bin/env python3
"""Read-only inspection of an Ozz-owned local VM; never reports credentials."""
import json
import os
import platform
import shutil

release = {}
with open('/etc/os-release', encoding='utf-8') as stream:
    for line in stream:
        key, separator, value = line.strip().partition('=')
        if separator:
            release[key] = value.strip('"')
memory = {}
with open('/proc/meminfo', encoding='utf-8') as stream:
    for line in stream:
        key, value = line.split(':', 1)
        memory[key] = int(value.strip().split()[0]) * 1024
with open('/proc/1/comm', encoding='utf-8') as stream:
    init = stream.read().strip()
disk = shutil.disk_usage('/')
print(json.dumps({
    'os': release.get('ID'),
    'version': release.get('VERSION_ID'),
    'architecture': platform.machine(),
    'kernel': platform.release(),
    'hostname': platform.node(),
    'cpus': os.cpu_count(),
    'memoryBytes': memory.get('MemTotal'),
    'rootDiskBytes': disk.total,
    'rootDiskAvailableBytes': disk.free,
    'init': init,
    'k3sInstalled': bool(shutil.which('k3s')),
    'labOwned': os.path.exists('/etc/ozz-local-lab-instance'),
}, separators=(',', ':')))
