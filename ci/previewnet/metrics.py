"""Sample node metrics and block fullness during a run, then summarise them.

`sample` writes node-metrics.jsonl (Prometheus lines per node, tagged with the
current phase) and blocks.jsonl (consumed weight and size of each finalised
block on the watched chain). `summarise` turns those files into
metrics-summary.json and metrics-summary.md. Missing metrics stay visible.
"""
import argparse
import concurrent.futures
import json
import math
from pathlib import Path
import re
import time
import urllib.request

ANSI = re.compile(r'\x1b\[[0-9;]*m')
ENDPOINT = re.compile(r'📊 ([^:]+): metrics link (http://127\.0\.0\.1:\d+/metrics)')
KEEP = re.compile(r'pool|transaction|block|finali|author|validat|pvf|process|memory|cpu|proof|proposer|approval|dispute|ready', re.I)
LINE = re.compile(r'^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(\S+)')
LABEL = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"')

# Metrics the summary reports. Each is read per node over the phase window.
GAUGES = [  # peak value
    'substrate_ready_transactions_number',
    'substrate_proposer_number_of_transactions',
    'polkadot_parachain_approval_checking_finality_lag',
    'polkadot_parachain_disputes_finality_lag',
    'polkadot_parachain_approval_unapproved_candidates_in_unfinalized_chain',
    'polkadot_memory_resident',
]
COUNTERS = [  # increase over the window
    'substrate_proposer_end_proposal_reason',
    'substrate_sub_txpool_submitted_txs_total',
    'substrate_sub_txpool_finalized_txs_total',
    'substrate_sub_txpool_removed_invalid_txs_total',
    'substrate_sub_txpool_reported_invalid_txs_total',
    'substrate_sub_txpool_timing_event_dropped_count',
    'substrate_sub_txpool_timing_event_invalid_count',
    'substrate_sub_txpool_timing_event_usurped_count',
    'substrate_sub_txpool_timing_event_finality_timeout_count',
    'substrate_sub_txpool_timing_event_retracted_count',
]
HISTOGRAMS = [  # p50/p95/count of observations inside the window
    'substrate_sub_txpool_timing_event_ready',      # submission to ready in the pool (includes validation)
    'substrate_sub_txpool_timing_event_in_block',   # submission to inclusion
    'substrate_sub_txpool_timing_event_finalized',  # submission to finality
    'rpc_transaction_validation_time',              # only counts the transactionWatch RPC, not author_submitAndWatch
    'substrate_proposer_block_proposal_time',
    'substrate_proposer_block_constructed',
    'substrate_block_verification_and_import_time',
    'polkadot_pvf_execution_time',
    'polkadot_pvf_execution_queued_time',
]
BACKLOG = ('substrate_sub_txpool_validations_scheduled', 'substrate_sub_txpool_validations_finished')

# --- storage keys -----------------------------------------------------------

PRIME64 = (0x9E3779B185EBCA87, 0xC2B2AE3D27D4EB4F, 0x165667B19E3779F9, 0x85EBCA77C2B2AE63, 0x27D4EB2F165667C5)
MASK = (1 << 64) - 1


def _rotl(value, bits):
    return ((value << bits) | (value >> (64 - bits))) & MASK


def _round(acc, lane):
    acc = (acc + lane * PRIME64[1]) & MASK
    return (_rotl(acc, 31) * PRIME64[0]) & MASK


def xxh64(data, seed=0):
    """xxHash64, as used by Substrate's twox hashers."""
    p1, p2, p3, p4, p5 = PRIME64
    length, offset = len(data), 0
    if length >= 32:
        acc = [(seed + p1 + p2) & MASK, (seed + p2) & MASK, seed, (seed - p1) & MASK]
        while offset + 32 <= length:
            for i in range(4):
                acc[i] = _round(acc[i], int.from_bytes(data[offset + 8 * i:offset + 8 * i + 8], 'little'))
            offset += 32
        h = (_rotl(acc[0], 1) + _rotl(acc[1], 7) + _rotl(acc[2], 12) + _rotl(acc[3], 18)) & MASK
        for lane in acc:
            h = ((h ^ _round(0, lane)) * p1 + p4) & MASK
    else:
        h = (seed + p5) & MASK
    h = (h + length) & MASK
    while offset + 8 <= length:
        h ^= _round(0, int.from_bytes(data[offset:offset + 8], 'little'))
        h = (_rotl(h, 27) * p1 + p4) & MASK
        offset += 8
    if offset + 4 <= length:
        h ^= (int.from_bytes(data[offset:offset + 4], 'little') * p1) & MASK
        h = (_rotl(h, 23) * p2 + p3) & MASK
        offset += 4
    while offset < length:
        h ^= (data[offset] * p5) & MASK
        h = (_rotl(h, 11) * p1) & MASK
        offset += 1
    h ^= h >> 33
    h = (h * p2) & MASK
    h ^= h >> 29
    h = (h * p3) & MASK
    return h ^ (h >> 32)


