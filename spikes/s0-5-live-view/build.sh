#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
state=spikes/s0-5-live-view/.state
mkdir -p "$state"
if [ ! -f "$state/kasm.deb" ]; then
  curl -fL -o "$state/kasm.deb" https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_bookworm_1.5.0_amd64.deb
fi
printf '%s\n' "770fd3df51510beecc89666879d82faf411276e68c6e11df612f736b891b5f71  $state/kasm.deb" | sha256sum -c -
docker build -f spikes/s0-5-live-view/Dockerfile -t 127.0.0.1:5001/opencrane/s035:spike .
docker push 127.0.0.1:5001/opencrane/s035:spike
docker inspect 127.0.0.1:5001/opencrane/s035:spike --format '{{index .RepoDigests 0}}' |
  sed 's|127.0.0.1:5001/|k3d-ocn-registry:5000/|' > "$state/image.txt"
