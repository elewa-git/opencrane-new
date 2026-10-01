#!/usr/bin/env bash
# Builds the computer image with Cloud Build (no local Docker) and pushes it to Artifact Registry:
#   europe-west1-docker.pkg.dev/weownai-proto/ocn-spike/computer:<tag>
#
#   ./build.sh [TAG]        default tag: dev-<date>-<time>
#
# It stages a small build context under .state/context (this folder's files plus a copy of the bridge and local
# proxy sources from spike S0.1), uploads it to our own bucket, and runs cloudbuild.yaml.
# Needs the repository and bucket from: infra/spike-cluster/create.sh registry
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/spike-cluster/lib.sh
source "${HERE}/../../infra/spike-cluster/lib.sh"

TAG="${1:-dev-$(date -u +%Y%m%d-%H%M)}"
IMAGE="${SPIKE_REGION}-docker.pkg.dev/${SPIKE_PROJECT}/${SPIKE_REPO}/computer"
S0_1_SRC="${HERE}/../s0-1-codex/src"
CONTEXT="${HERE}/.state/context"

[[ "${TAG}" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || die "invalid image tag"
cost_guard
gc artifacts repositories describe "${SPIKE_REPO}" --location "${SPIKE_REGION}" --format='value(name)' >/dev/null \
  || die "repository ${SPIKE_REPO} not found; run infra/spike-cluster/create.sh registry first"
gc storage buckets describe "gs://${SPIKE_BUILD_BUCKET}" --format='value(name)' >/dev/null \
  || die "bucket ${SPIKE_BUILD_BUCKET} not found; run infra/spike-cluster/create.sh registry first"

log "staging build context in ${CONTEXT}"
rm -rf "${CONTEXT}"
mkdir -p "${CONTEXT}/s0-1-src" "${CONTEXT}/bin"
cp "${HERE}"/{Dockerfile,cloudbuild.yaml,ci-selftest.sh,package.json,package-lock.json,constraints.txt,bridge-tsconfig.json,supervisord.conf,health.mjs,selftest.mjs,tcp-relay.mjs,licences.mjs,inventory.py} "${CONTEXT}/"
cp "${HERE}"/bin/* "${CONTEXT}/bin/"
# The S0.1 sources are copied as they are right now; the checksums go into the image so we can tell which version it holds.
cp "${S0_1_SRC}"/{bridge.ts,local-proxy.ts,codex-config.ts,model-stub-server.ts,mcp-stub-server.ts} "${CONTEXT}/s0-1-src/"
(cd "${CONTEXT}/s0-1-src" && shasum -a 256 ./*.ts) > "${CONTEXT}/s0-1-src.sha256"
cat "${CONTEXT}/s0-1-src.sha256"

log "submitting to Cloud Build (region ${SPIKE_REGION}); image ${IMAGE}:${TAG}"
ledger_sample "build-reserved" 60 "30 minute maximum Cloud Build reservation; includes failed builds"
started=$SECONDS
gc builds submit "${CONTEXT}" \
  --region "${SPIKE_REGION}" \
  --config "${CONTEXT}/cloudbuild.yaml" \
  --gcs-source-staging-dir "gs://${SPIKE_BUILD_BUCKET}/source" \
  --substitutions "_IMAGE=${IMAGE},_TAG=${TAG}"
minutes=$(( (SECONDS - started + 59) / 60 ))

digest="$(gc artifacts docker images describe "${IMAGE}:${TAG}" --format='value(image_summary.digest)')"
log "built ${IMAGE}:${TAG}@${digest}"
printf '%s@%s\n' "${IMAGE}:${TAG}" "${digest}" > "${HERE}/.state/last-image.txt"

ledger_sample "build-finished" 0 "Cloud Build ${minutes} min, ${TAG}; reserved 60 cents before submission"
