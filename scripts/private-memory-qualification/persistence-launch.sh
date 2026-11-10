#!/bin/sh
set -eu

[ "$#" -eq 0 ] || exit 2
script_directory=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
stack_directory=$(CDPATH='' cd "$script_directory/../../infra/dev-stack" && pwd -P)
repository_root=$(CDPATH='' cd "$script_directory/../.." && pwd -P)
cd "$repository_root"

# Keep the claim tied to this launcher until cleanup finishes.
export DEV_STACK_CLAIM_PID=$$
claimed_id=''
claim_pid=''
claim_file=$(mktemp)

cleanup() {
  previous_status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$claim_pid" ]; then
    # Let an interrupted claim finish before reading its slot and releasing it.
    wait "$claim_pid" || :
    if [ -z "$claimed_id" ]; then
      claimed_id=$(cat "$claim_file")
    fi
  fi
  rm -f "$claim_file"
  case "$claimed_id" in
    1|2)
      if ! /bin/sh "$stack_directory/down.sh" --id "$claimed_id"; then
        previous_status=1
      fi
      ;;
  esac
  exit "$previous_status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

/bin/sh "$stack_directory/claim.sh" > "$claim_file" &
claim_pid=$!
wait "$claim_pid" || exit 1
claimed_id=$(cat "$claim_file")
case "$claimed_id" in
  1|2) ;;
  *) echo 'Invalid secondary claim.' >&2; exit 1 ;;
esac

export DEV_STACK_ID="$claimed_id"
export MEMORY_CLAIMED_ID="$claimed_id"
# Leave dev Owner events and the separate chat journey out of this fresh check.
export DEV_OWNER_BOOTSTRAP=0
/bin/sh "$stack_directory/up.sh" --id "$claimed_id"
node --experimental-strip-types "$script_directory/persistence-run.mjs"
