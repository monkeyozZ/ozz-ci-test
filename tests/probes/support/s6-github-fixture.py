#!/usr/bin/env python3
"""Controlled GitHub HTTP protocol backed by real, local bare Git repositories.

Only local acceptance uses this provider. It is not evidence of GitHub itself
authorizing a PAT or delivering a webhook. No source checkout/build runs here.
"""

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit
from uuid import uuid4

OWNER = 'ozz-s6-github-fixture-v1'
MAX_BODY = 65536
MAX_GIT_RESPONSE = 4 * 1024 * 1024
FULL_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}')
SHA = re.compile(r'[0-9a-f]{40}')
DECIMAL = re.compile(r'[1-9][0-9]{0,19}')


class FixtureError(Exception):
    pass


def require(condition):
    if not condition:
        raise FixtureError('S6_GITHUB_FIXTURE_INVALID')


def private_file(root, name):
    candidate = root / name
    require(candidate.is_relative_to(root))
    info = candidate.lstat()
    require(not candidate.is_symlink() and candidate.resolve() == candidate)
    require(candidate.is_file() and info.st_mode & 0o077 == 0)
    require(0 < info.st_size <= 1024 * 1024)
    return candidate


def git_path(value, root_allowed=False):
    if root_allowed and value in ('', '.'):
        return ''
    require(isinstance(value, str) and 0 < len(value) <= 500)
    require(not value.startswith('/') and not re.search(r'[\\\x00-\x1f\x7f]', value))
    require(all(part and part not in ('.', '..', '.git') for part in value.split('/')))
    return value


class Store:
    def __init__(self, root, state_name):
        self.root = root
        self.state_name = state_name
        self.lock = threading.Lock()
        self.read()

    def read(self):
        state = json.loads(private_file(self.root, self.state_name).read_bytes())
        require(state.get('owner') == OWNER)
        require(1 <= len(state.get('repositories', [])) <= 8)
        require(1 <= len(state.get('accessTokens', [])) <= 8)
        ids = set()
        names = set()
        for repository in state['repositories']:
            require(DECIMAL.fullmatch(repository['id']))
            require(FULL_NAME.fullmatch(repository['fullName']))
            require(repository['id'] not in ids and repository['fullName'] not in names)
            ids.add(repository['id'])
            names.add(repository['fullName'])
            require(len(repository.get('hooks', [])) <= 16)
        for credential in state['accessTokens']:
            require(re.fullmatch(r'github_pat_[A-Za-z0-9_]{20,240}', credential['token']))
            require(set(credential['repositoryIds']).issubset(ids))
            require(isinstance(credential['webhookWrite'], bool))
        require(DECIMAL.fullmatch(state['nextHookId']))
        return state

    def save(self, state):
        encoded = json.dumps(state, separators=(',', ':')).encode()
        require(len(encoded) <= 1024 * 1024)
        target = private_file(self.root, self.state_name)
        temporary = self.root / ('.state-' + uuid4().hex)
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        directory = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


