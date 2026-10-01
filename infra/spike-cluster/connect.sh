#!/usr/bin/env bash
# Refresh only this spike's dedicated kubeconfig; never the user's defaults.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
assert_owned_cluster
gc container clusters get-credentials "${SPIKE_CLUSTER}" --zone "${SPIKE_ZONE}"
chmod 600 "${KUBECONFIG}"
require_cluster_access
