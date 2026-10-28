#!/usr/bin/env bash
# Gathers everything useful for debugging into one directory, for the workflow
# to upload as an artifact. Runs even when an earlier step failed, so nothing in
# here is allowed to fail the job.
#
# Usage: collect-logs.sh [dir]   (default ./logs)
# Needs: NAMESPACE

dir=${1:-logs}
work=${RUNNER_TEMP:-/tmp}/k3s-network
mkdir -p "$dir"

# What start-network.sh left behind: the config used and zombie-cli's output.
cp "$work/spawn.log" "$work/network.toml" "$dir/" 2>/dev/null

# Which pods existed and where they ended up.
kubectl -n "$NAMESPACE" get pods -o wide > "$dir/pods.txt" 2>&1

# Which cores K3s gave to which pod. Only reading the file needs root; the
# copy should belong to the runner user like the other logs.
# shellcheck disable=SC2024
sudo cat /var/lib/kubelet/cpu_manager_state > "$dir/cpu_manager_state.json" 2>&1

# One log file per pod: every node, plus zombienet's own helper pods.
for pod in $(kubectl -n "$NAMESPACE" get pods -o name 2>/dev/null); do
  kubectl -n "$NAMESPACE" logs "$pod" > "$dir/${pod#pod/}.log" 2>&1
done

exit 0
