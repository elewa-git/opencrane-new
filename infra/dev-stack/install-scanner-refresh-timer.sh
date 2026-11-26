#!/bin/sh
set -eu

if [ "$#" != 2 ] || [ "$1" != '--id' ]; then
  echo 'Usage: install-scanner-refresh-timer.sh --id 1|2' >&2
  exit 2
fi
slot=$2
case "$slot" in
  1|2) ;;
  *)
    echo 'Usage: install-scanner-refresh-timer.sh --id 1|2' >&2
    exit 2
    ;;
esac

script_directory=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
worktree=$(CDPATH='' cd "$script_directory/../.." && pwd -P)
unit_directory="$HOME/.config/systemd/user"
refresh_directory="$HOME/.config/opencrane/scanner-refresh"
unit=opencrane-scanner-refresh@

# Check the package before arming a timer for this worktree and slot.
"$script_directory/run.sh" package-check --id "$slot"
install -d -m 0700 "$refresh_directory"
ln -sfnT "$worktree" "$refresh_directory/$slot"
mkdir -p "$unit_directory"
install -m 0644 "$script_directory/systemd/$unit.service" "$unit_directory/$unit.service"
install -m 0644 "$script_directory/systemd/$unit.timer" "$unit_directory/$unit.timer"

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
systemctl --user daemon-reload
systemctl --user enable --now "$unit$slot.timer"
