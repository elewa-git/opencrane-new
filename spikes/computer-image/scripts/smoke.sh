#!/usr/bin/env bash
# Smoke test: ONE computer Pod from the image on the gVisor node pool.
#
#   ./scripts/smoke.sh [IMAGE]      IMAGE defaults to the one written by build.sh (.state/last-image.txt)
#   ./scripts/smoke.sh --keep       leave the Pod running afterwards (default: delete it and the relay)
#
# What it proves, each with a scripted check that fails if the thing breaks:
#   C1 the Pod runs with runtimeClassName gvisor on a node of the gVisor pool, and the kernel is gVisor's
#   C2 the health endpoint, reached through kubectl port-forward, reports every process up with PID and uptime
#   C3 the self-test passes inside gVisor: Chromium renders and screenshots a page, has a window on the
#      KasmVNC desktop, KasmVNC and Codex answer, only the expected ports are open, and so on
#   C4 a file written to /home/agent survives restarting processes (Chromium and the Codex app-server)
#   C5 the same file survives a restart of the whole container, while a file on the container's own layer
#      does not (the negative control that shows the check can fail)
# It also records, as information, whether `kubectl port-forward` straight to the sandboxed Pod works
# (Google documents that GKE Sandbox does not support it); C2 then uses a small relay Pod instead.
#
# All output is saved to evidence/smoke-<time>.txt.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../infra/spike-cluster/lib.sh
source "${HERE}/../../../infra/spike-cluster/lib.sh"

KEEP=0
IMAGE=""
for arg in "$@"; do
  case "${arg}" in
    --keep) KEEP=1 ;;
    *) IMAGE="${arg}" ;;
  esac
done
[[ -n "${IMAGE}" ]] || IMAGE="$(cat "${HERE}/../.state/last-image.txt" 2>/dev/null)" || true
[[ -n "${IMAGE}" ]] || die "no image given and no .state/last-image.txt; run build.sh first"

EVIDENCE_DIR="${HERE}/../evidence"
mkdir -p "${EVIDENCE_DIR}"
EVIDENCE="${EVIDENCE_DIR}/smoke-$(date -u +%Y%m%dT%H%M%SZ).txt"
# A pipeline works in the macOS sandbox; redirecting exec to /dev/fd does not.
if [[ "${OCN_SMOKE_LOGGED:-0}" != 1 ]]; then
  OCN_SMOKE_LOGGED=1 OCN_SMOKE_EVIDENCE="${EVIDENCE}" bash "${BASH_SOURCE[0]}" "$@" 2>&1 | tee "${EVIDENCE}"
  exit "${PIPESTATUS[0]}"
fi
EVIDENCE="${OCN_SMOKE_EVIDENCE}"

NS="${SPIKE_NAMESPACE}"
POD="ocn-spike-computer-smoke"
RELAY="ocn-spike-relay"
PF_LOG="$(mktemp)"
PF_PID=""
declare -a RESULTS=()

