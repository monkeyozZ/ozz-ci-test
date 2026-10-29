"""Builder proxy admission and phase egress boundaries; no host/network mutations."""
import copy
import importlib.util
import os
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[2]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, BASE / 'infra' / 'builder' / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


launcher = module('builder_network_launcher', 'launcher.py')
installer = module('builder_network_installer', 'install.py')
helper = module('builder_network_helper', 'phase-helper.py')
PROXY = {'url': 'http://host.lima.internal:51449', 'addresses': ['192.168.5.2']}
PREFIX = 'ozz11111111111141118111111111111111'
SPEC = {'destination': {'authority': 'host.lima.internal:50444'}}
CONFIG = {
    'dnsServer': '1.1.1.1', 'blockedNetworks': ['192.168.5.0/24'],
    'trustedCloneOrigins': ['https://host.lima.internal:51446'],
    'trustedUploadOrigins': ['https://host.lima.internal:50444'],
    'privateEgress': {'https://host.lima.internal:51446': ['192.168.5.2'], 'https://host.lima.internal:50444': ['192.168.5.2']},
}
CREDENTIALS = {'cloneUrl': 'https://host.lima.internal:51446/fixture/app.git', 'fullName': 'fixture/app'}


def addresses(*values):
    return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (value, 51449)) for value in values]


class ProxyAdmissionTests(unittest.TestCase):
    def test_exact_private_endpoint_is_validated_at_install_and_runtime(self):
        with patch('socket.getaddrinfo', return_value=addresses('192.168.5.2')) as resolver:
            self.assertEqual(launcher.validate_build_http_proxy(PROXY), PROXY)
            self.assertEqual(installer.checked_build_http_proxy(PROXY), PROXY)
            self.assertEqual(resolver.call_count, 2)
            resolver.assert_called_with('host.lima.internal', 51449, socket.AF_INET, socket.SOCK_STREAM)

    def test_rejects_unknown_fields_wrong_types_and_empty_or_duplicate_pins(self):
        invalid = [None, {}, {**PROXY, 'password': 'forbidden'}, {**PROXY, 'url': 1},
                   {**PROXY, 'addresses': '192.168.5.2'}, {**PROXY, 'addresses': []},
                   {**PROXY, 'addresses': ['192.168.5.2', '192.168.5.2']},
                   {**PROXY, 'addresses': ['192.168.5.' + str(value) for value in range(1, 10)]}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'BUILD_HTTP_PROXY_'):
                launcher.validate_build_http_proxy(value)

    def test_rejects_credentials_paths_queries_fragments_and_ambiguous_urls(self):
        urls = [
            'https://host.lima.internal:51449', 'http://user@host.lima.internal:51449',
            'http://user:password@host.lima.internal:51449', 'http://host.lima.internal:51449/',
            'http://host.lima.internal:51449/path', 'http://host.lima.internal:51449?',
            'http://host.lima.internal:51449?x=1', 'http://host.lima.internal:51449#',
            'http://host.lima.internal:51449#fragment', 'http://host.lima.internal',
            'http://host.lima.internal:0', 'http://host.lima.internal:65536',
            'http://host.lima.internal:051449', 'http://[::1]:51449', 'http://127.1:51449',
            'http://2130706433:51449', 'http://-proxy.example:51449', 'http://host.lima.internal.:51449',
            'http://host.lima.internal:51449\n', 'http://host.lima.internal:51449\\path',
        ]
        for url in urls:
            with self.subTest(url=url), self.assertRaisesRegex(RuntimeError, 'BUILD_HTTP_PROXY_CONFIGURATION_INVALID'):
                launcher.validate_build_http_proxy({**PROXY, 'url': url})

    def test_rejects_loopback_metadata_multicast_reserved_and_noncanonical_addresses(self):
        values = ['0.0.0.0', '0.1.2.3', '127.0.0.1', '169.254.169.254', '100.64.0.1',
                  '224.0.0.1', '255.255.255.255', '240.0.0.1', '198.18.0.1', '192.0.2.1',
                  '::1', '192.168.005.2', 3232236802, True]
        for value in values:
            with self.subTest(address=value), self.assertRaisesRegex(RuntimeError, 'BUILD_HTTP_PROXY_ADDRESS_INVALID'):
                launcher.validate_build_http_proxy({**PROXY, 'addresses': [value]})

    def test_dns_must_match_the_entire_pinned_set_including_no_extra_answers(self):
        for resolved in [[], ['127.0.0.1'], ['192.168.5.3'], ['192.168.5.2', '192.168.5.3']]:
            with self.subTest(resolved=resolved), patch('socket.getaddrinfo', return_value=addresses(*resolved)), self.assertRaisesRegex(RuntimeError, 'BUILD_HTTP_PROXY_ADDRESS_CHANGED'):
                launcher.validate_build_http_proxy(PROXY)
        with patch('socket.getaddrinfo', side_effect=socket.gaierror('untrusted diagnostic')), self.assertRaisesRegex(RuntimeError, '^BUILD_HTTP_PROXY_DNS_FAILED$'):
            installer.checked_build_http_proxy(PROXY)

    def test_dns_failure_occurs_before_namespace_or_firewall_mutation(self):
        with patch('socket.getaddrinfo', return_value=addresses('127.0.0.1')), patch.object(launcher, 'run') as command, self.assertRaisesRegex(RuntimeError, 'BUILD_HTTP_PROXY_ADDRESS_CHANGED'):
            launcher.configure_network(PREFIX, 'building', SPEC, {}, {**CONFIG, 'buildHttpProxy': PROXY})
        command.assert_not_called()


