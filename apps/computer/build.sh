#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p .state
# These are build tools and data only; neither is copied into the runtime.
curl -fsSL https://github.com/anchore/syft/releases/download/v1.54.0/syft_1.54.0_linux_amd64.tar.gz -o .state/syft.tar.gz
printf '%s\n' '54a87372498168b2d033e876fd41fa4e8035b872699e525a57046e1f2f09c860  .state/syft.tar.gz' | sha256sum -c -
tar -xzf .state/syft.tar.gz -C .state syft
curl -fsSL https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/json/licenses.json -o .state/osi.json
printf '%s\n' 'f728c534d8bd1044fc515a2ddb2292be99559021d830bfa3281be0bcd36302ee  .state/osi.json' | sha256sum -c -
docker build --target runtime -t ocn-computer-runtime .
.state/syft scan docker:ocn-computer-runtime -o syft-json=.state/sbom.syft.json -o spdx-json=.state/sbom.spdx.json
python3 check-licences.py .state/sbom.syft.json .state/osi.json .state/licences.json
# A failed licence check cannot publish the product tag.
docker tag ocn-computer-runtime 127.0.0.1:5001/opencrane/computer:p2-1
docker push 127.0.0.1:5001/opencrane/computer:p2-1
docker inspect 127.0.0.1:5001/opencrane/computer:p2-1 --format '{{index .RepoDigests 0}}' |
  sed 's|127.0.0.1:5001/|k3d-ocn-registry:5000/|' > .state/image.txt
docker inspect ocn-computer-runtime --format '{{.Size}}' > .state/image-size.txt
