import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import tomli_w
import tomllib
import network
import delay


class NetworkTests(unittest.TestCase):
    def test_best_blocks_do_not_count_as_finality(self):
        before = {'alice': {'best': 4, 'finalized': 2}, 'bob': {'best': 4, 'finalized': 2}}
        after = {'alice': {'best': 8, 'finalized': 3}, 'bob': {'best': 9, 'finalized': 2}}
        self.assertFalse(network.advanced(before, after))
        after['bob']['finalized'] = 3
        self.assertTrue(network.advanced(before, after))

    def test_prepare_preserves_authorities_and_parachains(self):
        config = {'relaychain': {'nodes': [{'name': n, 'rpc_port': 10000+i} for i, n in enumerate(['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'])]}, 'parachains': [{'id': 1004, 'collators': [{'name': 'people', 'rpc_port': 10004}]}], 'custom_processes': [{'name': 'product'}]}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/'source.toml'
            source.write_text(tomli_w.dumps(config))
            network.prepare(source, root/'out')
            result = tomllib.loads((root/'out/network.toml').read_text())
            self.assertEqual(result['relaychain'], config['relaychain'])
            self.assertEqual(result['parachains'], config['parachains'])
            self.assertNotIn('custom_processes', result)
            config['relaychain']['nodes'] = config['relaychain']['nodes'][:2]
            source.write_text(tomli_w.dumps(config))
            with self.assertRaises(ValueError):
                network.prepare(source, root/'out')

    def test_extract_peer_ports_including_embedded_relay(self):
        args = ['polkadot-omni-node', '--listen-addr', '/ip4/0.0.0.0/tcp/30333/ws', '--rpc-port', '9944', '--prometheus-port=9615', '--', '--port=30334', '--listen-addr=/ip4/0.0.0.0/udp/30335/quic-v1']
        self.assertEqual(delay.peer_ports(args), {30333, 30334})

    def test_filters_cover_both_directions_only_for_peer_ports(self):
        rules = list(delay.filters([30333]))
        self.assertEqual(len(rules), 2)
        self.assertIn('sport', rules[0])
        self.assertIn('dport', rules[1])
        for rule in rules:
            self.assertIn('30333', rule)
            self.assertNotIn('9944', rule)
            self.assertEqual(rule[-1], '7a00:3')

    @patch('delay.tc')
    @patch('delay.root_qdiscs', return_value=[{'root': True, 'kind': 'fq_codel'}])
    def test_does_not_overwrite_existing_qdisc(self, roots, tc):
        with self.assertRaises(RuntimeError):
            delay.apply(Path('/tmp/unused'), 1000000)
        tc.assert_not_called()

    @patch('delay.root_qdiscs', return_value=[])
    @patch('delay.tc')
    def test_queued_packets_verify_long_delay(self, tc, roots):
        tc.return_value.stdout = 'qdisc netem 7a30: parent 7a00:3 limit 100000 delay 1000s\n Sent 0 bytes 0 pkt (dropped 0, overlimits 0 requeues 0)\n backlog 10000b 10p requeues 0\n'
        with tempfile.TemporaryDirectory() as tmp:
            delay.capture(Path(tmp), require_packets=True)
            tc.return_value.stdout = tc.return_value.stdout.replace('10p', '0p')
            with self.assertRaises(RuntimeError):
                delay.capture(Path(tmp), require_packets=True)


if __name__ == '__main__':
    unittest.main()
