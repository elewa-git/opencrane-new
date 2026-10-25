#!/usr/bin/env bash
set -u
cd <worktree>
output=docs/process/i77-live-view/final4
sampler_pid=
stack_id=
cleanup() {
  if [ -n "$sampler_pid" ]; then
    kill "$sampler_pid" 2>/dev/null || true
    wait "$sampler_pid" || true
  fi
  if [ -n "$stack_id" ]; then
    infra/dev-stack/down.sh --id "$stack_id" > "$output/teardown.log" 2>&1
    echo "TEARDOWN exit=$? stack=$stack_id"
  fi
}
trap cleanup EXIT
for claim_attempt in $(seq 1 11); do
  if stack_id=$(infra/dev-stack/claim.sh 2>> "$output/claim.log"); then
    echo "CLAIM stack=$stack_id attempt=$claim_attempt"
    break
  fi
  stack_id=
  if [ "$claim_attempt" -eq 11 ]; then
    echo 'CLAIM FAILED after initial attempt and ten retries'
    exit 1
  fi
  echo "CLAIM waiting two minutes before retry $claim_attempt"
  sleep 120
done
export DEV_STACK_ID="$stack_id"
export ZITADEL_KEY_FILE=<worktree>/.keys/.zitadel-key
printf '%s\n' "$stack_id" > "$output/claimed-stack.txt"
infra/dev-stack/up.sh --fresh > "$output/startup.log" 2>&1
echo "STARTUP exit=$?"
echo 'READY: batch, fresh, repeat, finish'
while IFS= read -r action; do
  case "$action" in
    batch)
      python3 infra/dev-stack/live-view-resources.py "$output/resources.jsonl" &
      sampler_pid=$!
      node --experimental-strip-types infra/dev-stack/live-view-repeat.ts "$output" > "$output/batch.log" 2>&1
      echo "BATCH exit=$?"
      kill "$sampler_pid"
      wait "$sampler_pid" || true
      sampler_pid=
      ;;
    fresh|repeat)
      journey_output="$output/core-$action"
      mkdir -p "$journey_output"
      if [ "$action" = fresh ]; then
        infra/dev-stack/up.sh --fresh > "$journey_output/startup.log" 2>&1
      else
        infra/dev-stack/up.sh > "$journey_output/startup.log" 2>&1
      fi
      journey_status=$?
      echo "CORE $action exit=$journey_status"
      printf '%s\n' "$journey_status" > "$journey_output/exit-code.txt"
      for width in 390 1280; do
        if [ -f "docs/process/live-view/conversation-$width.json" ]; then
          cp "docs/process/live-view/conversation-$width.json" "$journey_output/live-view-$width.json"
        fi
      done
      ;;
    finish) exit 0 ;;
    *) echo 'Unknown action' ;;
  esac
  echo READY
done
