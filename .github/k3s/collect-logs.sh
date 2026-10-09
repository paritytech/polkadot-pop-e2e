#!/usr/bin/env bash
# Gathers everything useful for debugging into ./logs, which the workflow
# uploads as an artifact. Runs even when an earlier step failed, so nothing in
# here is allowed to fail the job.
#
# Usage: collect-logs.sh
# Needs: NAMESPACE (set in the workflow)

mkdir -p logs

# What start-network.sh left behind: the config used and zombie-cli's output.
cp spawn.log network.toml logs/ 2>/dev/null

# Which pods existed and where they ended up.
kubectl -n "$NAMESPACE" get pods -o wide > logs/pods.txt 2>&1

# One log file per pod: every node, plus zombienet's own helper pods.
for pod in $(kubectl -n "$NAMESPACE" get pods -o name 2>/dev/null); do
  kubectl -n "$NAMESPACE" logs "$pod" > "logs/${pod#pod/}.log" 2>&1
done

exit 0
