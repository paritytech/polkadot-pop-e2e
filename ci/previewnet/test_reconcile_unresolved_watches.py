"""Receipt reconciliation must preserve repeated actors and require finalized evidence."""
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('reconcile-unresolved-watches.py')
SPEC = importlib.util.spec_from_file_location('reconcile', SCRIPT)
RECONCILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECONCILE)


class ReconcileTests(unittest.TestCase):
    def test_pool_error_code_excludes_request_payload(self):
        classify = RECONCILE.is_pool_entry_rejection
        self.assertFalse(classify('Error: WebSocket is not connected\nFailed WS Request: {"params":["0x1016"]}'))
        self.assertFalse(classify('Error: request 0x1016 timed out'))
        self.assertTrue(classify('Error: 1016: Immediately Dropped\nFailed WS Request: {"params":["0x1234"]}'))
        self.assertFalse(classify('dropped'))

    def reconcile(self, canonical=True, failed=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            signed = [{'actor': 0, 'hex': raw, 'operation': 'CoinTransferred',
                       'txHash': '0x' + hashlib.blake2b(bytes.fromhex(raw[2:]), digest_size=32).hexdigest()}
                      for raw in ['0x0102', '0x0304']]
            # Same actor, different transactions: neither watch may overwrite the other.
            (root / 'sustained-signed.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in signed))
            (root / 'sustained-transactions.jsonl').write_text(''.join(json.dumps({
                'actor': 0, 'txHash': x['txHash'], 'status': 'dropped'}) + '\n' for x in signed))
            (root / 'sustained-CoinTransferred-receipts.json').write_text('[]')
            evidence = root / 'evidence/sustained-CoinTransferred'
            evidence.mkdir(parents=True)
            events = []
            for i in range(2):
                for pallet, event in [('System', 'ExtrinsicFailed' if failed else 'ExtrinsicSuccess'),
                                      ('Coinage', 'CoinTransferred')]:
                    events.append({'phase': {'type': 'ApplyExtrinsic', 'value': i},
                                   'event': {'type': pallet, 'value': {'type': event}}})
            (evidence / 'block-1.json').write_text(json.dumps({
                'hash': '0xabc', 'block': {'block': {'header': {'number': '0x1'},
                                                   'extrinsics': [x['hex'] for x in signed]}},
                'events': events, 'finalityViews': [
                    {'port': port, 'canonical': '0xabc' if canonical else '0xdef', 'finalizedNumber': 2}
                    for port in [10010, 10011]]}))
            output = root / 'report.json'
            subprocess.run(['python3', str(SCRIPT), str(root), '--name', 'sustained',
                            '--operation', 'CoinTransferred', '--out', str(output)],
                           check=True, capture_output=True)
            return json.loads(output.read_text())

    def test_multiple_transactions_for_one_actor(self):
        result = self.reconcile()
        self.assertEqual(result['nonFinalizedWatches'], 2)
        self.assertEqual(result['receiptVerifiedTotal'], 2)
        self.assertEqual(result['outcomes'], {'reconciled-success': 2})

    def test_noncanonical_dispatch_failure_remains_unverified(self):
        result = self.reconcile(canonical=False, failed=True)
        self.assertEqual(result['receiptVerifiedTotal'], 0)
        self.assertEqual(result['outcomes'], {'included-unverified': 2})

    def test_canonical_dispatch_failure_is_not_a_success_receipt(self):
        result = self.reconcile(failed=True)
        self.assertEqual(result['receiptVerifiedTotal'], 0)
        self.assertEqual(result['outcomes'], {'included-dispatch-failed': 2})


if __name__ == '__main__':
    unittest.main()
