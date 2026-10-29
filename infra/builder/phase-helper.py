#!/usr/bin/python3 -I
"""Root-owned helper, executed under a distinct unprivileged UID per phase.

No shell, repository hooks, shared credential helper, management socket, or
runtime pull credential is exposed to a Dockerfile. The root launcher owns all
paths and the surrounding cgroup, mount, network and disk boundaries.
"""
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


def command(argv, env, cwd=None, capture=False):
    return subprocess.run(argv, env=env, cwd=cwd, check=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def secret_file(directory, name, value):
    path = directory / name
    with path.open('x', encoding='utf8') as handle:
        os.chmod(path, 0o600)
        handle.write(value)
    return str(path)


def git_checkout(request, env, work, secrets):
    grant = request['credentials']
    spec = request['spec']
    git = request['tools']['git']
    source = work / 'source'
    source.mkdir(mode=0o700)
    env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                'GIT_TERMINAL_PROMPT': '0', 'GIT_ALLOW_PROTOCOL': 'https',
                'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.extraHeader',
                'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + base64.b64encode(
                    ('x-access-token:' + grant['token']).encode()).decode()})
    if grant.get('caCertificate'):
        env['GIT_SSL_CAINFO'] = secret_file(secrets, 'git-ca.pem', grant['caCertificate'])
    common = [git, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
              '-c', 'credential.helper=', '-c', 'protocol.file.allow=never',
              '-c', 'protocol.ext.allow=never', '-c', 'http.followRedirects=false',
              '-c', 'submodule.recurse=false', '-c', 'filter.lfs.required=false']
    command(common + ['init', '--template=', str(source)], env)
    command(common + ['-C', str(source), 'fetch', '--no-tags', '--no-recurse-submodules',
                      '--depth=1', grant['cloneUrl'], spec['source']['commitSha']], env)
    head = command(common + ['-C', str(source), 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], env, capture=True).stdout.decode().strip()
    if head != spec['source']['commitSha']:
        raise RuntimeError('BUILD_CHECKOUT_IDENTITY_MISMATCH')
    command(common + ['-C', str(source), 'checkout', '--detach', '--force', head], env)
    # No submodules/LFS are implicitly downloaded or executed.
    if (source / '.gitmodules').exists():
        raise RuntimeError('BUILD_SUBMODULE_UNSUPPORTED')
    (work / 'checkout-result.json').write_text(json.dumps({'commitSha': head}))


