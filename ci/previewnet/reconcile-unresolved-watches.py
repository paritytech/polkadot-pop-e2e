"""Reconcile non-finalized watches against saved raw blocks, offline.

A dropped or unresolved watch does not show what happened on chain. For every such
transaction this looks for its signed bytes in the saved block bodies and applies the same
checks as verify-burst-artifact.py: the block is canonical at both People nodes' finalized
views, the extrinsic hash matches the signed transaction, and the extrinsic emitted
System.ExtrinsicSuccess and the expected Coinage event. State changes alone never count.

A transaction absent from the saved blocks is reported as not found in that block range.
That does not prove it never executed.
"""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


def digest(raw):
    return '0x' + hashlib.blake2b(bytes.fromhex(raw.removeprefix('0x')), digest_size=32).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--name', required=True, help='Stage prefix, for example claim-burst')
    parser.add_argument('--operation', required=True, help='Expected Coinage event, for example CoinTransferred')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    root, name = args.directory, args.name

    signed = json.loads((root / f'{name}-signed.json').read_text())
    for tx in signed:
        assert digest(tx['hex']) == tx['txHash'], f"actor {tx['actor']}: signed bytes do not match txHash"
    by_hash = {tx['txHash']: tx['actor'] for tx in signed}
    watches = {}
    for line in (root / f'{name}-transactions.jsonl').read_text().splitlines():
        row = json.loads(line)
        watches[row['actor']] = row
    receipts = json.loads((root / f'{name}-receipts.json').read_text())
    receipt_hashes = {r['txHash'] for r in receipts}

    # Every saved block with finality evidence, indexed by extrinsic hash.
    found = {}
    numbers = []
    for path in sorted((root / 'evidence' / name).glob('block-*.json')):
        evidence = json.loads(path.read_text())
        number = int(evidence['block']['block']['header']['number'], 16)
        numbers.append(number)
        views = evidence['finalityViews']
        canonical = ({v['port'] for v in views} == {10010, 10011} and
                     all(v['canonical'] == evidence['hash'] and v['finalizedNumber'] >= number for v in views))
        events = {}
        for item in evidence['events']:
            if item['phase']['type'] == 'ApplyExtrinsic':
                events.setdefault(item['phase']['value'], []).append(item['event'])
        for index, raw in enumerate(evidence['block']['block']['extrinsics']):
            kinds = {(e['type'], e['value']['type']) for e in events.get(index, [])}
            found[digest(raw)] = {'number': number, 'hash': evidence['hash'], 'index': index, 'canonical': canonical,
                                  'success': ('System', 'ExtrinsicSuccess') in kinds,
                                  'failed': ('System', 'ExtrinsicFailed') in kinds,
                                  'operation': ('Coinage', args.operation) in kinds}

    rows, counts = [], Counter()
    for actor, watch in sorted(watches.items()):
        if watch['status'] == 'finalized':
            continue
        tx_hash = watch['txHash']
        assert by_hash.get(tx_hash) == actor, f'actor {actor}: watch hash is not its signed transaction'
        error = str(watch.get('error'))
        hit = found.get(tx_hash)
        if hit and hit['canonical'] and hit['success'] and hit['operation'] and not hit['failed']:
            outcome = 'reconciled-success'
        elif hit and hit['failed']:
            outcome = 'included-dispatch-failed'
        elif hit:
            outcome = 'included-unverified'
        elif '1016' in error:
            outcome = 'rejected-at-pool-entry'
        else:
            outcome = 'not-found-in-saved-blocks'
        assert not (outcome == 'reconciled-success' and tx_hash in receipt_hashes), 'double counted receipt'
        counts[outcome] += 1
        rows.append({'actor': actor, 'txHash': tx_hash, 'watchStatus': watch['status'], 'watchError': error,
                     'outcome': outcome, 'block': hit})

    report = {
        'name': name, 'operation': args.operation,
        'originalReceipts': len(receipt_hashes),
        'nonFinalizedWatches': len(rows),
        'outcomes': dict(counts),
        'receiptVerifiedTotal': len(receipt_hashes) + counts['reconciled-success'],
        'savedBlockRange': [min(numbers), max(numbers)] if numbers else None,
        'scope': 'Saved raw block bodies, decoded events and two local RPC finality views. '
                 'Not found means not in the saved block range, not proof of non-execution.',
        'transactions': rows,
    }
    args.out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'transactions'}, indent=2))


if __name__ == '__main__':
    main()
