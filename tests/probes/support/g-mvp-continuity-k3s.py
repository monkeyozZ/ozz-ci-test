"""One bounded, read-only continuity observation on a fixed local-lab VM.

Input arrives on SSH stdin from the Node driver. Only sanitized observations
leave this process; no Kubernetes Secret, environment value, HTTP body or
database marker is printed. There are no service/VM lifecycle operations.
"""
import hashlib
import http.client
import json
from pathlib import Path
import re
import socket
import ssl
import subprocess
import time
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def require(value, code):
    if not value:
        raise RuntimeError('GMVP_CONTINUITY_' + code)


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(
        value, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(data).hexdigest()


def kube(arguments):
    reply = subprocess.run(
        ['/usr/local/bin/k3s', 'kubectl', '--request-timeout=4s'] + arguments,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=7, check=False)
    require(reply.returncode == 0, 'KUBECTL_READ_FAILED')
    require(len(reply.stdout) <= 2 * 1024 * 1024, 'KUBECTL_OUTPUT_LIMIT')
    return reply.stdout


def get(kind, name, namespace=None):
    return json.loads(kube((['-n', namespace] if namespace else []) +
                          ['get', kind, name, '-o', 'json']))


def owned(item, target, network=False, namespace=False, volume=False):
    prefix = 'networking.ozz.dev/' if network else 'ozz.dev/'
    fields = ['installation', 'cluster', 'project', 'environment']
    if not namespace and not volume:
        fields.append('service')
    if network:
        fields.append('domain')
    if volume:
        fields.append('volume')
    labels = item['metadata'].get('labels', {})
    require(all(labels.get(prefix + key + '-id') == target[key + 'Id']
                for key in fields), 'RESOURCE_OWNERSHIP_CHANGED')
    require(not item['metadata'].get('deletionTimestamp'), 'RESOURCE_DELETING')


def resource(item):
    metadata = item['metadata']
    return {'kind': item['kind'], 'name': metadata['name'],
            'namespace': metadata.get('namespace'), 'uid': metadata['uid'],
            'generation': metadata.get('generation'),
            'specSha256': digest(item.get('spec', {})),
            'labelsSha256': digest(metadata.get('labels', {}))}


def snapshot_read(target, seen):
    guest = target['guest']
    require(Path('/etc/ozz-local-lab-instance').read_text().strip() ==
            'ozz-lab-' + guest, 'VM_IDENTITY_CHANGED')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    seen['bootId'] = boot
    namespaces = json.loads(kube(['get', 'namespace', 'kube-system', target['namespace'],
                                  '-o', 'json']))['items']
    require(len(namespaces) == 2, 'NAMESPACE_MISSING')
    by_name = {item['metadata']['name']: item for item in namespaces}
    system = by_name['kube-system']
    seen['kubeSystemUid'] = system['metadata']['uid']
    require(system['metadata']['uid'] == target['kubeSystemUid'], 'KUBE_SYSTEM_CHANGED')
    node = get('node', target['nodeName'])
    seen['nodeUid'] = node['metadata']['uid']
    require(node['metadata']['uid'] == target['nodeUid'], 'NODE_CHANGED')
    require(any(c['type'] == 'Ready' and c['status'] == 'True'
                for c in node.get('status', {}).get('conditions', [])), 'NODE_NOT_READY')
    namespace = by_name[target['namespace']]
    seen['namespaceUid'] = namespace['metadata']['uid']
    owned(namespace, target, namespace=True)
    objects = json.loads(kube(['-n', target['namespace'], 'get',
                              'deployments.apps,statefulsets.apps,replicasets.apps,pods,services',
                              '-l', 'ozz.dev/service-id=' + target['serviceId'], '-o', 'json']))['items']
    controllers = [x for x in objects if x['kind'] in ('Deployment', 'StatefulSet')]
    require(len(controllers) == 1, 'CONTROLLER_NOT_UNIQUE')
    controller = controllers[0]
    seen.update({'controller': resource(controller),
                 'readyReplicas': controller.get('status', {}).get('readyReplicas', 0)})
    owned(controller, target)
    require(controller['metadata']['name'] == target['serviceName'], 'CONTROLLER_NAME_CHANGED')
    require(controller['spec'].get('replicas', 1) == 1 and
            controller.get('status', {}).get('readyReplicas') == 1, 'CONTROLLER_NOT_READY')
    pods = [x for x in objects if x['kind'] == 'Pod' and
            not x['metadata'].get('deletionTimestamp')]
    seen['podUids'] = [x['metadata']['uid'] for x in pods]
    require(len(pods) == 1, 'POD_NOT_UNIQUE')
    pod = pods[0]
    seen.update({'pod': resource(pod), 'podPhase': pod.get('status', {}).get('phase')})
    owned(pod, target)
    require(pod.get('status', {}).get('phase') == 'Running' and
            any(c['type'] == 'Ready' and c['status'] == 'True'
                for c in pod.get('status', {}).get('conditions', [])), 'POD_NOT_READY')
    owners = [x for x in pod['metadata'].get('ownerReferences', []) if x.get('controller')]
    require(len(owners) == 1, 'POD_OWNER_MISSING')
    owner = owners[0]
    if controller['kind'] == 'Deployment':
        parents = [x for x in objects if x['kind'] == 'ReplicaSet' and
                   x['metadata']['uid'] == owner['uid']]
        require(owner['kind'] == 'ReplicaSet' and len(parents) == 1 and
                any(x.get('controller') and x['kind'] == 'Deployment' and
                    x['uid'] == controller['metadata']['uid']
                    for x in parents[0]['metadata'].get('ownerReferences', [])), 'POD_OWNER_CHANGED')
    else:
        require(owner['kind'] == 'StatefulSet' and owner['uid'] == controller['metadata']['uid'],
                'POD_OWNER_CHANGED')
    services = [x for x in objects if x['kind'] == 'Service' and
                x['metadata']['name'] == target['serviceName']]
    require(len(services) == 1, 'SERVICE_MISSING')
    service = services[0]
    seen['service'] = resource(service)
    owned(service, target)
    require(service['spec']['selector'].get('ozz.dev/service-id') == target['serviceId'] and
            service['spec']['selector'].get('ozz.dev/installation-id') == target['installationId'],
            'SERVICE_SELECTOR_CHANGED')
    identity = {'bootId': boot, 'kubeSystemUid': target['kubeSystemUid'],
                'nodeUid': target['nodeUid'], 'namespaceUid': namespace['metadata']['uid'],
                'controller': resource(controller), 'service': resource(service),
                'pod': resource(pod), 'podOwner': {'kind': owner['kind'], 'uid': owner['uid']}}
    if target['kind'] != 'application':
        pvc = get('pvc', target['pvcName'], target['namespace'])
        seen.update({'pvc': resource(pvc), 'pvcPhase': pvc.get('status', {}).get('phase')})
        owned(pvc, target, volume=True)
        require(pvc['metadata']['uid'] == target['pvcUid'] and
                pvc.get('status', {}).get('phase') == 'Bound', 'PVC_CHANGED_OR_UNBOUND')
        require(any(v.get('persistentVolumeClaim', {}).get('claimName') == target['pvcName']
                    for v in pod['spec'].get('volumes', [])), 'POD_PVC_MOUNT_CHANGED')
        pv = get('pv', pvc['spec']['volumeName'])
        seen['pv'] = resource(pv)
        claim = pv['spec'].get('claimRef', {})
        require(claim.get('uid') == target['pvcUid'] and
                claim.get('namespace') == target['namespace'] and
                claim.get('name') == target['pvcName'], 'PV_CLAIM_CHANGED')
        identity.update({'pvc': resource(pvc), 'pv': resource(pv)})
    else:
        network = json.loads(kube(['-n', target['namespace'], 'get',
                                   'ingresses.networking.k8s.io,certificates.cert-manager.io',
                                   '-l', 'networking.ozz.dev/domain-id=' + target['domainId'],
                                   '-o', 'json']))['items']
        route = []
        for suffix in ('http', 'https'):
            matches = [item for item in network if item['kind'] == 'Ingress' and
                       item['metadata']['name'] == target['domainName'] + '-' + suffix]
            require(len(matches) == 1, 'INGRESS_MISSING')
            ingress = matches[0]
            owned(ingress, target, network=True)
            rules = ingress['spec'].get('rules', [])
            require(len(rules) == 1 and rules[0].get('host') == target['hostname'] and
                    ingress['metadata'].get('annotations', {}).get(
                        'networking.ozz.dev/service-uid') == service['metadata']['uid'],
                    'INGRESS_TARGET_CHANGED')
            paths = rules[0].get('http', {}).get('paths', [])
            require(len(paths) == 1 and paths[0].get('path') == '/' and
                    paths[0]['backend']['service']['name'] == target['serviceName'],
                    'INGRESS_BACKEND_CHANGED')
            route.append(resource(ingress))
        certificates = [item for item in network if item['kind'] == 'Certificate' and
                        item['metadata']['name'] == target['domainName']]
        require(len(certificates) == 1, 'CERTIFICATE_MISSING')
        cert = certificates[0]
        owned(cert, target, network=True)
        issuer = cert['spec'].get('issuerRef', {})
        require(issuer.get('kind') == 'Issuer' and issuer.get('name') in
                ('ozz-acme-staging', 'ozz-acme-production') and
                cert['spec'].get('dnsNames') == [target['hostname']], 'CERTIFICATE_TARGET_CHANGED')
        environment = issuer['name'].removeprefix('ozz-acme-')
        ca = Path('/var/lib/ozz-local-lab') / guest / 'networking-v1' / (environment + '-signing-root.pem')
        slices = json.loads(kube(['-n', target['namespace'], 'get', 'endpointslices.discovery.k8s.io',
                                 '-l', 'kubernetes.io/service-name=' + target['serviceName'],
                                 '-o', 'json']))['items']
        endpoints = [e for s in slices for e in s.get('endpoints', [])
                     if e.get('conditions', {}).get('ready') is True]
        require(endpoints and all(e.get('targetRef', {}).get('uid') == pod['metadata']['uid']
                                  for e in endpoints), 'ROUTE_ENDPOINT_CHANGED')
        identity.update({'ingresses': route, 'certificate': resource(cert),
                         'certificateEnvironment': environment, 'caSha256': digest(ca.read_bytes())})
    return {'identity': identity, 'podPhase': pod['status']['phase'], 'podReady': True,
            'readyReplicas': controller['status']['readyReplicas'],
            'containerRestarts': [{'name': c['name'], 'count': c.get('restartCount', 0)}
                                  for c in pod['status'].get('containerStatuses', [])]}


def snapshot(target):
    seen = {}
    try:
        return snapshot_read(target, seen)
    except Exception as error:
        error.observation = seen
        raise


def request(target, before, tls):
    result = {'tlsVerified': False} if tls else {}
    connection = None
    raw = None
    try:
        if tls:
            environment = before['identity']['certificateEnvironment']
            ca = Path('/var/lib/ozz-local-lab') / target['guest'] / 'networking-v1' / (environment + '-signing-root.pem')
            context = ssl.create_default_context(cafile=str(ca))
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            raw = socket.create_connection((target['ingressIp'], 443), timeout=5)
            connection = context.wrap_socket(raw, server_hostname=target['hostname'])
            certificate = connection.getpeercert()
            result.update({'tlsVerified': True, 'hostnameVerified': context.check_hostname,
                           'certificateRequired': context.verify_mode == ssl.CERT_REQUIRED,
                           'caSha256': before['identity']['caSha256'],
                           'leafSha256': digest(connection.getpeercert(binary_form=True)),
                           'notBefore': certificate['notBefore'], 'notAfter': certificate['notAfter']})
            connection.sendall(('GET / HTTP/1.1\r\nHost: ' + target['hostname'] +
                                '\r\nConnection: close\r\n\r\n').encode())
            reply = http.client.HTTPResponse(connection)
            reply.begin()
        else:
            connection = http.client.HTTPConnection(target['ingressIp'], 80, timeout=5)
            connection.request('GET', '/', headers={'Host': target['hostname']})
            reply = connection.getresponse()
        body = reply.read(65537)
        result.update({'status': reply.status, 'bodyBytes': len(body), 'bodySha256': digest(body)})
        require(len(body) <= 65536, 'HTTP_BODY_LIMIT')
        if not tls and reply.status in (301, 302, 307, 308):
            result['redirectMatches'] = reply.getheader('Location') == 'https://' + target['hostname'] + '/'
            require(result['redirectMatches'], 'HTTP_REDIRECT_CHANGED')
        else:
            require(reply.status == 200, 'HTTP_STATUS_FAILED')
            message = json.loads(body).get('message')
            result['stableField'] = 'message'
            result['stableValueSha256'] = digest(message.encode()) if isinstance(message, str) else None
            result['contentMatches'] = result['stableValueSha256'] == target['messageSha256']
            require(result['contentMatches'], 'APPLICATION_CONTENT_CHANGED')
        return result
    except Exception as error:
        error.observation = result
        raise
    finally:
        if connection is not None:
            connection.close()
        if raw is not None:
            raw.close()


def marker(target, before):
    if target['kind'] == 'postgresql':
        command = ['sh', '-c',
                   'PGPASSWORD="$POSTGRES_PASSWORD" PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=3000 -c lock_timeout=2000" '
                   'psql -X -w -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -t -A '
                   '-c "SELECT value FROM public.ozz_s5_probe WHERE id=\'persistent\';"']
    else:
        command = ['sh', '-c', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --raw -h 127.0.0.1 -n 0 GET ozz:s5:persistent']
    value = kube(['-n', target['namespace'], 'exec', before['identity']['pod']['name'],
                  '-c', 'app', '--'] + command).rstrip(b'\r\n')
    return {'readOnly': True, 'markerBytes': len(value), 'markerSha256': digest(value),
            'markerMatches': len(value) == 36 and digest(value) == target['markerSha256']}


def main():
    target = parameters['target']
    require(target['guest'] in ('a', 'b') and target['kind'] in
            ('application', 'postgresql', 'redis'), 'TARGET_INVALID')
    for key in ('installationId', 'clusterId', 'projectId', 'environmentId', 'serviceId', 'kubeSystemUid', 'nodeUid'):
        require(re.fullmatch(r'[0-9a-f-]{36}', target[key]), 'TARGET_INVALID')
    require(target['namespace'] == 'ozz-e-' + target['environmentId'].replace('-', '') and
            target['serviceName'] == 'ozz-s-' + target['serviceId'].replace('-', ''), 'TARGET_INVALID')
    result = {'version': 1, 'key': target['key'], 'guest': target['guest'],
              'startedAt': now(), 'steps': [], 'ok': True}
    started = time.monotonic()

    def step(name, action):
        item = {'step': name, 'startedAt': now()}
        try:
            item['facts'] = action()
            item['ok'] = True
        except Exception as error:
            result['ok'] = False
            code = str(error)
            item.update({'ok': False, 'code': code if re.fullmatch(r'GMVP_CONTINUITY_[A-Z_]+', code)
                         else 'GMVP_CONTINUITY_' + ('TIMEOUT' if isinstance(error, (TimeoutError, subprocess.TimeoutExpired))
                                                   else 'TLS_VERIFICATION_FAILED' if isinstance(error, ssl.SSLCertVerificationError)
                                                   else 'READ_FAILED')})
            if isinstance(error, ssl.SSLCertVerificationError):
                item['tlsVerifyCode'] = error.verify_code
            if hasattr(error, 'observation'):
                item['facts'] = error.observation
        item['finishedAt'] = now()
        result['steps'].append(item)
        # Preserve completed/failed steps even if a later SSH request times out.
        print(json.dumps({'version': 1, 'key': target['key'], 'step': item}), flush=True)
        return item.get('facts') if item['ok'] else None

    before = step('identity-before', lambda: snapshot(target))
    if before:
        expected = parameters.get('expectedIdentity', before['identity'])
        admitted = step('fixed-identity', lambda: require(before['identity'] == expected, 'FIXED_IDENTITY_CHANGED') or {'matches': True})
        if admitted:
            if target['kind'] == 'application':
                step('http', lambda: request(target, before, False))
                step('https', lambda: request(target, before, True))
            else:
                read = step('marker', lambda: marker(target, before))
                if read:
                    step('marker-match', lambda: require(read['markerMatches'], 'MARKER_CHANGED') or {'matches': True})
        after = step('identity-after', lambda: snapshot(target))
        if after:
            step('identity-preserved', lambda: require(after['identity'] == before['identity'], 'IDENTITY_CHANGED_DURING_READ') or {'matches': True})
    result.update({'finishedAt': now(), 'durationMs': round((time.monotonic() - started) * 1000)})
    print(json.dumps({'version': 1, 'key': target['key'], 'result': result}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('GMVP_CONTINUITY_REMOTE_INPUT_FAILED')
