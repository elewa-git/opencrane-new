#!/usr/bin/env bash

set -eu
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The path is resolved from this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../setup.sh"

inspection_output=''
inspection_fails=false

k3d() {
  case "$*" in
    'cluster get ocn') return 0 ;;
    'cluster delete ocn') printf 'DELETE_CALLED\n' ;;
    'cluster start ocn') printf 'cluster start\n' ;;
    'kubeconfig merge ocn --kubeconfig-switch-context') return 0 ;;
    *) printf 'unexpected k3d call: %s\n' "$*" >&2; return 1 ;;
  esac
}

docker() {
  case "$*" in
    *k3d-ocn-serverlb)
      [ "$inspection_fails" = false ] || return 1
      printf '%s\n' "$inspection_output"
      ;;
    *k3d-ocn-server-0) printf '%s\n' "$NODE_IMAGE" ;;
    *) printf 'unexpected docker call: %s\n' "$*" >&2; return 1 ;;
  esac
}

kubectl() {
  return 0
}

run_case() {
  name="$1"
  expected_status="$2"
  expected_message="$3"
  inspection_output="$4"
  inspection_fails="$5"
  second_expected_message="${6:-}"

  if output="$(ensure_cluster 2>&1)"; then
    status=0
  else
    status=$?
  fi

  [ "$status" -eq "$expected_status" ] || {
    printf 'FAIL: %s: expected status %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    exit 1
  }
  printf '%s\n' "$output" | grep -Fq "$expected_message" || {
    printf 'FAIL: %s: missing expected message: %s\n%s\n' "$name" "$expected_message" "$output" >&2
    exit 1
  }
  if [ -n "$second_expected_message" ] &&
    ! printf '%s\n' "$output" | grep -Fq "$second_expected_message"; then
    printf 'FAIL: %s: missing expected message: %s\n%s\n' "$name" "$second_expected_message" "$output" >&2
    exit 1
  fi
  if printf '%s\n' "$output" | grep -Fq 'DELETE_CALLED'; then
    printf 'FAIL: %s: attempted to delete the cluster\n%s\n' "$name" "$output" >&2
    exit 1
  fi

  printf 'PASS: %s\n' "$name"
}

expected='HostIp=127.0.0.1 HostPort=6550'
remediation="delete it with \`k3d cluster delete ocn\` (this removes cluster MinIO data) and rerun"

run_case 'correct single binding continues' 0 'cluster start' "$expected" false
run_case 'failed inspection stops without deleting' 1 \
  'could not inspect the Kubernetes API binding for cluster ocn' "$expected" true
run_case 'extra :: binding stops' 1 'HostIp=:: HostPort=6550' \
  "${expected}"$'\n''HostIp=:: HostPort=6550' false "$remediation"
run_case 'extra 0.0.0.0 binding stops' 1 'HostIp=0.0.0.0 HostPort=6550' \
  "${expected}"$'\n''HostIp=0.0.0.0 HostPort=6550' false "$remediation"
run_case 'other port stops' 1 'HostIp=127.0.0.1 HostPort=6551' \
  'HostIp=127.0.0.1 HostPort=6551' false "$remediation"
