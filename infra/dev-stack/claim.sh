#!/bin/sh
set -eu

script_directory=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
worktree=$(CDPATH='' cd "$script_directory/../.." && pwd -P)
export DEV_STACK_CLAIM_PID=$$

for stack_id in 1 2; do
  owner_file="$HOME/.config/opencrane/dev-stack-$stack_id/stack-owner"
  if [ ! -f "$owner_file" ]; then
    continue
  fi

  IFS= read -r recorded_worktree < "$owner_file" || true
  case "$recorded_worktree" in
    worktree=*) recorded_worktree=${recorded_worktree#worktree=} ;;
  esac
  if [ "$recorded_worktree" = "$worktree" ]; then
    "$script_directory/run.sh" claim --id "$stack_id"
    exit 0
  fi
done

for stack_id in 1 2; do
  if "$script_directory/run.sh" claim --id "$stack_id"; then
    exit 0
  fi
done

echo 'Both secondary stack ids are claimed or have occupied ports; release a slot before retrying.' >&2
exit 1
