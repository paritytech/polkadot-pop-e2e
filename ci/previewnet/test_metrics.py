import json
from pathlib import Path
import tempfile
import unittest
import metrics


def sample_line(t, phase, node, lines):
    return json.dumps({'time': t, 'phase': phase, 'nodes': {node: {'metrics': lines, 'url': 'x'}}})


class MetricsTests(unittest.TestCase):
    def test_storage_key_matches_well_known_system_block_weight(self):
        self.assertEqual(metrics.twox128('System').hex(), '26aa394eea5630e07c48ae0c9558cef7')
        self.assertEqual(metrics.BLOCK_WEIGHT_KEY,
                         '0x26aa394eea5630e07c48ae0c9558cef734abf5cb34d6244378cddbf18e849d96')

    def test_xxh64_matches_reference_vectors(self):
        # Published xxHash64 vectors; the last is 39 bytes and exercises the 32-byte stripe path.
        self.assertEqual(metrics.xxh64(b''), 0xEF46DB3751D8E999)
        self.assertEqual(metrics.xxh64(b'abc'), 0x44BC2CF5AD770999)
        self.assertEqual(metrics.xxh64(b'Nobody inspects the spammish repetition'), 0xFBCEA83C8A378BF1)

    def test_consumed_weight_decodes_all_three_classes(self):
        # normal: ref_time 2^32 (big compact), proof 100 (two-byte compact); operational 1/2; mandatory 0/0
        big = bytes([0x03 | (1 << 2)]) + (1 << 32).to_bytes(5, 'little')
        encoded = big + (100 << 2 | 1).to_bytes(2, 'little') + bytes([1 << 2, 2 << 2, 0, 0])
        weight = metrics.consumed_weight('0x' + encoded.hex())
        self.assertEqual(weight['normal'], {'ref_time': 1 << 32, 'proof_size': 100})
        self.assertEqual(weight['operational'], {'ref_time': 1, 'proof_size': 2})
        self.assertEqual(weight['mandatory'], {'ref_time': 0, 'proof_size': 0})

    def test_parse_reads_labels_and_skips_comments(self):
        self.assertIsNone(metrics.parse('# HELP x y'))
        name, labels, value = metrics.parse('substrate_proposer_end_proposal_reason{reason="hit_block_weight_limit",chain="c"} 3')
        self.assertEqual((name, labels, value), ('substrate_proposer_end_proposal_reason',
                                                 {'reason': 'hit_block_weight_limit', 'chain': 'c'}, 3.0))

    def test_quantile_interpolates_within_the_bucket(self):
        buckets = [(0.1, 10.0), (1.0, 90.0), (float('inf'), 100.0)]
        self.assertAlmostEqual(metrics.quantile(buckets, 0.5), 0.1 + 0.9 * (50 - 10) / 80)
        self.assertEqual(metrics.quantile(buckets, 0.99), 1.0)
        self.assertIsNone(metrics.quantile([(1.0, 0.0), (float('inf'), 0.0)], 0.5))

    def test_counter_restart_counts_from_zero(self):
        self.assertEqual(metrics.increase(10, 15), 5)
        self.assertEqual(metrics.increase(10, 3), 3)

    def test_summary_reports_peak_drain_reasons_and_blocks_per_phase(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            rows = []
            for t, phase, ready, weight_hits, bucket in [(0, 'baseline', 0, 0, 0), (5, 'baseline', 0, 0, 0),
                                                        (10, 'burst', 0, 0, 0), (15, 'burst', 800, 1, 4),
                                                        (20, 'burst', 200, 2, 8), (25, 'burst', 0, 2, 10)]:
                rows.append(sample_line(t, phase, 'Collator-1502', [
                    f'substrate_ready_transactions_number{{chain="c"}} {ready}',
                    f'substrate_proposer_end_proposal_reason{{reason="hit_block_weight_limit",chain="c"}} {weight_hits}',
                    f'substrate_sub_txpool_timing_event_dropped_count{{chain="c"}} 0',
                    f'polkadot_pvf_execution_time_bucket{{le="0.5"}} {bucket}',
                    f'polkadot_pvf_execution_time_bucket{{le="+Inf"}} {bucket}',
                ]))
            (out / 'node-metrics.jsonl').write_text('\n'.join(rows) + '\n')
            blocks = [{'time': 15, 'phase': 'burst', 'number': n, 'extrinsics': e, 'bytes': 10 * e,
                       'weight': {'normal': {'ref_time': 1000 * e, 'proof_size': e}}} for n, e in ((1, 5), (2, 250))]
            (out / 'blocks.jsonl').write_text('\n'.join(json.dumps(b) for b in blocks) + '\n')
            result = metrics.summarise(out)
            burst = result['phases']['burst']['nodes']['Collator-1502']
            self.assertEqual(burst['substrate_ready_transactions_number']['max'], 800)
            self.assertEqual(burst['substrate_ready_transactions_number']['drain_seconds'], 10)
            self.assertEqual(burst['substrate_proposer_end_proposal_reason']['reason=hit_block_weight_limit'], 2)
            self.assertEqual(burst['polkadot_pvf_execution_time']['count'], 10)
            self.assertEqual(result['phases']['burst']['blocks']['extrinsics']['max'], 250)
            self.assertIsNone(result['phases']['baseline']['blocks'])
            self.assertIn('substrate_proposer_block_proposal_time_bucket', result['missing_metrics'])
            self.assertIn('hit_block_weight_limit 2', (out / 'metrics-summary.md').read_text())


if __name__ == '__main__':
    unittest.main()
