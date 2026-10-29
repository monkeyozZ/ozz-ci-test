#!/usr/bin/env python3
"""Apply only the reviewed S6 egress files/config to the existing local Builder.

Requires the product runtime stopped and every retained run closed. Preserves
host files, config, identity, releases and ledgers; never restarts the VM.
"""
import ast
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / '.local/local-lab/builder'
OLD = {
    'launcher.py': '72cb0f39543260c771e0d88c85078ef401106fb2071e55d6f0962be9dfe5e8e6',
    'phase-helper.py': 'a8f9418c8bb7d126d72b7542d395345d65058fe7699add281cb37707830e7e5a',
}
PROXY = {'url': 'http://host.lima.internal:51449', 'addresses': ['192.168.5.2']}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if len(sys.argv) not in (3, 4) or any(not re.fullmatch(r'[a-f0-9]{64}', value) for value in sys.argv[1:3]):
        raise RuntimeError('S6_EGRESS_HASHES_REQUIRED')
    resume = sys.argv[3].removeprefix('--resume=') if len(sys.argv) == 4 else None
    if resume and (not sys.argv[3].startswith('--resume=') or not re.fullmatch(r'egress-[0-9TZ]+-[a-f0-9]{8}', resume)):
        raise RuntimeError('S6_EGRESS_RESUME_INVALID')
    runtime = json.loads((ROOT / '.local/s3-runtime.json').read_text())
    for role in ('api', 'worker'):
        pid = runtime.get(role)
        if isinstance(pid, int) and pid > 1:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise RuntimeError('S6_EGRESS_REQUIRES_STOPPED_RUNTIME')
    expected = dict(zip(OLD, sys.argv[1:3]))
    for name, digest in expected.items():
        source = ROOT / 'infra/builder' / name
        if sha(source) != digest:
            raise RuntimeError('S6_EGRESS_SOURCE_CHANGED')
        ast.parse(source.read_text())
    os.umask(0o077)
    attempt = resume or 'egress-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8]
    output = BASE / 'updates' / attempt
    if resume:
        assert output.is_dir() and (output / 'install.log').exists() and not (output / 'results.json').exists()
    else:
        output.mkdir(parents=True, mode=0o700)
    remote = '/home/ozz/' + attempt
    ssh = ['-F', str(BASE / 'credentials/ssh_config'), 'ozz-build']
    if not resume:
        with (output / 'transfer.log').open('x') as log:
            subprocess.run(['ssh', *ssh, 'mkdir -m 700 ' + remote], check=True, stdout=log, stderr=log, timeout=15)
            for name in expected:
                subprocess.run(['scp', '-q', *ssh[:-1], str(ROOT / 'infra/builder' / name), 'ozz-build:' + remote + '/' + name], check=True, stdout=log, stderr=log, timeout=30)
    parameters = {'attempt': attempt, 'remote': remote, 'old': OLD, 'expected': expected, 'proxy': PROXY, 'resume': bool(resume)}
    program = '''
import ast,datetime,hashlib,importlib.util,json,os,shutil,subprocess
from pathlib import Path
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
assert Path('/etc/ozz-source-builder-instance').read_text().strip()=='ozz-build'
destinations={'launcher.py':Path('/usr/local/libexec/ozz-builder-launch'),'phase-helper.py':Path('/usr/local/libexec/ozz-builder-phase')}
base=Path(p['remote'])
for name,target in destinations.items():
 assert target.is_file() and not target.is_symlink() and sha(target)==(p['expected'] if p['resume'] else p['old'])[name]
 source=base/name
 assert source.is_file() and not source.is_symlink() and sha(source)==p['expected'][name]
 ast.parse(source.read_text())
spec=importlib.util.spec_from_file_location('ozz_pending_egress',base/'launcher.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
proxy=module.validate_build_http_proxy(p['proxy'])
host_path=Path('/etc/ozz-builder/host.json')
host=json.loads(host_path.read_text())
if p['resume']: assert host.get('buildHttpProxy')==proxy
else: assert 'buildHttpProxy' not in host
def confirmed():
 count=0
 for path in Path('/var/lib/ozz-builder/host/runs').glob('*/state.json'):
  state=json.loads(path.read_text());assert state['closed'] and state['terminationConfirmed'];count+=1
 return count
retained=confirmed()
backup=Path('/etc/ozz-builder')/p['attempt']
if p['resume']:
 for name in destinations: assert sha(backup/name)==p['old'][name]
 old_host=json.loads((backup/'host.json').read_text())
 assert 'buildHttpProxy' not in old_host and {**old_host,'buildHttpProxy':proxy}==host
else:
 backup.mkdir(mode=0o700)
 for name,target in destinations.items():
  shutil.copyfile(target,backup/name);os.chmod(backup/name,0o600)
 shutil.copyfile(host_path,backup/'host.json');os.chmod(backup/'host.json',0o600)
host_sha=sha(backup/'host.json')
if not p['resume']:
 subprocess.run(['systemctl','stop','ozz-builder.service'],check=True)
 confirmed()
 try:
  for name,target in destinations.items():
   temporary=target.with_name(target.name+'.'+p['attempt'])
   with temporary.open('xb') as f:
    f.write((base/name).read_bytes());f.flush();os.fsync(f.fileno())
   os.chown(temporary,0,0);os.chmod(temporary,0o755);os.replace(temporary,target)
  host['buildHttpProxy']=proxy
  module.atomic(host_path,host)
 finally:
  subprocess.run(['systemctl','start','ozz-builder.service'],check=True)
result=subprocess.run(['runuser','-u','ozz-builder','--','sudo','-n','--','/usr/local/libexec/ozz-builder-launch','preflight'],capture_output=True,text=True,timeout=30)
if result.returncode: raise RuntimeError('S6_EGRESS_PREFLIGHT_FAILED')
receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousFiles':p['old'],'installedFiles':p['expected'],'previousHostSha256':host_sha,'hostSha256':sha(host_path),'buildHttpProxy':proxy,'retainedClosedRuns':retained,'previousFilesPreserved':True,'preflightPassed':True,'identityRetained':True,'vmRestarted':False,'resumedAfterInstallCheckFailure':p['resume']}
(backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\\n');os.chmod(backup/'receipt.json',0o600)
print(json.dumps(receipt))
'''
    with (output / ('resume-' + uuid.uuid4().hex[:8] + '.log' if resume else 'install.log')).open('x') as log:
        result = subprocess.run(['ssh', *ssh, 'sudo python3 -I -B -'], input='p=' + repr(parameters) + '\n' + program, text=True, stdout=subprocess.PIPE, stderr=log, timeout=90)
        log.write(result.stdout)
    if result.returncode:
        raise RuntimeError('S6_EGRESS_UPDATE_FAILED')
    receipt = json.loads(result.stdout)
    operator = BASE / 'operator-config.json'
    config = json.loads(operator.read_text())
    assert 'buildHttpProxy' not in config
    (output / 'operator-config-before.json').write_bytes(operator.read_bytes())
    config['buildHttpProxy'] = PROXY
    temporary = operator.with_name('operator-config.' + attempt + '.json')
    with temporary.open('x') as file:
        json.dump(config, file, indent=2)
        file.write('\n')
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, operator)
    (output / 'results.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': 'passed', 'report': str(output / 'results.json'), 'retainedClosedRuns': receipt['retainedClosedRuns']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch(r'S6_EGRESS_[A-Z_]+', code) else 'S6_EGRESS_UPDATE_FAILED', file=sys.stderr)
        sys.exit(1)
