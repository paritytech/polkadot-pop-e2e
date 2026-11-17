#!/usr/bin/env bash
# Measures how many light clients a set of nodes takes at once. See packages/load-tests/README.md.
# Usage: run.sh <in-peers-light> <nodes: 1-6> <clients>
set -euo pipefail
in_peers_light=$1 nodes=$2 clients=$3
script_dir=$(cd "$(dirname "$0")" && pwd)
work_dir=$(mktemp -d)
names=(alice bob charlie dave eve ferdie)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$work_dir"' EXIT
polkadot build-spec --chain dev --raw > "$work_dir/spec.json"
boot=()
for index in $(seq 1 "$nodes"); do
  printf '%064x' "$index" > "$work_dir/key$index"
  peer=$(polkadot key inspect-node-key --file "$work_dir/key$index")
  boot+=("/ip4/127.0.0.1/tcp/$((30330 + index))/ws/p2p/$peer")
  polkadot --chain "$work_dir/spec.json" "--${names[$((index - 1))]}" --validator --insecure-validator-i-know-what-i-do \
    --base-path "$work_dir/db$index" --node-key-file "$work_dir/key$index" --listen-addr "/ip4/127.0.0.1/tcp/$((30330 + index))/ws" \
    --rpc-port $((9940 + index)) --prometheus-port $((9610 + index)) --in-peers-light "$in_peers_light" --no-mdns --no-telemetry \
    --reserved-nodes "${boot[0]}" > "$work_dir/node$index.log" 2>&1 &
done
sleep 25
echo "in-peers-light $in_peers_light, nodes $nodes, clients $clients"
node "$script_dir/clients.mjs" "$work_dir/spec.json" "$clients" "${boot[@]}" > "$work_dir/clients.out" 2>&1 &
clients_pid=$!
sleep $((clients / 20 + 60))
for index in $(seq 1 "$nodes"); do
  echo "  node$index while the clients are connected: $(grep -o 'Idle ([0-9]* peers)' "$work_dir/node$index.log" | tail -1)"
done
status=0
wait $clients_pid || status=$?
cat "$work_dir/clients.out"
exit "$status"
