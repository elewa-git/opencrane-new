#!/bin/bash
set -euo pipefail
# This produces candidates locally; only a successful GitHub run grants approval.
[ "${GITHUB_ACTIONS:-}" = true ]
[ "${GITHUB_REPOSITORY:-}" = elewa-git/opencrane-new ]
python3 infra/package/publish-image.test.py
package_directory=$1
mkdir -p "$package_directory/databases" "$package_directory/output"
node infra/clamav/refresh.mjs "$package_directory/candidate"
node --input-type=module - "$package_directory" <<'JS'
import { copyFile, readFile } from 'node:fs/promises';
const directory = process.argv[2];
const manifest = JSON.parse(await readFile(`${directory}/candidate/signatures.json`, 'utf8'));
for (const database of manifest.databases) {
  await copyFile(`${directory}/candidate/${database.file}`, `${directory}/databases/${database.file}`);
}
await copyFile(`${directory}/candidate/signatures.json`, `${directory}/output/signatures.json`);
JS
# Use a disposable registry on this runner to resolve the pushed manifest digest.
registry_container=clamav-packaging-registry
trap 'docker rm -f "$registry_container" >/dev/null' EXIT
docker run -d --name "$registry_container" -p 127.0.0.1:5000:5000 \
  registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
scanner_tag=127.0.0.1:5000/opencrane/scanner:ci
docker buildx build --provenance=false --platform linux/amd64 \
  --output "type=oci,dest=$package_directory/scanner.tar" \
  --metadata-file "$package_directory/build.json" \
  --build-context "signatures=$package_directory/databases" \
  -f infra/package/Scanner.Dockerfile -t "$scanner_tag" .
scanner_digest=$(node -p "require(process.argv[1])['containerimage.digest']" "$package_directory/build.json")
scanner_image="127.0.0.1:5000/opencrane/scanner@$scanner_digest"
python3 infra/package/publish-image.py "$package_directory/scanner.tar" \
  http://127.0.0.1:5000 "$scanner_image"
docker pull "$scanner_image"
docker image save -o "$package_directory/scanner-check.tar" "$scanner_image"
sh scripts/fetch-hosted-syft.sh
.tools/syft scan "docker:$scanner_image" -o "syft-json=$package_directory/scanner-syft.json"
python3 infra/clamav/check-package.py "$package_directory/scanner-check.tar" \
  "$package_directory/scanner-syft.json"
approved_sha=$(sha256sum "$package_directory/output/signatures.json" | cut -d ' ' -f 1)
node infra/clamav/release.mjs "$package_directory/output/signatures.json" \
  "$approved_sha" "$scanner_image" "$package_directory/release"
cp "$package_directory/release/release.json" "$package_directory/output/release.json"
node --input-type=module - "$package_directory" "$scanner_image" "$approved_sha" <<'JS'
import { writeFile, appendFile } from 'node:fs/promises';
const [directory, image, approvedSha] = process.argv.slice(2);
const imageDigest = image.slice(image.indexOf('@') + 1);
const record = { runId: Number(process.env.GITHUB_RUN_ID), revision: process.env.GITHUB_SHA,
  imageDigest, approvedSha };
await writeFile(`${directory}/output/approval.json`, JSON.stringify(record) + '\n');
await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `Approved manifest SHA-256: \`${approvedSha}\`\n\nScanner image: \`${imageDigest}\`\n`);
JS