def twox128(text):
    data = text.encode()
    return xxh64(data, 0).to_bytes(8, 'little') + xxh64(data, 1).to_bytes(8, 'little')


def storage_key(pallet, item):
    return '0x' + (twox128(pallet) + twox128(item)).hex()


BLOCK_WEIGHT_KEY = storage_key('System', 'BlockWeight')


def compact(data, offset):
    """Decode one SCALE compact integer; return (value, next offset)."""
    mode = data[offset] & 3
    if mode == 0:
        return data[offset] >> 2, offset + 1
    if mode == 1:
        return int.from_bytes(data[offset:offset + 2], 'little') >> 2, offset + 2
    if mode == 2:
        return int.from_bytes(data[offset:offset + 4], 'little') >> 2, offset + 4
    size = (data[offset] >> 2) + 4
    return int.from_bytes(data[offset + 1:offset + 1 + size], 'little'), offset + 1 + size


def consumed_weight(hex_value):
    """Decode frame-system ConsumedWeight: per class, compact ref_time then compact proof_size."""
    data, offset, result = bytes.fromhex(hex_value[2:]), 0, {}
    for dispatch_class in ('normal', 'operational', 'mandatory'):
        ref_time, offset = compact(data, offset)
        proof_size, offset = compact(data, offset)
        result[dispatch_class] = {'ref_time': ref_time, 'proof_size': proof_size}
    return result

# --- sampling ---------------------------------------------------------------


def endpoints(text):
    return dict(ENDPOINT.findall(ANSI.sub('', text)))


def fetch(item):
    name, url = item
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=3) as response:
            lines = response.read().decode().splitlines()
        return name, {'metrics': [line for line in lines if KEEP.search(line)], 'url': url}
    except Exception as error:
        return name, {'error': str(error), 'url': url}


