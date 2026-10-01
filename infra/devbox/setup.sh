#!/usr/bin/env bash

set -eu
set -o pipefail

K3D_VERSION="v5.9.0"
KUBECTL_VERSION="v1.37.1"
HELM_VERSION="v3.19.1"
K3S_VERSION="v1.37.0-k3s1"
GVISOR_VERSION="release-20260928.0"
AGENT_SANDBOX_VERSION="v1.0.4"
REGISTRY_VERSION="2.8.3"
BUSYBOX_VERSION="1.37.0"
MINIO_VERSION="RELEASE.2025-10-15T17-29-55Z"

K3D_SHA256="06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0"
KUBECTL_SHA256="65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8"
HELM_SHA256="966bed9b1e0dda11268f59bd7268c3cd3e308b37b070546e1d78a02526ff63f2"
GVISOR_SHA256="f3ed9131bc252259df150e270154180188f9df56b73a2312940325e1f522a2d6"
AGENT_SANDBOX_SHA256="8cbe7f4c252463667e2286993bd735cb33bb2e47d7f304b92aa2ca97f57052c0"

K3S_IMAGE_DIGEST="sha256:d33b1973401a60410681d66c007f5c3a51d565a7c03608904764aef3321fee4d"
AGENT_SANDBOX_IMAGE_DIGEST="sha256:c241245d7ff0068784ec0423f35efeb77c70ab08592533ca5b0cd7c36f8b2020"
REGISTRY_IMAGE_DIGEST="sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
BUSYBOX_IMAGE_DIGEST="sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"
MINIO_IMAGE_DIGEST="sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4"

CLUSTER_NAME="ocn"
REGISTRY_NAME="ocn-registry"
REGISTRY_PORT="5001"
CLUSTER_API_PORT="6550"
NODE_IMAGE_REVISION="1"
NODE_IMAGE="opencrane/k3s-gvisor:${K3S_VERSION}-${GVISOR_VERSION}-${NODE_IMAGE_REVISION}"
SWAP_SIZE_BYTES="8589934592"

