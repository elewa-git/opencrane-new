#!/bin/sh
set -eu
slot=${DEV_STACK_ID:?Set DEV_STACK_ID to the claimed secondary slot}
case "$slot" in
  1|2) ;;
  *) echo 'Only secondary slots can be forwarded' >&2; exit 1 ;;
esac
worktree=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd -P)
cd "$worktree"
exec node --experimental-strip-types infra/package/forward.ts
