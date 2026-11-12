#!/usr/bin/env bash
set -euo pipefail

spike=spikes/s0-9-postgres-event-store
export PG_TEST_URL=${PG_TEST_URL:-postgres://postgres:test@127.0.0.1:55432/postgres}
nice -n 10 npx vitest run --config "$spike/vitest.config.ts" \
  --reporter=json --outputFile=/tmp/clean-1094-contracts.json
nice -n 10 node --experimental-strip-types "$spike/src/record-contracts.ts" \
  /tmp/clean-1094-contracts.json

if docker container inspect pgtest-clean-1094 >/dev/null 2>&1; then
  echo 'The measurement container already exists; refusing to reuse it.' >&2
  exit 1
fi
docker run -d --name pgtest-clean-1094 -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=test-only postgres:17.6-alpine
function cleanup() {
  docker rm -f -v pgtest-clean-1094
}
trap cleanup EXIT
binding=$(docker port pgtest-clean-1094 5432)
export SPIKE_PG_URL="postgres://postgres:test-only@127.0.0.1:${binding##*:}/postgres"
ready_deadline=$((SECONDS + 60))
until docker exec pgtest-clean-1094 pg_isready -U postgres >/dev/null 2>&1; do
  if (( SECONDS >= ready_deadline )); then exit 1; fi
  sleep 0.2
done
nice -n 10 node --experimental-strip-types "$spike/src/record-environment.ts"
: > "$spike/results/latency.jsonl"
: > "$spike/results/pressure.jsonl"
nice -n 10 npx vitest run --config "$spike/volume.config.ts" --reporter=verbose
nice -n 10 npx vitest run --config "$spike/pressure.config.ts" --reporter=verbose
nice -n 10 node --experimental-strip-types "$spike/src/inventory.ts"
