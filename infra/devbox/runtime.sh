#!/usr/bin/env bash
# Share verified runtime releases between the developer node and the VM.

export K3S_VERSION="v1.37.0-k3s1"
export GVISOR_VERSION="release-20260928.0"
AGENT_SANDBOX_VERSION="v1.0.4"
export GVISOR_SHA256="f3ed9131bc252259df150e270154180188f9df56b73a2312940325e1f522a2d6"
AGENT_SANDBOX_SHA256="8cbe7f4c252463667e2286993bd735cb33bb2e47d7f304b92aa2ca97f57052c0"
AGENT_SANDBOX_IMAGE_DIGEST="sha256:c241245d7ff0068784ec0423f35efeb77c70ab08592533ca5b0cd7c36f8b2020"

download() {
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"

  if [ -f "$destination" ] &&
    printf '%s  %s\n' "$expected_sha256" "$destination" | sha256sum --check --status; then
    return
  fi

  local partial="${destination}.part"
  curl --fail --location --retry 3 --output "$partial" "$url"
  printf '%s  %s\n' "$expected_sha256" "$partial" | sha256sum --check --status ||
    fail "checksum did not match for $url"
  mv "$partial" "$destination"
}

install_runtime_class() {
  kubectl apply -f - <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
EOF
}

install_agent_sandbox() {
  printf 'Installing Agent Sandbox %s...\n' "$AGENT_SANDBOX_VERSION"
  local manifest="${CACHE_DIR}/agent-sandbox-with-extensions-${AGENT_SANDBOX_VERSION}.yaml"
  download \
    "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/sandbox-with-extensions.yaml" \
    "$manifest" \
    "$AGENT_SANDBOX_SHA256"
  local controller_image="registry.k8s.io/agent-sandbox/agent-sandbox-controller:${AGENT_SANDBOX_VERSION}"
  [ "$(grep -Fc "image: ${controller_image}" "$manifest")" -eq 1 ] ||
    fail "the verified Agent Sandbox manifest has an unexpected controller image"
  local pinned_manifest="${TEMP_DIR}/agent-sandbox-with-extensions.yaml"
  sed "s|image: ${controller_image}|image: ${controller_image}@${AGENT_SANDBOX_IMAGE_DIGEST}|" \
    "$manifest" >"$pinned_manifest"
  kubectl apply --server-side --field-manager=opencrane-devbox -f "$pinned_manifest" >/dev/null
  kubectl wait --for=condition=Established --timeout=120s \
    crd/sandboxes.agents.x-k8s.io \
    crd/sandboxclaims.extensions.agents.x-k8s.io \
    crd/sandboxtemplates.extensions.agents.x-k8s.io \
    crd/sandboxwarmpools.extensions.agents.x-k8s.io
  kubectl rollout status deployment/agent-sandbox-controller \
    --namespace agent-sandbox-system \
    --timeout=180s
}
