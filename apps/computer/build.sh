#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p .state
push_registry=${COMPUTER_PUSH_REGISTRY:-127.0.0.1:15001}
forwarder_pid=
if [ -z "${COMPUTER_PUSH_REGISTRY:-}" ]; then
  registry_ip=$(docker inspect k3d-ocn-registry \
    --format '{{with index .NetworkSettings.Networks "k3d-ocn"}}{{.IPAddress}}{{end}}')
  if [ -z "$registry_ip" ]; then
    printf '%s\n' 'The k3d registry is not attached to the k3d-ocn network.' >&2
    exit 1
  fi
  node test/registry-forwarder.mjs "$registry_ip" 5000 15001 &
  forwarder_pid=$!
  trap 'kill "$forwarder_pid" 2>/dev/null || true; wait "$forwarder_pid" 2>/dev/null || true' EXIT
  ready=0
  for attempt in $(seq 1 100); do
    if curl -fsS "http://$push_registry/v2/" -o /dev/null; then
      ready=1
      break
    fi
    sleep 0.2
  done
  if [ "$ready" -ne 1 ]; then
    printf '%s\n' 'The local registry forwarder did not become ready.' >&2
    exit 1
  fi
fi
computer_base=${COMPUTER_BASE:-$push_registry/opencrane/s035@sha256:6fe29bfc4455f19601bbca9e3cffa998fed57632484bb3a624a8da69beecee47}
# These are build tools and data only; neither is copied into the runtime.
curl -fsSL https://github.com/anchore/syft/releases/download/v1.54.0/syft_1.54.0_linux_amd64.tar.gz -o .state/syft.tar.gz
printf '%s\n' '54a87372498168b2d033e876fd41fa4e8035b872699e525a57046e1f2f09c860  .state/syft.tar.gz' | sha256sum -c -
tar -xzf .state/syft.tar.gz -C .state syft
curl -fsSL https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/json/licenses.json -o .state/osi.json
printf '%s\n' 'f728c534d8bd1044fc515a2ddb2292be99559021d830bfa3281be0bcd36302ee  .state/osi.json' | sha256sum -c -
docker build --build-context project=../.. --build-arg COMPUTER_BASE="$computer_base" \
  --target runtime -t ocn-computer-runtime .
docker run --rm --network none \
  -v "$PWD/test:/app/test:ro" \
  --entrypoint node ocn-computer-runtime \
  --experimental-strip-types /app/test/codex-mcp-wire.mjs > .state/codex-mcp-wire.json
docker run --rm -i \
  -v "$PWD/src:/expected/src:ro" \
  -v "$PWD/../../libs/models/src/routing.ts:/expected/routing.ts:ro" \
  -v "$PWD/../../libs/events/src/tool-call.ts:/expected/tool-call.ts:ro" \
  --entrypoint /usr/bin/python3 ocn-computer-runtime - < test/contents.py
.state/syft scan docker:ocn-computer-runtime -o syft-json=.state/sbom.syft.json -o spdx-json=.state/sbom.spdx.json
docker run --rm -i --entrypoint /usr/bin/python3 ocn-computer-runtime - notices < collect-licences.py > .state/licence-evidence.json
docker run --rm -i --entrypoint /usr/bin/python3 ocn-computer-runtime -c "$(cat test/notice-completeness.py)" < .state/licence-evidence.json
python3 check-licences.py .state/sbom.syft.json .state/osi.json .state/licences.json .state/licence-evidence.json
node test/private-capabilities.mjs
# Qualify the tracked manifest before moving the release tag.
docker tag ocn-computer-runtime "$push_registry"/opencrane/computer:qualification
docker push "$push_registry"/opencrane/computer:qualification
docker inspect "$push_registry"/opencrane/computer:qualification --format '{{index .RepoDigests 0}}' |
  sed "s|$push_registry/|k3d-ocn-registry:5000/|" > .state/image.txt
python3 - <<'PYTHON'
import json
from pathlib import Path
path = Path('sandbox-template.json')
template = json.loads(path.read_text())
template['spec']['podTemplate']['spec']['containers'][0]['image'] = Path('.state/image.txt').read_text().strip()
path.write_text(json.dumps(template, indent=2) + '\n')
PYTHON
node --experimental-strip-types test/exec-host.mjs
node test/run.mjs
node test/private-turns.mjs
docker tag ocn-computer-runtime "$push_registry"/opencrane/computer:p2-1
docker push "$push_registry"/opencrane/computer:p2-1
docker inspect ocn-computer-runtime --format '{{.Size}}' > .state/image-size.txt
