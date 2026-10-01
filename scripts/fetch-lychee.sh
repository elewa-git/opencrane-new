#!/bin/sh

set -eu

version=0.23.0
binary=.tools/lychee

if [ -x "$binary" ] && [ "$("$binary" --version 2>/dev/null || true)" = "lychee $version" ]; then
  exit 0
fi

case "$(uname -sm)" in
  'Darwin arm64')
    archive=lychee-arm64-macos.tar.gz
    checksum=1953bb425486e1b887757201e54e8fdf866c9cada6c270d8f6ed21ffbed4145a
    checksum_tool=shasum
    ;;
  'Linux x86_64')
    archive=lychee-x86_64-unknown-linux-gnu.tar.gz
    checksum=1fcb6ccf10d04c22b8c5873c5b9cb7be32ee7423e12169d6f1a79a6f1962ef81
    checksum_tool=sha256sum
    ;;
  *)
    echo "Lychee $version is pinned only for Darwin arm64 and Linux x86_64" >&2
    exit 1
    ;;
esac

mkdir -p .tools
download_dir=$(mktemp -d "${TMPDIR:-/tmp}/opencrane-lychee.XXXXXX")
trap 'rm -rf "$download_dir"' EXIT HUP INT TERM
archive_path=$download_dir/$archive

curl --fail --location --retry 3 \
  "https://github.com/lycheeverse/lychee/releases/download/lychee-v$version/$archive" \
  --output "$archive_path"

if [ "$checksum_tool" = sha256sum ]; then
  printf '%s  %s\n' "$checksum" "$archive_path" | sha256sum -c -
else
  printf '%s  %s\n' "$checksum" "$archive_path" | shasum -a 256 -c -
fi

tar -xzf "$archive_path" -C "$download_dir"
install -m 0755 "$download_dir/lychee" "$binary"
"$binary" --version
