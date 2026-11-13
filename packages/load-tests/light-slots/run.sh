#!/usr/bin/env bash
# Measures how many light clients a set of nodes takes at once.
# Usage: run.sh <in-peers-light> <nodes: 1-6> <clients>
# Starts a local dev chain of that many `polkadot` nodes (from PATH), each with that
# --in-peers-light and listed as a bootnode, connects that many light clients, and prints how many
# got a peer and each node's peer count while they were connected.
set -euo pipefail
light=$1 nodes=$2 clients=$3
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
names=(alice bob charlie dave eve ferdie)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$work"' EXIT
polkadot build-spec --chain dev --raw > "$work/spec.json" 2>/dev/null
boot=()
for n in $(seq 1 "$nodes"); do
  printf '%064x' "$n" > "$work/key$n"
  peer=$(polkadot key inspect-node-key --file "$work/key$n")
  boot+=("/ip4/127.0.0.1/tcp/$((30330 + n))/ws/p2p/$peer")
  polkadot --chain "$work/spec.json" "--${names[$((n - 1))]}" --validator --insecure-validator-i-know-what-i-do \
    --base-path "$work/db$n" --node-key-file "$work/key$n" --listen-addr "/ip4/127.0.0.1/tcp/$((30330 + n))/ws" \
    --rpc-port $((9940 + n)) --prometheus-port $((9610 + n)) --in-peers-light "$light" --no-mdns --no-telemetry \
    --reserved-nodes "${boot[0]}" > "$work/node$n.log" 2>&1 &
done
sleep 25
echo "in-peers-light $light, nodes $nodes, clients $clients"
node "$here/clients.mjs" "$work/spec.json" "$clients" "${boot[@]}" > "$work/clients.out" 2>&1 &
clients_pid=$!
sleep $((clients / 20 + 60))
for n in $(seq 1 "$nodes"); do
  echo "  node$n while the clients are connected: $(grep -o 'Idle ([0-9]* peers)' "$work/node$n.log" | tail -1)"
done
wait $clients_pid
cat "$work/clients.out"
