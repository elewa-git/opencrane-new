#!/usr/bin/env bash
set -eu

script_directory=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
unit_directory="$HOME/.config/systemd/user"
runtime_directory="/run/user/$(id -u)"

export XDG_RUNTIME_DIR="$runtime_directory"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus"

mkdir -p "$unit_directory"
install -m 0644 "$script_directory/systemd/opencrane-daily-fresh.service" \
  "$unit_directory/opencrane-daily-fresh.service"
install -m 0644 "$script_directory/systemd/opencrane-daily-fresh.timer" \
  "$unit_directory/opencrane-daily-fresh.timer"

systemctl --user daemon-reload
systemctl --user enable --now opencrane-daily-fresh.timer
systemctl --user list-timers --all --no-pager
