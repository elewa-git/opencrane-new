#!/usr/bin/env bash
set -euo pipefail

started_at=$SECONDS
check_directory=$(mktemp -d)
trap 'rm -rf "$check_directory"' EXIT
# Check for absent packages without treating available upgrades as missing packages.
printf 'APT::Get::Upgrade "false";\n' > "$check_directory/apt.conf"

dependencies_present() {
  APT_CONFIG="$check_directory/apt.conf" npx playwright install-deps --dry-run chromium
}

install_system_packages() {
  cache_directory=${CHROMIUM_DEB_CACHE:-.tools/ci/chromium-debs}
  mkdir -p "$cache_directory"
  cache_directory=$(realpath "$cache_directory")
  shopt -s nullglob
  archives=("$cache_directory"/*.deb)

  if (( ${#archives[@]} > 0 )); then
    # Keep a cache hit offline, including when apt finds a missing dependency.
    # Point apt at the restored archives because --no-download skips copying local files.
    if sudo timeout --kill-after=10s 180s apt-get \
      --option "Dir::Cache::archives=$cache_directory" install --yes \
      --no-install-recommends --no-download "${archives[@]}" && dependencies_present; then
      return
    fi
  fi

  # Retain downloaded packages so fresh runners can install them on later runs.
  download_config="$check_directory/download.conf"
  printf 'Dir::Cache::archives "%s";\nAPT::Keep-Downloaded-Packages "true";\n' \
    "$cache_directory" > "$download_config"
  sudo env "PATH=$PATH" "APT_CONFIG=$download_config" \
    timeout --kill-after=10s 180s npx playwright install-deps chromium
}

if ! dependencies_present; then
  install_system_packages
fi
npx playwright install chromium
printf 'Chromium setup: %s seconds\n' "$((SECONDS - started_at))"