class PhaseProxyTests(unittest.TestCase):
    def test_proxy_build_has_only_the_pinned_endpoint_as_outbound_allowance(self):
        with patch('socket.getaddrinfo', return_value=addresses('192.168.5.2')):
            rules, endpoint = launcher.network_rules(PREFIX, 'building', SPEC, {}, {**CONFIG, 'buildHttpProxy': PROXY})
        outbound = [line for line in rules.decode().splitlines() if line.startswith('iifname ') and line.endswith(' accept')]
        self.assertEqual(set(outbound), {'iifname "v11111111111" ip daddr 192.168.5.2 tcp dport 51449 accept'})
        self.assertEqual(endpoint, 'http://192.168.5.2:51449')
        self.assertNotIn(' dport 53 ', rules.decode())
        self.assertNotIn('dport { 80, 443 }', rules.decode())

    def test_proxy_option_does_not_change_checkout_or_upload_rules(self):
        with patch('socket.getaddrinfo', return_value=addresses('192.168.5.2')):
            for phase in ('checkout', 'pushing'):
                with self.subTest(phase=phase):
                    before = launcher.network_rules(PREFIX, phase, SPEC, CREDENTIALS, CONFIG)
                    after = launcher.network_rules(PREFIX, phase, SPEC, CREDENTIALS, {**CONFIG, 'buildHttpProxy': PROXY})
                    self.assertEqual(before, after)
                    self.assertIsNone(after[1])
                    self.assertNotIn('51449', after[0].decode())

    def test_absent_proxy_preserves_direct_build_policy_and_ignores_host_environment(self):
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:7890', 'HTTPS_PROXY': 'http://127.0.0.1:7890'}):
            rules, endpoint = launcher.network_rules(PREFIX, 'building', SPEC, {}, CONFIG)
            self.assertIsNone(endpoint)
            self.assertIn('dport { 80, 443 } accept', rules.decode())
            self.assertEqual(helper.build_proxy_environment({'phase': 'building'}), {})

    def test_only_building_accepts_the_root_derived_literal_ip_endpoint(self):
        endpoint = 'http://192.168.5.2:51449'
        self.assertEqual(helper.build_proxy_environment({'phase': 'building', 'buildHttpProxy': endpoint}),
                         {name: endpoint for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy')})
        for phase in ('checkout', 'pushing'):
            with self.subTest(phase=phase), self.assertRaisesRegex(RuntimeError, 'BUILD_HTTP_PROXY_PHASE_INVALID'):
                helper.build_proxy_environment({'phase': phase, 'buildHttpProxy': endpoint})
        for value in ['http://host.lima.internal:51449', endpoint + '/', endpoint + '?', 'http://192.168.5.2:65536']:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'BUILD_HTTP_PROXY_ENDPOINT_INVALID'):
                helper.build_proxy_environment({'phase': 'building', 'buildHttpProxy': value})


if __name__ == '__main__':
    unittest.main()
