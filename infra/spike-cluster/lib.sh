#!/usr/bin/env bash
# Shared settings, safety checks and the cost ledger for the ocn-spike scripts.
# Source this file from the other scripts. Do not run it directly.
#
# Safety rules this file enforces for every script that sources it:
#   * Only the GCP project weownai-proto is ever used (every gcloud call gets
#     an explicit --project; nothing here changes gcloud defaults).
#   * kubectl only ever talks to the dedicated kubeconfig in .state/, never to
#     the user's own ~/.kube/config.
#   * Anything that is created or deleted must have a name starting with
#     "ocn-spike" (assert_spike_name).

# shellcheck shell=bash

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_STATE_DIR="${SPIKE_DIR}/.state"
mkdir -p "${SPIKE_STATE_DIR}"

# --- Fixed settings (do not make these configurable: the approval is for this project and zone only)
readonly SPIKE_PROJECT="weownai-proto"
readonly SPIKE_REGION="europe-west1"
readonly SPIKE_ZONE="europe-west1-b"
readonly SPIKE_CLUSTER="ocn-spike"
readonly SPIKE_POOL_DEFAULT="ocn-spike-default"
readonly SPIKE_POOL_SANDBOX="ocn-spike-sandbox"
readonly SPIKE_REPO="ocn-spike"
readonly SPIKE_NODE_SA_NAME="ocn-spike-nodes"
readonly SPIKE_NODE_SA="${SPIKE_NODE_SA_NAME}@${SPIKE_PROJECT}.iam.gserviceaccount.com"
readonly SPIKE_BUILD_BUCKET="ocn-spike-build-${SPIKE_PROJECT}"
readonly SPIKE_SNAPSHOT_BUCKET="ocn-spike-snapshots-${SPIKE_PROJECT}"
readonly SPIKE_LABELS="owner=opencrane-new,purpose=spike"
readonly SPIKE_NAMESPACE="ocn-spike"

# GKE version: Agent Sandbox (managed) needs 1.36.3-gke.1767000 or later, and
# Pod Snapshots need 1.35.3-gke.1234000 or later. 1.36.4-gke.1247000 is on the
# REGULAR channel in europe-west1-b (checked 2026-10-01 with
# `gcloud container get-server-config`).
readonly SPIKE_GKE_CHANNEL="regular"
readonly SPIKE_GKE_VERSION="1.36.4-gke.1247000"

# N2 is the cheapest machine family that GKE Pod Snapshots (whole-pod scope)
# accepts. E2 is not supported for whole-pod snapshots, and N2 Spot is also
# cheaper than E2 Spot and N2D Spot in europe-west1 (Cloud Billing Catalog).
readonly SPIKE_MACHINE_TYPE="n2-standard-2"

# Conservative rounded hourly rates, always integer euro cents.
readonly SPIKE_BUDGET_CENTS=2500
readonly SPIKE_STOP_CENTS=2000
readonly RATE_CLUSTER_CENTS=9
readonly RATE_NODE_CENTS=4
readonly RATE_STORAGE_CENTS=1
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export KUBECONFIG="${SPIKE_STATE_DIR}/kubeconfig"
readonly SPIKE_LEDGER="${SPIKE_STATE_DIR}/ledger.tsv"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Every gcloud call goes through gc(), which pins the project and refuses the
# commands that would change local gcloud or kubectl defaults.
gc() {
  case "${1:-} ${2:-}" in
    "config set"|"config unset"|"config configurations"|"components install"|"components update"|"components remove")
      die "refusing to run 'gcloud $1 $2': spike scripts never change gcloud defaults" ;;
  esac
  command gcloud "$@" --project "${SPIKE_PROJECT}"
}

# kubectl always uses the dedicated kubeconfig.
kc() { command kubectl --kubeconfig "${KUBECONFIG}" "$@"; }

# Refuse to create or delete anything that is not named ocn-spike*.
assert_spike_name() {
  case "$1" in
    ocn-spike*) return 0 ;;
    *) die "refusing to touch '$1': name does not start with ocn-spike" ;;
  esac
}

cluster_exists() {
  gc container clusters describe "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --format='value(name)' >/dev/null 2>&1
}

