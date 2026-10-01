#!/usr/bin/env bash
# Cancel only a computer build submitted by this task, after checking its output image.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../../infra/spike-cluster/lib.sh"
build="${1:?build id required}"
gc builds describe "${build}" --region "${SPIKE_REGION}" --format=json | jq -e '.substitutions._IMAGE=="europe-west1-docker.pkg.dev/weownai-proto/ocn-spike/computer"' >/dev/null
gc builds cancel "${build}" --region "${SPIKE_REGION}"
