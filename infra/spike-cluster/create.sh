#!/usr/bin/env bash
# Creates the ocn-spike environment in GCP project weownai-proto. Safe to run again.
#
#   ./create.sh            registry stage, then cluster stage
#   ./create.sh registry   only the cheap parts: Artifact Registry repo, build bucket, node service account.
#                          Use this first so images can be built before the cluster fee starts.
#   ./create.sh cluster    only the cluster: zonal Standard cluster, default pool, gVisor pool,
#                          Pod Snapshots, managed Agent Sandbox, credentials in .state/kubeconfig
#
# Everything created here is named ocn-spike* and labelled owner=opencrane-new,purpose=spike
# (where the resource type supports labels). Nothing existing in the project is changed.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

stage="${1:-all}"
case "${stage}" in all|registry|cluster) ;; *) die "usage: $0 [all|registry|cluster]" ;; esac

# --- Registry stage ------------------------------------------------------------

ensure_artifact_registry() {
  assert_spike_name "${SPIKE_REPO}"
  if gc artifacts repositories describe "${SPIKE_REPO}" --location "${SPIKE_REGION}" >/dev/null 2>&1; then
    log "Artifact Registry repo ${SPIKE_REPO} already exists"
  else
    log "creating Artifact Registry repo ${SPIKE_REPO} in ${SPIKE_REGION}"
    gc artifacts repositories create "${SPIKE_REPO}" \
      --repository-format docker --location "${SPIKE_REGION}" \
      --labels "${SPIKE_LABELS}" \
      --description "OpenCrane 2 spike images (ocn-spike). Safe to delete."
  fi
}

# Our own bucket for Cloud Build source uploads, so builds never write into the
# project's shared *_cloudbuild bucket. Objects expire after 2 days.
ensure_build_bucket() {
  assert_spike_name "${SPIKE_BUILD_BUCKET}"
  if gc storage buckets describe "gs://${SPIKE_BUILD_BUCKET}" >/dev/null 2>&1; then
    log "bucket ${SPIKE_BUILD_BUCKET} already exists"
    return 0
  else
    log "creating bucket ${SPIKE_BUILD_BUCKET} in ${SPIKE_REGION}"
    gc storage buckets create "gs://${SPIKE_BUILD_BUCKET}" \
      --location "${SPIKE_REGION}" --uniform-bucket-level-access \
      --public-access-prevention --soft-delete-duration 0d
  fi
  gc storage buckets update "gs://${SPIKE_BUILD_BUCKET}" --update-labels "${SPIKE_LABELS}" >/dev/null
  local lifecycle="${SPIKE_STATE_DIR}/build-bucket-lifecycle.json"
  printf '%s\n' '{"rule":[{"action":{"type":"Delete"},"condition":{"age":2}}]}' > "${lifecycle}"
  gc storage buckets update "gs://${SPIKE_BUILD_BUCKET}" --lifecycle-file "${lifecycle}" >/dev/null
}

# A dedicated node identity with no project-level roles at all. Its only
# permission is reading images from our own repository, so a compromised node
# cannot reach anything else in the project. Logging and monitoring are
# switched off on the cluster for the same reason (kubectl logs is enough).
ensure_node_service_account() {
  assert_spike_name "${SPIKE_NODE_SA_NAME}"
  if gc iam service-accounts describe "${SPIKE_NODE_SA}" >/dev/null 2>&1; then
    log "service account ${SPIKE_NODE_SA} already exists"
  else
    log "creating service account ${SPIKE_NODE_SA}"
    gc iam service-accounts create "${SPIKE_NODE_SA_NAME}" \
      --display-name "ocn-spike GKE nodes" \
      --description "Spike nodes. Reads images from Artifact Registry repo ocn-spike only. Safe to delete."
  fi
  # The previous spike session granted this binding. Do not change the shared repo.
  gc artifacts repositories get-iam-policy "${SPIKE_REPO}" --location "${SPIKE_REGION}" --format=json \
    | jq -e --arg member "serviceAccount:${SPIKE_NODE_SA}" '.bindings[] | select(.role=="roles/artifactregistry.reader") | .members | index($member)' >/dev/null \
    || die "node identity lacks repository access; shared repository IAM is outside this task"

}

# --- Cluster stage -------------------------------------------------------------

