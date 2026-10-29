"""Pure launcher boundary tests. Linux isolation and real systemd races need the VM probes."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[2]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, BASE / 'infra' / 'builder' / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


launcher = module('builder_launcher', 'launcher.py')
entry = module('builder_entry', 'phase-entry.py')
RUN = '11111111-1111-4111-8111-111111111111'
BOOT = '22222222-2222-4222-8222-222222222222'
NONCE = '33333333-3333-4333-8333-333333333333'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'
SPEC = {'limits': {'diskBytes': '1073741824'}, 'source': {'platforms': [{'os': 'linux', 'architecture': 'arm64'}]}}


def descriptor(data, media):
    return {'mediaType': media, 'digest': 'sha256:' + hashlib.sha256(data).hexdigest(), 'size': len(data)}


def archive(*, layout='1.0.0', index_version=2, root_size_delta=0, config_size_delta=0, config_media=CONFIG, architecture='arm64', corrupt_layer=False, member=None):
    layer = b'a real layer payload'
    config = json.dumps({'os': 'linux', 'architecture': architecture, 'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + hashlib.sha256(layer).hexdigest()]}}).encode()
    config_descriptor = descriptor(config, config_media)
    config_descriptor['size'] += config_size_delta
    layer_descriptor = descriptor(layer, 'application/vnd.oci.image.layer.v1.tar')
    manifest = json.dumps({'schemaVersion': 2, 'mediaType': MANIFEST, 'config': config_descriptor, 'layers': [layer_descriptor]}).encode()
    root = descriptor(manifest, MANIFEST)
    root['size'] += root_size_delta
    files = {'oci-layout': json.dumps({'imageLayoutVersion': layout}).encode(), 'index.json': json.dumps({'schemaVersion': index_version, 'manifests': [root]}).encode(),
             'blobs/sha256/' + root['digest'][7:]: manifest,
             'blobs/sha256/' + config_descriptor['digest'][7:]: config,
             'blobs/sha256/' + layer_descriptor['digest'][7:]: b'corrupt layer bytes!!' if corrupt_layer else layer}
    target = io.BytesIO()
    with tarfile.open(fileobj=target, mode='w', format=tarfile.USTAR_FORMAT) as output:
        for name, data in files.items():
            header = tarfile.TarInfo(name)
            header.size = len(data)
            output.addfile(header, io.BytesIO(data))
        if member:
            output.addfile(member, io.BytesIO(bytes(member.size)))
    target.seek(0)
    return target, root


class CheckoutBoundaryTests(unittest.TestCase):
    def checkout(self, temporary):
        source = Path(temporary).resolve() / 'checkout' / 'source'
        source.mkdir(parents=True)
        (source / '.git').mkdir()
        (source / '.git' / 'config').write_text('private checkout metadata')
        (source / 'Dockerfile').write_text('FROM scratch\nCOPY public /public\n')
        spec = {'source': {'dockerfilePath': 'Dockerfile', 'contextPath': '.'},
                'profile': {'frontendDigest': 'sha256:' + 'a' * 64}}
        return source, spec

    def test_git_file_and_directory_modes_survive_copy_without_solve_write_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, spec = self.checkout(temporary)
            public = source / 'public'
            public.mkdir(mode=0o700)
            page = public / 'index.html'
            page.write_text('application content')
            page.chmod(0o640)
            script = source / 'start.sh'
            script.write_text('#!/bin/sh\nexit 0\n')
            script.chmod(0o700)
            (public / 'current.html').symlink_to('index.html')
            with patch.object(launcher.os, 'chown') as ownership:
                launcher.validate_checkout(source, spec, {'solveUid': 62002})
            try:
                expected = {source: 0o755, public: 0o755, page: 0o644,
                            script: 0o755, source / 'Dockerfile': 0o644,
                            source.parent: 0o550}
                for path, mode in expected.items():
                    with self.subTest(path=path.name):
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode)
                        self.assertEqual(mode & 0o022, 0, 'solve group and other UIDs must not write')
                        ownership.assert_any_call(path, 0, 62002)
                self.assertTrue(page.stat().st_mode & stat.S_IROTH)
                self.assertTrue(script.stat().st_mode & stat.S_IXOTH)
                self.assertEqual(source.parent.stat().st_mode & 0o007, 0)
                self.assertFalse((source / '.git').exists())
                self.assertTrue((public / 'current.html').is_symlink())
                self.assertEqual((public / 'current.html').read_text(), 'application content')
            finally:
                source.parent.chmod(0o700)

    def test_checkout_normalization_strips_special_modes_and_preserves_execute_bit(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, spec = self.checkout(temporary)
            ordinary = source / 'ordinary'
            ordinary.write_text('readable data')
            ordinary.chmod(0o664)
            executable = source / 'executable'
            executable.write_text('#!/bin/sh\n')
            executable.chmod(0o4751)
            with patch.object(launcher.os, 'chown'):
                launcher.validate_checkout(source, spec, {'solveUid': 62002})
            try:
                self.assertEqual(stat.S_IMODE(ordinary.stat().st_mode), 0o644)
                self.assertEqual(stat.S_IMODE(executable.stat().st_mode), 0o755)
            finally:
                source.parent.chmod(0o700)

    def test_world_readable_image_modes_do_not_admit_outside_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, spec = self.checkout(temporary)
            outside = Path(temporary) / 'outside'
            outside.write_text('unchanged outside data')
            original = outside.stat()
            (source / 'outside').symlink_to(outside)
            with patch.object(launcher.os, 'chown'), self.assertRaisesRegex(RuntimeError, 'BUILD_SYMLINK_ESCAPES_CHECKOUT'):
                launcher.validate_checkout(source, spec, {'solveUid': 62002})
            self.assertEqual(outside.stat().st_mode, original.st_mode)
            self.assertEqual(outside.read_text(), 'unchanged outside data')


class OciBoundaryTests(unittest.TestCase):
    def test_complete_graph_and_platform(self):
        source, root = archive()
        actual, platforms = launcher.inspect_oci(source, SPEC)
        self.assertEqual(actual, root)
        self.assertEqual(platforms[0]['architecture'], 'arm64')

    def test_invalid_layout_schema_sizes_media_platform_and_digest(self):
        for options in ({'layout': '9.0.0'}, {'index_version': 1}, {'root_size_delta': 1}, {'config_size_delta': 1},
                        {'config_media': 'application/octet-stream'}, {'architecture': 'amd64'}, {'corrupt_layer': True}):
            with self.subTest(options=options), self.assertRaises((RuntimeError, KeyError, ValueError)):
                launcher.inspect_oci(archive(**options)[0], SPEC)

    def test_rejects_links_paths_extensions_and_duplicates(self):
        for name, kind in (('../../host', tarfile.REGTYPE), ('blobs/sha256/' + 'e' * 64, tarfile.SYMTYPE),
                           ('index.json', tarfile.REGTYPE), ('pax', tarfile.XHDTYPE)):
            member = tarfile.TarInfo(name)
            member.type = kind
            with self.subTest(name=name, kind=kind), self.assertRaises((RuntimeError, KeyError, ValueError)):
                launcher.inspect_oci(archive(member=member)[0], SPEC)

    def test_entry_count_is_bounded_before_root_tar_metadata_allocations(self):
        source, _ = archive()
        raw = source.getvalue()
        # Valid small ordinary headers; stop before any descriptor parsing.
        target = io.BytesIO()
        for index in range(16385):
            target.write(tarfile.TarInfo('blobs/sha256/' + format(index, '064x')).tobuf(format=tarfile.USTAR_FORMAT))
        target.write(bytes(1024))
        with self.assertRaisesRegex(RuntimeError, 'BUILD_OCI_ENTRY_LIMIT'):
            launcher.inspect_oci(target, SPEC)
        with self.assertRaises(RuntimeError):
            launcher.inspect_oci(io.BytesIO(raw[:-1024] + b'late-hidden-data'), SPEC)

    def test_archive_fd_rejects_symlink_and_hardlink_without_changing_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            target = directory / 'target'
            target.write_bytes(b'unchanged')
            original = target.stat()
            (directory / 'symlink').symlink_to(target)
            os.link(target, directory / 'hardlink')
            parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                for name in ('symlink', 'hardlink'):
                    with self.subTest(name=name), self.assertRaises((OSError, RuntimeError)):
                        with launcher.checked_archive_fd(parent, name, os.getuid()):
                            self.fail('untrusted inode accepted')
                (directory / 'hardlink').unlink()
                with launcher.checked_archive_fd(parent, 'target', os.getuid()) as source:
                    self.assertEqual(source.read(), b'unchanged')
            finally:
                os.close(parent)
            self.assertEqual(target.stat().st_mode, original.st_mode)
            self.assertEqual(target.stat().st_uid, original.st_uid)
            self.assertEqual(target.read_bytes(), b'unchanged')


class PhaseEntryTests(unittest.TestCase):
    def test_systemd_runtime_never_expires_before_the_absolute_deadline(self):
        deadline = '2026-10-26T06:00:40.125Z'
        end = launcher.timestamp(deadline)
        # Include the fractional interval that caused the real 40-second run to
        # stop before its deadline and acquire a BUILD_SOLVE_FAILED proof.
        for remaining in (40.0, 39.501, 1.125, 0.875, 0.001, 0.0001):
            with self.subTest(remaining=remaining), patch.object(launcher.time, 'time', return_value=end - remaining):
                configured = launcher.remaining_runtime(deadline)
                self.assertTrue(configured.endswith('us'))
                interval = int(configured[:-2]) / 1000000
                actual_remaining = end - launcher.time.time()
                self.assertGreaterEqual(interval, actual_remaining)
                self.assertLess(interval - actual_remaining, 0.0000011)

    def test_expired_deadline_never_disables_systemd_runtime_limit(self):
        deadline = '2026-10-26T06:00:40.125Z'
        for offset in (0, 0.5, 2):
            with self.subTest(offset=offset), patch.object(launcher.time, 'time', return_value=launcher.timestamp(deadline) + offset):
                self.assertEqual(launcher.remaining_runtime(deadline), '1us')

    def test_late_entry_rejects_closed_boot_nonce_phase_and_cgroup_mismatches(self):
        group = '0::/ozz' + RUN.replace('-', '') + '.slice/ozz' + RUN.replace('-', '') + '-building.service\n'
        state = {'closed': False, 'terminationConfirmed': False, 'bootId': BOOT, 'specHash': 'a' * 64,
                 'spec': {'runId': RUN, 'deadlineAt': '2099-01-01T00:00:00.000Z'}, 'leaseUntil': '2099-01-01T00:00:00.000Z',
                 'started': ['building'], 'completed': [], 'phaseEntries': {'building': {'nonce': NONCE, 'uid': 62002, 'specHash': 'a' * 64}}}
        self.assertEqual(entry.allowed_entry(state, RUN, 'building', NONCE, BOOT, group)[0], 62002)
        cases = [({'closed': True}, NONCE, BOOT, group), ({'terminationConfirmed': True}, NONCE, BOOT, group),
                 ({'completed': ['building']}, NONCE, BOOT, group), ({}, 'invalid', BOOT, group),
                 ({}, NONCE, 'wrong-boot', group), ({}, NONCE, BOOT, '0::/system.slice/unrelated.service\n'),
                 ({'leaseUntil': '2000-01-01T00:00:00.000Z'}, NONCE, BOOT, group)]
        for changes, nonce, boot, cgroup in cases:
            with self.subTest(changes=changes, nonce=nonce, boot=boot, group=cgroup), self.assertRaises(RuntimeError):
                entry.allowed_entry({**copy.deepcopy(state), **changes}, RUN, 'building', nonce, boot, cgroup)


if __name__ == '__main__':
    unittest.main()
