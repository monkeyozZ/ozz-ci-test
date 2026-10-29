"""Read-only workload inventory for the two known local K3s VMs.

The caller supplies parameters over SSH stdin. Secret values, Pod environment
values and kubeconfig credentials never leave this process. This helper does
not apply resources, execute in Pods, restart services or change any file.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess


def require(value, code):
    if not value:
        raise RuntimeError('GMVP_RECOVERY_' + code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def main():
    alias = parameters.get('alias')
    installation = parameters.get('installationId', '')
    require(alias in ('ozz-lab-a', 'ozz-lab-b'), 'K3S_ALIAS_INVALID')
    require(re.fullmatch(r'[0-9a-f-]{36}', installation), 'INSTALLATION_INVALID')
    require(Path('/etc/ozz-local-lab-instance').read_text().strip() == alias, 'K3S_HOST_CHANGED')
    kinds = 'deployments.apps,statefulsets.apps,services,persistentvolumeclaims,secrets'
    reply = subprocess.run(
        ['/usr/local/bin/k3s', 'kubectl', 'get', kinds, '--all-namespaces',
         '--selector=ozz.dev/installation-id=' + installation, '--output=json'],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
    )
    require(len(reply.stdout) <= 8 * 1024 * 1024, 'K3S_INVENTORY_LIMIT')
    items = json.loads(reply.stdout)['items']
    require(len(items) <= 1000, 'K3S_RESOURCE_LIMIT')
    resources = []
    for item in items:
        metadata = item['metadata']
        labels = metadata.get('labels', {})
        require(labels.get('ozz.dev/installation-id') == installation, 'K3S_INSTALLATION_CHANGED')
        # cert-manager rotates TLS Secrets independently of workload recovery.
        if item['kind'] == 'Secret' and item.get('type') == 'kubernetes.io/tls':
            continue
        template = item.get('spec', {}).get('template', {})
        resources.append({
            'clusterAlias': alias,
            'kind': item['kind'],
            'namespace': metadata['namespace'],
            'name': metadata['name'],
            'uid': metadata['uid'],
            'generation': metadata.get('generation'),
            'serviceId': labels.get('ozz.dev/service-id'),
            'mutationRevision': metadata.get('annotations', {}).get('ozz.dev/mutation-revision'),
            'snapshotId': template.get('metadata', {}).get('labels', {}).get('ozz.dev/snapshot-id'),
            'images': [container['image'] for container in template.get('spec', {}).get('containers', [])],
            'labelsSha256': digest(labels),
            'specSha256': digest(item.get('spec')),
            'secretDataSha256': digest(item.get('data', {})) if item['kind'] == 'Secret' else None,
        })
    return sorted(resources, key=lambda item: (item['kind'], item['namespace'], item['name']))


if __name__ == '__main__':
    try:
        print(json.dumps({'version': 1, 'source': 'live read-only K3s API', 'resources': main()}))
    except Exception as error:
        code = str(error)
        raise SystemExit(code if re.fullmatch(r'GMVP_RECOVERY_[A-Z_]+', code)
                         else 'GMVP_RECOVERY_K3S_OBSERVATION_FAILED')
