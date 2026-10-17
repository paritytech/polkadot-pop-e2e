#!/usr/bin/env bash
# Starts a zombienet network on K3s, one pod per node, and waits until every
# node is running.
#
# Usage:  start-network.sh <network.toml> [timeout-minutes]   (default 15)
# Needs:  NAMESPACE, and every env var the TOML names as {{NAME}}
# Writes: network.toml (the config actually used) and spawn.log, in
#         $RUNNER_TEMP/k3s-network, for check-cores.sh and collect-logs.sh.
set -euo pipefail

here=$(dirname "$0")
network=$1
timeout_minutes=${2:-15}
work=${RUNNER_TEMP:-/tmp}/k3s-network
mkdir -p "$work"

# 1. Make the namespace (Kubernetes' folder for our pods) ourselves, instead of
#    letting zombienet make one, so limitrange.yaml is in place before the first
#    pod starts. See that file for why the nodes need it.
kubectl create namespace "$NAMESPACE"
kubectl -n "$NAMESPACE" apply -f "$here/limitrange.yaml"

# Kubernetes adds a `default` account to a new namespace a moment later. A pod
# created before it exists is refused, and zombienet does not retry, so wait.
until kubectl -n "$NAMESPACE" get serviceaccount default >/dev/null 2>&1; do
  sleep 1
done

# 2. Replace each {{NAME}} in the TOML with the env var NAME, e.g.
#    {{POLKADOT_IMAGE}}. zombienet's own {{ZOMBIE:...}} tokens contain a colon,
#    so they do not match and are left for zombienet.
cp "$network" "$work/network.toml"
for name in $(grep -o '{{[A-Za-z_][A-Za-z0-9_]*}}' "$network" | tr -d '{}' | sort -u); do
  if [ -z "${!name:-}" ]; then
    echo "::error::$network uses {{$name}} but the env var $name is not set"
    exit 1
  fi
  sed -i "s|{{$name}}|${!name}|g" "$work/network.toml"
done

# 3. Start the network. zombie-cli keeps running for as long as the network
#    lives, so it goes in the background with its output in spawn.log.
#
#    The two env vars together tell zombienet "use the namespace that already
#    exists" instead of creating its own.
cd "$work"
RUN_IN_CI=1 ZOMBIE_K8S_CI_NAMESPACE="$NAMESPACE" \
  nohup zombie-cli spawn -p k8s network.toml > spawn.log 2>&1 &

# 4. zombie-cli prints "network is up" once every node is running. Most of the
#    wait is downloading images onto a fresh runner (about 7 minutes for the
#    public polkadot images). Give up after the timeout and show the end of
#    the log.
if ! timeout $(( timeout_minutes * 60 )) bash -c 'until grep -q "network is up" spawn.log; do sleep 10; done'; then
  echo "::error::the network did not come up within $timeout_minutes minutes"
  tail -40 spawn.log
  exit 1
fi

kubectl -n "$NAMESPACE" get pods
