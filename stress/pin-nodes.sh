#!/usr/bin/env bash
# Gives each People collator of a running previewnet fork its own CPUs and memory with cgroup v2,
# so a flood measures People on a known share of the machine rather than on whatever the other
# nodes and the load tool leave free. Everything else (the relay validators, the other chains, the
# services, zombie-cli and the load tool, which joins `ppn/rest` itself) shares what is left: one
# pool, because splitting it would only strand CPUs in whichever group is idle.
#
# Linux only, as root, once the network is up. A process moves with its descendants, and one a node
# starts later (a PVF worker) starts in its parent's group. Prints the layout as Markdown.
#
#   sudo -E stress/pin-nodes.sh      # with ZOMBIE_JSON and PPN_DIR set
#
# PEOPLE_CPUS (4) and PEOPLE_MEM (8G) are per People collator. The shared pool must keep at least
# REST_MIN_CPUS (8), one per validator of a 3-core People network.
set -euo pipefail

: "${ZOMBIE_JSON:?set ZOMBIE_JSON}" "${PPN_DIR:?set PPN_DIR}"
PEOPLE_PARA=${PEOPLE_PARA:-1502}
PEOPLE_CPUS=${PEOPLE_CPUS:-4}
PEOPLE_MEM=${PEOPLE_MEM:-8G}
REST_MIN_CPUS=${REST_MIN_CPUS:-8}
ROOT=/sys/fs/cgroup
TOP=$ROOT/ppn

[ "$(stat -fc %T "$ROOT")" = cgroup2fs ] || { echo "pin-nodes: no cgroup v2 at $ROOT" >&2; exit 1; }

# vCPUs with SMT siblings next to each other: an even count is whole cores, so two groups never
# share a core.
expand() { local part; for part in ${1//,/ }; do seq "${part%-*}" "${part#*-}"; done; }
mapfile -t CPUS < <(sort -un /sys/devices/system/cpu/cpu[0-9]*/topology/thread_siblings_list | while read -r s; do expand "$s"; done)
smt=$(expand "$(cat /sys/devices/system/cpu/cpu0/topology/thread_siblings_list)" | wc -l)

# A para is an array of entries or a single one, as the flood's own topology reader takes it.
mapfile -t COLLATORS < <(jq -r --arg p "$PEOPLE_PARA" '.parachains[$p] | if type == "array" then .[] else . end | .collators[].name' "$ZOMBIE_JSON")
# A jq error inside the substitution does not trip `set -e`; without this the collators would
# land in the shared pool and the run would look pinned.
(( ${#COLLATORS[@]} )) || { echo "pin-nodes: no collators for para $PEOPLE_PARA in $ZOMBIE_JSON" >&2; exit 1; }
rest=$(( ${#CPUS[@]} - ${#COLLATORS[@]} * PEOPLE_CPUS ))
(( rest >= REST_MIN_CPUS )) || { echo "pin-nodes: ${#COLLATORS[@]} × $PEOPLE_CPUS vCPUs leaves $rest of ${#CPUS[@]} for the rest, below $REST_MIN_CPUS" >&2; exit 1; }

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

for name in "${COLLATORS[@]}"; do group "$name" "$PEOPLE_CPUS" "$PEOPLE_MEM"; done
group rest "$rest" max

# The whole network into the pool first, then each People collator out of it into its own group.
mapfile -t network < <({ pgrep -x zombie-cli; pgrep -f -- "$PPN_DIR/"; } | grep -vx "$$" || true)
move rest "${network[@]}"
for name in "${COLLATORS[@]}"; do
  mapfile -t pids < <(pgrep -f -- "--name $name( |\$)" || true)
  (( ${#pids[@]} )) || { echo "pin-nodes: no process for collator $name" >&2; exit 1; }
  move "$name" "${pids[@]}"
done

echo "Nodes pinned with cgroup v2: ${#CPUS[@]} vCPUs, $smt per core."
echo
echo "| group | vCPUs | memory.max | processes |"
echo "|---|---|---|---|"
for g in "${GROUPS_MADE[@]}"; do
  read -r name mem <<<"$g"
  echo "| $name | $(cat "$TOP/$name/cpuset.cpus.effective") | $mem | $(wc -l < "$TOP/$name/cgroup.procs") |"
done
