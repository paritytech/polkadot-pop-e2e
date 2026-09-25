"""Apply Linux netem to this network's loopback TCP peer ports, not RPC ports."""
import argparse
import json
from pathlib import Path
import re
import subprocess

HANDLE = '7a00:'
CHILD = '7a30:'


def tc(*args, check=True):
    return subprocess.run(['sudo', '-n', 'tc', *args], text=True, capture_output=True, check=check)


def peer_ports(argv):
    ports = set()
    for i, arg in enumerate(argv):
        flag, _, value = arg.partition('=')
        if flag not in ('--listen-addr', '--port'):
            continue
        value = value or argv[i + 1]
        if flag == '--port':
            ports.add(int(value))
        else:
            match = re.search(r'/tcp/(\d+)', value)
            if match:
                ports.add(int(match[1]))
    return ports


def discover(directory):
    ports = set()
    processes = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            argv = (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
        except (OSError, UnicodeError):
            continue
        if not argv or Path(argv[0]).name not in ('polkadot', 'polkadot-omni-node'):
            continue
        # Scope to node processes launched into this run's data directory.
        if not any(str(directory / 'data') in arg for arg in argv):
            continue
        found = peer_ports(argv)
        ports.update(found)
        processes.append({'pid': int(proc.name), 'binary': Path(argv[0]).name, 'ports': sorted(found)})
    if len(processes) < 3 or not ports:
        raise RuntimeError('Could not discover peer listeners for at least three network nodes')
    rpc_ports = {n['rpc_port'] for n in json.loads((directory / 'nodes.json').read_text())}
    if ports & rpc_ports:
        raise RuntimeError('Peer ports overlap with RPC ports')
    return sorted(ports), processes


def filters(ports):
    # A connection uses one listener port and one ephemeral port. Match both directions.
    for port in ports:
        for field in ('sport', 'dport'):
            yield ['filter', 'add', 'dev', 'lo', 'protocol', 'ip', 'parent', HANDLE,
                   'prio', '1', 'u32', 'match', 'ip', 'protocol', '6', '0xff',
                   'match', 'ip', field, str(port), '0xffff', 'flowid', '7a00:3']


def root_qdiscs():
    return json.loads(tc('-j', 'qdisc', 'show', 'dev', 'lo').stdout)


def remove():
    roots = root_qdiscs()
    if any(q.get('handle') == HANDLE and q.get('root') for q in roots):
        tc('qdisc', 'del', 'dev', 'lo', 'root', 'handle', HANDLE)


def apply(directory, delay_ms):
    if not 1 <= delay_ms <= 1_000_000:
        raise ValueError('Delay must be 1–1,000,000 ms per direction')
    if any(q.get('root') and q.get('kind') != 'noqueue' for q in root_qdiscs()):
        raise RuntimeError('Loopback already has a qdisc; refusing to replace another configuration')
    ports, processes = discover(directory)
    tc('qdisc', 'add', 'dev', 'lo', 'root', 'handle', HANDLE, 'prio', 'bands', '3',
       'priomap', *(['0'] * 16))
    try:
        tc('qdisc', 'add', 'dev', 'lo', 'parent', '7a00:3', 'handle', CHILD,
           'netem', 'limit', '100000', 'delay', f'{delay_ms}ms')
        for args in filters(ports):
            tc(*args)
    except Exception:
        remove()
        raise
    (directory / 'delay-config.json').write_text(json.dumps({
        'delay_ms_per_direction': delay_ms, 'ports': ports, 'processes': processes,
        'scope': 'IPv4 loopback TCP peer traffic; RPC is excluded',
    }, indent=2) + '\n')


def capture(directory, require_packets=False):
    directory.mkdir(parents=True, exist_ok=True)
    stats = root_qdiscs()
    (directory / 'qdisc.json').write_text(json.dumps(stats, indent=2) + '\n')
    result = tc('-s', 'qdisc', 'show', 'dev', 'lo')
    (directory / 'qdisc.txt').write_text(result.stdout)
    (directory / 'filters.txt').write_text(tc('-s', 'filter', 'show', 'dev', 'lo', 'parent', HANDLE).stdout)
    if require_packets:
        # JSON counter layout varies with iproute2; the textual packet counter is stable.
        child = result.stdout.split(f'qdisc netem {CHILD}', 1)
        matched = re.search(r'Sent\s+\d+\s+bytes\s+(\d+)\s+pkt', child[1]) if len(child) == 2 else None
        queued = re.search(r'backlog\s+\S+\s+(\d+)p', child[1]) if len(child) == 2 else None
        if not ((matched and int(matched[1]) > 0) or (queued and int(queued[1]) > 0)):
            raise RuntimeError('No packets transmitted or queued in netem; the delayed phase is not verified')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['apply', 'capture', 'remove'])
    parser.add_argument('--directory', type=Path, default=Path('network-out'))
    parser.add_argument('--delay-ms', type=int, default=50)
    parser.add_argument('--require-packets', action='store_true')
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.command == 'apply':
        apply(directory, args.delay_ms)
    elif args.command == 'capture':
        capture(directory, args.require_packets)
    else:
        remove()
