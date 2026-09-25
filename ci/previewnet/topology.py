"""Partition the engine's fork TOML; each authority runs on exactly one machine."""
import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import tomllib
import tomli_w


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def partition(config, bundle, worker, count, address):
    address = str(ipaddress.IPv4Address(address))
    if not ipaddress.ip_address(address).is_private or address.startswith('127.'):
        raise ValueError('Use a private, non-loopback runner address')
    if count not in (2, 3) or worker not in range(count):
        raise ValueError('Expected two or three workers')
    relay = config['relaychain']
    names = [node['name'] for node in relay['nodes']]
    if names != ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie']:
        raise ValueError(f'Unexpected fork authority set: {names}')
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if manifest.get('network', 'previewnet') != 'previewnet':
        raise ValueError('This workflow only supports the Previewnet fork')

    specs = [relay] + config['parachains']
    for spec in specs:
        raw = json.loads(Path(spec['chain_spec_path']).read_text())
        if not raw.get('genesis', {}).get('raw', {}).get('top'):
            raise ValueError('All workers must use the same raw spec; plain specs may rewrite authorities')
        if raw.get('bootNodes'):
            raise ValueError('Fork specs must not connect to production bootnodes')

    common = ['--network-backend=libp2p', '--discover-local', '--allow-private-ip',
              '--no-mdns', '--no-hardware-benchmarks']
    def args_for(existing, port):
        # RPC stays local. Cross-machine transport is P2P, not unsafe RPC.
        args = [a for a in existing if not a.startswith((
            '--unsafe-rpc-external', '--rpc-external', '--public-addr', '--listen-addr',
        ))]
        for arg in common:
            if arg not in args:
                args.append(arg)
        args.append(f'--public-addr=/ip4/{address}/tcp/{port}/ws')
        return args

    nodes = []
    selected = []
    for i, node in enumerate(relay['nodes']):
        if i % count != worker:
            continue
        node['p2p_port'] = 30334 + i
        node['prometheus_port'] = 9615 + i
        node['args'] = args_for(relay['default_args'], node['p2p_port'])
        selected.append(node)
        nodes.append({'name': node['name'], 'chain': 'relay', 'rpc_port': node['rpc_port'],
                      'p2p_port': node['p2p_port'], 'metrics_port': node['prometheus_port'],
                      'bite_block': manifest['biteBlocks']['relay']})
    relay['nodes'] = selected
    relay['default_args'] = []
    local_relay_rpc = selected[0]['rpc_port']
    paras = []
    for i, para in enumerate(config['parachains']):
        # People is deliberately on the last runner. The remaining collators are spread.
        assigned = count - 1 if para['id'] == 1502 else i % count
        if assigned != worker:
            continue
        for collator in para['collators']:
            # Keep collator listeners disjoint from the six fixed relay ports.
            collator['p2p_port'] = 30400 + i
            args = [a for a in collator['args'] if not a.startswith('--relay-chain-rpc-urls')]
            collator['args'] = args_for(args, collator['p2p_port']) + [
                f'--relay-chain-rpc-urls=ws://127.0.0.1:{local_relay_rpc}',
            ]
            collator['prometheus_port'] = 9700 + i
            nodes.append({'name': collator['name'], 'chain': str(para['id']),
                          'rpc_port': collator['rpc_port'], 'p2p_port': collator['p2p_port'],
                          'metrics_port': collator['prometheus_port'],
                          'bite_block': manifest['biteBlocks'][str(para['id'])]})
        paras.append(para)
    config['parachains'] = paras
    config.pop('custom_processes', None)  # No dashboards, product imports or unrelated services.
    config['settings']['timeout'] = 1200
    return config, {'worker': worker, 'count': count, 'address': address, 'nodes': nodes,
                    'spec_hashes': {str(s.get('id', 'relay')): sha256(s['chain_spec_path']) for s in specs},
                    'bitten_at': manifest['bittenAt']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--worker', required=True, type=int)
    parser.add_argument('--count', required=True, type=int)
    parser.add_argument('--descriptor', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    config, topology = partition(tomllib.loads(args.config.read_text()), args.bundle,
                                args.worker, args.count, json.loads(args.descriptor.read_text())['address'])
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'network.toml').write_text(tomli_w.dumps(config))
    (args.out / 'topology.json').write_text(json.dumps(topology, indent=2) + '\n')
