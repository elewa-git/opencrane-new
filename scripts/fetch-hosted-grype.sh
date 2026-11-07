#!/bin/sh
# Keep the pinned test scanner outside runtime images.
set -eu
case "$(uname -sm)" in
  'Linux x86_64') ;;
  *) echo 'Unsupported Grype test platform' >&2; exit 1 ;;
esac
mkdir -p .tools
binary_hash=bd511334178bc3002eb9eb58880f89e01e35f7fed7cfbe671171127a8afa3596
if [ -x .tools/grype ] &&
   printf '%s  %s\n' "$binary_hash" .tools/grype | sha256sum -c --status; then
  exit 0
fi
scratch=$(mktemp -d .tools/grype-download.XXXXXX)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
curl -fsSL --retry 3 --max-time 90 \
  https://github.com/anchore/grype/releases/download/v0.121.0/grype_0.121.0_linux_amd64.tar.gz \
  -o "$scratch/grype.tar.gz"
printf '%s  %s\n' 64e07133d3486115de647a66581461dccf5c732748a0a3119077395565f15519 \
  "$scratch/grype.tar.gz" | sha256sum -c -
tar -xzf "$scratch/grype.tar.gz" -C "$scratch" grype LICENSE
printf '%s  %s\n' "$binary_hash" "$scratch/grype" | sha256sum -c -
mv "$scratch/grype" .tools/grype
