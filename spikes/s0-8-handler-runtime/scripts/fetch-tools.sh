#!/usr/bin/env bash
# Download the two official Temporal release binaries this spike needs into
# .tools/ (git-ignored). Both are pinned and checked against the checksums
# published with each release. Nothing else is downloaded here: PostgreSQL
# comes from the embedded-postgres npm package, everything else from npm.
#
#   .tools/temporal                 the `temporal` CLI 1.9.1 (MIT, github.com/temporalio/cli);
#                                   its `server start-dev` is the dev server with the Web UI
#   .tools/temporal-server/         Temporal Server 1.32.0 (MIT, github.com/temporalio/temporal):
#                                   temporal-server, temporal-sql-tool and sample config
#
# Usage: scripts/fetch-tools.sh        (set TOOLS_DIR to download somewhere else)
set -euo pipefail

CLI_VERSION="1.9.1"
SERVER_VERSION="1.32.0"
here="$(cd "$(dirname "$0")/.." && pwd)"
tools="${TOOLS_DIR:-$here/.tools}"
mkdir -p "$tools"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  os=darwin; arch=arm64 ;;
  Darwin-x86_64) os=darwin; arch=amd64 ;;
  Linux-aarch64) os=linux;  arch=arm64 ;;
  Linux-x86_64)  os=linux;  arch=amd64 ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fetch_verified() { # url checksums_url file_name_in_checksums output
  local url="$1" sums_url="$2" name="$3" out="$4"
  curl -fsSL "$url" -o "$out"
  local want; want="$(curl -fsSL "$sums_url" | awk -v n="$name" '$2 == n {print $1}')"
  [ -n "$want" ] || { echo "no checksum for $name" >&2; exit 1; }
  [ "$(sha256 "$out")" = "$want" ] || { echo "checksum mismatch for $name" >&2; exit 1; }
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

if [ ! -x "$tools/temporal" ]; then
  name="temporal_cli_${CLI_VERSION}_${os}_${arch}.tar.gz"
  base="https://github.com/temporalio/cli/releases/download/v${CLI_VERSION}"
  fetch_verified "$base/$name" "$base/checksums.txt" "$name" "$tmp/cli.tgz"
  tar -xzf "$tmp/cli.tgz" -C "$tools" temporal LICENSE
  echo "installed temporal CLI ${CLI_VERSION}"
fi

if [ ! -x "$tools/temporal-server/temporal-server" ]; then
  name="temporal_${SERVER_VERSION}_${os}_${arch}.tar.gz"
  base="https://github.com/temporalio/temporal/releases/download/v${SERVER_VERSION}"
  fetch_verified "$base/$name" "$base/checksums.txt" "$name" "$tmp/server.tgz"
  mkdir -p "$tools/temporal-server"
  tar -xzf "$tmp/server.tgz" -C "$tools/temporal-server" config temporal-server temporal-sql-tool
  echo "installed Temporal Server ${SERVER_VERSION}"
fi

"$tools/temporal" --version
"$tools/temporal-server/temporal-server" --version