def rpc(port, method, params=None):
    request = urllib.request.Request(f'http://127.0.0.1:{port}',
        data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
        result = json.load(response)
    if 'error' in result:
        raise RuntimeError(f'{method}: {result["error"]}')
    return result['result']


def block_record(port, number):
    block_hash = rpc(port, 'chain_getBlockHash', [number])
    extrinsics = rpc(port, 'chain_getBlock', [block_hash])['block']['extrinsics']
    record = {'number': number, 'hash': block_hash, 'extrinsics': len(extrinsics),
              'bytes': sum((len(x) - 2) // 2 for x in extrinsics)}
    try:
        record['weight'] = consumed_weight(rpc(port, 'state_getStorage', [BLOCK_WEIGHT_KEY, block_hash]))
    except Exception as error:  # Pruned state or an unexpected encoding stays visible.
        record['weight_error'] = str(error)
    return record


def watched_node(directory, chain):
    nodes_path = directory / 'nodes.json'
    if not nodes_path.exists():
        return None
    return next((n for n in json.loads(nodes_path.read_text()) if n['chain'] == chain), None)


def sample(directory, interval, chain, max_blocks):
    """Run until killed. Prometheus every `interval` seconds; every new finalised block on `chain`."""
    nodes = endpoints((directory / 'spawn.log').read_text())
    (directory / 'metrics-endpoints.json').write_text(json.dumps(nodes, indent=2) + '\n')
    watched, last_block = watched_node(directory, chain), None
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(nodes))) as pool, \
            (directory / 'node-metrics.jsonl').open('a', buffering=1) as metrics_out, \
            (directory / 'blocks.jsonl').open('a', buffering=1) as blocks_out:
        while True:
            started = time.monotonic()
            phase_path = directory / 'phase.txt'
            phase = phase_path.read_text().strip() if phase_path.exists() else None
            data = dict(pool.map(fetch, nodes.items()))
            metrics_out.write(json.dumps({'time': time.time(), 'phase': phase, 'nodes': data,
                'warning': None if nodes else 'No Prometheus endpoints found in spawn.log'}) + '\n')
            if watched:
                try:
                    head = rpc(watched['rpc_port'], 'chain_getHeader', [rpc(watched['rpc_port'], 'chain_getFinalizedHead')])
                    finalized = int(head['number'], 16)
                    start = finalized if last_block is None else last_block + 1
                    for number in range(max(start, finalized - max_blocks + 1), finalized + 1):
                        record = block_record(watched['rpc_port'], number)
                        blocks_out.write(json.dumps({'time': time.time(), 'phase': phase, 'chain': chain,
                                                     'node': watched['name'], **record}) + '\n')
                    last_block = finalized
                except Exception as error:
                    blocks_out.write(json.dumps({'time': time.time(), 'phase': phase, 'chain': chain, 'error': str(error)}) + '\n')
            time.sleep(max(0, interval - (time.monotonic() - started)))

# --- summarising ------------------------------------------------------------


def parse(line):
    """Parse one Prometheus text line into (name, labels, value), or None."""
    if line.startswith('#'):
        return None
    match = LINE.match(line)
    if not match:
        return None
    try:
        value = float(match.group(3))
    except ValueError:
        return None
    return match.group(1), dict(LABEL.findall(match.group(2) or '')), value


def series_key(labels, drop=('chain',)):
    return ','.join(f'{k}={v}' for k, v in sorted(labels.items()) if k not in drop)


def quantile(buckets, q):
    """Estimate a quantile from cumulative (upper bound, count) pairs, as Prometheus does."""
    buckets = sorted(buckets)
    if not buckets or buckets[-1][1] <= 0:
        return None
    rank, previous_bound, previous_count = q * buckets[-1][1], 0.0, 0.0
    for bound, count in buckets:
        if count >= rank:
            if math.isinf(bound):
                return previous_bound
            if count == previous_count:
                return bound
            return previous_bound + (bound - previous_bound) * (rank - previous_count) / (count - previous_count)
        previous_bound, previous_count = bound, count
    return previous_bound


def increase(first, last):
    """Counter increase; a restart resets the counter, so count from zero."""
    return last - first if last >= first else last


def load_samples(path):
    samples = []
    for line in Path(path).read_text().splitlines():
        if line.strip():
            samples.append(json.loads(line))
    return samples


def node_series(samples):
    """Return {node: [(time, {(name, labels_key): value, ...}), ...]}."""
    result = {}
    for sample_row in samples:
        for node, payload in sample_row.get('nodes', {}).items():
            values = {}
            for line in payload.get('metrics', []):
                parsed = parse(line)
                if parsed:
                    name, labels, value = parsed
                    values[(name, series_key(labels))] = value
            if values:
                result.setdefault(node, []).append((sample_row['time'], values))
    return result


def summarise_node(points):
    """Summarise one node's samples within one window."""
    first, last = points[0][1], points[-1][1]
    out = {'samples': len(points), 'seconds': round(points[-1][0] - points[0][0], 1)}
    for name in GAUGES:
        values = [(t, v) for t, row in points for (n, _), v in row.items() if n == name]
        if values:
            peak = max(v for _, v in values)
            out[name] = {'max': peak, 'last': values[-1][1]}
            if name == 'substrate_ready_transactions_number' and peak > 0:
                peak_time = next(t for t, v in values if v == peak)
                drained = next((t for t, v in values if t > peak_time and v == 0), None)
                out[name]['drain_seconds'] = None if drained is None else round(drained - peak_time, 1)
    for name in COUNTERS:
        keys = sorted({k for k in last if k[0] == name})
        if keys:
            out[name] = {k[1] or 'total': increase(first.get(k, 0.0), last[k]) for k in keys}
    for name in HISTOGRAMS:
        buckets = {}
        for (n, labels), value in last.items():
            if n == f'{name}_bucket':
                fields = dict(item.split('=', 1) for item in labels.split(',') if item)
                bound = float('inf') if fields['le'] in ('+Inf', 'Inf') else float(fields['le'])
                buckets[bound] = buckets.get(bound, 0.0) + increase(first.get((n, labels), 0.0), value)
        pairs = sorted(buckets.items())
        count = pairs[-1][1] if pairs else 0
        if pairs:
            out[name] = {'count': count, 'p50': quantile(pairs, 0.5), 'p95': quantile(pairs, 0.95)}
    scheduled, finished = BACKLOG
    backlog = [row.get((scheduled, ''), 0.0) - row.get((finished, ''), 0.0) for _, row in points
               if (scheduled, '') in row and (finished, '') in row]
    if backlog:
        out['validation_backlog'] = {'max': max(backlog), 'last': backlog[-1]}
    return out


def percentile(values, q):
    """Nearest-rank percentile of a list of numbers."""
    values = sorted(values)
    if not values:
        return None
    return values[min(len(values) - 1, max(0, math.ceil(q * len(values)) - 1))]


def summarise_blocks(rows):
    rows = [r for r in rows if 'number' in r]
    if not rows:
        return None
    normal = [r['weight']['normal'] for r in rows if 'weight' in r]
    out = {'blocks': len(rows), 'first': rows[0]['number'], 'last': rows[-1]['number'],
           'weight_errors': sum('weight_error' in r for r in rows)}
    for label, values in (('extrinsics', [r['extrinsics'] for r in rows]), ('bytes', [r['bytes'] for r in rows]),
                          ('normal_ref_time', [w['ref_time'] for w in normal]),
                          ('normal_proof_size', [w['proof_size'] for w in normal])):
        if values:
            out[label] = {'max': max(values), 'p95': percentile(values, 0.95), 'p50': percentile(values, 0.5)}
    return out


def stage_window(directory, stage, margin=30.0):
    """Time window of a burst stage from its `<stage>-summary.json`, with a margin to see the drain."""
    summary = json.loads((directory / f'{stage}-summary.json').read_text())
    start = time.mktime(time.strptime(summary['wallStart'][:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone
    return start, start + summary['elapsedMs'] / 1000 + margin


def windows(samples, requested, directory=None, stages=None):
    """Group samples by burst stage window, by phase tag, or treat the whole file as one window."""
    if stages:
        result = {}
        for stage in stages:
            start, end = stage_window(directory, stage)
            result[stage] = [s for s in samples if start <= s['time'] <= end]
        return result
    tags = [s.get('phase') for s in samples]
    names = requested or [t for i, t in enumerate(tags) if t and t not in tags[:i]] or ['all']
    return {name: [s for s in samples if name == 'all' or s.get('phase') == name] for name in names}


def summarise(directory, phases=None, stages=None):
    samples = load_samples(directory / 'node-metrics.jsonl')
    blocks_path = directory / 'blocks.jsonl'
    blocks = load_samples(blocks_path) if blocks_path.exists() else []
    seen = {n for s in samples for p in s.get('nodes', {}).values() for n in
            (parse(l)[0] for l in p.get('metrics', []) if parse(l))}
    expected = set(GAUGES + COUNTERS + [f'{h}_bucket' for h in HISTOGRAMS] + list(BACKLOG))
    result = {'phases': {}, 'missing_metrics': sorted(expected - seen),
              'fetch_errors': {n: sum('error' in s['nodes'].get(n, {}) for s in samples)
                               for n in {n for s in samples for n in s.get('nodes', {})}}}
    for phase, rows in windows(samples, phases, directory, stages).items():
        per_node = {node: summarise_node(points) for node, points in node_series(rows).items() if len(points) >= 2}
        if stages and rows:
            phase_blocks = [b for b in blocks if rows[0]['time'] <= b['time'] <= rows[-1]['time']]
        else:
            phase_blocks = [b for b in blocks if phase == 'all' or b.get('phase') == phase]
        result['phases'][phase] = {'nodes': per_node, 'blocks': summarise_blocks(phase_blocks)}
    (directory / 'metrics-summary.json').write_text(json.dumps(result, indent=2) + '\n')
    (directory / 'metrics-summary.md').write_text(markdown(result))
    return result


def fmt(value, scale=1.0, digits=1):
    if value is None:
        return '—'
    value *= scale
    return f'{value:.{digits}f}' if isinstance(value, float) and not value.is_integer() else f'{int(value)}'


def markdown(result):
    lines = ['## Node metrics', '']
    for phase, data in result['phases'].items():
        lines += [f'### {phase}', '', '| Node | Ready pool peak | Drain (s) | Dropped | Invalid | Finality timeout | '
                  'Proposal end reasons | Pool ready p95 (ms) | Finalised p95 (s) | PVF exec p95 (ms) | Approval lag peak | RSS peak (MiB) |',
                  '| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |']
        for node, m in sorted(data['nodes'].items()):
            ready = m.get('substrate_ready_transactions_number', {})
            reasons = m.get('substrate_proposer_end_proposal_reason', {})
            reason_text = ', '.join(f'{k.split("=", 1)[-1]} {int(v)}' for k, v in sorted(reasons.items()) if v) or '—'
            lines.append('| ' + ' | '.join([
                node, fmt(ready.get('max')), fmt(ready.get('drain_seconds')),
                fmt(m.get('substrate_sub_txpool_timing_event_dropped_count', {}).get('total')),
                fmt(m.get('substrate_sub_txpool_timing_event_invalid_count', {}).get('total')),
                fmt(m.get('substrate_sub_txpool_timing_event_finality_timeout_count', {}).get('total')),
                reason_text,
                fmt(m.get('substrate_sub_txpool_timing_event_ready', {}).get('p95'), 1000, 1),
                fmt(m.get('substrate_sub_txpool_timing_event_finalized', {}).get('p95'), 1, 1),
                fmt(m.get('polkadot_pvf_execution_time', {}).get('p95'), 1000, 1),
                fmt(m.get('polkadot_parachain_approval_checking_finality_lag', {}).get('max')),
                fmt(m.get('polkadot_memory_resident', {}).get('max'), 1 / 1048576, 0),
            ]) + ' |')
        blocks = data['blocks']
        if blocks:
            lines += ['', f'Finalised blocks {blocks["first"]}–{blocks["last"]} ({blocks["blocks"]} blocks, '
                      f'{blocks["weight_errors"]} weight reads failed):', '',
                      '| Per block | p50 | p95 | max |', '| --- | ---: | ---: | ---: |']
            for label, key, scale in (('Extrinsics', 'extrinsics', 1), ('Extrinsic bytes', 'bytes', 1),
                                      ('Normal ref time (ms)', 'normal_ref_time', 1e-9),
                                      ('Normal proof size (KiB)', 'normal_proof_size', 1 / 1024)):
                if key in blocks:
                    b = blocks[key]
                    lines.append(f'| {label} | {fmt(float(b["p50"]), scale, 1)} | {fmt(float(b["p95"]), scale, 1)} | {fmt(float(b["max"]), scale, 1)} |')
        lines.append('')
    if result['missing_metrics']:
        lines += ['Not exposed by any node: ' + ', '.join(f'`{m}`' for m in result['missing_metrics']), '']
    errors = {n: c for n, c in result['fetch_errors'].items() if c}
    if errors:
        lines += ['Metric fetch errors: ' + ', '.join(f'{n} {c}' for n, c in sorted(errors.items())), '']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['sample', 'summarise'])
    parser.add_argument('--directory', type=Path, default=Path('network-out'))
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--chain', default='1502', help='Parachain id whose finalised blocks are recorded')
    parser.add_argument('--max-blocks', type=int, default=50, help='Most blocks read per sample, to stay current')
    parser.add_argument('--phase', action='append', help='Summarise only these phases (repeatable)')
    parser.add_argument('--stage', action='append', help='Summarise the window of a burst stage from <stage>-summary.json (repeatable)')
    args = parser.parse_args()
    if args.command == 'sample':
        sample(args.directory, args.interval, args.chain, args.max_blocks)
    else:
        print(json.dumps(summarise(args.directory, args.phase, args.stage)['missing_metrics']))
        print((args.directory / 'metrics-summary.md').read_text())
