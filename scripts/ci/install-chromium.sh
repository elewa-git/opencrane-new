#!/usr/bin/env bash
set -euo pipefail

started_at=$SECONDS
check_directory=$(mktemp -d)
trap 'rm -rf "$check_directory"' EXIT
# Check for absent packages without treating available upgrades as missing packages.
printf 'APT::Get::Upgrade "false";\n' > "$check_directory/apt.conf"
if APT_CONFIG="$check_directory/apt.conf" npx playwright install-deps --dry-run chromium; then
  npx playwright install chromium
else
  npx playwright install --with-deps chromium
fi
printf 'Chromium setup: %s seconds\n' "$((SECONDS - started_at))"
