#!/bin/sh
set -eu
slot=${DEV_STACK_ID:?Set DEV_STACK_ID to the claimed secondary slot}
case "$slot" in
  1|2) ;;
  *) echo 'Only secondary slots can be forwarded' >&2; exit 1 ;;
esac
worktree=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd -P)
owner_file="$HOME/.config/opencrane/dev-stack-$slot/stack-owner"
package_file="$HOME/.config/opencrane/dev-stack-$slot/package-owner.json"
if [ ! -f "$owner_file" ] || [ ! -f "$package_file" ]; then
  echo 'This slot has no owned package' >&2
  exit 1
fi
if ! grep -Fqx "worktree=$worktree" "$owner_file"; then
  echo 'This worktree does not own the slot' >&2
  exit 1
fi
"$worktree/infra/dev-stack/run.sh" package-check --id "$slot" || exit 1
port=$((25000 + slot * 100 + 6))
exec kubectl --context=k3d-ocn -n "opencrane-package-$slot" \
  port-forward --address 127.0.0.1 service/web "$port:80"
