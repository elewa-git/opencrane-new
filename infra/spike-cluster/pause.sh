#!/usr/bin/env bash
# Stops the spend that can be stopped without deleting the cluster:
#   1. removes only this task's two smoke Pods; refuses if another spike has Pods,
#   2. scales both node pools to 0 nodes (autoscaling is switched off so they stay at 0).
# What still costs money while paused: the cluster fee (about EUR 0.0858 per hour, EUR 2.06 per day),
# the image repository and tiny storage. Use teardown.sh --yes to remove those too.
# Undo with resume.sh.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cluster_exists || { log "cluster ${SPIKE_CLUSTER} does not exist; nothing to pause"; exit 0; }
require_cluster_access

ledger_sample "pause-start"

assert_owned_cluster
wait_for_cluster_operations
# Refuse to disrupt another spike that is still running.
foreign="$(kc get pods -A -o json | jq -r '.items[] | select(.metadata.namespace | startswith("ocn-spike")) | select(.metadata.name != "ocn-spike-computer-smoke" and .metadata.name != "ocn-spike-relay") | .metadata.name')"
[[ -z "${foreign}" ]] || die "other spike Pods are running; cannot pause: ${foreign}"
for pod in ocn-spike-computer-smoke ocn-spike-relay; do
  kc -n "${SPIKE_NAMESPACE}" delete pod "${pod}" --ignore-not-found --wait=true --timeout=180s
done

scale_pool_to_zero() {
  local pool="$1"
  assert_spike_name "${pool}"
  log "scaling node pool ${pool} to 0 (autoscaling off)"
  gc container node-pools describe "${pool}" --cluster "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" >/dev/null 2>&1 || return 0
  gc container node-pools update "${pool}" --cluster "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --no-enable-autoscaling
  gc container clusters resize "${SPIKE_CLUSTER}" --node-pool "${pool}" --num-nodes 0 --zone "${SPIKE_ZONE}" --quiet
}
scale_pool_to_zero "${SPIKE_POOL_SANDBOX}"
scale_pool_to_zero "${SPIKE_POOL_DEFAULT}"

[[ -z "$(node_counts)" ]] || die "node VMs are still running"
ledger_sample "paused"
log "PASS: zero running spike node VMs"
log "paused. Cluster fee still running: about EUR $(euros "${RATE_CLUSTER_CENTS}") per hour. Run ./resume.sh to continue or ./teardown.sh --yes to remove everything."
