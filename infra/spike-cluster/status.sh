#!/usr/bin/env bash
# Read-only status of the ocn-spike environment: cluster, nodes, pods, Agent Sandbox objects, estimated
# hourly cost. Changes nothing, in the cloud or locally.
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "== Cluster ${SPIKE_CLUSTER} (${SPIKE_ZONE}, project ${SPIKE_PROJECT})"
if ! cluster_exists; then
  echo "cluster does not exist (nothing running, no cluster fee)"
else
  gc container clusters describe "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" \
    --format='table(name,status,currentMasterVersion,releaseChannel.channel,addonsConfig.agentSandboxConfig.enabled:label=AGENT_SANDBOX,addonsConfig.podSnapshotConfig.enabled:label=POD_SNAPSHOTS,networkConfig.datapathProvider:label=DATAPLANE)' 2>&1
  echo
  echo "== Node pools"
  gc container node-pools list --cluster "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" \
    --format='table(name,config.machineType,config.spot,config.sandboxConfig.type:label=SANDBOX,autoscaling.enabled:label=AUTOSCALE,autoscaling.minNodeCount:label=MIN,autoscaling.maxNodeCount:label=MAX,version)' 2>&1
  echo
  echo "== Running node VMs"
  default_nodes=0; sandbox_nodes=0
  while IFS=$'\t' read -r pool count; do
    [[ -z "${pool}" ]] && continue
    echo "${pool}: ${count}"
    [[ "${pool}" == "${SPIKE_POOL_DEFAULT}" ]] && default_nodes="${count}"
    [[ "${pool}" == "${SPIKE_POOL_SANDBOX}" ]] && sandbox_nodes="${count}"
  done < <(node_counts)
  echo
  if [[ -s "${KUBECONFIG}" ]] && kc version --request-timeout=10s >/dev/null 2>&1; then
    echo "== kubectl nodes"
    kc get nodes -o wide 2>&1
    echo
    echo "== Spike namespaces: pods"
    for ns in $(kc get namespace -o name 2>/dev/null | sed 's#^namespace/##' | grep '^ocn-spike' || true); do
      echo "-- ${ns}"
      kc -n "${ns}" get pods -o wide 2>&1
      for kind in sandboxwarmpools sandboxclaims sandboxes; do
        kc -n "${ns}" get "${kind}" 2>/dev/null
      done
    done
  else
    echo "(kubectl cannot reach the cluster with ${KUBECONFIG})"
  fi
  echo
  hourly=$((RATE_CLUSTER_CENTS + RATE_NODE_CENTS * (default_nodes+sandbox_nodes) + RATE_STORAGE_CENTS))
  echo "== Estimated cost right now: ${hourly} cents/hour (includes storage allowance)"
fi
echo "== Estimated spend so far (ledger): $(cost_so_far) cents of EUR 25 (stop line EUR 20)"
echo
echo "== Images in Artifact Registry repo ${SPIKE_REPO}"
gc artifacts docker images list "${SPIKE_REGION}-docker.pkg.dev/${SPIKE_PROJECT}/${SPIKE_REPO}" --format='table(package,version,createTime)' 2>&1 | head -20