def build_proxy_environment(request):
    proxy = request.get('buildHttpProxy')
    if proxy is None:
        return {}
    if request.get('phase') != 'building' or type(proxy) is not str:
        raise RuntimeError('BUILD_HTTP_PROXY_PHASE_INVALID')
    match = re.fullmatch(r'http://([0-9.]+):([1-9][0-9]{0,4})', proxy)
    if not match or int(match[2]) > 65535:
        raise RuntimeError('BUILD_HTTP_PROXY_ENDPOINT_INVALID')
    try:
        if str(ipaddress.IPv4Address(match[1])) != match[1]:
            raise ValueError()
    except ValueError:
        raise RuntimeError('BUILD_HTTP_PROXY_ENDPOINT_INVALID') from None
    return {name: proxy for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy')}


def solve(request, env, work, secrets):
    spec, tools = request['spec'], request['tools']
    env.update(build_proxy_environment(request))
    socket = work / 'buildkit.sock'
    env['XDG_RUNTIME_DIR'] = str(work / 'runtime')
    Path(env['XDG_RUNTIME_DIR']).mkdir(mode=0o700, exist_ok=True)
    daemon = subprocess.Popen([
        tools['rootlesskit'], '--net=slirp4netns', '--disable-host-loopback',
        '--pidns', '--copy-up=/etc', '--copy-up=/run',
        '--state-dir=' + str(work / 'rootlesskit'), tools['buildkitd'],
        '--addr=unix://' + str(socket), '--root=' + str(work / 'cache'),
        '--oci-worker=true', '--containerd-worker=false', '--oci-worker-rootless',
        '--oci-worker-snapshotter=native', '--oci-worker-binary=' + tools['runc'],
    ], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    def drain():
        while True:
            data = daemon.stdout.read(4096)
            if not data:
                return
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        for _ in range(150):
            if daemon.poll() is not None:
                raise RuntimeError('BUILD_ROOTLESS_DAEMON_FAILED')
            if socket.exists():
                ready = subprocess.run([tools['buildctl'], '--addr=unix://' + str(socket),
                                        'debug', 'workers'], env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if ready.returncode == 0:
                    break
            time.sleep(0.1)
        else:
            raise RuntimeError('BUILD_ROOTLESS_DAEMON_TIMEOUT')
        source = Path(request['sourceDirectory'])
        dockerfile = source / spec['source']['dockerfilePath']
        context = source / spec['source']['contextPath']
        platform = spec['source']['platforms'][0]
        args = [tools['buildctl'], '--addr=unix://' + str(socket), 'build',
                '--progress=plain', '--frontend=gateway.v0',
                '--opt=source=docker/dockerfile@' + spec['profile']['frontendDigest'],
                '--local=context=' + str(context), '--local=dockerfile=' + str(dockerfile.parent),
                '--opt=filename=' + dockerfile.name,
                '--opt=platform=' + platform['os'] + '/' + platform['architecture'] +
                ('/' + platform['variant'] if platform.get('variant') else ''),
                '--output=type=oci,dest=' + str(work / 'result.oci.tar')]
        for name, value in sorted(spec['source']['buildArgs'].items()):
            if name.startswith('BUILDKIT_'):
                raise RuntimeError('BUILD_RESERVED_ARGUMENT')
            args.append('--opt=build-arg:' + name + '=' + value)
        for entry in request['credentials']['secrets']:
            args.append('--secret=id=' + entry['mountId'] + ',src=' +
                        secret_file(secrets, entry['mountId'], entry['value']))
        command(args, env)
    finally:
        daemon.send_signal(signal.SIGTERM)
        try:
            daemon.wait(timeout=10)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait(timeout=10)
        reader.join(timeout=5)


def validate_registry_challenge(spec, grant, context):
    allowed = {'https://' + spec['destination']['authority'], *grant.get('tokenServiceOrigins', [])}
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),
                                        urllib.request.ProxyHandler({}))
    # No credential is used for this challenge-origin check.
    req = urllib.request.Request('https://' + spec['destination']['authority'] +
                                 '/v2/' + spec['destination']['repository'] + '/manifests/ozz-challenge-check')
    try:
        response = opener.open(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    challenge = response.headers.get('WWW-Authenticate', '')
    if challenge.lower().startswith('bearer '):
        match = re.search(r'(?:^|[,\s])realm="([^"]+)"', challenge[7:])
        if not match:
            raise RuntimeError('BUILD_REGISTRY_CHALLENGE_INVALID')
        realm = urllib.parse.urlsplit(match[1])
        if realm.scheme != 'https' or realm.username or realm.password or realm.scheme + '://' + realm.netloc not in allowed:
            raise RuntimeError('BUILD_REGISTRY_TOKEN_ORIGIN_REJECTED')
    response.close()


def push(request, env, work, secrets):
    grant, spec = request['credentials'], request['spec']
    authority = spec['destination']['authority']
    auth = base64.b64encode((grant['username'] + ':' + grant['password']).encode()).decode()
    authfile = secret_file(secrets, 'auth.json', json.dumps({'auths': {authority: {'auth': auth}}}))
    context = ssl.create_default_context()
    args = [request['tools']['skopeo'], '--tmpdir=' + str(work / 'tmp'),
            'copy', '--all', '--preserve-digests', '--authfile=' + authfile]
    if grant.get('caCertificate'):
        context.load_verify_locations(cadata=grant['caCertificate'])
        ca_dir = secrets / 'registry-certs'
        ca_dir.mkdir(mode=0o700)
        secret_file(ca_dir, 'ca.crt', grant['caCertificate'])
        args.append('--dest-cert-dir=' + str(ca_dir))
        bundle = Path('/etc/ssl/certs/ca-certificates.crt').read_text() + '\n' + grant['caCertificate']
        env['SSL_CERT_FILE'] = secret_file(secrets, 'upload-ca.pem', bundle)
    validate_registry_challenge(spec, grant, context)
    args += ['oci-archive:' + request['archivePath'],
             'docker://' + authority + '/' + spec['destination']['repository'] + ':ozz-' + spec['runId']]
    command(args, env)


def main():
    if os.getuid() == 0:
        raise RuntimeError('BUILD_HELPER_MUST_BE_UNPRIVILEGED')
    raw = sys.stdin.buffer.read(524289)
    if len(raw) > 524288:
        raise RuntimeError('BUILD_REQUEST_TOO_LARGE')
    request = json.loads(raw)
    work, secrets = Path(request['workDirectory']), Path(request['secretDirectory'])
    env = {'PATH': '/opt/ozz-builder/bin:/usr/bin:/bin', 'HOME': str(work / 'home'),
           'TMPDIR': str(work / 'tmp'),
           'XDG_CONFIG_HOME': str(work / 'home' / '.config'), 'LANG': 'C.UTF-8'}
    Path(env['HOME']).mkdir(mode=0o700, exist_ok=True)
    os.chdir(work)
    try:
        {'checkout': git_checkout, 'building': solve, 'pushing': push}[request['phase']](request, env, work, secrets)
    finally:
        # root also unmounts the whole credential tmpfs after this service exits.
        for directory, _, files in os.walk(secrets, topdown=False):
            for name in files:
                try:
                    os.unlink(Path(directory) / name)
                except FileNotFoundError:
                    pass


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # The root launcher forwards source/tool output, but never a credential-bearing exception.
        sys.stderr.write('BUILD_PHASE_FAILED\n')
        sys.exit(1)
