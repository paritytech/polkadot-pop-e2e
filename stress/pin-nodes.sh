#!/usr/bin/env bash
# Gives the nodes of a running previewnet fork their own CPUs and memory with cgroup v2, so a flood
# measures People on a known share of the machine rather than on whatever the other nodes and the
# load tool leave free. Each People collator gets its own cores, the relay validators share a set,
# the load tool gets a set (the flood joins `ppn/loadgen` itself), and everything else the network
# runs (the other chains, the services, zombie-cli) shares what is left.
#
# Linux only, as root, once the network is up. A process moves with its descendants, and one a node
# starts later (a PVF worker) starts in its parent's group. Prints the layout as Markdown.
#
#   sudo -E stress/pin-nodes.sh      # with ZOMBIE_JSON and PPN_DIR set
#
# PEOPLE_CPUS (4) is per People collator, RELAY_CPUS (6) for all validators together and
# LOADGEN_CPUS (4) for the load tool. PEOPLE_MEM (8G) caps each People collator's memory.
set -euo pipefail

: "${ZOMBIE_JSON:?set ZOMBIE_JSON}" "${PPN_DIR:?set PPN_DIR}"
PEOPLE_PARA=${PEOPLE_PARA:-1502}
PEOPLE_CPUS=${PEOPLE_CPUS:-4}
RELAY_CPUS=${RELAY_CPUS:-6}
LOADGEN_CPUS=${LOADGEN_CPUS:-4}
PEOPLE_MEM=${PEOPLE_MEM:-8G}
ROOT=/sys/fs/cgroup
TOP=$ROOT/ppn

[ "$(stat -fc %T "$ROOT")" = cgroup2fs ] || { echo "pin-nodes: no cgroup v2 at $ROOT" >&2; exit 1; }

# vCPUs with SMT siblings next to each other: an even count is whole cores, so two groups never
# share a core.
expand() { local part; for part in ${1//,/ }; do seq "${part%-*}" "${part#*-}"; done; }
mapfile -t CPUS < <(sort -un /sys/devices/system/cpu/cpu[0-9]*/topology/thread_siblings_list | while read -r s; do expand "$s"; done)
smt=$(expand "$(cat /sys/devices/system/cpu/cpu0/topology/thread_siblings_list)" | wc -l)

mapfile -t VALIDATORS < <(jq -r '.relay.nodes[].name' "$ZOMBIE_JSON")
mapfile -t COLLATORS < <(jq -r --arg p "$PEOPLE_PARA" '.parachains[$p][].collators[].name' "$ZOMBIE_JSON")
need=$(( ${#COLLATORS[@]} * PEOPLE_CPUS + RELAY_CPUS + LOADGEN_CPUS + 1 ))
(( need <= ${#CPUS[@]} )) || { echo "pin-nodes: the layout needs $need vCPUs, this machine has ${#CPUS[@]}" >&2; exit 1; }

echo "+cpuset +memory" > "$ROOT/cgroup.subtree_control"
mkdir -p "$TOP"
echo "+cpuset +memory" > "$TOP/cgroup.subtree_control"

next=0
GROUPS_MADE=()
# group <name> <vCPUs> <memory.max>: the next <vCPUs> CPUs of the list.
group() {
  local cpus
  cpus=$(IFS=,; echo "${CPUS[*]:next:$2}")
  next=$(( next + $2 ))
  mkdir -p "$TOP/$1"
  echo "$cpus" > "$TOP/$1/cpuset.cpus"
  echo "$3" > "$TOP/$1/memory.max"
  GROUPS_MADE+=("$1 $3")
}

tree() { echo "$1"; local c; for c in $(pgrep -P "$1"); do tree "$c"; done; }
# move <group> <pid>...: each process with its descendants.
move() {
  local g=$1 p root; shift
  for p in $(for root in "$@"; do tree "$root"; done); do
    echo "$p" > "$TOP/$g/cgroup.procs" 2>/dev/null || true # exited since the listing
  done
}
node() {
  local pids
  mapfile -t pids < <(pgrep -f -- "--name $2( |\$)" || true)
  (( ${#pids[@]} )) || { echo "pin-nodes: no process for node $2" >&2; exit 1; }
  move "$1" "${pids[@]}"
}

for name in "${COLLATORS[@]}"; do group "$name" "$PEOPLE_CPUS" "$PEOPLE_MEM"; done
group relay "$RELAY_CPUS" max
group loadgen "$LOADGEN_CPUS" max
group other $(( ${#CPUS[@]} - next )) max

# The whole network first, then each node out of it into its own group.
mapfile -t network < <({ pgrep -x zombie-cli; pgrep -f -- "$PPN_DIR/"; } | grep -vx "$$" || true)
move other "${network[@]}"
for name in "${VALIDATORS[@]}"; do node relay "$name"; done
for name in "${COLLATORS[@]}"; do node "$name" "$name"; done

echo "Nodes pinned with cgroup v2: ${#CPUS[@]} vCPUs, $smt per core."
echo
echo "| group | vCPUs | memory.max | processes |"
echo "|---|---|---|---|"
for g in "${GROUPS_MADE[@]}"; do
  read -r name mem <<<"$g"
  echo "| $name | $(cat "$TOP/$name/cpuset.cpus.effective") | $mem | $(wc -l < "$TOP/$name/cgroup.procs") |"
done