ensure_cluster() {
  assert_spike_name "${SPIKE_CLUSTER}"
  if cluster_exists; then
    assert_owned_cluster
    if [[ -f "${SPIKE_STATE_DIR}/created-cluster-operation.json" ]]; then
      gc container operations wait "$(jq -r .name "${SPIKE_STATE_DIR}/created-cluster-operation.json")" --zone "${SPIKE_ZONE}"
    fi
    log "cluster ${SPIKE_CLUSTER} already exists"
    return 0
  fi
  log "creating zonal Standard cluster ${SPIKE_CLUSTER} in ${SPIKE_ZONE} (GKE ${SPIKE_GKE_VERSION}, ${SPIKE_GKE_CHANNEL} channel)"
  ledger_sample "create-start"
  local operation
  operation="$(python3 "${SPIKE_DIR}/create-cluster.py")"
  gc container operations wait "${operation}" --zone "${SPIKE_ZONE}"
  assert_owned_cluster

}

ensure_sandbox_pool() {
  assert_spike_name "${SPIKE_POOL_SANDBOX}"
  if gc container node-pools describe "${SPIKE_POOL_SANDBOX}" --cluster "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" >/dev/null 2>&1; then
    log "node pool ${SPIKE_POOL_SANDBOX} already exists"
    return 0
  fi
  log "creating gVisor node pool ${SPIKE_POOL_SANDBOX} (Spot, autoscaling 0..3)"
  gc container node-pools create "${SPIKE_POOL_SANDBOX}" \
    --cluster "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" \
    --machine-type "${SPIKE_MACHINE_TYPE}" --spot \
    --num-nodes 0 --enable-autoscaling --min-nodes 0 --max-nodes 3 \
    --node-version "${SPIKE_GKE_VERSION}" --max-surge-upgrade 0 --max-unavailable-upgrade 1 \
    --image-type cos_containerd --sandbox type=gvisor \
    --disk-type pd-balanced --disk-size 50 \
    --service-account "${SPIKE_NODE_SA}" --scopes cloud-platform \
    --workload-metadata GKE_METADATA \
    --labels "${SPIKE_LABELS}" \
    --node-labels "owner=opencrane-new,purpose=spike"
}

# GKE's managed Agent Sandbox: the control plane installs and runs the CRDs and
# controller. It needs a gVisor pool to exist first, so this runs after the pool.
ensure_agent_sandbox() {
  local enabled
  enabled="$(gc container clusters describe "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --format='value(addonsConfig.agentSandboxConfig.enabled)' 2>/dev/null || true)"
  if [[ "${enabled}" == "True" ]]; then
    log "managed Agent Sandbox already enabled"
  else
    log "enabling managed Agent Sandbox (gcloud container clusters update --enable-agent-sandbox)"
    gc container clusters update "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --enable-agent-sandbox
  fi
}

ensure_monitoring_disabled() {
  # New GKE releases enable extra metrics even when monitoringService is none.
  local config
  config="$(gc container clusters describe "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --format=json)"
  if ! jq -e '.monitoringConfig.managedPrometheusConfig.enabled!=true and ((.monitoringConfig.componentConfig.enableComponents//[])|length)==0' <<< "${config}" >/dev/null; then
    gc container clusters update "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --monitoring NONE --no-enable-managed-prometheus
  fi
}

write_credentials() {
  log "writing credentials to ${KUBECONFIG} (your own ~/.kube/config is not touched)"
  # KUBECONFIG is exported by lib.sh, so get-credentials writes only to the dedicated file.
  gc container clusters get-credentials "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}"
  chmod 600 "${KUBECONFIG}"
}

ensure_namespace() {
  kc get namespace "${SPIKE_NAMESPACE}" >/dev/null 2>&1 || kc create namespace "${SPIKE_NAMESPACE}"
  kc label namespace "${SPIKE_NAMESPACE}" owner=opencrane-new purpose=spike --overwrite >/dev/null
}

main() {
  cost_guard
  if [[ "${stage}" == "all" || "${stage}" == "registry" ]]; then
    ensure_artifact_registry
    ensure_build_bucket
    ensure_node_service_account
    ledger_sample "registry-ready"
  fi
  if [[ "${stage}" == "all" || "${stage}" == "cluster" ]]; then
    # The node service account and repo must exist before the cluster uses them.
    ensure_artifact_registry
    ensure_node_service_account
    ensure_cluster
    ledger_sample "cluster-created"
    ensure_sandbox_pool
    ensure_agent_sandbox
    ensure_monitoring_disabled
    write_credentials
    ensure_namespace
    ledger_sample "cluster-ready"
    log "done. Next: ./install-agent-sandbox.sh to check the Agent Sandbox CRDs, then ./status.sh"
  fi
}
main
