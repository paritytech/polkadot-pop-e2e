"""Require receipt coverage for every operation in each lifecycle wave."""
import json


def require_wave_audits(root, name, scenario, states):
    operations = {'': 'RecyclerUnloadedIntoExternalAsset'}
    if scenario == 'full-flow':
        operations.update({
            '-topup': 'RecyclerLoadedWithExternalAsset',
            '-payment': 'RecyclerUnloadedIntoCoin',
            '-claim': 'CoinTransferred',
            '-recycle': 'RecyclerLoadedWithCoin',
        })
    required = set()
    for path, state in states:
        prefix = path.name.removesuffix('-state.json')
        for suffix, operation in operations.items():
            stage = prefix + suffix
            audit_path = root / f'{stage}-audit.json'
            assert audit_path.exists(), f'Missing lifecycle receipt audit: {stage}'
            audit = json.loads(audit_path.read_text())
            assert audit['name'] == stage, f'{stage}: audit name differs'
            assert audit['operation'] == operation, f'{stage}: wrong receipt event'
            assert audit['expected'] == len(state['states']) > 0, f'{stage}: wrong wave population'
            required.add(audit_path)
    actual = set(root.glob(f'{name}*-audit.json'))
    assert required == actual, 'Lifecycle audits do not match the observed waves'
