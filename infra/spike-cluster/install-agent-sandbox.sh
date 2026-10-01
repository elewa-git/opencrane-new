#!/usr/bin/env bash
# Makes sure Agent Sandbox (Sandbox, SandboxTemplate, SandboxWarmPool, SandboxClaim) is installed
# on the spike cluster, then prints what is installed. Safe to run again.
#
#   ./install-agent-sandbox.sh            managed mode (default): GKE installs and runs Agent Sandbox
#                                         for us (cluster flag --enable-agent-sandbox, no extra charge).
#   ./install-agent-sandbox.sh --oss      open-source mode: applies the pinned upstream release.
#                                         Do not use both on one cluster; they share the same CRDs.
#
# Licence: Agent Sandbox (kubernetes-sigs/agent-sandbox) is Apache-2.0. See LICENCES.md.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Pinned upstream release for --oss mode (latest at 2026-10-01).
readonly OSS_VERSION="v1.0.4"
readonly OSS_URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${OSS_VERSION}/sandbox-with-extensions.yaml"
readonly OSS_SHA256="8cbe7f4c252463667e2286993bd735cb33bb2e47d7f304b92aa2ca97f57052c0"

mode="managed"
[[ "${1:-}" == "--oss" ]] && mode="oss"

readonly CRDS=(
  sandboxes.agents.x-k8s.io
  sandboxtemplates.extensions.agents.x-k8s.io
  sandboxwarmpools.extensions.agents.x-k8s.io
  sandboxclaims.extensions.agents.x-k8s.io
)

managed_enabled() {
  [[ "$(gc container clusters describe "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" \
    --format='value(addonsConfig.agentSandboxConfig.enabled)' 2>/dev/null || true)" == "True" ]]
}

install_managed() {
  if managed_enabled; then
    log "managed Agent Sandbox is enabled"
  else
    log "enabling managed Agent Sandbox"
    gc container clusters update "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}" --enable-agent-sandbox
  fi
}

install_oss() {
  die "BLOCKED: upstream ${OSS_VERSION} creates CRDs and a namespace without the ocn-spike prefix. Managed installation is available; use it within this task's naming restriction."
}

wait_for_crds() {
  local crd deadline=$((SECONDS + 600))
  for crd in "${CRDS[@]}"; do
    until kc get crd "${crd}" >/dev/null 2>&1; do
      (( SECONDS < deadline )) || die "CRD ${crd} did not appear within 10 minutes"
      sleep 10
    done
    kc wait --for=condition=Established "crd/${crd}" --timeout=120s >/dev/null
  done
}

report() {
  log "installed CRDs and the API versions they serve:"
  local crd
  for crd in "${CRDS[@]}"; do
    kc get crd "${crd}" -o jsonpath='{.metadata.name}{"  versions="}{range .spec.versions[*]}{.name}{"(served="}{.served}{",storage="}{.storage}{") "}{end}{"\n"}'
  done
  log "Agent Sandbox controller pods (any namespace):"
  kc get pods -A 2>/dev/null | grep -iE 'sandbox|NAMESPACE' || true
  log "admission policies that mention sandbox:"
  kc get validatingadmissionpolicy 2>/dev/null | grep -iE 'sandbox|NAME' || true
  log "RuntimeClasses:"
  kc get runtimeclass 2>/dev/null || true
}

main() {
  cost_guard
  cluster_exists || die "cluster ${SPIKE_CLUSTER} does not exist; run create.sh first"
  require_cluster_access
  assert_owned_cluster
  if [[ "${mode}" == "oss" ]]; then install_oss; else install_managed; fi
  wait_for_crds
  report
}
main
