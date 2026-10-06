"""Re-read sustained-run receipts, inventory checks and achieved-pressure evidence."""
import argparse
import importlib.util
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--scenario', required=True)
parser.add_argument('--smoke-only', choices=['true', 'false'], required=True)
args = parser.parse_args()
root = args.directory
summary = json.loads((root / 'sustained-summary.json').read_text())
fixture = json.loads((root / 'sustained-fixture.json').read_text())
assert summary['scenario'] == fixture['scenario'] == args.scenario
assert summary['poolProfile'] == 'default'
smoke = args.smoke_only == 'true'
assert summary['smokeOnly'] == smoke
pressure = summary['pressure']
assert pressure['target'] == (1 if smoke else 8000)
assert pressure['requestedHoldMs'] == (10000 if smoke else 180000)
assert pressure['poolLimit'] == 8192
assert summary['workloadPassed'] and summary['pressurePassed']
assert not summary['auditErrors'] and not summary['stateErrors']
assert pressure['holdCompleted'] and pressure['reason'] == 'hold-complete'
if not smoke:
    assert pressure['fractionOfRequestedHoldInBand'] >= .95
samples = [json.loads(line) for line in (root / 'sustained-pool.jsonl').open()]
hold = [sample for sample in samples if sample['phase'] == 'hold']
assert hold
start = hold[0]['elapsedMs']
end = start + pressure['requestedHoldMs']
observed = in_band = 0
for previous, current in zip(hold, hold[1:]):
    gap = current['elapsedMs'] - previous['elapsedMs']
    assert gap >= 0
    if gap <= 1000:
        interval = max(0, min(current['elapsedMs'], end) - previous['elapsedMs'])
        observed += interval
        if pressure['band'][0] <= previous['ready'] <= 8192:
            in_band += interval
assert abs(observed - pressure['sampledMs']) < .001
assert abs(in_band - pressure['sampledInBandMs']) < .001
spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('verify-burst-artifact.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
audits = sorted(root.glob('sustained-*-audit.json'))
assert audits
receipts = 0
counts = {}
for path in audits:
    audit.verify(root, path)
    item = json.loads(path.read_text())
    receipts += item['expected']
    counts[item['operation']] = item['expected']
assert receipts == summary['transactions'] == summary['finalized'] > 0
sent = set()
with (root / 'sustained-signed.jsonl').open() as stream:
    for line in stream:
        row = json.loads(line)
        assert row['txHash'] not in sent
        sent.add(row['txHash'])
assert len(sent) == receipts
seen = set()
with (root / 'sustained-state.jsonl').open() as stream:
    for line in stream:
        row = json.loads(line)
        assert row['actor'] not in seen and row['stage'] == 'done'
        seen.add(row['actor'])
        assert row['source'] is None and row['payment'] is None
        if args.scenario in ['claim', 'merchant', 'split']:
            assert row['recipient'] == {'instance_id': fixture['instanceId'], 'value': 1,
                                        'age': 2 if args.scenario == 'split' else 1}
            if args.scenario == 'split':
                assert row['change'] == {'instance_id': fixture['instanceId'], 'value': 1, 'age': 1}
        else:
            assert row['recipient'] is None
        if args.scenario in ['quota', 'offboard', 'full-flow']:
            assert int(row['external']['balance']) == int(fixture['amount'])
assert len(seen) == summary['admittedActors']
assert int(summary['finalBacking']) == int(fixture['backing'])
assert int(summary['heldBacking']) == int(summary['expectedHeld'])
if args.scenario in ['quota', 'offboard']:
    expected_held = int(fixture['amount']) * (fixture['inventory'] - counts['RecyclerUnloadedIntoExternalAsset'])
elif args.scenario in ['topup', 'full-flow']:
    expected_held = int(fixture['amount']) * (counts.get('RecyclerLoadedWithExternalAsset', 0) - counts.get('RecyclerUnloadedIntoExternalAsset', 0))
else:
    expected_held = 0
assert int(summary['heldBacking']) == expected_held
if args.scenario in ['quota', 'offboard', 'full-flow']:
    tokens = [json.loads(line) for line in (root / 'sustained-tokens.jsonl').open()]
    assert all(row['consumed'] for row in tokens)
    assert len({(row['period'], row['alias']) for row in tokens}) == len(tokens)
    assert len(tokens) == counts.get('RecyclerUnloadedIntoCoin', 0) + counts.get('RecyclerUnloadedIntoExternalAsset', 0)
print(f"{args.scenario}: {receipts} receipts, {len(seen)} completed actors; "
      f"observed target-band fraction {pressure['fractionOfRequestedHoldInBand']:.3f}")
