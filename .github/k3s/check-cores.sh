#!/usr/bin/env bash
# Checks every chain node really got CPU cores of its own.
#
# Usage: check-cores.sh
# Needs: NAMESPACE (set in the workflow), and the network already running
#
# K3s does not complain when it cannot give a pod its own cores: it quietly
# puts the pod on the shared CPUs, and the network still runs. This script
# catches that. For each node in network.toml it checks:
#   - the node has cores of its own,
#   - it has as many as network.toml asked for,
#   - no other node, and nothing else on the machine, uses those cores.
# Writes a node -> cores table to the GitHub run summary. Fails if any check
# fails.
set -euo pipefail

here=$(dirname "$0")

# K3s writes down which cores it gave to which pod in this file. It is only
# readable by root, hence sudo. Shape:
#   { "policyName": "static",
#     "defaultCpuSet": "0-1,13-17",                    <- the shared CPUs
#     "entries": { "<pod id>": { "<container>": "2-3,18-19" } } }
state=$(sudo cat /var/lib/kubelet/cpu_manager_state)

# expand "2-3,18-19" -> "2 3 18 19"
expand() {
  local part
  for part in ${1//,/ }; do
    seq -s ' ' "${part%-*}" "${part#*-}"
  done | tr '\n' ' '
}

# The node names, read from network.toml so the two never disagree.
nodes=$(sed -n 's/^name = "\(.*\)"$/\1/p' "$here/network.toml")

shared=" $(expand "$(jq -r .defaultCpuSet <<<"$state")") "
declare -A owner   # core -> the node that has it
errors=()

{
  echo "| node | cores asked | cores given |"
  echo "|---|---|---|"
} >> "$GITHUB_STEP_SUMMARY"

for node in $nodes; do
  # Each node runs in a pod named after it, in a container of the same name.
  uid=$(kubectl -n "$NAMESPACE" get pod "$node" -o jsonpath='{.metadata.uid}')
  asked=$(kubectl -n "$NAMESPACE" get pod "$node" \
    -o jsonpath="{.spec.containers[?(@.name==\"$node\")].resources.limits.cpu}")
  given=$(jq -r --arg uid "$uid" --arg c "$node" '.entries[$uid][$c] // ""' <<<"$state")
  cores=$(expand "$given")

  echo "| $node | $asked | ${given:-none} |" | tee -a "$GITHUB_STEP_SUMMARY"

  if [ -z "$given" ]; then
    errors+=("$node has no cores of its own")
    continue
  fi

  if [ "$(wc -w <<<"$cores")" != "$asked" ]; then
    errors+=("$node asked for $asked cores but got $(wc -w <<<"$cores")")
  fi

  for core in $cores; do
    if [ -n "${owner[$core]:-}" ]; then
      errors+=("core $core is given to both ${owner[$core]} and $node")
    fi
    if [[ $shared == *" $core "* ]]; then
      errors+=("core $core of $node is also in the shared pool")
    fi
    owner[$core]=$node
  done
done

if [ "$(jq -r .policyName <<<"$state")" != static ]; then
  errors+=("K3s is not handing out dedicated cores (policy is not static)")
fi

for e in "${errors[@]}"; do
  echo "::error::$e"
done
[ ${#errors[@]} -eq 0 ]
