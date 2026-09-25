import copy
import json
from pathlib import Path
import tempfile
import unittest
import tomllib
import tomli_w
from topology import partition


class TopologyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        spec = self.root / 'raw.json'
        spec.write_text(json.dumps({'genesis': {'raw': {'top': {'0x00': '0x01'}}}, 'bootNodes': []}))
        (self.root / 'manifest.json').write_text(json.dumps({
            'network': 'previewnet', 'bittenAt': 'fixture',
            'biteBlocks': {k: 100 for k in ['relay', '1500', '1502', '1501', '1600']},
        }))
        self.config = {
            'settings': {}, 'custom_processes': [{'name': 'unrelated-service'}],
            'relaychain': {'chain_spec_path': str(spec), 'default_args': ['--unsafe-rpc-external'],
                           'nodes': [{'name': name, 'rpc_port': 10000 + i} for i, name in enumerate(
                               ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'])]},
            'parachains': [{'id': para_id, 'chain_spec_path': str(spec), 'collators': [{
                'name': f'Collator-{para_id}', 'rpc_port': 10010 + i,
                'p2p_port': 30400 + i, 'args': ['--relay-chain-rpc-urls=ws://127.0.0.1:10000'],
            }]} for i, para_id in enumerate([1500, 1502, 1501, 1600])],
        }

    def build(self, worker, count):
        return partition(copy.deepcopy(self.config), self.root, worker, count, f'10.0.0.{worker + 1}')

    def test_each_authority_and_collator_runs_once_on_two_or_three_machines(self):
        for count in (2, 3):
            parts = [self.build(i, count) for i in range(count)]
            nodes = [node for _, topology in parts for node in topology['nodes']]
            self.assertEqual(len(nodes), 10)
            self.assertEqual(len({n['name'] for n in nodes}), 10)
            for config, topology in parts:
                self.assertEqual(len(config['relaychain']['nodes']), 6 // count)
                self.assertEqual(topology['spec_hashes'], parts[0][1]['spec_hashes'])
                self.assertNotIn('custom_processes', config)
                self.assertEqual(tomllib.loads(tomli_w.dumps(config)), config)
            people = [t['worker'] for _, t in parts if any(n['chain'] == '1502' for n in t['nodes'])]
            self.assertEqual(people, [count - 1])

    def test_collators_use_a_relay_on_their_own_machine(self):
        config, _ = self.build(1, 2)
        for para in config['parachains']:
            args = para['collators'][0]['args']
            self.assertIn('--relay-chain-rpc-urls=ws://127.0.0.1:10001', args)
            self.assertNotIn('--relay-chain-rpc-urls=ws://127.0.0.1:10000', args)
        for node in config['relaychain']['nodes']:
            self.assertIn(f"--public-addr=/ip4/10.0.0.2/tcp/{node['p2p_port']}/ws", node['args'])
            self.assertNotIn('--unsafe-rpc-external', node['args'])

    def test_rejects_plain_spec_that_could_change_the_authority_set(self):
        (self.root / 'raw.json').write_text(json.dumps({'genesis': {'runtimeGenesis': {}}}))
        with self.assertRaisesRegex(ValueError, 'same raw spec'):
            self.build(0, 2)

    def test_rejects_production_bootnodes(self):
        spec = self.root / 'raw.json'
        data = json.loads(spec.read_text())
        data['bootNodes'] = ['/dns/production/tcp/30333/p2p/peer']
        spec.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'production bootnodes'):
            self.build(0, 2)

    def test_rejects_duplicate_authority(self):
        self.config['relaychain']['nodes'][1]['name'] = 'alice'
        with self.assertRaisesRegex(ValueError, 'authority set'):
            self.build(0, 2)

    def test_rejects_loopback_advertisement(self):
        with self.assertRaisesRegex(ValueError, 'non-loopback'):
            partition(self.config, self.root, 0, 2, '127.0.0.1')


if __name__ == '__main__':
    unittest.main()
