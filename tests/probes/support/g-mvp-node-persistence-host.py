"""Identity-bound observations and one initial marker write on existing C.

The caller supplies parameters through SSH stdin. Kubernetes objects, node
configuration, services, credentials and volume contents other than the unique
initial marker are never changed. Node stop/start belongs to the local driver.
"""
import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone

UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
MARKER_PATH = '/data/ozz-node-persistence-marker'


def require(value, code):
    if not value:
        raise RuntimeError('GMVP_NODE_' + code)


def writer_program(path=MARKER_PATH):
    # O_EXCL makes even a replay incapable of overwriting an existing marker.
    return """const fs=require('node:fs'),crypto=require('node:crypto');
const path=PATH, value=Buffer.from(process.argv[1],'utf8');
if(!/^[a-f0-9]{64}\\n$/.test(value.toString()))throw Error('MARKER_INVALID');
const fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
try{fs.writeFileSync(fd,value);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
const dir=fs.openSync(require('node:path').dirname(path),fs.constants.O_RDONLY);
try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
console.log(JSON.stringify({sha256:crypto.createHash('sha256').update(value).digest('hex'),bytes:value.length,exclusiveCreate:true,fsynced:true}));
""".replace('PATH', json.dumps(path), 1)


def reader_program(path=MARKER_PATH):
    return """const fs=require('node:fs'),crypto=require('node:crypto');
const fd=fs.openSync(PATH,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
let value,info;try{info=fs.fstatSync(fd);if(!info.isFile()||info.size!==65)throw Error('MARKER_SIZE');value=fs.readFileSync(fd)}finally{fs.closeSync(fd)}
console.log(JSON.stringify({sha256:crypto.createHash('sha256').update(value).digest('hex'),bytes:value.length,inode:info.ino,mtimeMilliseconds:info.mtimeMs,readOnly:true}));
""".replace('PATH', json.dumps(path), 1)


def http_reader_program():
    return """const http=require('node:http'),crypto=require('node:crypto');
const req=http.get('http://127.0.0.1:8080/',res=>{const chunks=[];let size=0;
if(res.statusCode!==200)throw Error('HTTP_NOT_READY');
res.on('data',chunk=>{size+=chunk.length;if(size>128)throw Error('HTTP_BOUND');chunks.push(chunk)});
res.on('end',()=>{const value=Buffer.concat(chunks);console.log(JSON.stringify({sha256:crypto.createHash('sha256').update(value).digest('hex'),bytes:value.length,readOnly:true}))})});
req.setTimeout(3000,()=>req.destroy(Error('HTTP_TIMEOUT')));req.on('error',()=>process.exit(1));
"""


def validate_parameters(value):
    require(value.get('guest') in ('b', 'c'), 'GUEST_NOT_ALLOWED')
    require(value.get('action') in ('node', 'snapshot', 'write-once', 'read'), 'ACTION_INVALID')
    require(re.fullmatch(UUID, value.get('kubeSystemUid', '')), 'CLUSTER_IDENTITY_INVALID')
    if value['guest'] == 'b':
        require(value['action'] == 'node', 'B_IS_READ_ONLY')
    if value['action'] != 'node':
        for name in ('environmentId', 'serviceId', 'volumeId', 'pvcUid', 'pvUid'):
            require(re.fullmatch(UUID, value.get(name, '')), 'RESOURCE_IDENTITY_INVALID')
        require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,252}', value.get('pvName', '')), 'PV_NAME_INVALID')
        if value['action'] == 'write-once':
            require(re.fullmatch(r'[a-f0-9]{64}\n', value.get('marker', '')), 'MARKER_INVALID')
            require(re.fullmatch(UUID, value.get('writeIntentId', '')), 'WRITE_INTENT_REQUIRED')


