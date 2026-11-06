"""Sample node Prometheus metrics during a burst. Missing metrics stay visible."""
import argparse
import concurrent.futures
import json
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path('network-out'))
    args = parser.parse_args()
    nodes = endpoints((args.directory / 'spawn.log').read_text())
    (args.directory / 'metrics-endpoints.json').write_text(json.dumps(nodes, indent=2) + '\n')
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(nodes))) as pool:
        with (args.directory / 'node-metrics.jsonl').open('a', buffering=1) as out:
            while True:
                started = time.monotonic()
                data = dict(pool.map(fetch, nodes.items()))
                out.write(json.dumps({'time': time.time(), 'nodes': data,
                    'warning': None if nodes else 'No Prometheus endpoints found in spawn.log'}) + '\n')
                time.sleep(max(0, 5 - (time.monotonic() - started)))


if __name__ == '__main__':
    main()
