#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
action=$1
shift
stack_id=${DEV_STACK_ID:-owner}
fresh=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id) [ "$#" -ge 2 ] || exit 2; stack_id=$2; shift 2 ;;
    --fresh) [ "$action" = up ] || exit 2; fresh=--fresh; shift ;;
    *) echo 'Usage: up|down|status|journey [--id owner|1|2] [--fresh]' >&2; exit 2 ;;
  esac
done
case "$stack_id" in owner) suffix= ;; 1|2) suffix=-$stack_id ;; *) echo 'Stack id must be owner, 1 or 2' >&2; exit 2 ;; esac
export DEV_STACK_ID="$stack_id"
DEV_STACK_CLAIM_PID=${DEV_STACK_CLAIM_PID:-$$}
export DEV_STACK_CLAIM_PID
# Close the lock in the child: detached servers must not hold it after up exits.
if [ "$action" = claim ]; then
  exec flock --nonblock --close "/tmp/opencrane-dev-stack-$(id -u)$suffix.lock" node --experimental-strip-types infra/dev-stack/stack.ts claim
fi
if [ -n "$fresh" ]; then
  exec flock --close "/tmp/opencrane-dev-stack-$(id -u)$suffix.lock" node --experimental-strip-types infra/dev-stack/stack.ts "$action" "$fresh"
fi
exec flock --close "/tmp/opencrane-dev-stack-$(id -u)$suffix.lock" node --experimental-strip-types infra/dev-stack/stack.ts "$action"
