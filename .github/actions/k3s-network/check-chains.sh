#!/usr/bin/env bash
# Checks the relay and every parachain keep finalizing blocks.
#
# Usage: check-chains.sh <minutes> <pod>...
#   minutes  how long to watch once every chain has finalized a block;
#            0 only waits for that first block
#   pod      one node per chain to ask, e.g. alice asset-hub-collator
# Needs: NAMESPACE
#
# Fails if any chain never finalizes a block, or stops finalizing while we
# watch. Writes a "blocks finalized" table to the GitHub run summary.
set -euo pipefail

minutes=$1
shift
chains="$*"

# rpc POD METHOD PARAMS
# Calls a JSON-RPC method on a node. K3s pod IPs can be reached straight from
# the runner, so no port-forwarding is needed. Port 9944 is the node's RPC port.
rpc() {
  local ip
  ip=$(kubectl -n "$NAMESPACE" get pod "$1" -o jsonpath='{.status.podIP}') || return 0
  curl -s --max-time 5 -H 'Content-Type: application/json' \
    -d "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"$2\",\"params\":$3}" \
    "http://$ip:9944" || true
}

# finalized POD
# Prints the chain's latest finalized block number, or 0 if it has none yet or
# the node did not answer. Takes two calls: one for the finalized block's hash,
# one for that block's header, which holds its number (in hex, hence printf).
finalized() {
  local hash number
  hash=$(rpc "$1" chain_getFinalizedHead '[]' | jq -r '.result // empty') || true
  number=$(rpc "$1" chain_getHeader "[\"$hash\"]" | jq -r '.result.number // "0x0"') || true
  printf '%d' "${number:-0x0}"
}

# 1. Wait until every chain has finalized at least one block. Parachains start
#    later than the relay, typically 1-3 minutes. Give each up to 10 minutes.
for chain in $chains; do
  echo "waiting for $chain to finalize a block..."
  for _ in $(seq 60); do
    if [ "$(finalized "$chain")" -gt 0 ]; then
      break
    fi
    sleep 10
  done

  if [ "$(finalized "$chain")" -eq 0 ]; then
    echo "::error::$chain never finalized a block"
    exit 1
  fi
done

if [ "$minutes" -eq 0 ]; then
  echo "every chain is finalizing"
  exit 0
fi

# 2. Note where each chain is now, watch for a while, then compare.
declare -A start
for chain in $chains; do
  start[$chain]=$(finalized "$chain")
done

echo "every chain is finalizing; watching for $minutes minutes"
sleep $(( minutes * 60 ))

# 3. Report how many blocks each chain finalized while we watched. A chain
#    that finalized nothing has stalled, and fails the run.
{
  echo "| chain | blocks finalized in $minutes min |"
  echo "|---|---|"
} >> "$GITHUB_STEP_SUMMARY"

stalled=""
for chain in $chains; do
  gained=$(( $(finalized "$chain") - start[$chain] ))
  echo "| $chain | $gained |" | tee -a "$GITHUB_STEP_SUMMARY"
  if [ "$gained" -le 0 ]; then
    stalled="$stalled $chain"
  fi
done

if [ -n "$stalled" ]; then
  echo "::error::stopped finalizing:$stalled"
  exit 1
fi