# Node VMs of the spike cluster, one "pool<TAB>count" line per node pool.
# GKE names node VMs gke-<cluster>-<pool>-<hash>-<id>, so the pool comes from the name.
node_counts() {
  local name pool
  gc compute instances list \
    --filter="name~^gke-${SPIKE_CLUSTER}- AND status=RUNNING" \
    --format='value(name)' 2>/dev/null \
    | while read -r name; do
        case "${name}" in
          "gke-${SPIKE_CLUSTER}-${SPIKE_POOL_DEFAULT}-"*) pool="${SPIKE_POOL_DEFAULT}" ;;
          "gke-${SPIKE_CLUSTER}-${SPIKE_POOL_SANDBOX}-"*) pool="${SPIKE_POOL_SANDBOX}" ;;
          *) pool="other" ;;
        esac
        echo "${pool}"
      done | sort | uniq -c | awk '{print $2"\t"$1}'
}

# Confirm the dedicated context before any Kubernetes call.
require_cluster_access() {
  [[ -s "${KUBECONFIG}" ]] || die "missing dedicated kubeconfig; run create.sh cluster"
  local context
  context="$(kc config current-context)"
  [[ "${context}" == "gke_${SPIKE_PROJECT}_${SPIKE_ZONE}_${SPIKE_CLUSTER}" ]] || die "wrong Kubernetes context: ${context}"
  kc version --request-timeout=15s >/dev/null
}

assert_owned_cluster() {
  local labels
  labels="$(gc container clusters describe "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --format=json)"
  jq -e '.name=="ocn-spike" and .resourceLabels.owner=="opencrane-new" and .resourceLabels.purpose=="spike"' <<< "${labels}" >/dev/null || die "cluster ownership check failed"
}

euros() { printf '%d.%02d' "$(( $1 / 100 ))" "$(( $1 % 100 ))"; }
cost_so_far() { python3 "${SPIKE_DIR}/cost-model.py"; }
cost_rate_now() {
  if cluster_exists; then
    local nodes
    nodes="$(node_counts | awk '{n+=$2} END {print n+0}')"
    echo "$((RATE_CLUSTER_CENTS + RATE_NODE_CENTS * nodes + RATE_STORAGE_CENTS))"
  else echo "${RATE_STORAGE_CENTS}"; fi
}
ledger_sample() {
  local event="$1" extra="${2:-0}" note="${3:-}" cluster=0 d=0 s=0 pool count
  [[ "${extra}" =~ ^[0-9]+$ ]] || die "extra spend must be integer cents"
  if cluster_exists; then
    cluster=1
    while IFS=$'\t' read -r pool count; do
      case "${pool}" in
        "${SPIKE_POOL_DEFAULT}") d="${count}" ;;
        "${SPIKE_POOL_SANDBOX}") s="${count}" ;;
      esac
    done < <(node_counts)
  fi
  [[ -s "${SPIKE_LEDGER}" ]] || printf 'epoch\tiso\tevent\tcluster\tdefault_nodes\tsandbox_nodes\textraCents\tnote\n' > "${SPIKE_LEDGER}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%s)" "$(date -u +%FT%TZ)" "${event}" "${cluster}" "${d}" "${s}" "${extra}" "${note}" >> "${SPIKE_LEDGER}"
}
cost_guard() {
  local spent projected
  spent="$(cost_so_far)"
  # Reserve a full day with six nodes, plus a 60-cent build and 50-cent buffer.
  projected=$((spent + 24 * (RATE_CLUSTER_CENTS + 6 * RATE_NODE_CENTS + RATE_STORAGE_CENTS) + 110))
  log "estimated ${spent} cents spent; next-day worst-case projection ${projected} cents (stop at ${SPIKE_STOP_CENTS})"
  (( projected < SPIKE_STOP_CENTS )) || die "cost projection reaches EUR 20; pause and report"
}

wait_for_cluster_operations() {
  local operation
  while read -r operation; do
    [[ -n "${operation}" ]] || continue
    log "waiting for this spike's operation ${operation}"
    gc container operations wait "${operation}" --zone "${SPIKE_ZONE}" --format='value(status)'
  done < <(gc container operations list --zone "${SPIKE_ZONE}" --filter='status!=DONE' --format=json \
    | jq -r '.[] | select(.targetLink | test("/clusters/ocn-spike(/|$)")) | .name')
}
