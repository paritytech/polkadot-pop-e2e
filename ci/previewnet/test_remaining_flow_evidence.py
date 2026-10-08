import json
import tempfile
import unittest
from pathlib import Path
from remaining_flow_evidence import require_wave_audits


class WaveEvidenceTests(unittest.TestCase):
    def test_full_flow_requires_every_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            name = 'full-flow-pilot'
            prefix = name + '-wave-1'
            state = (root / f'{prefix}-state.json', {'states': [{}, {}]})
            operations = {'': 'RecyclerUnloadedIntoExternalAsset', '-topup': 'RecyclerLoadedWithExternalAsset',
                          '-payment': 'RecyclerUnloadedIntoCoin', '-claim': 'CoinTransferred', '-recycle': 'RecyclerLoadedWithCoin'}
            for suffix, operation in operations.items():
                stage = prefix + suffix
                (root / f'{stage}-audit.json').write_text(json.dumps({'name': stage, 'operation': operation, 'expected': 2}))
            require_wave_audits(root, name, 'full-flow', [state])
            for suffix in operations:
                path = root / f'{prefix}{suffix}-audit.json'
                saved = path.read_text()
                path.unlink()
                with self.assertRaisesRegex(AssertionError, 'Missing lifecycle'):
                    require_wave_audits(root, name, 'full-flow', [state])
                path.write_text(saved)
            path = root / f'{prefix}-claim-audit.json'
            bad = json.loads(path.read_text())
            bad['expected'] = 1
            path.write_text(json.dumps(bad))
            with self.assertRaisesRegex(AssertionError, 'wrong wave population'):
                require_wave_audits(root, name, 'full-flow', [state])

    def test_offboard_requires_one_operation_per_wave(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            name = 'offboard-pilot'
            states = []
            for wave, count in [(1, 8), (2, 2)]:
                stage = f'{name}-wave-{wave}'
                states.append((root / f'{stage}-state.json', {'states': [{}] * count}))
                (root / f'{stage}-audit.json').write_text(json.dumps({'name': stage, 'operation': 'RecyclerUnloadedIntoExternalAsset', 'expected': count}))
            require_wave_audits(root, name, 'offboard', states)


if __name__ == '__main__':
    unittest.main()
