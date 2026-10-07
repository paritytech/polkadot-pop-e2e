"""Partial evidence checks must not turn failed workloads into passes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('verify-burst-artifact.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class PartialReceiptTests(unittest.TestCase):
    def fixture(self, root, success=True):
        name = 'partial'
        raw = '0x0102'
        tx_hash = '0x' + hashlib.blake2b(bytes.fromhex(raw[2:]), digest_size=32).hexdigest()
        path = root / 'partial-audit.json'
        path.write_text(json.dumps({'name': name, 'expected': 2, 'passed': False,
                                   'summary': {'passed': False}, 'operation': 'CoinTransferred'}))
        (root / 'partial-receipts.json').write_text(json.dumps([{'actor': 0, 'txHash': tx_hash,
            'block': {'number': 1, 'hash': '0xabc', 'index': 0}}]))
        evidence = root / 'evidence/partial'
        evidence.mkdir(parents=True)
        (evidence / 'block-1.json').write_text(json.dumps({'hash': '0xabc',
            'block': {'block': {'header': {'number': '0x1'}, 'extrinsics': [raw]}},
            'finalityViews': [{'port': port, 'canonical': '0xabc', 'finalizedNumber': 1} for port in [10010, 10011]],
            'events': [{'phase': {'type': 'ApplyExtrinsic', 'value': 0},
                        'event': {'type': pallet, 'value': {'type': event}}}
                       for pallet, event in [('System', 'ExtrinsicSuccess' if success else 'ExtrinsicFailed'),
                                             ('Coinage', 'CoinTransferred')]]}))
        return path

    def test_partial_receipts_do_not_pass_the_normal_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.fixture(root)
            with self.assertRaisesRegex(AssertionError, 'failed run'):
                audit.verify(root, path)
            audit.verify(root, path, receipts_only=True)

    def test_partial_mode_still_rejects_failed_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.fixture(root, success=False)
            with self.assertRaises(AssertionError):
                audit.verify(root, path, receipts_only=True)


if __name__ == '__main__':
    unittest.main()
