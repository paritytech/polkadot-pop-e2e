"""Sample node Prometheus metrics during a burst. Missing metrics stay visible."""
import argparse
import concurrent.futures
import json
import os
import platform
import subprocess
from pathlib import Path
import re
import time
import urllib.request

ANSI = re.compile(r'\x1b\[[0-9;]*m')
ENDPOINT = re.compile(r'📊 ([^:]+): metrics link (http://127\.0\.0\.1:\d+/metrics)')
INTERESTING = re.compile(r'pool|transaction|block|finali|author|validat|pvf|process|memory|cpu|proof', re.I)


def endpoints(text):
    return dict(ENDPOINT.findall(ANSI.sub('', text)))


def fetch(item):
    name, url = item
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=3) as response:
            lines = response.read().decode().splitlines()
        selected = [line for line in lines if INTERESTING.search(line)]
        return name, {'metrics': selected, 'url': url}
    except Exception as error:
        return name, {'error': str(error), 'url': url}


def read_file(path):
    try:
        return Path(path).read_text()
    except OSError as error:
        return {'unavailable': str(error)}


def cgroup_directories():
    root = Path('/sys/fs/cgroup')
    membership = read_file('/proc/self/cgroup')
    if not isinstance(membership, str):
        return [root]
    unified = next((line.split(':', 2)[2] for line in membership.splitlines()
                    if line.startswith('0::')), '/')
    current = root / unified.lstrip('/')
    # Limits can be imposed by the service or any ancestor, not just the mount root.
    return [current, *[parent for parent in current.parents if parent == root or root in parent.parents]]


def host_sample():
    # Raw cumulative counters allow CPU, throttling, OOM and I/O deltas to be checked later.
    paths = ['/proc/stat', '/proc/meminfo', '/proc/loadavg', '/proc/diskstats',
             '/proc/pressure/cpu', '/proc/pressure/memory', '/proc/pressure/io',
             '/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/memory.current',
             '/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/io.stat']
    paths += [str(group / name) for group in cgroup_directories() for name in
              ('cpu.stat', 'memory.current', 'memory.peak', 'memory.events', 'io.stat')]
    return {path: read_file(path) for path in paths}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path('network-out'))
    args = parser.parse_args()
    limits = ['/proc/self/cgroup', '/proc/self/mountinfo', '/sys/fs/cgroup/cpu.max',
              '/sys/fs/cgroup/cpuset.cpus.effective', '/sys/fs/cgroup/memory.max',
              '/sys/fs/cgroup/memory.swap.max']
    limits += [str(group / name) for group in cgroup_directories() for name in
               ('cpu.max', 'cpuset.cpus.effective', 'memory.max', 'memory.swap.max')]
    hardware = {'platform': platform.platform(), 'cpuCount': os.cpu_count(),
                'affinity': sorted(os.sched_getaffinity(0)),
                'limits': {path: read_file(path) for path in limits}, 'initial': host_sample()}
    for command in (['lscpu'], ['df', '-h']):
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        hardware[command[0]] = {'stdout': result.stdout, 'stderr': result.stderr, 'exit': result.returncode}
    (args.directory / 'runner-hardware.json').write_text(json.dumps(hardware, indent=2) + '\n')
    nodes = endpoints((args.directory / 'spawn.log').read_text())
    (args.directory / 'metrics-endpoints.json').write_text(json.dumps(nodes, indent=2) + '\n')
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(nodes))) as pool:
        with (args.directory / 'node-metrics.jsonl').open('a', buffering=1) as out:
            while True:
                started = time.monotonic()
                data = dict(pool.map(fetch, nodes.items()))
                out.write(json.dumps({'time': time.time(), 'nodes': data, 'host': host_sample(),
                    'warning': None if nodes else 'No Prometheus endpoints found in spawn.log'}) + '\n')
                time.sleep(max(0, 5 - (time.monotonic() - started)))


if __name__ == '__main__':
    main()