def kube(args):
    result = subprocess.run(['k3s', 'kubectl', '--request-timeout=10s', *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    require(result.returncode == 0, 'KUBERNETES_READ_FAILED')
    require(len(result.stdout) <= 2 * 1024 * 1024, 'KUBERNETES_RESPONSE_BOUND')
    return result.stdout


def resource_identities(value, pvc, pv, deployment, pod, replica_set):
    namespace = 'ozz-e-' + value['environmentId'].replace('-', '')
    deployment_name = 'ozz-s-' + value['serviceId'].replace('-', '')
    pvc_name = 'ozz-v-' + value['volumeId'].replace('-', '')
    require(pvc['metadata']['namespace'] == namespace and pvc['metadata']['name'] == pvc_name and
            pvc['metadata']['uid'] == value['pvcUid'] and not pvc['metadata'].get('deletionTimestamp'),
            'PVC_IDENTITY_CHANGED')
    require(pv['metadata']['name'] == value['pvName'] and pv['metadata']['uid'] == value['pvUid'] and
            pvc['spec']['volumeName'] == pv['metadata']['name'] and
            pv['spec']['claimRef']['uid'] == pvc['metadata']['uid'] and
            pv['spec']['claimRef']['namespace'] == namespace and
            not pv['metadata'].get('deletionTimestamp'), 'PV_IDENTITY_CHANGED')
    require(deployment['metadata']['name'] == deployment_name and
            deployment['metadata']['namespace'] == namespace and
            pod['metadata']['namespace'] == namespace and not pod['metadata'].get('deletionTimestamp'),
            'WORKLOAD_IDENTITY_CHANGED')
    require(any(owner.get('controller') and owner.get('kind') == 'ReplicaSet' and
                owner.get('uid') == replica_set['metadata']['uid']
                for owner in pod['metadata'].get('ownerReferences', [])) and
            any(owner.get('controller') and owner.get('kind') == 'Deployment' and
                owner.get('uid') == deployment['metadata']['uid']
                for owner in replica_set['metadata'].get('ownerReferences', [])), 'POD_OWNER_CHANGED')
    volumes = [entry for entry in pod['spec'].get('volumes', [])
               if entry.get('persistentVolumeClaim', {}).get('claimName') == pvc_name]
    app = [entry for entry in pod['spec'].get('containers', []) if entry['name'] == 'app']
    require(len(volumes) == 1 and len(app) == 1 and
            any(mount['name'] == volumes[0]['name'] and mount['mountPath'] == '/data'
                for mount in app[0].get('volumeMounts', [])), 'POD_VOLUME_CHANGED')
    return {'namespace': namespace, 'pvcName': pvc_name, 'pvcUid': pvc['metadata']['uid'],
            'pvName': pv['metadata']['name'], 'pvUid': pv['metadata']['uid'],
            'deploymentUid': deployment['metadata']['uid'], 'podName': pod['metadata']['name'],
            'podUid': pod['metadata']['uid'], 'nodeName': pod['spec']['nodeName']}


def observe(value):
    validate_parameters(value)
    require(os.getuid() == 0 and Path('/etc/ozz-local-lab-instance').read_text().strip() ==
            'ozz-lab-' + value['guest'], 'HOST_IDENTITY_CHANGED')
    system = json.loads(kube(['get', 'namespace', 'kube-system', '-o', 'json']))
    require(system['metadata']['uid'] == value['kubeSystemUid'], 'CLUSTER_IDENTITY_CHANGED')
    nodes = json.loads(kube(['get', 'nodes', '-o', 'json']))
    require(len(nodes['items']) == 1 and not nodes.get('metadata', {}).get('continue'), 'NODE_COUNT_CHANGED')
    node = nodes['items'][0]
    ready = any(row['type'] == 'Ready' and row['status'] == 'True' for row in node['status']['conditions'])
    result = {'at': datetime.now(timezone.utc).isoformat(), 'guest': value['guest'],
              'kubeSystemUid': system['metadata']['uid'], 'nodeName': node['metadata']['name'],
              'nodeUid': node['metadata']['uid'], 'nodeReady': ready,
              'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
              'uptimeSeconds': float(Path('/proc/uptime').read_text().split()[0]),
              'credentialsRead': False}
    if value['action'] == 'node':
        return result
    require(ready, 'NODE_NOT_READY')
    namespace = 'ozz-e-' + value['environmentId'].replace('-', '')
    name = 'ozz-s-' + value['serviceId'].replace('-', '')
    pvc = json.loads(kube(['-n', namespace, 'get', 'pvc', 'ozz-v-' + value['volumeId'].replace('-', ''), '-o', 'json']))
    pv = json.loads(kube(['get', 'pv', value['pvName'], '-o', 'json']))
    deployment = json.loads(kube(['-n', namespace, 'get', 'deployment', name, '-o', 'json']))
    pods = json.loads(kube(['-n', namespace, 'get', 'pods', '-o', 'json']))
    active = [pod for pod in pods['items'] if not pod['metadata'].get('deletionTimestamp') and
              any(row['type'] == 'Ready' and row['status'] == 'True' for row in pod.get('status', {}).get('conditions', []))]
    require(len(active) == 1, 'READY_POD_COUNT_CHANGED')
    pod = active[0]
    owner = next((owner for owner in pod['metadata'].get('ownerReferences', [])
                  if owner.get('controller') and owner.get('kind') == 'ReplicaSet'), None)
    require(owner is not None, 'POD_OWNER_CHANGED')
    replica_set = json.loads(kube(['-n', namespace, 'get', 'replicaset', owner['name'], '-o', 'json']))
    result.update(resource_identities(value, pvc, pv, deployment, pod, replica_set))
    require(result['nodeName'] == node['metadata']['name'], 'WORKLOAD_NODE_CHANGED')
    if value['action'] in ('write-once', 'read'):
        program = writer_program() if value['action'] == 'write-once' else reader_program()
        command = ['-n', namespace, 'exec', pod['metadata']['name'], '-c', 'app', '--', 'node', '-e', program]
        if value['action'] == 'write-once':
            command.append(value['marker'])
        marker = json.loads(kube(command))
        after = json.loads(kube(['-n', namespace, 'get', 'pod', pod['metadata']['name'], '-o', 'json']))
        require(after['metadata']['uid'] == pod['metadata']['uid'], 'POD_CHANGED_DURING_MARKER_ACCESS')
        result['marker'] = marker
        served = json.loads(kube(['-n', namespace, 'exec', pod['metadata']['name'], '-c', 'app',
                                  '--', 'node', '-e', http_reader_program()]))
        require(served['sha256'] == marker['sha256'] and served['bytes'] == 65,
                'HTTP_MARKER_MISMATCH')
        result['httpMarker'] = served
        result['writeIntentId'] = value.get('writeIntentId') if value['action'] == 'write-once' else None
        result['readOnly'] = value['action'] == 'read'
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(observe(parameters)))
    except Exception as error:
        code = str(error)
        raise SystemExit(code if re.fullmatch(r'GMVP_NODE_[A-Z_]+', code) else 'GMVP_NODE_HOST_PROBE_FAILED')
