#!/bin/bash
set -euo pipefail
# Local runs produce candidates; consumers trust only a successful GitHub workflow.
[ "${GITHUB_ACTIONS:-}" = true ]
[ "${GITHUB_REPOSITORY:-}" = elewa-git/opencrane-new ]
[ "$(git rev-parse HEAD)" = "$GITHUB_SHA" ]
application_directory=$1
mkdir -p "$application_directory/output"
registry_container=application-packaging-registry
trap 'docker rm -f "$registry_container" >/dev/null' EXIT
docker run -d --name "$registry_container" -p 127.0.0.1:5000:5000 \
  registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
application_tag=127.0.0.1:5000/opencrane/package:ci
docker buildx build --provenance=false --platform linux/amd64 \
  --build-arg "SOURCE_REVISION=$GITHUB_SHA" \
  --output "type=oci,dest=$application_directory/application.tar" \
  --metadata-file "$application_directory/build.json" \
  -f infra/package/Dockerfile -t "$application_tag" .
application_digest=$(node -p "require(process.argv[1])['containerimage.digest']" \
  "$application_directory/build.json")
application_image="127.0.0.1:5000/opencrane/package@$application_digest"
python3 infra/package/publish-image.py "$application_directory/application.tar" \
  http://127.0.0.1:5000 "$application_image"
docker pull "$application_image"
docker image inspect "$application_image" > "$application_directory/inspect.json"
docker image save -o "$application_directory/check.tar" "$application_image"
PACKAGE_IMAGE_NAME="$application_image" PACKAGE_IMAGE_ARCHIVE="$application_directory/check.tar" \
  PACKAGE_IMAGE_REVISION="$GITHUB_SHA" python3 infra/package/image-layers.test.py
sh scripts/fetch-hosted-syft.sh
.tools/syft scan "docker:$application_image" --scope all-layers \
  -o "syft-json=$application_directory/scan.json"
# Use the keyring inside the pinned Debian base; its reviewed checksum is checked below.
docker run --rm --network none --entrypoint cat "$application_image" \
  /usr/share/keyrings/debian-archive-keyring.gpg > "$application_directory/debian-archive-keyring.gpg"
python3 infra/package/check-application.py "$application_directory" "$GITHUB_SHA" "$application_image"
cp "$application_directory/scan.json" "$application_directory/inspect.json" "$application_directory/output/"
rm "$application_directory/check.tar"
