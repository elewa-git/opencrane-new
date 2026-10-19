#!/bin/sh
# Keep scanner and SPDX data in test tooling, outside runtime images.
set -eu
mkdir -p .tools
binary_hash=d46a9a61a6ae3d367f0a03748c5e9c59253e586c4388ab26ddcacebc2efa0d92
osi_hash=f728c534d8bd1044fc515a2ddb2292be99559021d830bfa3281be0bcd36302ee
case "$(uname -sm)" in
  'Linux x86_64') ;;
  *) echo 'Unsupported Syft test platform' >&2; exit 1 ;;
esac
scratch=$(mktemp -d .tools/syft-download.XXXXXX)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
if ! printf '%s  %s\n' "$binary_hash" .tools/syft | sha256sum -c --status; then
  curl -fsSL --retry 3 --max-time 90 \
    https://github.com/anchore/syft/releases/download/v1.54.0/syft_1.54.0_linux_amd64.tar.gz \
    -o "$scratch/syft.tar.gz"
  printf '%s  %s\n' 54a87372498168b2d033e876fd41fa4e8035b872699e525a57046e1f2f09c860 \
    "$scratch/syft.tar.gz" | sha256sum -c -
  tar -xzf "$scratch/syft.tar.gz" -C "$scratch" syft
  mv "$scratch/syft" .tools/syft
fi
if ! printf '%s  %s\n' "$osi_hash" .tools/osi.json | sha256sum -c --status; then
  curl -fsSL --retry 3 --max-time 90 \
    https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/json/licenses.json \
    -o "$scratch/osi.json"
  printf '%s  %s\n' "$osi_hash" "$scratch/osi.json" | sha256sum -c -
  mv "$scratch/osi.json" .tools/osi.json
fi
