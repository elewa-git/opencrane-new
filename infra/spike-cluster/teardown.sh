#!/usr/bin/env bash
# Delete this task's recorded cluster, never the pre-existing shared image repository.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ "${1:-}" == --yes && $# == 1 ]] || die "usage: teardown.sh --yes (deletes ocn-spike cluster only; retains shared images and build bucket)"
if cluster_exists; then
  [[ -f "${SPIKE_STATE_DIR}/created-cluster-operation.json" ]] || die "no local record of creating this cluster"
  assert_owned_cluster
  ledger_sample teardown-start
  gc container clusters delete "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --quiet
  rm -f "${KUBECONFIG}"
fi
ledger_sample teardown-done
log "cluster deleted; shared registry, build bucket and node identity retained"
