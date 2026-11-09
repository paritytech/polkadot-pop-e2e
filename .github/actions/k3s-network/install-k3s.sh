#!/usr/bin/env bash
# Installs K3s (a small single-machine Kubernetes) on the runner, set up so that
# each chain node can get CPU cores of its own.
#
# Usage: install-k3s.sh [reserved-cores]   (default 2)
set -euo pipefail

reserved_cores=${1:-2}

# The CPUs (threads) of physical cores 0 .. reserved_cores-1. `lscpu -p` prints
# one "cpu,core" line per thread; on parity-large, core 0 is CPUs 0 and 16.
reserved_cpus=$(lscpu -p=CPU,CORE | grep -v '^#' \
  | awk -F, -v n="$reserved_cores" '$2 < n { print $1 }' | paste -sd,)
echo "reserving CPUs $reserved_cpus (physical cores 0-$((reserved_cores - 1)))"

# The K3s flags, one by one:
#
#   --write-kubeconfig-mode 644
#       Lets the non-root `runner` user read K3s's config, so kubectl and
#       zombie-cli work without sudo.
#
#   --disable traefik --disable metrics-server
#       Two add-ons K3s installs by default. We need neither, and both use CPU.
#
#   --kubelet-arg=cpu-manager-policy=static
#       The setting that gives a pod its own cores. Without it every pod shares
#       every CPU, which is the problem we are trying to fix.
#
#   --kubelet-arg=cpu-manager-policy-options=full-pcpus-only=true
#       Hands out whole physical cores only. Each physical core has two threads;
#       this stops two nodes from each getting one thread of the same core.
#
#   --kubelet-arg=reserved-cpus=...
#       Keeps the first physical cores for the OS, K3s itself and zombie-cli,
#       so no chain node is put on them.
curl -sfL https://get.k3s.io | sudo sh -s - \
  --write-kubeconfig-mode 644 \
  --disable traefik \
  --disable metrics-server \
  --kubelet-arg=cpu-manager-policy=static \
  --kubelet-arg=cpu-manager-policy-options=full-pcpus-only=true \
  --kubelet-arg=reserved-cpus="$reserved_cpus"

# K3s starts in the background. First wait until it answers at all...
until kubectl get node >/dev/null 2>&1; do
  sleep 2
done

# ...then until the machine is registered as ready to run pods.
kubectl wait --for=condition=Ready node --all --timeout=180s
