#!/bin/sh
# Fetch the test verifier only; no runtime image includes this binary.
set -eu
version=2.6.1
checksum=064954c5d8c7e3b28188eee5b1727b31c411550bc5fefd41aa672d3c761d103a
binary=.tools/cosign
case "$(uname -sm)" in
  'Linux x86_64') ;;
  *) echo 'Unsupported Cosign test platform' >&2; exit 1 ;;
esac
if [ -x "$binary" ] && printf '%s  %s\n' "$checksum" "$binary" | sha256sum -c --status; then
  exit 0
fi
mkdir -p .tools
download=$(mktemp .tools/cosign.XXXXXX)
trap 'rm -f "$download"' EXIT HUP INT TERM
curl -fsSL --retry 3 --max-time 90 \
  "https://github.com/sigstore/cosign/releases/download/v$version/cosign-linux-amd64" -o "$download"
printf '%s  %s\n' "$checksum" "$download" | sha256sum -c -
chmod 755 "$download"
mv "$download" "$binary"
