#!/bin/sh
set -eu
case "${DEV_STACK_ID:-}" in 1|2) requested_id=$DEV_STACK_ID ;; *)
  echo 'Demo start requires DEV_STACK_ID=1 or 2.' >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || exit 2
[ -n "${DEV_REAL_PROVIDER_FILE:-}" ] && [ -r "$DEV_REAL_PROVIDER_FILE" ] || {
  echo 'Demo start requires DEV_REAL_PROVIDER_FILE pointing to a readable file.' >&2; exit 2;
}
script_directory=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
cd "$script_directory/../.."
claimed_id=$("$script_directory/claim.sh") || exit 1
case "$claimed_id" in 1|2) ;; *) echo 'Invalid secondary claim.' >&2; exit 1 ;; esac
[ "$claimed_id" = "$requested_id" ] || {
  echo 'Requested secondary is unavailable.' >&2; exit 1;
}
export DEV_STACK_ID="$claimed_id"
export COMPUTER_IDLE_MS=14400000
# Keep an existing claim intact unless this run reaches startup for the requested slot.
cleanup() {
  "$script_directory/down.sh" --id "$claimed_id"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
"$script_directory/up.sh" --id "$claimed_id" --fresh
node --experimental-strip-types infra/dev-stack/demo-seed-run.ts
trap - EXIT HUP INT TERM
printf 'Secondary %s ready for rehearsal; release with down.sh --id %s.\n' "$claimed_id" "$claimed_id"
