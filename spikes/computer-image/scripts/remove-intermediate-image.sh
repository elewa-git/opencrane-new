#!/usr/bin/env bash
# Remove only this task's superseded build, which still included npm's non-OSI data.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../../infra/spike-cluster/lib.sh"
image="europe-west1-docker.pkg.dev/weownai-proto/ocn-spike/computer"
digest="sha256:188b35a602bc36096d0c3722ebd7c1f8476f8440e361a5e0dfb3c0658be9f563"
gc builds describe b69d31dd-d093-4f99-a2ec-79fb5183da86 --region "${SPIKE_REGION}" --format=json \
  | jq -e --arg digest "${digest}" '.results.images[] | select(.digest==$digest and .name=="europe-west1-docker.pkg.dev/weownai-proto/ocn-spike/computer:ocn-spike-20261001-04")' >/dev/null
[[ "$(cat "${SPIKE_DIR}/../../spikes/computer-image/.state/last-image.txt")" != *"${digest}" ]] || die "refusing to remove the current image"
gc artifacts docker images delete "${image}@${digest}" --delete-tags --quiet
