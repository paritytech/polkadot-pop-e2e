"""Verify lifecycle receipts and saved state; no live node needed."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('receipt_verifier', Path(__file__).with_name('verify-burst-artifact.py'))
receipt_verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt_verifier)


def verify(root, scenario, count, suffix):
    name = f'{scenario}-{suffix}'
    load = lambda file: json.loads((root / f'{file}.json').read_text())
    fixture = load(f'{name}-fixture')
    summary = load(f'{name}-summary')
    assert summary['passed'] and summary['count'] == count
    assert fixture['count'] == count and fixture['scenario'] == scenario
    actors = {a['id']: a for a in fixture['actors']}
    assert len(actors) == count and set(actors) == set(range(count))
    addresses = [a[k] for a in actors.values() for k in ('source', 'payment', 'change', 'recipient')]
    assert len(set(addresses)) == 4 * count
    instance = fixture['instanceId']
    denomination = 2 if scenario == 'split' else 1
    assert fixture['originalCoin'] == {'instance_id': instance, 'value': denomination, 'age': 0}
    kinds = [('split', 'CoinSplit', False), ('claim', 'CoinTransferred', True)] if scenario == 'split' else [('recycle', 'RecyclerLoadedWithCoin', False)]
    mode = fixture['mode']
    assert mode in ('burst', 'paced')
    assert mode != 'paced' or count == 10000
    groups = [list(range(8000)), list(range(8000, 10000))] if mode == 'paced' else [list(range(count))]
    expected_waves = [(f'{name}-wave-{g + 1}' if mode == 'paced' else name, ids, kind)
                      for g, ids in enumerate(groups) for kind in kinds]
    assert len(summary['waves']) == len(expected_waves)
    member_deadlines = {}
    for position, (prefix, ids, (wave, event_name, claimed)) in enumerate(expected_waves):
        label = f'{prefix}-{wave}'
        observed_wave = summary['waves'][position]
        assert observed_wave['name'] == label and observed_wave['actorIds'] == ids
        assert observed_wave['sent'] == len(ids)
        if wave == 'recycle':
            for actor in ids:
                member_deadlines[actors[actor]['memberKey']] = observed_wave['startedMs'] + fixture['deadlineMs']
        audit = load(f'{label}-audit')
        assert audit['expected'] == len(ids) and audit['operation'] == event_name
        receipt_verifier.verify(root, root / f'{label}-audit.json')
        state = load(f'{label}-state')
        assert state['passed'] and not state['errors'] and state['instanceId'] == instance
        assert state['backing'] == state['finalBacking'] == fixture['backing']
        states = {s['actor']: s for s in state['states']}
        assert len(state['states']) == len(ids) and set(states) == set(ids)
        for actor, s in states.items():
            assert s['source'] is None
            if scenario == 'split':
                coin = {'instance_id': instance, 'value': 1, 'age': 1}
                assert s['change'] == coin
                assert s['payment'] == (None if claimed else coin)
                assert s['recipient'] == ({**coin, 'age': 2} if claimed else None)
            else:
                assert s['member'] == [instance, denomination]
        for receipt in load(f'{label}-receipts'):
            event = next(e['value']['value'] for e in receipt['events'] if e['type'] == 'Coinage' and e['value']['type'] == event_name)
            assert event['instance_id'] == instance
            if wave == 'split': assert event['output_count'] == 2
            if wave == 'claim':
                assert event['to'] == actors[ids[receipt['actor']]]['recipient']
                assert event['value'] == 1 and event['new_age'] == 2
            if wave == 'recycle': assert event['value'] == denomination
    if scenario == 'recycle':
        expected = {a['memberKey'] for a in actors.values()}
        assert len(expected) == count
        assert summary['ready'] == count and summary['unresolvedReadiness'] == 0
        assert summary['readinessMs']['count'] == count
        observed = {}
        for line in (root / f'{name}-readiness-evidence.jsonl').read_text().splitlines():
            record = json.loads(line)
            evidence = record['evidence']
            assert evidence['collection'] == fixture['collection']
            for observation in record['newlyReady']:
                member = observation['member']; ring = observation['ring']
                assert member in expected and member not in observed
                assert 0 <= evidence['elapsedMs'] <= member_deadlines[member]
                assert observation['at'] == evidence['at'] and observation['elapsedMs'] == evidence['elapsedMs']
                pages = sorted([p for p in evidence['pages'] if p['keyArgs'][1] == ring], key=lambda p: p['keyArgs'][2])
                assert [p['keyArgs'][2] for p in pages] == list(range(len(pages)))
                keys = [key for page in pages for key in page['value']]
                status = next(s['value'] for s in evidence['statuses'] if s['keyArgs'][1] == ring)
                root_value = next(r['value'] for r in evidence['roots'] if r['keyArgs'][1] == ring)
                assert keys[observation['position']] == member
                assert observation['position'] < status['included'] == observation['included']
                assert observation['revision'] == root_value['revision']
                observed[member] = observation
        assert set(observed) == expected
    print(f'{name}: {count} actors passed saved lifecycle state checks')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--scenario', choices=['split', 'recycle'], required=True)
    parser.add_argument('--expected', type=int, required=True)
    args = parser.parse_args()
    assert 1 <= args.expected <= 100000
    verify(args.directory, args.scenario, 1, 'smoke')
    verify(args.directory, args.scenario, args.expected, 'pilot')
    print('Saved RPC evidence consistency only; not a cryptographic storage or consensus proof.')
