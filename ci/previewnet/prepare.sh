#!/usr/bin/env bash
# Fetch the snapshot and record the exact binary bytes used for this run.
set -euo pipefail
out=${1:?output directory}
mkdir -p "$out/bin" "$out/bundle"
python3 - "$out" <<'PY'
import hashlib
import json
from pathlib import Path
import subprocess
import sys
out = Path(sys.argv[1])
manifest = json.loads(Path('environments/networks/previewnet.json').read_text())
provenance = {'engine_commit': '7907a3bfa7b2e47535a74b7920086a05ca94773a', 'assets': []}
def download(repo, tag, names):
    data = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/tags/{tag}']))
    assets = {a['name']: a for a in data['assets']}
    for name in names:
        asset = assets[name]
        target = out / ('fork-bundle-previewnet.tar.gz' if name.startswith('fork-bundle') else f'bin/{name}')
        with target.open('wb') as dest:
            subprocess.run(['gh', 'api', '-H', 'Accept: application/octet-stream',
                            f"repos/{repo}/releases/assets/{asset['id']}"], stdout=dest, check=True, timeout=600)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if asset.get('digest') and asset['digest'] != 'sha256:' + digest:
            raise RuntimeError(f'Release digest mismatch: {name}')
        provenance['assets'].append({'repo': repo, 'tag': tag, 'asset_id': asset['id'],
                                     'name': name, 'sha256': digest})
for binary, names in [('polkadot', ['polkadot', 'polkadot-execute-worker', 'polkadot-prepare-worker']),
                       ('polkadot-omni-node', ['polkadot-omni-node'])]:
    repo, tag = manifest['binaries'][binary].split('@')
    if tag == 'latest':
        raise RuntimeError('Node binaries must use a fixed release tag')
    download(repo, tag, names)
download('paritytech/zombienet-sdk', 'v0.4.15', ['zombie-cli-x86_64-unknown-linux-gnu'])
download('paritytech/previewnet-engine', 'bites', ['fork-bundle-previewnet.tar.gz'])
(out / 'bin/zombie-cli-x86_64-unknown-linux-gnu').rename(out / 'bin/zombie-cli')
(out / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
PY
tar -xzf "$out/fork-bundle-previewnet.tar.gz" -C "$out/bundle"
chmod +x "$out"/bin/*
# Artifacts preserve the archive bytes, including executable permissions.
tar -czf "$out/network-inputs.tar.gz" -C "$out" bin bundle provenance.json
sha256sum "$out/network-inputs.tar.gz" > "$out/network-inputs.sha256"
