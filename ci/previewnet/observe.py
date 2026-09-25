"""Connect partitioned relay nodes and require continuing, agreed finality."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.request
from mesh import read_json, write_json, wait_artifacts, namespace


def rpc(node, method, params=None):
    request = urllib.request.Request(
        f"http://127.0.0.1:{node['rpc_port']}",
        data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=10) as response:
        result = json.load(response)
    if 'error' in result:
        raise RuntimeError(f"{node['name']} {method}: {result['error']}")
    return result['result']


def alive(directory):
    pid = int((directory / 'spawn.pid').read_text())
    os.kill(pid, 0)


def announce(directory):
    topology = read_json(directory / 'topology.json')
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        alive(directory)
        try:
            for node in topology['nodes']:
                node['peer_id'] = rpc(node, 'system_localPeerId')
                node['genesis'] = rpc(node, 'chain_getBlockHash', [0])
            write_json(directory / 'ready' / 'descriptor.json', topology)
            return
        except (OSError, RuntimeError) as error:
            print(f'Waiting for local RPCs: {error}', flush=True)
            time.sleep(5)
    raise TimeoutError('Local nodes never answered RPC')


def sample(node):
    finalized = rpc(node, 'chain_getFinalizedHead')
    header = rpc(node, 'chain_getHeader', [finalized])
    best = rpc(node, 'chain_getHeader')
    return {'finalized': int(header['number'], 16), 'finalized_hash': finalized,
            'best': int(best['number'], 16), 'peers': rpc(node, 'system_peers')}


def progress(mine, last, baseline, relays):
    progressed = all(last[n['name']]['finalized'] >= max(baseline[n['name']], n['bite_block']) + 3
                     for n in mine['nodes'])
    connected = all(
        all(any(peer['peerId'] in {remote['peer_id'] for w, _, remote in relays if w == worker}
                for peer in last[n['name']]['peers'])
            for worker in range(mine['count']) if worker != mine['worker'])
        for n in mine['nodes'] if n['chain'] == 'relay'
    )
    return progressed, connected


def watch(directory, seconds):
    mine = read_json(directory / 'ready' / 'descriptor.json')
    peers = wait_artifacts('nodes-' + namespace(mine['count']), mine['count'], directory / 'peers', timeout=1200)
    if any(p['spec_hashes'] != mine['spec_hashes'] for p in peers):
        raise RuntimeError('Workers have different raw chain specs')
    relays = [(p['worker'], p['address'], n) for p in peers for n in p['nodes'] if n['chain'] == 'relay']
    if len({n['name'] for _, _, n in relays}) != 6 or len(relays) != 6:
        raise RuntimeError('An authority is missing or duplicated')
    if len({n['genesis'] for _, _, n in relays}) != 1:
        raise RuntimeError('Relay genesis differs across runners')
    for local in mine['nodes']:
        if local['chain'] != 'relay':
            continue
        for _, address, remote in relays:
            if remote['peer_id'] != local['peer_id']:
                rpc(local, 'system_addReservedPeer', [f"/ip4/{address}/tcp/{remote['p2p_port']}/ws/p2p/{remote['peer_id']}"])

    start = time.monotonic()
    baseline = {n['name']: sample(n)['finalized'] for n in mine['nodes']}
    last = {}
    while time.monotonic() - start < seconds:
        alive(directory)
        last = {n['name']: sample(n) for n in mine['nodes']}
        with (directory / 'samples.jsonl').open('a') as output:
            output.write(json.dumps({'time': time.time(), 'nodes': last}) + '\n')
        # Save local Prometheus data for diagnosis; absence is visible, not silently ignored.
        for node in mine['nodes']:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{node['metrics_port']}/metrics", timeout=5) as response:
                    (directory / f"{node['name']}.prom").write_bytes(response.read())
            except OSError as error:
                print(f"Metrics unavailable for {node['name']}: {error}", flush=True)
        progressed, connected = progress(mine, last, baseline, relays)
        if progressed and connected and time.monotonic() - start >= 30:
            checkpoints = {n['name']: rpc(n, 'chain_getBlockHash', [n['bite_block'] + 2]) for n in mine['nodes']}
            if any(value is None for value in checkpoints.values()):
                raise RuntimeError('Missing finalised checkpoint hash')
            write_json(directory / 'result' / 'descriptor.json', {
                **mine, 'result': 'passed', 'baseline': baseline, 'last': last,
                'checkpoints': checkpoints, 'elapsed_seconds': time.monotonic() - start,
            })
            return
        print('Waiting for cross-runner peers and three new finalised blocks: ' +
              json.dumps({k: v['finalized'] for k, v in last.items()}), flush=True)
        time.sleep(5)
    raise TimeoutError('Network did not demonstrate cross-runner peers and finality progress')


def agree(directory):
    mine = read_json(directory / 'topology.json')
    reports = wait_artifacts('chain-result-' + namespace(mine['count']), mine['count'], directory / 'reports', timeout=1200)
    hashes = set()
    para_ids = []
    for report in reports:
        if report.get('result') != 'passed':
            raise RuntimeError('A worker did not pass')
        for node in report['nodes']:
            if node['chain'] == 'relay':
                hashes.add(report['checkpoints'][node['name']])
            else:
                para_ids.append(node['chain'])
    if len(hashes) != 1:
        raise RuntimeError('Relay validators disagree on the finalised checkpoint')
    if sorted(para_ids) != ['1500', '1501', '1502', '1600']:
        raise RuntimeError(f'Missing or duplicated Previewnet collators: {para_ids}')
    write_json(directory / 'network-result.json', {'result': 'passed', 'workers': reports})
    print('All workers agree on the finalised relay checkpoint; all four parachains advanced.')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
            output.write(f"### {mine['count']}-runner Previewnet\n\nPassed: cross-runner peers, six relay validators and all four parachains finalising.\n")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['announce', 'watch', 'agree'])
    parser.add_argument('--directory', type=Path, default=Path('network-out'))
    parser.add_argument('--seconds', type=int, default=600)
    args = parser.parse_args()
    if args.command == 'watch':
        watch(args.directory, args.seconds)
    else:
        globals()[args.command](args.directory)