section() { printf '\n=== %s\n' "$*"; }
result() { # name verdict detail
  RESULTS+=("$1|$2|$3")
  printf 'RESULT %-5s %s :: %s\n' "$2" "$1" "$3"
}
pod_exec() { kc -n "${NS}" exec "${POD}" -c computer -- "$@"; }
health_inside() { pod_exec curl -s -m 10 http://127.0.0.1:8080/health; }
pids_of() { jq -r '.processes[] | "\(.name)=\(.pid)"' | sort | tr '\n' ' '; }

pf_stop() {
  if [[ -n "${PF_PID}" ]]; then
    kill "${PF_PID}" 2>/dev/null || true
    wait "${PF_PID}" 2>/dev/null || true
    PF_PID=""
  fi
}
cleanup() {
  pf_stop
  rm -f "${PF_LOG}"
  if [[ "${KEEP}" == 0 ]]; then
    kc -n "${NS}" delete pod "${POD}" "${RELAY}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  : # Port-forward children have been killed and waited for above.
}
trap cleanup EXIT

wait_ready() { # pod, seconds
  kc -n "${NS}" wait --for=condition=Ready "pod/$1" --timeout="${2}s" >/dev/null 2>&1
}

require_cluster_access
assert_owned_cluster
cost_guard
log "image: ${IMAGE}"
section "Start"
date -u
kc -n "${NS}" delete pod "${POD}" "${RELAY}" --ignore-not-found --wait=true >/dev/null 2>&1

# The smoke Pod cannot make any external calls, including real model calls.
kc apply -f "${HERE}/../k8s/smoke-network-policy.yaml"

# --- Create the Pod -----------------------------------------------------------------------------------
section "Create the computer Pod on the gVisor pool"
sed "s#IMAGE_PLACEHOLDER#${IMAGE}#" "${HERE}/../k8s/smoke-pod.yaml" | kc apply -f -
started=$SECONDS
if wait_ready "${POD}" 900; then
  echo "Pod Ready after $((SECONDS - started)) seconds (includes any node scale-up and the image pull)"
else
  echo "Pod did not become Ready within 15 minutes"
  kc -n "${NS}" describe pod "${POD}" | tail -40
  kc -n "${NS}" logs "${POD}" --tail=60 2>&1 || true
  die "smoke Pod is not Ready"
fi
kc -n "${NS}" get pod "${POD}" -o wide

# --- C1: gVisor -----------------------------------------------------------------------------------
section "C1 gVisor placement"
runtime_class="$(kc -n "${NS}" get pod "${POD}" -o jsonpath='{.spec.runtimeClassName}')"
node="$(kc -n "${NS}" get pod "${POD}" -o jsonpath='{.spec.nodeName}')"
node_pool="$(kc get node "${node}" -o jsonpath='{.metadata.labels.cloud\.google\.com/gke-nodepool}' 2>/dev/null)"
node_runtime="$(kc get node "${node}" -o jsonpath='{.metadata.labels.sandbox\.gke\.io/runtime}' 2>/dev/null)"
handler="$(kc get runtimeclass gvisor -o jsonpath='{.handler}' 2>/dev/null)"
kernel="$(pod_exec cat /proc/version 2>/dev/null | cut -c1-100)"
echo "runtimeClassName=${runtime_class} node=${node} pool=${node_pool} node-runtime-label=${node_runtime} runtimeclass-handler=${handler}"
echo "kernel inside the Pod: ${kernel}"
if [[ "${runtime_class}" == "gvisor" && "${node_pool}" == "${SPIKE_POOL_SANDBOX}" && "${node_runtime}" == "gvisor" && "${handler}" == "gvisor" && "${kernel}" == *"gvisor"* ]]; then
  result "C1 gVisor placement" PASS "runtimeClassName=gvisor on ${node} (pool ${node_pool}); kernel inside Pod is gVisor's: ${kernel}"
else
  result "C1 gVisor placement" FAIL "runtime=${runtime_class} pool=${node_pool} label=${node_runtime} handler=${handler} kernel=${kernel}"
fi

# --- Port-forward: direct, then through the relay -------------------------------------------------------
section "Information: kubectl port-forward straight to the sandboxed Pod"
pod_ip="$(kc -n "${NS}" get pod "${POD}" -o jsonpath='{.status.podIP}')"
echo "Pod IP ${pod_ip}"
command kubectl --kubeconfig "${KUBECONFIG}" -n "${NS}" port-forward "pod/${POD}" 18080:8080 > "${PF_LOG}" 2>&1 &
PF_PID=$!
sleep 4
direct_code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/health 2>/dev/null || true)"
echo "curl http://127.0.0.1:18080/health -> HTTP ${direct_code:-none}"
echo "--- port-forward output:"; cat "${PF_LOG}"
pf_stop
if [[ "${direct_code}" == "200" || "${direct_code}" == "503" ]]; then
  result "INFO direct port-forward to gVisor Pod" PASS "works (HTTP ${direct_code})"
  DIRECT_OK=1
else
  result "INFO direct port-forward to gVisor Pod" FAIL "does not work (HTTP ${direct_code:-none}); see output above. Using a relay Pod on a normal node instead"
  DIRECT_OK=0
fi

section "Relay Pod on the default pool, then port-forward to the relay"
kc apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${RELAY}
  namespace: ${NS}
  labels: { app: ${RELAY}, owner: opencrane-new, purpose: spike }
