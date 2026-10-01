#!/usr/bin/env bash
# Brings a paused cluster back: default pool to 1 node (autoscaling 1..3), gVisor pool to
# N nodes (autoscaling 0..3, default N=1). Hard maximum stays 3 nodes per pool.
#   ./resume.sh [--sandbox-nodes N]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sandbox_nodes=1
if [[ "${1:-}" == "--sandbox-nodes" ]]; then sandbox_nodes="${2:?--sandbox-nodes needs a number}"; fi
[[ "${sandbox_nodes}" =~ ^[0-3]$ ]] || die "--sandbox-nodes must be 0 to 3"

cost_guard
cluster_exists || die "cluster ${SPIKE_CLUSTER} does not exist; run create.sh"
assert_owned_cluster
wait_for_cluster_operations
ledger_sample "resume-start"

grow_pool() {
  local pool="$1" size="$2" min="$3"
  assert_spike_name "${pool}"
  log "resizing ${pool} to ${size} node(s), then autoscaling ${min}..3"
  gc container clusters resize "${SPIKE_CLUSTER}" --node-pool "${pool}" --num-nodes "${size}" --zone "${SPIKE_ZONE}" --quiet
  gc container node-pools update "${pool}" --cluster "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" \
    --enable-autoscaling --min-nodes "${min}" --max-nodes 3
}
grow_pool "${SPIKE_POOL_DEFAULT}" 1 1
grow_pool "${SPIKE_POOL_SANDBOX}" "${sandbox_nodes}" 0

# Refresh credentials in case the endpoint changed, then wait for the nodes.
gc container clusters get-credentials "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}"
chmod 600 "${KUBECONFIG}"
log "waiting for nodes to be Ready"
deadline=$((SECONDS + 600))
until kc wait --for=condition=Ready node --all --timeout=30s >/dev/null 2>&1; do
  (( SECONDS < deadline )) || die "nodes not Ready within 10 minutes"
done
kc get nodes
ledger_sample "resumed"
