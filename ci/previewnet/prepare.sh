#!/usr/bin/env bash
# Fetch the snapshot and record the exact binary bytes used for this run.
set -euo pipefail
out=${1:?output directory}
mkdir -p "$out/bin" "$out/bundle"
python3 - "$out" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
out = Path(sys.argv[1])
manifest = json.loads(Path('environments/networks/previewnet.json').read_text())
provenance = {'engine_commit': '7907a3bfa7b2e47535a74b7920086a05ca94773a', 'assets': []}
def download(repo, tag, names):
    data = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/tags/{tag}']))
    assets = {a['name']: a for a in data['assets']}
    for name in names:
        asset = assets[name]
        target = out / ('fork-bundle-previewnet.tar.gz' if name.startswith('fork-bundle') else f'bin/{name}')
        for attempt in range(3):
            try:
                # Truncate partial bytes before retrying the same pinned asset.
                with target.open('wb') as dest:
                    subprocess.run(['gh', 'api', '-H', 'Accept: application/octet-stream',
                                    f"repos/{repo}/releases/assets/{asset['id']}"], stdout=dest, check=True, timeout=600)
                break
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                target.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                print(f'Retrying release download {name} ({attempt + 2}/3)', file=sys.stderr, flush=True)
                time.sleep(10 * (attempt + 1))
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if asset.get('digest') and asset['digest'] != 'sha256:' + digest:
            raise RuntimeError(f'Release digest mismatch: {name}')
        if name == 'fork-bundle-previewnet.tar.gz' and os.environ.get('PREVIEWNET_BUNDLE_SHA256'):
            if digest != os.environ['PREVIEWNET_BUNDLE_SHA256']:
                raise RuntimeError('PreviewNet snapshot changed; review the new snapshot before comparing capacity runs')
        provenance['assets'].append({'repo': repo, 'tag': tag, 'asset_id': asset['id'],
                                     'name': name, 'sha256': digest})
for binary, names in [('polkadot', ['polkadot', 'polkadot-execute-worker', 'polkadot-prepare-worker']),
                       ('polkadot-omni-node', ['polkadot-omni-node'])]:
    repo, tag = manifest['binaries'][binary].split('@')
    if tag == 'latest':
        raise RuntimeError('Node binaries must use a fixed release tag')
    download(repo, tag, names)
download('paritytech/zombienet-sdk', 'v0.4.15', ['zombie-cli-x86_64-unknown-linux-gnu'])
if os.environ.get('PREVIEWNET_BUNDLE_RUN_ID'):
    run_id = os.environ['PREVIEWNET_BUNDLE_RUN_ID']
    repo = 'paritytech/previewnet-engine'
    artifacts = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/actions/runs/{run_id}/artifacts']))
    artifact = next(a for a in artifacts['artifacts'] if a['name'] == 'fork-bundle-previewnet' and not a['expired'])
    subprocess.run(['gh', 'run', 'download', run_id, '--repo', repo, '--name', 'fork-bundle-previewnet',
                    '--dir', str(out)], check=True, timeout=600)
    digest = hashlib.sha256((out / 'fork-bundle-previewnet.tar.gz').read_bytes()).hexdigest()
    if digest != os.environ['PREVIEWNET_BUNDLE_SHA256']:
        raise RuntimeError('Pinned PreviewNet artifact digest mismatch')
    provenance['assets'].append({'repo': repo, 'run_id': run_id, 'artifact_id': artifact['id'],
                                'name': 'fork-bundle-previewnet.tar.gz', 'sha256': digest})
else:
    download('paritytech/previewnet-engine', 'bites', ['fork-bundle-previewnet.tar.gz'])
(out / 'bin/zombie-cli-x86_64-unknown-linux-gnu').rename(out / 'bin/zombie-cli')
(out / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
PY
tar -xzf "$out/fork-bundle-previewnet.tar.gz" -C "$out/bundle"
chmod +x "$out"/bin/*
# Artifacts preserve the archive bytes, including executable permissions.
tar -czf "$out/network-inputs.tar.gz" -C "$out" bin bundle provenance.json
sha256sum "$out/network-inputs.tar.gz" > "$out/network-inputs.sha256"
