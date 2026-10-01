#!/usr/bin/env bash
# Cost estimate for the ocn-spike environment, from .state/ledger.tsv.
#   ./cost.sh                       show the estimate and the ledger
#   ./cost.sh sample "note" [cents]   record what is running right now (read-only cloud calls, writes only the
#                                   local ledger); the optional integer cents amount is extra spend, e.g. a Cloud Build run
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ "${1:-}" == "sample" ]]; then
  ledger_sample "sample" "${3:-0}" "${2:-}"
fi

echo "Estimated spend so far: $(cost_so_far) cents  (ceiling EUR 25, stop line EUR 20)"
echo "Current hourly rate:    $(cost_rate_now) cents per hour (from the last ledger row)"
echo
[[ -s "${SPIKE_LEDGER}" ]] && column -t -s $'\t' "${SPIKE_LEDGER}" || echo "(ledger is empty)"
