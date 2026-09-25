"""Prepare one engine network and record block progress from local RPCs."""
import argparse
import json
from pathlib import Path
import time
import tomllib
import tomli_w
import urllib.request


def write(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2) + '\n')


def prepare(config_path, directory):
    config = tomllib.loads(Path(config_path).read_text())
    config.pop('custom_processes', None)  # Node readiness only; no product services.
    nodes = []
    groups = [('relay', config['relaychain']['nodes'])] + [
        (str(p['id']), p['collators']) for p in config['parachains']]
    for chain, group in groups:
        for node in group:
            nodes.append({'name': node['name'], 'chain': chain, 'rpc_port': node['rpc_port']})
    if len(config['relaychain']['nodes']) < 3:
        raise ValueError('At least three relay validators are required')
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'network.toml').write_text(tomli_w.dumps(config))
    write(directory / 'nodes.json', nodes)


def rpc(node, method, params=None):
    request = urllib.request.Request(f"http://127.0.0.1:{node['rpc_port']}",
        data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}).encode(),
        headers={'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=10) as response:
        result = json.load(response)
    if 'error' in result:
        raise RuntimeError(f"{node['name']} {method}: {result['error']}")
    return result['result']


def sample(nodes):
    result = {}
    for node in nodes:
        finalized = rpc(node, 'chain_getFinalizedHead')
        header = rpc(node, 'chain_getHeader', [finalized])
        best = rpc(node, 'chain_getHeader')
        result[node['name']] = {'finalized': int(header['number'], 16),
            'finalized_hash': finalized, 'best': int(best['number'], 16),
            'peers': len(rpc(node, 'system_peers'))}
    return result


def advanced(before, after):
    return all(after[name]['finalized'] > old['finalized'] for name, old in before.items())


def observe(directory, phase, seconds, timeout):
    nodes = json.loads((directory / 'nodes.json').read_text())
    start = time.monotonic()
    initial = sample(nodes)
    last = initial
    history = []
    result_path = directory / f'{phase}.json'
    while time.monotonic() - start < timeout:
        last = sample(nodes)
        with (directory / f'{phase}.jsonl').open('a') as output:
            output.write(json.dumps({'time': time.time(), 'nodes': last}) + '\n')
        elapsed = time.monotonic() - start
        history.append((elapsed, last))
        passed = elapsed >= seconds and (phase == 'delayed' or advanced(initial, last))
        write(result_path, {'phase': phase, 'passed': passed, 'elapsed_seconds': elapsed,
                           'initial': initial, 'last': last,
                           'finality_delta': {n: last[n]['finalized'] - initial[n]['finalized'] for n in initial},
                           'tail_finality_delta': {n: last[n]['finalized'] - next((v[n]['finalized'] for t, v in history if t >= max(0, elapsed - 60)), initial[n]['finalized']) for n in initial}})
        if passed:
            print(result_path.read_text(), flush=True)
            return
        time.sleep(5)
    raise TimeoutError(f'{phase}: not every node advanced finality; see {result_path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'observe'])
    parser.add_argument('--config', default='ppn/full-fork.toml')
    parser.add_argument('--directory', type=Path, default=Path('network-out'))
    parser.add_argument('--phase', choices=['baseline', 'delayed', 'recovery'], default='baseline')
    parser.add_argument('--seconds', type=int, default=60)
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.config, args.directory)
    else:
        observe(args.directory, args.phase, args.seconds, args.timeout)
