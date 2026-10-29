import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).parents[1] / 'probes/support/g-mvp-node-persistence-host.py'
spec = importlib.util.spec_from_file_location('node_persistence_host', SOURCE)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

IDS = [f'{number:08d}-1111-4111-8111-111111111111' for number in range(1, 8)]


class NodePersistenceIdentityTests(unittest.TestCase):
    def fixture(self):
        value = {'guest': 'c', 'action': 'read', 'kubeSystemUid': IDS[0],
                 'environmentId': IDS[1], 'serviceId': IDS[2], 'volumeId': IDS[3],
                 'pvcUid': IDS[4], 'pvUid': IDS[5], 'pvName': 'pvc-test'}
        namespace = 'ozz-e-' + IDS[1].replace('-', '')
        pvc_name = 'ozz-v-' + IDS[3].replace('-', '')
        pvc = {'metadata': {'namespace': namespace, 'name': pvc_name, 'uid': IDS[4]},
               'spec': {'volumeName': 'pvc-test'}}
        pv = {'metadata': {'name': 'pvc-test', 'uid': IDS[5]},
              'spec': {'claimRef': {'uid': IDS[4], 'namespace': namespace}}}
        deployment = {'metadata': {'name': 'ozz-s-' + IDS[2].replace('-', ''),
                                  'namespace': namespace, 'uid': IDS[6]}}
        replica_set = {'metadata': {'uid': 'replica-uid', 'ownerReferences': [
            {'controller': True, 'kind': 'Deployment', 'uid': IDS[6]}]}}
        pod = {'metadata': {'namespace': namespace, 'name': 'marker-pod', 'uid': 'pod-uid',
                            'ownerReferences': [{'controller': True, 'kind': 'ReplicaSet', 'uid': 'replica-uid'}]},
               'spec': {'nodeName': 'ozz-node', 'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': pvc_name}}],
                        'containers': [{'name': 'app', 'volumeMounts': [{'name': 'data', 'mountPath': '/data'}]}]}}
        return value, pvc, pv, deployment, pod, replica_set

    def test_b_and_other_hosts_cannot_receive_marker_actions(self):
        value = self.fixture()[0]
        host.validate_parameters(value)
        for guest in ('a', 'b', 'ozz-build'):
            changed = {**value, 'guest': guest}
            with self.subTest(guest=guest), self.assertRaises(RuntimeError):
                host.validate_parameters(changed)
        host.validate_parameters({'guest': 'b', 'action': 'node', 'kubeSystemUid': IDS[0]})

    def test_wrong_claim_pv_or_owner_is_rejected_before_exec(self):
        expected = host.resource_identities(*self.fixture())
        self.assertEqual(expected['pvcUid'], IDS[4])
        mutations = [(1, ('metadata', 'uid')), (2, ('metadata', 'uid')),
                     (2, ('spec', 'claimRef', 'uid')), (3, ('metadata', 'uid'))]
        for index, keys in mutations:
            values = copy.deepcopy(self.fixture())
            target = values[index]
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = 'changed'
            with self.subTest(index=index, keys=keys), self.assertRaises(RuntimeError):
                host.resource_identities(*values)

    def test_initial_write_requires_explicit_unique_intent(self):
        value = {**self.fixture()[0], 'action': 'write-once', 'marker': 'a' * 64 + '\n'}
        with self.assertRaises(RuntimeError):
            host.validate_parameters(value)
        host.validate_parameters({**value, 'writeIntentId': IDS[0]})


@unittest.skipUnless(shutil.which('node'), 'Node is required for temporary-file marker semantics')
class MarkerWriteOnceTests(unittest.TestCase):
    def run_node(self, program, *arguments):
        return subprocess.run(['node', '-e', program, *arguments], capture_output=True, text=True, timeout=10)

    def test_write_once_fsync_and_read_only_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'marker'
            value = 'a' * 64 + '\n'
            first = self.run_node(host.writer_program(str(marker)), value)
            self.assertEqual(first.returncode, 0, first.stderr)
            written = json.loads(first.stdout)
            self.assertTrue(written['exclusiveCreate'] and written['fsynced'])
            before = marker.stat()
            read = self.run_node(host.reader_program(str(marker)))
            self.assertEqual(read.returncode, 0, read.stderr)
            result = json.loads(read.stdout)
            self.assertEqual(result['sha256'], hashlib.sha256(value.encode()).hexdigest())
            self.assertTrue(result['readOnly'])
            self.assertEqual(marker.stat().st_mtime_ns, before.st_mtime_ns)
            second = self.run_node(host.writer_program(str(marker)), 'b' * 64 + '\n')
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(marker.read_text(), value)
            self.assertEqual(marker.stat().st_mtime_ns, before.st_mtime_ns)

    def test_marker_read_rejects_symlink_and_wrong_size(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target'
            target.write_text('a' * 64 + '\n')
            link = Path(directory) / 'marker'
            link.symlink_to(target)
            self.assertNotEqual(self.run_node(host.reader_program(str(link))).returncode, 0)
            self.assertNotEqual(self.run_node(host.writer_program(str(link)), 'b' * 64 + '\n').returncode, 0)
            target.write_text('short')
            self.assertNotEqual(self.run_node(host.reader_program(str(target))).returncode, 0)


if __name__ == '__main__':
    unittest.main()
