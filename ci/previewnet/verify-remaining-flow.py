"""Verify saved receipt evidence; never infer success from the Actions conclusion."""
import argparse
import importlib.util
import json
from pathlib import Path
from remaining_flow_evidence import require_wave_audits

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--scenario', choices=['merchant', 'quota', 'offboard', 'full-flow'], required=True)
parser.add_argument('--expected', type=int, required=True)
parser.add_argument('--smoke-only', choices=['true', 'false'], default='false')
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('verify-burst-artifact.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
smoke = args.smoke_only == 'true'
name = ('claim-smoke' if smoke else 'claim-burst') if args.scenario == 'merchant' else f'{args.scenario}-{"smoke" if smoke else "pilot"}'
summary = json.loads((args.directory / f'{name}-summary.json').read_text())
expected = 1 if smoke else args.expected
assert summary.get('count', summary.get('users')) == expected
assert summary['passed'], 'Workload summary failed'
paths = sorted(args.directory.glob(f'{name}*-audit.json'))
assert paths, 'No workload receipt audits'
for path in paths:
    audit.verify(args.directory, path)
if args.scenario != 'merchant':
    state_paths = sorted(args.directory.glob(f'{name}-wave-*-state.json'))
    states = [json.loads(path.read_text()) for path in state_paths]
    assert states and sum(len(state['states']) for state in states) == expected
    require_wave_audits(args.directory, name, args.scenario, zip(state_paths, states))
    fixture = json.loads((args.directory / f'{name}-fixture.json').read_text())
    seen = set()
    completed = 0
    for state in states:
        for row in state['states']:
            assert row['actor'] not in seen
            seen.add(row['actor'])
            assert int(row['balance']) == int(fixture['amount'])
            assert row['source'] is None and row['recipient'] is None
        completed += len(state['states'])
        expected_held = 0 if args.scenario == 'full-flow' else int(fixture['amount']) * (expected - completed)
        assert int(state['heldBacking']) == expected_held
        assert int(state['finalBacking']) == 1
        assert state['finalBacking'] == state['expectedBacking']
        assert state['heldBacking'] == state['expectedHeldBacking']
    assert seen == set(range(expected))
    token_paths = sorted(args.directory.glob(f'{name}-wave-*-tokens.json'))
    tokens = [token for path in token_paths for token in json.loads(path.read_text())['tokens']]
    assert len(tokens) == expected * (2 if args.scenario == 'full-flow' else 1)
    assert all(t['consumed'] for t in tokens)
    assert len({(t['period'], t['alias']) for t in tokens}) == len(tokens)
print(f'{name}: receipt evidence and workload gates verified for {expected} actors')
