"""Fault-control admission/restore tests on temporary files, never a real host."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

BASE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('fault_control', BASE / 'tests/probes/support/s6-builder-fault-host.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
SESSION = '11111111-1111-4111-8111-111111111111'
RUN = '22222222-2222-4222-8222-222222222222'
DEPLOYMENT = '33333333-3333-4333-8333-333333333333'


class FaultWindowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.config_path = self.directory / 'host.json'
        self.runs = self.directory / 'runs'
        self.ledger = self.directory / 'ledger'
        self.runs.mkdir()
        self.ledger.mkdir()
        self.config = {'limits': {'timeoutSeconds': 1200, 'memoryMiB': 1024},
                       'dnsServer': '1.1.1.1', 'unchangedMarker': 'fixture configuration'}
        self.original = (json.dumps(self.config, indent=2) + '\n').encode()
        self.config_path.write_bytes(self.original)
        self.parameters = {'sessionId': SESSION, 'expectedHostSha256': policy.sha(self.original),
                           'runId': RUN, 'deploymentId': DEPLOYMENT}
        for name, value in [('CONFIG', self.config_path), ('RUNS', self.runs), ('LEDGER', self.ledger),
                            ('parameters', self.parameters)]:
            context = patch.object(policy, name, value, create=True)
            context.start()
            self.addCleanup(context.stop)
        # Ownership checks are Linux admission concerns; these tests exercise
        # real temporary-file writes, identity matching and exact restoration.
        for context in (patch.object(policy, 'regular', side_effect=lambda path: path.read_bytes()),
                        patch.object(policy, 'manager_identity', return_value={'pid': 100, 'startTicks': '50', 'state': 'S'}),
                        patch.object(policy, 'same_manager', return_value=True)):
            context.start()
            self.addCleanup(context.stop)

    def state(self, **changes):
        directory = self.runs / RUN
        directory.mkdir()
        value = {'closed': True, 'terminationConfirmed': True, 'started': ['checkout', 'building'],
                 'completed': ['checkout'], 'spec': {'runId': RUN, 'deploymentId': DEPLOYMENT}}
        value.update(changes)
        (directory / 'state.json').write_text(json.dumps(value))

    def test_deadline_window_only_changes_timeout_and_restores_exact_bytes(self):
        self.state()
        receipt = policy.limits(self.config, False)
        during = json.loads(self.config_path.read_bytes())
        self.assertEqual(during, {**self.config, 'limits': {**self.config['limits'], 'timeoutSeconds': 40}})
        self.assertEqual(receipt['beforeSha256'], policy.sha(self.original))
        restored = policy.limits(during, True)
        self.assertTrue(restored['restored'])
        self.assertEqual(self.config_path.read_bytes(), self.original)
        backup = self.directory / ('s6-fault-limits-' + SESSION) / 'host-before.json'
        self.assertEqual(backup.read_bytes(), self.original)

    def test_open_run_prevents_any_deadline_mutation(self):
        self.state(closed=False, terminationConfirmed=False)
        with self.assertRaisesRegex(RuntimeError, 'S6_FAULT_HOST_HAS_OPEN_RUN'):
            policy.limits(self.config, False)
        self.assertEqual(self.config_path.read_bytes(), self.original)
        self.assertFalse((self.directory / ('s6-fault-limits-' + SESSION)).exists())

    def test_manager_open_record_also_blocks_a_window_before_host_prepare(self):
        (self.ledger / (RUN + '.json')).write_text(json.dumps({'observation': {'proof': None}}))
        with self.assertRaisesRegex(RuntimeError, 'S6_FAULT_MANAGER_HAS_OPEN_RUN'):
            policy.limits(self.config, False)
        self.assertEqual(self.config_path.read_bytes(), self.original)

    def test_restore_does_not_overwrite_an_intervening_configuration_change(self):
        policy.limits(self.config, False)
        changed = json.loads(self.config_path.read_bytes())
        changed['dnsServer'] = '203.0.113.1'
        content = json.dumps(changed).encode()
        self.config_path.write_bytes(content)
        with self.assertRaisesRegex(RuntimeError, 'S6_FAULT_LIMIT_CONFIG_CHANGED'):
            policy.limits(changed, True)
        self.assertEqual(self.config_path.read_bytes(), content)

    def test_wrong_product_deployment_never_signals_the_manager(self):
        self.state(closed=False, terminationConfirmed=False)
        self.parameters['deploymentId'] = SESSION
        with patch.object(policy.os, 'kill') as kill, self.assertRaisesRegex(RuntimeError, 'S6_FAULT_RUN_IDENTITY_CHANGED'):
            policy.disconnect(self.config)
        kill.assert_not_called()

    def test_manager_restart_does_not_block_exact_configuration_restoration(self):
        policy.limits(self.config, False)
        with patch.object(policy, 'same_manager', return_value=False):
            result = policy.limits(json.loads(self.config_path.read_bytes()), True)
        self.assertEqual(self.config_path.read_bytes(), self.original)
        self.assertTrue(result['managerRefreshRequired'])
        self.assertFalse(result['managerIdentityUnchanged'])

    def test_interrupted_temporary_file_does_not_block_a_restore_retry(self):
        policy.limits(self.config, False)
        leftover = self.config_path.with_name(self.config_path.name + '.s6-' + SESSION)
        leftover.write_bytes(b'prior interrupted attempt')
        policy.limits(json.loads(self.config_path.read_bytes()), True)
        self.assertEqual(self.config_path.read_bytes(), self.original)
        self.assertEqual(leftover.read_bytes(), b'prior interrupted attempt')


class ManagerIdentityTests(unittest.TestCase):
    def test_flock_main_pid_selects_only_its_unique_node_child_in_the_same_cgroup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = {'managerUid': 62000, 'tools': {'node': {'path': '/opt/ozz-builder/bin/node'}}}
            for pid, executable, children, group in ((100, '/usr/bin/flock', '101 102', 'manager'),
                                                     (101, '/opt/ozz-builder/bin/node', '', 'manager'),
                                                     (102, '/opt/ozz-builder/bin/node', '', 'source')):
                proc = root / str(pid)
                (proc / 'task' / str(pid)).mkdir(parents=True)
                (proc / 'cgroup').write_text('0::/' + group)
                (proc / 'status').write_text('Uid:\t62000 62000 62000 62000\n')
                (proc / 'exe').symlink_to(executable)
                (proc / 'task' / str(pid) / 'children').write_text(children)
                (proc / 'stat').write_text(str(pid) + ' (fixture) ' + ' '.join(['S'] + ['0'] * 18 + ['500']))
            with patch.object(policy, 'PROC', root), patch.object(policy.subprocess, 'run', return_value=SimpleNamespace(stdout=b'100\n')):
                identity = policy.manager_identity(config)
                self.assertEqual(identity['pid'], 101)
                self.assertEqual(identity['unitMainPid'], 100)
                self.assertTrue(policy.same_manager(identity))
                (root / '101' / 'stat').write_text('101 (fixture) ' + ' '.join(['S'] + ['0'] * 18 + ['501']))
                self.assertFalse(policy.same_manager(identity))


if __name__ == '__main__':
    unittest.main()
