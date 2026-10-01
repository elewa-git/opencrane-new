#!/bin/sh
set -eu
version=2.15.0
binary=.tools/nats-server
if [ -x "$binary" ] && [ "$("$binary" --version)" = "nats-server: v$version" ]; then
  exit 0
fi
case "$(uname -sm)" in
  'Darwin arm64') platform=darwin-arm64; checksum=e1c4e22d70bd44abfa0bcb3c16f7cf0c66f648c2e728c58924e8a1ce88913cc8 ;;
  'Linux x86_64') platform=linux-amd64; checksum=5d2c51caca950333aba84911df7d377f826f3a59ec36061c6539105084f65c92 ;;
  *) echo 'Unsupported NATS test platform' >&2; exit 1 ;;
esac
mkdir -p .tools
download_dir=$(mktemp -d "${TMPDIR:-/tmp}/opencrane-nats.XXXXXX")
trap 'rm -rf "$download_dir"' EXIT HUP INT TERM
archive=nats-server-v$version-$platform
curl -fsSL --retry 3 "https://github.com/nats-io/nats-server/releases/download/v$version/$archive.tar.gz" -o "$download_dir/archive.tar.gz"
if command -v sha256sum >/dev/null; then
  printf '%s  %s\n' "$checksum" "$download_dir/archive.tar.gz" | sha256sum -c -
else
  printf '%s  %s\n' "$checksum" "$download_dir/archive.tar.gz" | shasum -a 256 -c -
fi
tar -xzf "$download_dir/archive.tar.gz" -C "$download_dir"
install -m 0755 "$download_dir/$archive/nats-server" "$binary"
