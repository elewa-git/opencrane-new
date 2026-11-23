#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run only on the pilot VM. The refusal checks also apply to dry runs.
script_directory=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=infra/devbox/runtime.sh
source "$script_directory/../devbox/runtime.sh"
K3S_SHA256=39eed8f53f277497dfc2542f66eab0ed68a94dfc598946dbebfb50366916c7a2
state=/var/lib/opencrane-vm
marker="$state/managed-k3s"
dry_run=true

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: bootstrap.sh [--dry-run | --apply]\n' >&2
  printf 'Defaults to dry run; only --apply permits host changes.\n' >&2
  exit 2
}

parse_arguments() {
  case "${1:-}" in
    '')
      [ "$#" -eq 0 ] || usage
      ;;
    --dry-run)
      [ "$#" -eq 1 ] || usage
      ;;
    --apply)
      [ "$#" -eq 1 ] || usage
      dry_run=false
      ;;
    *)
      usage
      ;;
  esac
}

refuse_existing_runtime() {
  local path
  for path in /run/docker.sock /var/run/docker.sock /etc/docker /var/lib/docker \
      /etc/kubernetes /var/snap/microk8s /etc/rancher/rke2 \
      /run/containerd/containerd.sock /etc/containerd /var/lib/containerd; do
    [ ! -e "$path" ] || fail "Refusing existing Docker or Kubernetes/containerd: $path"
  done
  local binary
  for binary in docker dockerd kubelet kubeadm microk8s containerd; do
    ! command -v "$binary" >/dev/null || fail "Refusing existing runtime: $binary"
  done
  for path in /var/lib/kubelet /etc/rancher/k3s /var/lib/rancher/k3s /usr/local/bin/k3s \
      /etc/systemd/system/k3s.service /etc/systemd/system/k3s-agent.service; do
    if [ -e "$path" ] && [ ! -f "$marker" ]; then
      fail "Refusing existing unowned k3s: $path"
    fi
  done
  if [ -f "$marker" ]; then
    [ "$(cat "$marker")" = "$K3S_SHA256" ] || fail 'Refusing existing unknown k3s marker'
    printf '%s  %s\n' "$K3S_SHA256" /usr/local/bin/k3s | sha256sum --check --status ||
      fail 'Refusing existing changed k3s binary'
  fi
}

check_host() {
  refuse_existing_runtime
  # Read the distribution's own settings before any package or service change.
  # shellcheck source=/dev/null
  source /etc/os-release
  [ "${ID:-}" = ubuntu ] || fail 'Use a fresh Ubuntu LTS VM'
  case "${VERSION_ID:-}" in
    22.04|24.04)
      ;;
    *)
      fail 'Use Ubuntu 22.04 or 24.04 LTS'
      ;;
  esac
  [ "$(uname -m)" = x86_64 ] || fail 'Only x86-64 is supported by the verified releases'
  [ "$(id -u)" -eq 0 ] || fail 'Run as root on the pilot VM'
}

run() {
  printf 'Step:'
  printf ' %q' "$@"
  printf '\n'
  if [ "$dry_run" = false ]; then
    "$@"
  fi
}

write_file() {
  local destination=$1
  local content=$2
  printf 'Write %s:\n%s\n' "$destination" "$content"
  if [ "$dry_run" = false ]; then
    mkdir -p "$(dirname "$destination")"
    printf '%s\n' "$content" > "$destination"
  fi
}

