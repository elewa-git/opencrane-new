#!/bin/sh
set -eu

[ "$#" -eq 0 ] || exit 2
script_directory=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
stack_directory=$(CDPATH='' cd "$script_directory/../../infra/dev-stack" && pwd -P)
repository_root=$(CDPATH='' cd "$script_directory/../.." && pwd -P)
cd "$repository_root"

# Keep the claim tied to this launcher until cleanup finishes.
export DEV_STACK_CLAIM_PID=$$
claimed_id=$(/bin/sh "$stack_directory/claim.sh") || exit 1
case "$claimed_id" in
  1|2) ;;
  *) echo 'Invalid secondary claim.' >&2; exit 1 ;;
esac

cleanup() {
  previous_status=$?
  trap - EXIT HUP INT TERM
  if ! /bin/sh "$stack_directory/down.sh" --id "$claimed_id"; then
    previous_status=1
  fi
  exit "$previous_status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

export DEV_STACK_ID="$claimed_id"
export MEMORY_CLAIMED_ID="$claimed_id"
/bin/sh "$stack_directory/up.sh" --id "$claimed_id"
node --experimental-strip-types "$script_directory/persistence-run.mjs"
