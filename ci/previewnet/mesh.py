"""Run-scoped rendezvous and private-network checks for concurrent CI runners."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def fetch(url):
    # Do not route private runner traffic through an HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=5) as response:
        return json.load(response)


def namespace(count):
    return f"mesh-{os.environ.get('MESH_PHASE', 'probe')}-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}-{count}"


def wait_artifacts(prefix, count, dest, timeout=600):
    """Artifacts are available as soon as upload-artifact completes, during a run."""
    deadline = time.monotonic() + timeout
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    while time.monotonic() < deadline:
        result = subprocess.run([
            "gh", "api", "--paginate",
            f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}/artifacts",
            "--jq", ".artifacts[].name",
        ], text=True, capture_output=True, timeout=30, check=True)
        available = set(result.stdout.splitlines())
        missing = []
        for worker in range(count):
            name = f"{prefix}-{worker}"
            target = dest / str(worker)
            if (target / "descriptor.json").exists():
                continue
            if name not in available:
                missing.append(name)
                continue
            subprocess.run([
                "gh", "run", "download", os.environ['GITHUB_RUN_ID'],
                "--repo", os.environ['GITHUB_REPOSITORY'], "--name", name, "--dir", str(target),
            ], check=True, timeout=120)
        if not missing:
            return [read_json(dest / str(i) / "descriptor.json") for i in range(count)]
        print(f"Waiting for {len(missing)} runner artifacts", flush=True)
        time.sleep(10)
    raise TimeoutError(f"Timed out waiting for {prefix}; all {count} jobs must run concurrently")


def serve(worker, count, directory):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect(("1.1.1.1", 80))
        address = route.getsockname()[0]
    descriptor = {
        "worker": worker, "count": count, "namespace": namespace(count),
        "address": address, "port": 30334,
        "runner": os.environ.get("RUNNER_NAME"), "hostname": socket.gethostname(),
        "boot_id": Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != '/health':
                self.send_error(404)
                return
            body = json.dumps(descriptor).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = HTTPServer(('0.0.0.0', descriptor['port']), Handler)
    write_json(Path(directory) / 'descriptor.json', descriptor)
    server.serve_forever()


def check(worker, count, directory):
    peers = wait_artifacts(namespace(count), count, Path(directory) / 'peers')
    if len({p['address'] for p in peers}) != count:
        raise RuntimeError('Runners do not have distinct routable addresses')
    # This checks kernel/VM separation, not the underlying hypervisor placement.
    if len({p['boot_id'] for p in peers}) != count:
        raise RuntimeError('Runner jobs share a kernel; use separate runner machines')
    failures = []
    for peer in peers:
        print(f"Probing worker {peer['worker']} at {peer['address']}:{peer['port']}", flush=True)
        try:
            observed = fetch(f"http://{peer['address']}:{peer['port']}/health")
            if observed != peer:
                raise RuntimeError(f"Wrong runner reached: {peer['worker']}")
        except OSError as error:
            failures.append({'worker': peer['worker'], 'address': peer['address'], 'error': str(error)})
    write_json(Path(directory) / 'mesh-result.json', {
        'worker': worker, 'result': 'failed' if failures else 'connected', 'peers': peers, 'failures': failures,
    })
    if failures:
        raise RuntimeError(f'Private connectivity failed: {failures}')
    print(f'Worker {worker}: all {count} distinct runners are reachable', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['serve', 'check'])
    parser.add_argument('--worker', required=True, type=int)
    parser.add_argument('--count', required=True, type=int, choices=[2, 3])
    parser.add_argument('--directory', default='mesh-out')
    args = parser.parse_args()
    if not 0 <= args.worker < args.count:
        parser.error('worker must belong to this topology')
    globals()[args.command](args.worker, args.count, args.directory)
