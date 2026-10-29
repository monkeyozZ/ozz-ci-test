#!/usr/bin/env python3
"""Install a verified JS-only bundle into the dedicated local Builder.

Requires stopped local API/Worker and confirmed termination of every retained
Builder run. Keeps previous releases, units and all receipts; never resets a
ledger, changes identity or restarts a VM/application node.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / '.local/local-lab/builder'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r's6-[A-Za-z0-9-]+', sys.argv[1]) or not re.fullmatch(r'[a-f0-9]{64}', sys.argv[2]):
        raise RuntimeError('S6_BUILDER_UPDATE_ARGUMENT_INVALID')
    name, expected = sys.argv[1:]
    runtime = json.loads((ROOT / '.local/s3-runtime.json').read_text())
    for role in ('api', 'worker'):
        pid = runtime.get(role)
        if isinstance(pid, int) and pid > 1:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise RuntimeError('S6_BUILDER_UPDATE_REQUIRES_STOPPED_RUNTIME')
    bundle = BASE / 'bundles' / name
    manifest = bundle / 'builder-bundle-manifest.json'
    if sha(manifest) != expected:
        raise RuntimeError('S6_BUILDER_UPDATE_MANIFEST_MISMATCH')
    entries = json.loads(manifest.read_text())['entries']
    for entry in entries:
        path = bundle / entry['path']
        if not path.resolve().is_relative_to(bundle) or not path.is_file() or path.is_symlink() or path.stat().st_size != entry['bytes'] or sha(path) != entry['sha256']:
            raise RuntimeError('S6_BUILDER_UPDATE_FILE_MISMATCH')
    os.umask(0o077)
    attempt = 'update-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8]
    directory = BASE / 'updates' / attempt
    directory.mkdir(parents=True, mode=0o700)
    archive = directory / 'application.tar'
    with tarfile.open(archive, 'x') as handle:
        handle.add(bundle, arcname=name)
    digest = sha(archive)
    remote_archive = '/home/ozz/' + attempt + '.tar'
    ssh = ['-F', str(BASE / 'credentials/ssh_config'), 'ozz-build']
    with (directory / 'transfer.log').open('x') as log:
        subprocess.run(['scp', '-q', *ssh[:-1], str(archive), 'ozz-build:' + remote_archive], stdout=log, stderr=log, check=True, timeout=60)
    parameters = {'name': name, 'expected': expected, 'archive': remote_archive, 'archiveSha256': digest, 'attempt': attempt}
    program = """
import datetime,hashlib,json,os,subprocess,tarfile
from pathlib import Path,PurePosixPath
def sha(path):
 with path.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()
assert Path('/etc/ozz-source-builder-instance').read_text().strip()=='ozz-build'
retained=0
for path in Path('/var/lib/ozz-builder/host/runs').glob('*/state.json'):
 state=json.loads(path.read_text())
 assert state['closed'] and state['terminationConfirmed']
 retained+=1
archive=Path(p['archive'])
assert sha(archive)==p['archiveSha256']
release=Path('/opt/ozz-builder/releases')/p['name']
assert not release.exists()
with tarfile.open(archive) as t:
 for member in t.getmembers():
  parts=PurePosixPath(member.name).parts
  assert parts[0]==p['name'] and '..' not in parts and not member.name.startswith('/')
  assert member.isdir() or member.isfile() or member.issym()
  if member.issym(): assert os.path.normpath(str(PurePosixPath(member.name).parent/member.linkname)).startswith(p['name']+'/')
 t.extractall(release.parent,filter='data')
manifest=release/'builder-bundle-manifest.json'
assert sha(manifest)==p['expected']
entries=json.loads(manifest.read_text())['entries']
for e in entries:
 f=release/e['path']
 assert f.is_file() and not f.is_symlink() and f.stat().st_size==e['bytes'] and sha(f)==e['sha256']
for directory,dirs,files in os.walk(release):
 os.chown(directory,0,0);os.chmod(directory,0o755)
 for name in dirs+files:
  f=Path(directory)/name
  if f.is_symlink(): assert f.resolve().is_relative_to(release)
  elif f.is_file(): os.chown(f,0,0);os.chmod(f,0o644)
subprocess.run(['systemctl','stop','ozz-builder.service'],check=True)
for path in Path('/var/lib/ozz-builder/host/runs').glob('*/state.json'):
 state=json.loads(path.read_text());assert state['closed'] and state['terminationConfirmed']
unit=Path('/etc/systemd/system/ozz-builder.service')
old=unit.read_text()
import re
previous=re.findall(r'/opt/ozz-builder/releases/[A-Za-z0-9-]+/apps/builder/dist/main.js',old)
assert len(previous)==1
backup=Path('/etc/ozz-builder')/(p['attempt']+'-previous.service')
assert not backup.exists()
backup.write_text(old);os.chmod(backup,0o600)
unit.write_text(old.replace(previous[0],str(release/'apps/builder/dist/main.js')))
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','start','ozz-builder.service'],check=True)
subprocess.run(['/opt/ozz-builder/bin/node','-e','require('+json.dumps(str(release/'apps/builder/dist/main.js'))+')'],check=True)
receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bundle':p['name'],'manifestSha256':p['expected'],'archiveSha256':p['archiveSha256'],'filesVerified':len(entries),'oldReleaseRetained':True,'allHostRunsTerminationConfirmed':True,'retainedRuns':retained,'identityRetained':True,'vmRestarted':False}
out=Path('/etc/ozz-builder')/(p['attempt']+'.json')
out.write_text(json.dumps(receipt,indent=2)+'\\n');os.chmod(out,0o600)
print(json.dumps(receipt))
"""
    source = 'p=' + repr(parameters) + '\n' + program
    with (directory / 'install.log').open('x') as log:
        result = subprocess.run(['ssh', *ssh, 'sudo python3 -I -'], input=source, text=True, stdout=subprocess.PIPE, stderr=log, timeout=90)
        log.write(result.stdout)
    if result.returncode:
        raise RuntimeError('S6_BUILDER_UPDATE_INSTALL_FAILED')
    receipt = json.loads(result.stdout)
    (directory / 'results.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': 'passed', 'bundle': name, 'filesVerified': len(entries), 'report': str(directory / 'results.json')}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch(r'S6_BUILDER_[A-Z0-9_]+', code) else 'S6_BUILDER_UPDATE_FAILED', file=sys.stderr)
        sys.exit(1)
