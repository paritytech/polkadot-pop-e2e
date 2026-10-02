"""Negative tests for lifecycle-specific artifact checks; receipt checks have separate tests."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('lifecycle', Path(__file__).with_name('verify-lifecycle-artifact.py'))
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def save(self, name, value):
        (self.root / f'{name}.json').write_text(json.dumps(value))

    def fixture(self, scenario):
        name = f'{scenario}-pilot'
        denomination = 2 if scenario == 'split' else 1
        self.save(f'{name}-fixture', {'scenario': scenario, 'count': 1, 'instanceId': 7, 'backing': '5', 'collection': 'c',
            'mode': 'burst', 'deadlineMs': 600000, 'originalCoin': {'instance_id': 7, 'value': denomination, 'age': 0},
            'actors': [{'id': 0, 'source': 's', 'payment': 'p', 'change': 'c', 'recipient': 'r', 'memberKey': 'member'}]})
        self.save(f'{name}-summary', {'passed': True, 'count': 1, 'ready': 1, 'unresolvedReadiness': 0, 'readinessMs': {'count': 1},
            'waves': [{'name': f'{name}-{wave}', 'actorIds': [0], 'sent': 1, 'startedMs': 0}
                      for wave in (['split', 'claim'] if scenario == 'split' else ['recycle'])]})
        coin = {'instance_id': 7, 'value': 1, 'age': 1}
        for wave, event in ([('split', 'CoinSplit'), ('claim', 'CoinTransferred')] if scenario == 'split' else [('recycle', 'RecyclerLoadedWithCoin')]):
            self.save(f'{name}-{wave}-audit', {'expected': 1, 'operation': event})
            fields = {'instance_id': 7, 'output_count': 2, 'to': 'r', 'value': 1, 'new_age': 2}
            self.save(f'{name}-{wave}-receipts', [{'actor': 0, 'events': [{'type': 'Coinage', 'value': {'type': event, 'value': fields}}]}])
            self.save(f'{name}-{wave}-state', {'passed': True, 'errors': [], 'instanceId': 7, 'backing': '5', 'finalBacking': '5',
                'states': [{'actor': 0, 'source': None, 'payment': coin if wave == 'split' else None,
                    'change': coin, 'recipient': {**coin, 'age': 2} if wave == 'claim' else None, 'member': [7, 1]}]})
        if scenario == 'recycle':
            evidence = {'collection': 'c', 'at': 'finalized-block', 'elapsedMs': 100,
                'pages': [{'keyArgs': ['c', 0, 0], 'value': ['member']}],
                'statuses': [{'keyArgs': ['c', 0], 'value': {'included': 1}}],
                'roots': [{'keyArgs': ['c', 0], 'value': {'revision': 2}}]}
            record = {'evidence': evidence, 'newlyReady': [{'member': 'member', 'ring': 0, 'position': 0,
                'included': 1, 'revision': 2, 'at': 'finalized-block', 'elapsedMs': 100}]}
            (self.root / f'{name}-readiness-evidence.jsonl').write_text(json.dumps(record) + '\n')

    def test_split_rejects_wrong_change_even_with_green_summary(self):
        self.fixture('split')
        with patch.object(lifecycle.receipt_verifier, 'verify') as receipt:
            lifecycle.verify(self.root, 'split', 1, 'pilot')
            self.assertEqual(receipt.call_count, 2)
            p = self.root / 'split-pilot-claim-state.json'
            state = json.loads(p.read_text()); state['states'][0]['change']['value'] = 2
            p.write_text(json.dumps(state))
            with self.assertRaises(AssertionError): lifecycle.verify(self.root, 'split', 1, 'pilot')

    def test_recycle_requires_root_coverage_and_deadline(self):
        self.fixture('recycle')
        p = self.root / 'recycle-pilot-readiness-evidence.jsonl'
        original = json.loads(p.read_text())
        with patch.object(lifecycle.receipt_verifier, 'verify'):
            lifecycle.verify(self.root, 'recycle', 1, 'pilot')
            changed = json.loads(json.dumps(original)); changed['evidence']['statuses'][0]['value']['included'] = 0
            p.write_text(json.dumps(changed) + '\n')
            with self.assertRaises(AssertionError): lifecycle.verify(self.root, 'recycle', 1, 'pilot')
            changed = json.loads(json.dumps(original)); changed['evidence']['elapsedMs'] = 600001
            p.write_text(json.dumps(changed) + '\n')
            with self.assertRaises(AssertionError): lifecycle.verify(self.root, 'recycle', 1, 'pilot')


if __name__ == '__main__':
    unittest.main()
