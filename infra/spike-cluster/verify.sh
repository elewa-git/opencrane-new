#!/usr/bin/env bash
# Read-only checks. Each PASS is printed only after an assertion succeeds.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cluster_access
assert_owned_cluster
cluster="$(gc container clusters describe "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --format=json)"
jq -e '.location=="europe-west1-b" and .currentMasterVersion=="1.36.4-gke.1247000" and .resourceLabels.owner=="opencrane-new" and .resourceLabels.purpose=="spike" and .workloadIdentityConfig.workloadPool=="weownai-proto.svc.id.goog" and .networkConfig.datapathProvider=="ADVANCED_DATAPATH"' <<< "${cluster}" >/dev/null
echo 'PASS cluster version, zone, labels, Workload Identity and NetworkPolicy dataplane'
jq -e '.addonsConfig.agentSandboxConfig.enabled and .addonsConfig.podSnapshotConfig.enabled' <<< "${cluster}" >/dev/null
echo 'PASS managed Agent Sandbox and Pod Snapshots enabled'
jq -e '.nodePools | length==2 and all(.[]; (.name|startswith("ocn-spike")) and .config.spot==true and (.upgradeSettings.maxSurge//0)==0 and (.autoscaling.enabled!=true or .autoscaling.maxNodeCount==3) and (.locations==["europe-west1-b"]))' <<< "${cluster}" >/dev/null
jq -e '.nodePools[] | select(.name=="ocn-spike-sandbox") | .config.machineType=="n2-standard-2" and .config.sandboxConfig.type=="GVISOR"' <<< "${cluster}" >/dev/null
nodes="$(node_counts | awk '{n+=$2} END {print n+0}')"
(( nodes <= 6 ))
echo "PASS two Spot pools, maximum 3 each, no upgrade surge; ${nodes} running node VMs"
kc get crd -o json | jq -e '[.items[].metadata.name] | index("sandboxes.agents.x-k8s.io") and index("podsnapshots.podsnapshot.gke.io")' >/dev/null
echo 'PASS Agent Sandbox and Pod Snapshot CRDs installed'
kc get services -A -o json | jq -e 'all(.items[]; .spec.type!="LoadBalancer" and .spec.type!="NodePort")' >/dev/null
kc get ingress -A -o json | jq -e '.items | length==0' >/dev/null
echo 'PASS no LoadBalancer, NodePort or Ingress'
if [[ "${1:-}" == --paused ]]; then
  (( nodes == 0 ))
  jq -e 'all(.nodePools[]; .autoscaling.enabled!=true)' <<< "${cluster}" >/dev/null
  echo 'PASS paused: zero node VMs and both autoscalers disabled'
fi
gc container clusters describe opencrane-dev --region "${SPIKE_REGION}" --format=json > "${SPIKE_STATE_DIR}/opencrane-dev-after.json"
python3 - "${SPIKE_STATE_DIR}" <<'PY'
import json, pathlib, sys
state = pathlib.Path(sys.argv[1])
before = json.loads((state/'opencrane-dev-before.json').read_text())
after = json.loads((state/'opencrane-dev-after.json').read_text())
# Compare configuration; server-maintained resourceVersion and timestamps may advance.
keys = ['id', 'name', 'location', 'currentMasterVersion', 'nodePools', 'addonsConfig', 'resourceLabels', 'networkConfig', 'workloadIdentityConfig', 'endpoint']
changed = [k for k in keys if before.get(k) != after.get(k)]
assert not changed, f'Existing cluster configuration changed: {changed}'
print('PASS opencrane-dev configuration unchanged in before/after read-only describes')
PY
