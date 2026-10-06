#!/usr/bin/env bash
set -eu

source_repository="$HOME/dev/opencrane-new"
daily_checkout="$HOME/dev/daily-fresh"
timer_directory="$HOME/.opencrane/daily-fresh"
lock_record="$timer_directory/package-lock.sha256"

mkdir -p "$timer_directory"
chmod 700 "$timer_directory"

git -C "$source_repository" fetch origin

if [ ! -d "$daily_checkout" ]; then
  git -C "$source_repository" worktree add --detach "$daily_checkout" origin/main
fi

git -C "$daily_checkout" fetch origin
git -C "$daily_checkout" checkout --detach --force origin/main

lock_hash=$(sha256sum "$daily_checkout/package-lock.json")
lock_hash=${lock_hash%% *}
previous_lock_hash=
if [ -f "$lock_record" ]; then
  previous_lock_hash=$(cat "$lock_record")
fi

if [ "$lock_hash" != "$previous_lock_hash" ]; then
  (cd "$daily_checkout" && nice -n 10 npm ci)
  printf '%s\n' "$lock_hash" > "$lock_record"
  chmod 600 "$lock_record"
fi

exec "$daily_checkout/infra/dev-stack/daily-fresh.sh" "$@"