class GitObjects:
    def __init__(self, root, executable):
        require(root.is_dir() and not root.is_symlink())
        require(executable.startswith('/') and Path(executable).is_file())
        self.root = root.resolve()
        self.executable = executable

    def repository(self, repository_id):
        require(DECIMAL.fullmatch(repository_id))
        path = self.root / (repository_id + '.git')
        require(path.is_dir() and not path.is_symlink() and path.resolve() == path)
        return path

    def environment(self):
        # Do not inherit user Git config, hooks, helpers, proxies, or SSH agent.
        return {
            'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
            'LANG': 'C.UTF-8',
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_TERMINAL_PROMPT': '0',
            'GIT_OPTIONAL_LOCKS': '0',
        }

    def execute(self, arguments, body=None, environment=None):
        child = subprocess.Popen(
            [self.executable, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', *arguments],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment or self.environment(),
            start_new_session=True,
        )
        try:
            output, _ = child.communicate(body, timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
            raise FixtureError('S6_GIT_FIXTURE_TIMEOUT') from None
        require(child.returncode == 0 and len(output) <= MAX_GIT_RESPONSE)
        return output

    def command(self, repository_id, *arguments):
        return self.execute(['--git-dir', str(self.repository(repository_id)), *arguments])

    def commit(self, repository_id, lookup):
        if SHA.fullmatch(lookup):
            reference = lookup
        else:
            require(lookup and len(lookup) <= 255 and '\x00' not in lookup)
            reference = 'refs/heads/' + lookup
            self.command(repository_id, 'check-ref-format', reference)
        sha = self.command(repository_id, 'rev-parse', '--verify', '--end-of-options', reference + '^{commit}').decode().strip()
        require(SHA.fullmatch(sha))
        values = self.command(repository_id, 'show', '-s', '--format=%H%x00%T%x00%cI%x00%s', sha).decode('utf-8').rstrip('\n').split('\x00', 3)
        require(len(values) == 4 and values[0] == sha and SHA.fullmatch(values[1]))
        return {'sha': sha, 'commit': {'tree': {'sha': values[1]}, 'committer': {'date': values[2]}, 'message': values[3]}}

    def branches(self, repository_id):
        output = self.command(repository_id, 'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/')
        branches = []
        for line in output.decode('utf-8').splitlines():
            name, sha = line.split('\x00')
            require(name.startswith('refs/heads/') and SHA.fullmatch(sha))
            branches.append({'name': name[11:], 'commit': {'sha': sha}, 'protected': False})
        require(len(branches) <= 1000)
        return branches

    def entries(self, repository_id, tree, path=None):
        arguments = ['ls-tree', '-l', '-z', tree]
        if path is not None:
            arguments += ['--', path]
        output = self.command(repository_id, *arguments)
        result = []
        for entry in output.split(b'\x00'):
            if not entry:
                continue
            meta, name = entry.split(b'\t', 1)
            mode, kind, sha, size = meta.decode().split()
            result.append({'name': name.decode('utf-8'), 'mode': mode, 'type': kind, 'sha': sha, 'size': int(size) if size != '-' else 0})
        require(len(result) <= 1000)
        return result

    def contents(self, repository_id, commit_sha, path):
        require(SHA.fullmatch(commit_sha))
        self.commit(repository_id, commit_sha)
        safe = git_path(path, True)
        entries = self.entries(repository_id, commit_sha, safe) if safe else []
        if safe:
            require(len(entries) == 1 and entries[0]['name'] == safe)
            entry = entries[0]
            if entry['type'] != 'tree':
                return {'type': 'symlink' if entry['mode'] == '120000' else 'file', 'path': safe, 'name': safe.split('/')[-1], 'sha': entry['sha'], 'size': entry['size']}
        tree = commit_sha + ':' + safe if safe else commit_sha
        return [
            {'type': 'dir' if item['type'] == 'tree' else 'symlink' if item['mode'] == '120000' else 'file',
             'path': (safe + '/' if safe else '') + item['name'], 'name': item['name'], 'sha': item['sha'], 'size': item['size']}
            for item in self.entries(repository_id, tree)
        ]

    def upload(self, repository_id, method, suffix, query, body, content_type, protocol):
        self.repository(repository_id)
        require((method == 'GET' and suffix == 'info/refs' and query == 'service=git-upload-pack') or
                (method == 'POST' and suffix == 'git-upload-pack' and not query and content_type == 'application/x-git-upload-pack-request'))
        environment = self.environment()
        environment.update({
            'GIT_PROJECT_ROOT': str(self.root), 'GIT_HTTP_EXPORT_ALL': '1',
            'PATH_INFO': '/' + repository_id + '.git/' + suffix,
            'QUERY_STRING': query, 'REQUEST_METHOD': method,
            'CONTENT_TYPE': content_type, 'CONTENT_LENGTH': str(len(body)),
            'REMOTE_ADDR': '127.0.0.1', 'REMOTE_USER': 'fixture-authorized-reader',
            'SERVER_PROTOCOL': 'HTTP/1.1',
        })
        if protocol == 'version=2':
            environment['GIT_PROTOCOL'] = protocol
        output = self.execute(['-c', 'http.receivepack=false', '-c', 'uploadpack.allowReachableSHA1InWant=true', 'http-backend'], body, environment)
        head, separator, payload = output.partition(b'\r\n\r\n')
        if not separator:
            head, separator, payload = output.partition(b'\n\n')
        require(separator and len(head) <= 8192)
        headers = {}
        status = 200
        for line in head.decode('ascii').splitlines():
            name, value = line.split(':', 1)
            if name.lower() == 'status':
                status = int(value.strip().split()[0])
            elif name.lower() in ('content-type', 'cache-control', 'expires', 'pragma'):
                headers[name] = value.strip()
        return status, headers, payload


def repository_view(repository):
    return {
        'id': repository['id'], 'full_name': repository['fullName'],
        'default_branch': repository['defaultBranch'], 'private': True, 'archived': False,
    }


def hook_view(hook):
    return {key: hook[key] for key in ('id', 'name', 'active', 'events', 'config')}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, handler, settings, store, git):
        self.address_family = socket.AF_INET6 if ':' in address[0] else socket.AF_INET
        self.settings = settings
        self.store = store
        self.git = git
        self.slots = threading.BoundedSemaphore(8)
        self.event_count = 0
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # BaseServer's default traceback can include provider inputs.
        self.event('request_error')

    def event(self, event, **values):
        self.event_count += 1
        if self.event_count <= 10000:
            print(json.dumps({'event': event, **values}), flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *args):
        pass

    def reply(self, status, value, headers=None, raw=False):
        payload = value if raw else json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        if not raw:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Ozz-Local-Fixture', OWNER)
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def body(self):
        require(self.headers.get('Transfer-Encoding') is None)
        lengths = self.headers.get_all('Content-Length', [])
        require(len(lengths) <= 1)
        size = lengths[0] if lengths else '0'
        require(re.fullmatch(r'0|[1-9][0-9]{0,5}', size))
        require(int(size) <= MAX_BODY)
        content = self.rfile.read(int(size))
        require(len(content) == int(size))
        return content

    def credential(self, state, cloning=False):
        headers = self.headers.get_all('Authorization', [])
        if len(headers) != 1:
            return None
        header = headers[0]
        if cloning:
            try:
                require(header.startswith('Basic ') and len(header) <= 4096)
                decoded = base64.b64decode(header[6:], validate=True).decode('utf-8')
                username, candidate = decoded.split(':', 1)
                require(username in ('x-access-token', 'fixture'))
            except Exception:
                return None
        else:
            if not header.startswith('Bearer '):
                return None
            candidate = header[7:]
        candidate_hash = hashlib.sha256(candidate.encode()).digest()
        matched = None
        for credential in state['accessTokens']:
            if hmac.compare_digest(candidate_hash, hashlib.sha256(credential['token'].encode()).digest()):
                matched = credential
        return matched

    def page(self, items, query, path):
        page = query.get('page', ['1'])
        size = query.get('per_page', ['100'])
        require(len(page) == len(size) == 1 and page[0].isdigit() and size[0].isdigit())
        page, size = int(page[0]), int(size[0])
        require(1 <= page <= 1000 and 1 <= size <= 100)
        begin = (page - 1) * size
        headers = {}
        if begin + size < len(items):
            following = dict(query)
            following['page'] = [str(page + 1)]
            following['per_page'] = [str(size)]
            headers['Link'] = '<' + self.server.settings['apiOrigin'] + path + '?' + urlencode(following, doseq=True) + '>; rel="next"'
        self.reply(200, items[begin:begin + size], headers)

    def dispatch(self):
        require(len(self.path) <= 8192)
        url = urlsplit(self.path)
        require(not url.scheme and not url.netloc and not url.fragment)
        path = unquote(url.path, encoding='utf-8', errors='strict')
        require('\x00' not in path and '\\' not in path)
        query = parse_qs(url.query, keep_blank_values=True, max_num_fields=32)
        body = self.body()
        if self.command == 'GET' and path == '/healthz' and not url.query:
            self.reply(200, {'owner': OWNER, 'fixtureId': self.server.settings['fixtureId']})
            return
        clone = re.fullmatch(r'/([^/]+/[^/]+)\.git/(info/refs|git-upload-pack)', path)
        with self.server.store.lock:
            state = self.server.store.read()
            credential = self.credential(state, cloning=clone is not None)
            if credential is None:
                self.server.event('authentication_rejected', operation='git' if clone else 'api')
                self.reply(401, {'message': 'Fixture authentication required.'}, {'WWW-Authenticate': 'Basic realm="ozz-s6-git"'} if clone else {})
                return
            authorized = [repo for repo in state['repositories'] if repo['id'] in credential['repositoryIds']]
            if clone:
                repository = next((repo for repo in authorized if repo['fullName'] == clone[1]), None)
                if not repository:
                    self.reply(404, {'message': 'Repository not found.'})
                    return
                status, headers, payload = self.server.git.upload(
                    repository['id'], self.command, clone[2], url.query, body,
                    self.headers.get('Content-Type', ''), self.headers.get('Git-Protocol', ''),
                )
                self.server.event('git_upload_pack', repositoryId=repository['id'], method=self.command, status=status)
                self.reply(status, payload, headers, raw=True)
                return
            if self.command == 'GET' and path == '/user':
                self.reply(200, state['account'])
                return
            if self.command == 'GET' and path == '/user/repos':
                self.page([repository_view(repo) for repo in sorted(authorized, key=lambda item: item['fullName'])], query, url.path)
                return
            by_id = re.fullmatch(r'/repositories/([1-9][0-9]{0,19})', path)
            if self.command == 'GET' and by_id:
                repository = next((repo for repo in authorized if repo['id'] == by_id[1]), None)
                self.reply(200, repository_view(repository)) if repository else self.reply(404, {'message': 'Repository not found.'})
                return
            route = re.fullmatch(r'/repos/([^/]+/[^/]+)/(branches|commits/.+|contents/.*|hooks(?:/[1-9][0-9]{0,19})?)', path)
            if not route:
                self.reply(404, {'message': 'Fixture route not found.'})
                return
            repository = next((repo for repo in authorized if repo['fullName'] == route[1]), None)
            if not repository:
                self.reply(404, {'message': 'Repository not found.'})
                return
            suffix = route[2]
            if self.command == 'GET' and suffix == 'branches':
                self.page(self.server.git.branches(repository['id']), query, url.path)
                return
            if self.command == 'GET' and suffix.startswith('commits/'):
                try:
                    result = self.server.git.commit(repository['id'], suffix[8:])
                except FixtureError:
                    self.reply(404, {'message': 'Commit not found.'})
                    return
                self.reply(200, result)
                return
            if self.command == 'GET' and suffix.startswith('contents/'):
                revisions = query.get('ref', [])
                require(len(revisions) == 1)
                try:
                    result = self.server.git.contents(repository['id'], revisions[0], suffix[9:])
                except FixtureError:
                    self.reply(404, {'message': 'Path not found.'})
                    return
                self.reply(200, result)
                return
            if suffix.startswith('hooks'):
                self.hooks(state, repository, credential, suffix, body, query, url.path)
                return
            self.reply(405, {'message': 'Fixture method not supported.'})

    def hooks(self, state, repository, credential, suffix, body, query, path):
        if not credential['webhookWrite']:
            self.reply(403, {'message': 'Fixture webhooks permission required.'})
            return
        hooks = repository.setdefault('hooks', [])
        existing_id = suffix[6:] if suffix.startswith('hooks/') else None
        existing = next((hook for hook in hooks if hook['id'] == existing_id), None)
        if self.command == 'GET':
            if not existing_id:
                self.page([hook_view(hook) for hook in hooks], query, path)
            elif existing:
                self.reply(200, hook_view(existing))
            else:
                self.reply(404, {'message': 'Hook not found.'})
            return
        require(self.command in ('POST', 'PATCH'))
        require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json')
        value = json.loads(body.decode('utf-8'))
        require(isinstance(value, dict) and set(value).issubset({'name', 'active', 'events', 'config'}))
        require(value.get('active') is True and value.get('events') == ['push'])
        config = value['config']
        require(set(config) == {'url', 'content_type', 'insecure_ssl', 'secret'})
        callback = urlsplit(config['url'])
        require(callback.scheme == 'https' and callback.hostname and not callback.username and not callback.password and not callback.fragment)
        require(config['content_type'] == 'json' and config['insecure_ssl'] == '0')
        require(re.fullmatch(r'[A-Za-z0-9_-]{32,128}', config['secret']))
        if self.command == 'POST':
            require(existing_id is None and value.get('name') == 'web' and len(hooks) < 16)
            existing = {'id': state['nextHookId'], 'name': 'web'}
            state['nextHookId'] = str(int(state['nextHookId']) + 1)
            hooks.append(existing)
        elif not existing:
            self.reply(404, {'message': 'Hook not found.'})
            return
        existing.update({
            'active': True, 'events': ['push'],
            'config': {key: config[key] for key in ('url', 'content_type', 'insecure_ssl')},
            'secret': config['secret'],
        })
        self.server.store.save(state)
        self.server.event('hook_saved', repositoryId=repository['id'], hookId=existing['id'], method=self.command)
        self.reply(201 if self.command == 'POST' else 200, hook_view(existing))

    def handle_fixture(self):
        try:
            self.dispatch()
        except (FixtureError, ValueError, KeyError, TypeError, UnicodeError):
            self.reply(422, {'message': 'Controlled fixture input is invalid.'})
        except (ConnectionError, BrokenPipeError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.server.event('internal_error')
            self.reply(503, {'message': 'Controlled fixture unavailable.'})

    do_GET = handle_fixture
    do_POST = handle_fixture
    do_PATCH = handle_fixture


def main():
    require(len(sys.argv) == 3)
    config = Path(sys.argv[2]).absolute()
    root = config.parent
    require(root.resolve() == root and root.stat().st_mode & 0o077 == 0)
    settings = json.loads(private_file(root, config.name).read_bytes())
    require(settings['owner'] == OWNER)
    state = Store(root, settings['stateFile'])
    git_root = (root / settings['gitRoot']).resolve()
    require(git_root.is_relative_to(root))
    git = GitObjects(git_root, settings['gitExecutable'])
    for repository in state.read()['repositories']:
        git.repository(repository['id'])
    require(sys.argv[1] == 'serve')
    require(settings['listenHost'] in ('127.0.0.1', '::1', '0.0.0.0'))
    require(isinstance(settings['listenPort'], int) and 1024 <= settings['listenPort'] <= 65535)
    origin = urlsplit(settings['apiOrigin'])
    require(origin.scheme == 'https' and origin.hostname and not origin.path and not origin.query and not origin.fragment and not origin.username and not origin.password)
    server = Server((settings['listenHost'], settings['listenPort']), Handler, settings, state, git)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(private_file(root, settings['tlsCertificateFile'])), str(private_file(root, settings['tlsKeyFile'])))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.event('listening', owner=OWNER, fixtureId=settings['fixtureId'], listenHost=settings['listenHost'], listenPort=settings['listenPort'])
    def stop(_signal, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()


if __name__ == '__main__':
    try:
        os.umask(0o077)
        main()
    except Exception:
        print(json.dumps({'error': 'S6_GITHUB_FIXTURE_FAILED'}), flush=True)
        sys.exit(1)