spec:
  nodeSelector: { cloud.google.com/gke-nodepool: ocn-spike-default }
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 }
  containers:
    - name: relay
      image: ${IMAGE}
      command: ["node", "/opt/computer/tcp-relay.mjs", "8080=${pod_ip}:8080", "6901=${pod_ip}:6901"]
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { memory: 256Mi } }
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
EOF
if wait_ready "${RELAY}" 300; then echo "relay Ready"; else echo "relay not Ready"; kc -n "${NS}" describe pod "${RELAY}" | tail -20; fi

command kubectl --kubeconfig "${KUBECONFIG}" -n "${NS}" port-forward "pod/${RELAY}" 18081:8080 18901:6901 > "${PF_LOG}" 2>&1 &
PF_PID=$!
sleep 4
curl -s -m 15 http://127.0.0.1:18081/health -o /tmp/ocn-spike-health.json -w 'HTTP %{http_code}\n' || true
health_code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:18081/health || true)"
vnc_code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:18901/ || true)"
echo "--- health JSON as seen from this laptop through kubectl port-forward (relay -> sandboxed Pod):"
cat /tmp/ocn-spike-health.json 2>/dev/null
echo "--- KasmVNC web client through the same path: HTTP ${vnc_code}"
pf_stop
if [[ "${health_code}" == "200" && "${vnc_code}" == "200" ]] && jq -e '.status=="ok" and ([.processes[] | select(.state=="RUNNING" and .pid>0 and .uptimeSeconds>=0 and .probe.ok)] | length) >= 5' /tmp/ocn-spike-health.json >/dev/null 2>&1; then
  procs="$(jq -r '[.processes[] | "\(.name) pid=\(.pid) up=\(.uptimeSeconds)s"] | join("; ")' /tmp/ocn-spike-health.json)"
  result "C2 health endpoint via port-forward" PASS "HTTP 200, status ok, all 5 processes RUNNING with a passing probe: ${procs}; KasmVNC web client HTTP ${vnc_code}"
else
  result "C2 health endpoint via port-forward" FAIL "health HTTP ${health_code}; see JSON above"
fi
rm -f /tmp/ocn-spike-health.json

# --- C3: self-test inside gVisor ----------------------------------------------------------------------
section "C3 self-test inside the Pod (gVisor)"
selftest_rc=0
selftest_out="$(pod_exec node /opt/computer/selftest.mjs 2>&1)" || selftest_rc=$?
echo "${selftest_out}"
summary_line="$(echo "${selftest_out}" | grep '^{' | tail -1)"
if [[ "${selftest_rc}" == 0 ]]; then
  result "C3 self-test inside gVisor" PASS "$(echo "${summary_line}" | jq -r '"\(.passed) of \(.passed + .failed) checks passed"')"
else
  result "C3 self-test inside gVisor" FAIL "exit ${selftest_rc}: $(echo "${selftest_out}" | grep '^FAIL' | head -5 | tr '\n' ';')"
fi

# Keep the exact installed versions and licences beside the smoke results.
for file in components.txt debian.json python.json pip-freeze.txt apt-packages.txt; do
  pod_exec cat "/opt/computer/licences/${file}" > "${EVIDENCE_DIR}/${file}"
done
pod_exec cat /opt/computer/spike-s0-1/SOURCES.sha256 > "${EVIDENCE_DIR}/bridge-sources.sha256"
pod_exec cat /home/agent/work/selftest.png > "${EVIDENCE_DIR}/chromium-gvisor.png"

