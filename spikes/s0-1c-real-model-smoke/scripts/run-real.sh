#!/bin/bash
# Only the orchestrator runs this, after the owner approves the real call.
set +x
set +v
set -euo pipefail
umask 077
ulimit -c 0
cd "$(dirname "$0")/.."
root="$PWD"
node_bin="$(command -v node)"
clean_path="$(dirname "$node_bin"):/usr/bin:/bin:/usr/sbin:/sbin"
owner_home="$HOME"
model="${MODEL:-}"
# Do not source model.env: treating a setting as shell code invites execution.
[[ -n "$model" ]] || { echo 'MODEL is required and must have a confirmed price.'; exit 1; }
env -i PATH="$clean_path" MODEL="$model" "$node_bin" --import tsx scripts/runner.ts preflight >/dev/null 2>&1 || { echo 'MODEL is unpriced or its price is unconfirmed.'; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) binary="$root/.tools/agentgateway-darwin-arm64" ;;
  Linux-x86_64) binary="$root/.tools/agentgateway-linux-amd64" ;;
  *) exit 1 ;;
esac
[[ $# == 0 && -x "$binary" ]] || exit 1
# Verify the installed gateway without fetching anything during a real run.
case "$binary" in
  *darwin-arm64) expected=da432d35bd696da0564f7b2b6bbc783542b6b9c616d6c0c4d4c3daef9dfa11a1 ;;
  *linux-amd64) expected=daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b ;;
esac
printf "%s  %s\n" "$expected" "$binary" | shasum -a 256 -c - >/dev/null 2>&1 || exit 1
mkdir -p .state
run_dir="$(mktemp -d "$root/.state/real-XXXXXX")"
gateway_pid='' runner_pid='' logger_pid=''
cleanup() {
  code=$?
  trap - EXIT INT TERM
  for pid in "$runner_pid" "$gateway_pid"; do
    if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  # Children have bounded shutdown; allow Codex and gateway to drain.
  for i in {1..50}; do
    alive=0
    for pid in "$runner_pid" "$gateway_pid"; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [[ $alive == 0 ]] && break
    sleep 0.1
  done
  for pid in "$runner_pid" "$gateway_pid" "$logger_pid"; do
    if [[ -n "$pid" ]]; then kill -KILL "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  rm -f "$run_dir/gateway.pipe"
  # Pass the pattern through a file descriptor, never through argv or a file.
  env -i PATH="$clean_path" SCAN_HOME="$owner_home" /bin/bash scripts/leak-check.sh 3< <(cat '/Users/jenterosseel/Documents/GitHub/opencrane-2/keys/.openai-key') || code=1
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkfifo "$run_dir/gateway.pipe"
env -i PATH="$clean_path" "$node_bin" --import tsx scripts/gateway-log.ts < "$run_dir/gateway.pipe" > "$run_dir/usage.jsonl" 2>/dev/null &
logger_pid=$!
env -i PATH="$clean_path" MODEL="$model" "$node_bin" --import tsx scripts/runner.ts real "$run_dir" > "$run_dir/result.log" 2>/dev/null &
runner_pid=$!
for i in {1..300}; do
  [[ -f "$run_dir/prepared" ]] && break
  kill -0 "$runner_pid" 2>/dev/null || exit 1
  sleep 0.1
done
[[ -f "$run_dir/prepared" ]] || exit 1
# The secret is expanded inside this clean child shell, immediately before exec.
# The command text in ps contains the file path, never the file contents.
env -i PATH="$clean_path" /bin/bash --noprofile --norc -c '
  set +x
  set +v
  ulimit -c 0
  OPENAI_API_KEY="$(cat /Users/jenterosseel/Documents/GitHub/opencrane-2/keys/.openai-key)" exec "$1" -f "$2"
' smoke-gateway "$binary" "$run_dir/agentgateway.yaml" > "$run_dir/gateway.pipe" 2>&1 &
gateway_pid=$!
wait "$runner_pid"
runner_pid=''
# result.log contains only locally constructed counters, ids and costs.
cat "$run_dir/result.log"
