#!/usr/bin/env bash
set -u
cd /home/jente/dev/wt/i77-batch4
output=docs/process/i77-live-view/final4
fixture=i77-batch4-postgres
fixture_started=0
cleanup() {
  if [ "$fixture_started" -eq 1 ]; then
    docker rm -f "$fixture" > "$output/test-fixture-teardown.log" 2>&1
  fi
}
trap cleanup EXIT
run_check() {
  name=$1
  shift
  "$@" > "$output/$name.log" 2>&1
  result=$?
  printf '%s %s\n' "$name" "$result" >> "$output/check-exits.txt"
  echo "$name exit=$result"
}
: > "$output/check-exits.txt"
run_check lint nice -n 10 npm run lint
run_check typecheck nice -n 10 npm run typecheck
run_check infra-typecheck nice -n 10 npx tsc -p infra/dev-stack/tsconfig.json --noEmit
run_check check-events nice -n 10 npm run check:events
if docker run -d --rm --name "$fixture" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:17@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f > "$output/test-fixture-start.log" 2>&1; then
  fixture_started=1
  fixture_port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$fixture")
  for attempt in $(seq 1 60); do
    if docker exec "$fixture" pg_isready -U postgres > /dev/null 2>&1; then break; fi
    sleep 1
  done
  export PG_TEST_URL="postgres://postgres@127.0.0.1:$fixture_port/postgres"
  run_check test nice -n 10 npm test -- --maxWorkers=2
else
  echo 'test NOT RUN: PostgreSQL fixture failed to start' >> "$output/check-exits.txt"
fi
run_check web-build nice -n 10 npm run build -w apps/web
run_check web-test nice -n 10 npm test -w apps/web -- --watch=false
