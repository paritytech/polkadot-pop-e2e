#!/usr/bin/env bash
# What CI runs on stress/: lint, tests, and the guard that no crate turns ark-vrf's `parallel`
# feature back on. With it, ark-ec builds a rayon pool inside every multi-scalar multiplication
# and a long proving run crashes with EAGAIN (STRESS-RUST.md, "Risks and open points" 1).
set -euo pipefail
cd "$(dirname "$0")"

cargo clippy --all-targets -- -D warnings
cargo test --release

if cargo tree -e features -i ark-vrf | grep -q 'ark-vrf feature "parallel"'; then
  echo "ark-vrf/parallel is on: some crate enables verifiable's std feature" >&2
  exit 1
fi
echo "ci: clippy, tests and the ark-vrf feature guard pass"