# --- C4: file survives a process restart --------------------------------------------------------------
section "C4 file in /home/agent survives restarting processes"
nonce="$(openssl rand -hex 8)"
persist="/home/agent/work/persist-${nonce}.txt"
control="/var/tmp/rootfs-control-${nonce}.txt"
pod_exec sh -c "mkdir -p /home/agent/work && echo ${nonce} > ${persist} && echo ${nonce} > ${control}"
first_start_before="$(pod_exec cat /home/agent/.computer-first-start)"
before="$(health_inside | pids_of)"
echo "written ${persist} (and the control ${control} on the container layer)"
echo "PIDs before: ${before}"
pod_exec supervisorctl -c /opt/computer/supervisord.conf restart chromium codex-app-server
sleep 12
after="$(health_inside | pids_of)"
echo "PIDs after:  ${after}"
health_after_code="$(pod_exec curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health)"
content="$(pod_exec cat "${persist}" 2>/dev/null)"
chromium_before="$(echo "${before}" | tr ' ' '\n' | grep '^chromium=')"
chromium_after="$(echo "${after}" | tr ' ' '\n' | grep '^chromium=')"
codex_before="$(echo "${before}" | tr ' ' '\n' | grep '^codex-app-server=')"
codex_after="$(echo "${after}" | tr ' ' '\n' | grep '^codex-app-server=')"
if [[ "${content}" == "${nonce}" && "${chromium_before}" != "${chromium_after}" && "${codex_before}" != "${codex_after}" && "${health_after_code}" == "200" ]]; then
  result "C4 file survives process restart" PASS "chromium ${chromium_before} -> ${chromium_after}, codex ${codex_before} -> ${codex_after}; ${persist} still holds ${nonce}; health HTTP ${health_after_code} again"
else
  result "C4 file survives process restart" FAIL "content='${content}' chromium '${chromium_before}'->'${chromium_after}' codex '${codex_before}'->'${codex_after}' health ${health_after_code}"
fi

# --- C5: file survives a container restart -----------------------------------------------------------------
section "C5 file in /home/agent survives restarting the whole container"
restarts_before="$(kc -n "${NS}" get pod "${POD}" -o jsonpath='{.status.containerStatuses[0].restartCount}')"
pod_exec sh -c 'kill -TERM 1' || true
echo "sent SIGTERM to the supervisor (PID 1); restartCount before: ${restarts_before}"
deadline=$((SECONDS + 240))
while (( SECONDS < deadline )); do
  now_count="$(kc -n "${NS}" get pod "${POD}" -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null)"
  [[ "${now_count:-0}" -gt "${restarts_before:-0}" ]] && break
  sleep 3
done
wait_ready "${POD}" 300 && echo "Pod Ready again" || echo "Pod not Ready within 5 minutes"
restarts_after="$(kc -n "${NS}" get pod "${POD}" -o jsonpath='{.status.containerStatuses[0].restartCount}')"
content="$(pod_exec cat "${persist}" 2>/dev/null)"
control_after="$(pod_exec cat "${control}" 2>/dev/null || true)"
first_start_after="$(pod_exec cat /home/agent/.computer-first-start 2>/dev/null)"
health_json="$(health_inside)"
up_min="$(echo "${health_json}" | jq -r '[.processes[].uptimeSeconds] | max')"
all_ok="$(echo "${health_json}" | jq -r '.status')"
echo "restartCount ${restarts_before} -> ${restarts_after}; persist file='${content}'; rootfs control file='${control_after:-<gone>}'"
echo "first-start marker before='${first_start_before}' after='${first_start_after}'; health=${all_ok}; longest process uptime ${up_min}s"
echo "PIDs after container restart: $(echo "${health_json}" | pids_of)"
if [[ "${restarts_after}" -gt "${restarts_before}" && "${content}" == "${nonce}" && -z "${control_after}" && "${first_start_before}" == "${first_start_after}" && "${all_ok}" == "ok" ]]; then
  result "C5 file survives container restart" PASS "restartCount ${restarts_before}->${restarts_after}; ${persist} intact; negative control on the container layer is gone; every process up again (health ok)"
else
  result "C5 file survives container restart" FAIL "restarts ${restarts_before}->${restarts_after} persist='${content}' control='${control_after}' health=${all_ok}"
fi

# --- Summary ------------------------------------------------------------------------------------------
section "Summary"
failed=0
for r in "${RESULTS[@]}"; do
  IFS='|' read -r name verdict detail <<< "${r}"
  printf '%-5s %s\n' "${verdict}" "${name}"
  if [[ "${verdict}" == "FAIL" && "${name}" != INFO* ]]; then failed=1; fi
done
echo "evidence saved to ${EVIDENCE}"
exit "${failed}"
