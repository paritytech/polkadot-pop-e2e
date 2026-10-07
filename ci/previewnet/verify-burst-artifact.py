"""Recheck saved block receipts without a running network or project dependencies."""
import argparse
import hashlib
import json
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=2)
def read_evidence(path):
    evidence = json.loads(path.read_text())
    by_index = {}
    for item in evidence['events']:
        if item['phase']['type'] == 'ApplyExtrinsic':
            by_index.setdefault(item['phase']['value'], []).append(item['event'])
    return evidence, by_index


def verify(root, audit_path, *, receipts_only=False):
    audit = json.loads(audit_path.read_text())
    name = audit['name']
    receipts = json.loads((root / f'{name}-receipts.json').read_text())
    if not receipts_only:
        assert audit['passed'] and audit['summary']['passed'], f'{name}: failed run'
        assert not audit['summary'].get('generatorLimited'), f'{name}: missed launch target'
        assert len(receipts) == audit['expected'] > 0, f'{name}: missing receipts'
    hashes = set()
    actors = set()
    for receipt in receipts:
        block_info = receipt['block']
        evidence, by_index = read_evidence(root / 'evidence' / name / f"block-{block_info['number']}.json")
        assert evidence['hash'] == block_info['hash']
        assert int(evidence['block']['block']['header']['number'], 16) == block_info['number']
        assert {view['port'] for view in evidence['finalityViews']} == {10010, 10011}
        for view in evidence['finalityViews']:
            assert view['canonical'] == block_info['hash']
            assert view['finalizedNumber'] >= block_info['number']
        extrinsics = evidence['block']['block']['extrinsics']
        assert 0 <= block_info['index'] < len(extrinsics), f'{name}: invalid extrinsic index'
        raw = extrinsics[block_info['index']]
        digest = '0x' + hashlib.blake2b(bytes.fromhex(raw.removeprefix('0x')), digest_size=32).hexdigest()
        assert digest == receipt['txHash'], f'{name}: wrong block extrinsic'
        assert digest not in hashes and receipt['actor'] not in actors, f'{name}: duplicate receipt'
        hashes.add(digest)
        actors.add(receipt['actor'])
        events = by_index.get(block_info['index'], [])
        kinds = {(item['type'], item['value']['type']) for item in events}
        assert ('System', 'ExtrinsicSuccess') in kinds
        assert ('System', 'ExtrinsicFailed') not in kinds
        assert ('Coinage', audit['operation']) in kinds
    if not receipts_only:
        assert actors == set(range(audit['expected'])), f'{name}: actor coverage differs'
    else:
        assert actors <= set(range(audit['expected'])), f'{name}: actor outside expected population'
        print(f'{name}: receipt-only check; workload gates and completeness are NOT asserted')
    print(f'{name}: {len(receipts)} unique transactions matched saved block bodies and successful dispatch events')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--receipts-only', action='store_true', help='Verify existing receipts without asserting workload success or completeness')
    parser.add_argument('--stage', help='Require this burst stage, so smoke results alone cannot pass')
    parser.add_argument('--expected', type=int, help='Required burst transaction count')
    args = parser.parse_args()
    assert bool(args.stage) == (args.expected is not None), '--stage and --expected must be used together'
    if args.stage:
        required = json.loads((args.directory / f'{args.stage}-audit.json').read_text())
        assert required['expected'] == args.expected > 0, 'Wrong burst size'
    audits = sorted(args.directory.glob('*-audit.json'))
    assert audits, 'No audited results found'
    for audit in audits:
        verify(args.directory, audit, receipts_only=args.receipts_only)
    print('This checks saved evidence consistency; it does not authenticate the RPC nodes or prove consensus.')


if __name__ == '__main__':
    main()