protect_node() {
  run swapoff --all
  run sed -i '/^[^#].*[[:space:]]swap[[:space:]]/s/^/# Disabled by OpenCrane: /' /etc/fstab
  # Stop generators from re-enabling swap after reboot, including zram generators.
  run systemctl mask swap.target
  local unit
  for unit in apport.service whoopsie.service kdump-tools.service systemd-coredump.socket; do
    run systemctl mask --now "$unit"
  done
  write_file /etc/default/apport 'enabled=0'
  write_file /etc/default/kdump-tools 'USE_KDUMP=0'
  write_file /etc/systemd/coredump.conf.d/99-opencrane.conf '[Coredump]
Storage=none
ProcessSizeMax=0'
  write_file /etc/systemd/system.conf.d/99-opencrane.conf '[Manager]
DefaultLimitCORE=0'
  write_file /etc/security/limits.d/99-opencrane.conf '* hard core 0
* soft core 0
root hard core 0
root soft core 0'
  write_file /etc/sysctl.d/99-opencrane.conf 'kernel.core_pattern=
kernel.core_uses_pid=0
fs.suid_dumpable=0'
  run sysctl --load=/etc/sysctl.d/99-opencrane.conf
  # Unload an already armed crash kernel; disabled services alone do not unload it.
  if [ -f /sys/kernel/kexec_crash_loaded ]; then
    local crash_loaded
    IFS= read -r crash_loaded < /sys/kernel/kexec_crash_loaded
    case "$crash_loaded" in
      0)
        ;;
      1)
        run kexec -p -u
        ;;
      *)
        fail 'Cannot establish whether a crash kernel is armed'
        ;;
    esac
  fi
}

install_payloads() {
  run apt-get update
  run apt-get install -y --no-install-recommends ca-certificates curl bzip2 kexec-tools
  run mkdir -p "$CACHE_DIR" "$TEMP_DIR"
  printf 'Download pinned k3s and gVisor; verify each with sha256sum before installation.\n'
  run download "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION/-/+}/k3s" \
    "$CACHE_DIR/k3s" "$K3S_SHA256"
  run download "https://github.com/google/gvisor/releases/download/$GVISOR_VERSION/gvisor-x86_64.tar.bz2" \
    "$CACHE_DIR/gvisor.tar.bz2" "$GVISOR_SHA256"
  run install -m 0755 "$CACHE_DIR/k3s" /usr/local/bin/k3s
  run tar -xjf "$CACHE_DIR/gvisor.tar.bz2" -C /usr/local/bin
  run ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl
}

configure_k3s() {
  write_file /etc/rancher/k3s/config.yaml 'write-kubeconfig-mode: "0600"
disable:
  - traefik
  - servicelb'
  write_file /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl \
    '{{ template "base" . }}
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes."runsc"]
  runtime_type = "io.containerd.runsc.v1"'
  write_file /etc/systemd/system/k3s.service '[Unit]
Description=OpenCrane single-node Kubernetes
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
ExecStart=/usr/local/bin/k3s server
Restart=on-failure
Delegate=yes
KillMode=process
LimitNOFILE=1048576
LimitNPROC=infinity
LimitCORE=0
TasksMax=infinity
[Install]
WantedBy=multi-user.target'
  # Save ownership before starting the service so an interrupted start can be resumed.
  write_file "$marker" "$K3S_SHA256"
  run systemctl daemon-reload
  run systemctl enable k3s.service
  run systemctl restart k3s.service
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  run kubectl wait --for=condition=Ready node --all --timeout=180s
  run install_runtime_class
  run install_agent_sandbox
  run kubectl get runtimeclass gvisor
  run kubectl wait --for=create deployment/local-path-provisioner -n kube-system --timeout=180s
  run kubectl rollout status deployment/local-path-provisioner -n kube-system --timeout=180s
  run kubectl get storageclass local-path
}

main() {
  parse_arguments "$@"
  check_host
  CACHE_DIR="$state/cache"
  TEMP_DIR="$state/work"
  # Print shared substeps too; a dry run never calls these mutating helpers.
  if [ "$dry_run" = true ]; then
    declare -f download install_runtime_class install_agent_sandbox
  fi
  install_payloads
  protect_node
  configure_k3s
  if [ "$dry_run" = true ]; then
    printf 'Dry run complete. Use --apply on the pilot VM to change the host.\n'
  else
    printf 'Host configuration ready. Reboot, then run package preflight before installation.\n'
  fi
}

main "$@"
