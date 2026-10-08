#!/usr/bin/env bash
# Starts the relay + collator network on K3s, one pod per node, and waits until
# every node is running.
#
# Usage: start-network.sh
# Needs:  NAMESPACE, POLKADOT_IMAGE, CUMULUS_IMAGE (set in the workflow)
# Writes: network.toml (the config actually used) and spawn.log, in the
#         current directory, so the workflow can upload them.
set -euo pipefail

here=$(dirname "$0")

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

# 2. Fill the image names into the network config.
sed -e "s|{{POLKADOT_IMAGE}}|$POLKADOT_IMAGE|" \
    -e "s|{{CUMULUS_IMAGE}}|$CUMULUS_IMAGE|" \
    "$here/network.toml" > network.toml

# 3. Start the network. zombie-cli keeps running for as long as the network
#    lives, so it goes in the background with its output in spawn.log.
#
#    The two env vars together tell zombienet "use the namespace that already
#    exists" instead of creating its own.
RUN_IN_CI=1 ZOMBIE_K8S_CI_NAMESPACE="$NAMESPACE" \
  nohup zombie-cli spawn -p k8s network.toml > spawn.log 2>&1 &

# 4. zombie-cli prints "network is up" once every node is running. Most of the
#    wait (about 7 minutes) is downloading images onto a fresh runner. Give up
#    after 15 minutes and show the end of the log.
if ! timeout 900 bash -c 'until grep -q "network is up" spawn.log; do sleep 10; done'; then
  echo "::error::the network did not come up within 15 minutes"
  tail -40 spawn.log
  exit 1
fi

kubectl -n "$NAMESPACE" get pods