fail() {
  printf 'setup failed: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

download() {
  url="$1"
  destination="$2"
  expected_sha256="$3"

  if [ -f "$destination" ] &&
    printf '%s  %s\n' "$expected_sha256" "$destination" | sha256sum --check --status; then
    return
  fi

  partial="${destination}.part"
  curl --fail --location --retry 3 --output "$partial" "$url"
  printf '%s  %s\n' "$expected_sha256" "$partial" | sha256sum --check --status ||
    fail "checksum did not match for $url"
  mv "$partial" "$destination"
}

install_plain_binary() {
  name="$1"
  url="$2"
  expected_sha256="$3"
  cached_binary="${CACHE_DIR}/${name}"

  download "$url" "$cached_binary" "$expected_sha256"
  if [ ! -x "/usr/local/bin/${name}" ] ||
    ! printf '%s  %s\n' "$expected_sha256" "/usr/local/bin/${name}" |
      sha256sum --check --status; then
    sudo install -m 0755 "$cached_binary" "/usr/local/bin/${name}"
  fi
}

configure_swap() {
  printf 'Configuring the 8 GB swap file...\n'
  if [ -e /swapfile ] && [ "$(stat --format='%s' /swapfile)" != "$SWAP_SIZE_BYTES" ]; then
    if swapon --noheadings --show=NAME | tr -d ' ' | grep -qx '/swapfile'; then
      sudo swapoff /swapfile
    fi
    sudo rm -f /swapfile
  fi

  if [ ! -e /swapfile ]; then
    sudo fallocate --length "$SWAP_SIZE_BYTES" /swapfile
  fi
  sudo chmod 0600 /swapfile

  swap_type="$(sudo blkid -p -s TYPE -o value /swapfile 2>/dev/null || true)"
  if [ "$swap_type" != "swap" ]; then
    sudo mkswap /swapfile >/dev/null
  fi

  if ! swapon --noheadings --show=NAME | tr -d ' ' | grep -qx '/swapfile'; then
    sudo swapon /swapfile
  fi
  if ! grep -Eq '^[[:space:]]*/swapfile[[:space:]]' /etc/fstab; then
    printf '/swapfile none swap sw 0 0\n' | sudo tee -a /etc/fstab >/dev/null
  fi

  printf 'vm.swappiness = 10\n' | sudo tee /etc/sysctl.d/99-opencrane-devbox.conf >/dev/null
  sudo sysctl --load=/etc/sysctl.d/99-opencrane-devbox.conf >/dev/null
}

install_tools() {
  printf 'Installing pinned command-line tools...\n'
  install_plain_binary \
    k3d \
    "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-linux-amd64" \
    "$K3D_SHA256"
  install_plain_binary \
    kubectl \
    "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    "$KUBECTL_SHA256"

  helm_archive="${CACHE_DIR}/helm-${HELM_VERSION}-linux-amd64.tar.gz"
  download \
    "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
    "$helm_archive" \
    "$HELM_SHA256"
  if ! command -v helm >/dev/null 2>&1 ||
    ! helm version --short 2>/dev/null | grep -Fq "$HELM_VERSION"; then
    helm_dir="${TEMP_DIR}/helm"
    mkdir -p "$helm_dir"
    tar -xzf "$helm_archive" -C "$helm_dir"
    sudo install -m 0755 "$helm_dir/linux-amd64/helm" /usr/local/bin/helm
  fi
}

install_gvisor() {
  printf 'Installing pinned gVisor binaries...\n'
  GVISOR_ARCHIVE="${CACHE_DIR}/gvisor-x86_64-${GVISOR_VERSION}.tar.bz2"
  download \
    "https://github.com/google/gvisor/releases/download/${GVISOR_VERSION}/gvisor-x86_64.tar.bz2" \
    "$GVISOR_ARCHIVE" \
    "$GVISOR_SHA256"

  if ! command -v runsc >/dev/null 2>&1 ||
    ! command -v containerd-shim-runsc-v1 >/dev/null 2>&1 ||
    ! runsc --version 2>/dev/null | grep -Fq "$GVISOR_VERSION"; then
    sudo tar -xjf "$GVISOR_ARCHIVE" -C /usr/local/bin
  fi
  command -v containerd-shim-runsc-v1 >/dev/null 2>&1 ||
    fail "the gVisor containerd shim was not installed"
}

build_node_image() {
  printf 'Building the pinned k3s node image with gVisor...\n'
  build_dir="${CACHE_DIR}/k3s-gvisor-image"
  mkdir -p "$build_dir"
  cp "$GVISOR_ARCHIVE" "$build_dir/gvisor.tar.bz2"

  cat >"$build_dir/config-v3.toml.tmpl" <<'EOF'
{{ template "base" . }}

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runsc']
  runtime_type = "io.containerd.runsc.v1"
EOF

  cat >"$build_dir/Dockerfile" <<EOF
FROM docker.io/rancher/k3s@${K3S_IMAGE_DIGEST}
ADD gvisor.tar.bz2 /usr/local/bin/
COPY config-v3.toml.tmpl /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl
LABEL org.opencrane.k3s-version="${K3S_VERSION}"
LABEL org.opencrane.gvisor-version="${GVISOR_VERSION}"
LABEL org.opencrane.node-image-revision="${NODE_IMAGE_REVISION}"
EOF

  if docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 &&
    [ "$(docker image inspect --format '{{ index .Config.Labels "org.opencrane.node-image-revision" }}' "$NODE_IMAGE")" = "$NODE_IMAGE_REVISION" ]; then
    return
  fi
  docker build --tag "$NODE_IMAGE" "$build_dir"
}

ensure_registry() {
  printf 'Ensuring the local registry is running...\n'
  if docker container inspect "k3d-${REGISTRY_NAME}" >/dev/null 2>&1; then
    registry_image="$(docker container inspect --format '{{.Config.Image}}' "k3d-${REGISTRY_NAME}")"
    registry_image_id="$(docker container inspect --format '{{.Image}}' "k3d-${REGISTRY_NAME}")"
    if [ "$registry_image" != "docker.io/library/registry:${REGISTRY_VERSION}@${REGISTRY_IMAGE_DIGEST}" ] &&
      [ "$registry_image_id" != "$REGISTRY_IMAGE_DIGEST" ]; then
      fail "k3d-${REGISTRY_NAME} does not use the pinned Registry image"
    fi
    published_port="$(docker container inspect --format '{{(index (index .HostConfig.PortBindings "5000/tcp") 0).HostPort}}' "k3d-${REGISTRY_NAME}")"
    [ "$published_port" = "$REGISTRY_PORT" ] ||
      fail "k3d-${REGISTRY_NAME} does not use host port ${REGISTRY_PORT}"
    published_address="$(docker container inspect --format '{{(index (index .HostConfig.PortBindings "5000/tcp") 0).HostIp}}' "k3d-${REGISTRY_NAME}")"
    [ "$published_address" = "127.0.0.1" ] ||
      fail "k3d-${REGISTRY_NAME} is not bound to 127.0.0.1"
    if [ "$(docker container inspect --format '{{.State.Running}}' "k3d-${REGISTRY_NAME}")" != "true" ]; then
      docker start "k3d-${REGISTRY_NAME}" >/dev/null
    fi
  else
    k3d registry create "$REGISTRY_NAME" \
      --image "docker.io/library/registry:${REGISTRY_VERSION}@${REGISTRY_IMAGE_DIGEST}" \
      --port "127.0.0.1:${REGISTRY_PORT}"
  fi
}

check_cluster_api_binding() {
  expected_binding="HostIp=127.0.0.1 HostPort=${CLUSTER_API_PORT}"
  if ! api_bindings="$(docker container inspect \
    --format '{{range (index .HostConfig.PortBindings "6443/tcp")}}{{printf "HostIp=%s HostPort=%s\n" .HostIp .HostPort}}{{end}}' \
    "k3d-${CLUSTER_NAME}-serverlb" 2>/dev/null)"; then
    fail "could not inspect the Kubernetes API binding for cluster ${CLUSTER_NAME}"
  fi

  if [ "$api_bindings" != "$expected_binding" ]; then
    [ -n "$api_bindings" ] || api_bindings="<none>"
    fail "cluster ${CLUSTER_NAME} Kubernetes API bindings: ${api_bindings}; expected only ${expected_binding}; delete it with \`k3d cluster delete ${CLUSTER_NAME}\` (this removes cluster MinIO data) and rerun"
  fi
}

ensure_cluster() {
  printf 'Ensuring the %s k3d cluster is running...\n' "$CLUSTER_NAME"
  if k3d cluster get "$CLUSTER_NAME" >/dev/null 2>&1; then
    check_cluster_api_binding
    configured_image="$(docker container inspect --format '{{.Config.Image}}' "k3d-${CLUSTER_NAME}-server-0")"
    [ "$configured_image" = "$NODE_IMAGE" ] ||
      fail "cluster ${CLUSTER_NAME} uses $configured_image; tear it down before changing the pinned node image"
    k3d cluster start "$CLUSTER_NAME"
  else
    k3d cluster create "$CLUSTER_NAME" \
      --image "$NODE_IMAGE" \
      --api-port "127.0.0.1:${CLUSTER_API_PORT}" \
      --registry-use "k3d-${REGISTRY_NAME}:5000" \
      --servers 1 \
      --agents 0 \
      --k3s-arg '--disable=traefik@server:0' \
      --timeout 240s \
      --wait
  fi
  k3d kubeconfig merge "$CLUSTER_NAME" --kubeconfig-switch-context >/dev/null
  kubectl wait --for=condition=Ready node --all --timeout=120s
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

prove_registry() {
  printf 'Proving a pushed image can be pulled by a Pod...\n'
  source_image="docker.io/library/busybox:${BUSYBOX_VERSION}@${BUSYBOX_IMAGE_DIGEST}"
  pushed_image="127.0.0.1:${REGISTRY_PORT}/opencrane/devbox-test:busybox-${BUSYBOX_VERSION}"
  cluster_image="k3d-${REGISTRY_NAME}:5000/opencrane/devbox-test:busybox-${BUSYBOX_VERSION}"
  docker pull "$source_image" >/dev/null
  source_image_id="$(docker image inspect --format '{{.Id}}' "$source_image")"
  docker tag "$source_image_id" "$pushed_image"
  docker push "$pushed_image" >/dev/null

  kubectl delete pod registry-pull-test --ignore-not-found --wait=true >/dev/null
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: registry-pull-test
spec:
  restartPolicy: Never
  containers:
    - name: test
      image: ${cluster_image}
      imagePullPolicy: Always
      command: ["sh", "-c", "echo registry-pull-ok; sleep 3600"]
EOF
  kubectl wait --for=condition=Ready pod/registry-pull-test --timeout=120s
  registry_output="$(kubectl logs registry-pull-test)"
  [ "$registry_output" = "registry-pull-ok" ] || fail "the registry test Pod did not start correctly"
  registry_image_id="$(kubectl get pod registry-pull-test -o jsonpath='{.status.containerStatuses[0].imageID}')"
  printf 'Registry proof: %s, imageID=%s\n' "$registry_output" "$registry_image_id"
  kubectl delete pod registry-pull-test --wait=true >/dev/null
}

prove_gvisor() {
  printf 'Proving the gVisor RuntimeClass...\n'
  cluster_image="k3d-${REGISTRY_NAME}:5000/opencrane/devbox-test:busybox-${BUSYBOX_VERSION}"
  kubectl delete pod gvisor-test --ignore-not-found --wait=true >/dev/null
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: gvisor-test
spec:
  runtimeClassName: gvisor
  restartPolicy: Never
  containers:
    - name: test
      image: ${cluster_image}
      imagePullPolicy: Always
      command: ["sh", "-c", "dmesg | head -n 3"]
EOF

  attempts=0
  while :; do
    phase="$(kubectl get pod gvisor-test -o jsonpath='{.status.phase}')"
    [ "$phase" = "Succeeded" ] && break
    if [ "$phase" = "Failed" ]; then
      kubectl describe pod gvisor-test >&2
      kubectl logs gvisor-test >&2 || true
      fail "the gVisor test Pod failed"
    fi
    attempts=$((attempts + 1))
    [ "$attempts" -lt 60 ] || fail "timed out waiting for the gVisor test Pod"
    sleep 2
  done

  gvisor_output="$(kubectl logs gvisor-test)"
  printf '%s\n' "$gvisor_output" | grep -qi 'gvisor' ||
    fail "the test Pod kernel output did not identify gVisor"
  printf 'gVisor proof: %s\n' "$(printf '%s\n' "$gvisor_output" | grep -i -m 1 'gvisor')"
  kubectl delete pod gvisor-test --wait=true >/dev/null
}

install_agent_sandbox() {
  printf 'Installing Agent Sandbox %s...\n' "$AGENT_SANDBOX_VERSION"
  manifest="${CACHE_DIR}/agent-sandbox-with-extensions-${AGENT_SANDBOX_VERSION}.yaml"
  download \
    "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/sandbox-with-extensions.yaml" \
    "$manifest" \
    "$AGENT_SANDBOX_SHA256"
  controller_image="registry.k8s.io/agent-sandbox/agent-sandbox-controller:${AGENT_SANDBOX_VERSION}"
  [ "$(grep -Fc "image: ${controller_image}" "$manifest")" -eq 1 ] ||
    fail "the verified Agent Sandbox manifest has an unexpected controller image"
  pinned_manifest="${TEMP_DIR}/agent-sandbox-with-extensions.yaml"
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

install_minio() {
  printf 'Installing MinIO with credentials held outside the repository...\n'
  credentials_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/opencrane"
  credentials_file="${credentials_dir}/minio.env"
  mkdir -p "$credentials_dir"
  chmod 0700 "$credentials_dir"
  if [ ! -f "$credentials_file" ]; then
    umask 077
    {
      printf 'MINIO_ROOT_USER=ocn%s\n' "$(openssl rand -hex 8)"
      printf 'MINIO_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    } >"$credentials_file"
  fi
  chmod 0600 "$credentials_file"

  kubectl create namespace opencrane-dev --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl --namespace opencrane-dev create secret generic minio-root \
    --from-env-file="$credentials_file" \
    --dry-run=client \
    -o yaml | kubectl apply -f - >/dev/null

  kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: minio-data
  namespace: opencrane-dev
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: Service
metadata:
  name: minio
  namespace: opencrane-dev
spec:
  selector:
    app.kubernetes.io/name: minio
  ports:
    - name: api
      port: 9000
      targetPort: api
    - name: console
      port: 9001
      targetPort: console
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
  namespace: opencrane-dev
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: minio
  template:
    metadata:
      labels:
        app.kubernetes.io/name: minio
    spec:
      securityContext:
        fsGroup: 101
      containers:
        - name: minio
          image: docker.io/alpine/minio:${MINIO_VERSION}@${MINIO_IMAGE_DIGEST}
          imagePullPolicy: IfNotPresent
          args: ["server", "/data", "--console-address", ":9001"]
          envFrom:
            - secretRef:
                name: minio-root
          ports:
            - name: api
              containerPort: 9000
            - name: console
              containerPort: 9001
          readinessProbe:
            httpGet:
              path: /minio/health/ready
              port: api
          livenessProbe:
            httpGet:
              path: /minio/health/live
              port: api
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            runAsUser: 100
            runAsGroup: 101
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: minio-data
EOF
  kubectl rollout status deployment/minio --namespace opencrane-dev --timeout=240s
}

# TODO: Add tailscale serve only after its exposure and access policy are decided.

main() {
  [ "$(uname -s)" = "Linux" ] || fail "this setup supports Linux only"
  [ "$(uname -m)" = "x86_64" ] || fail "this setup currently supports x86_64 only"

  for command_name in curl sha256sum sudo stat fallocate blkid mkswap swapon swapoff grep sed tar docker openssl; do
    need_command "$command_name"
  done
  sudo -n true || fail "passwordless sudo is required"
  docker info >/dev/null 2>&1 || fail "Docker is not available to the current user"

  CACHE_DIR="${XDG_CACHE_HOME:-${HOME}/.cache}/opencrane/devbox"
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  mkdir -p "$CACHE_DIR"

  configure_swap
  install_tools
  install_gvisor
  build_node_image
  ensure_registry
  ensure_cluster
  install_runtime_class
  prove_registry
  prove_gvisor
  install_agent_sandbox
  install_minio

  printf 'OpenCrane dev box setup is complete.\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
