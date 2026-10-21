#!/bin/sh
# Run one Codex task headless on the dev box and keep its log.
# Usage: tools/fleet/codex-task.sh <name> <workdir> <prompt-file> [effort] [model]
#   effort: low | medium | high (default high)
#   model:  gpt-6.1-sol (default; regular builds and reviews)
#           gpt-6-luna (mechanical edits)
# Logs go to $FLEET_LOGS/<name>/ (default ~/.fleet): events.jsonl, stderr.log,
# last.md (Codex's final message) and exit (its exit code).
# On the dev box Codex runs without its sandbox: the box is disposable and
# agents have full control of it by the owner's decision.
set -u
NAME="$1"; WORKDIR="$2"; PROMPT="$3"; EFFORT="${4:-high}"; MODEL="${5:-gpt-6.1-sol}"
OPENCRANE_FLEET_TASK=${OPENCRANE_FLEET_TASK-$NAME}
export OPENCRANE_FLEET_TASK
OUT="${FLEET_LOGS:-$HOME/.fleet}/$NAME"; mkdir -p "$OUT"
cd "$WORKDIR" || exit 2
nice -n 10 ionice -c3 codex exec --ignore-user-config -m "$MODEL" -c model_reasoning_effort="$EFFORT" \
  --dangerously-bypass-approvals-and-sandbox \
  -C "$WORKDIR" --json -o "$OUT/last.md" "$(cat "$PROMPT")" < /dev/null > "$OUT/events.jsonl" 2> "$OUT/stderr.log"
echo $? > "$OUT/exit"
echo "codex task $NAME finished with exit $(cat "$OUT/exit")"
tail -c 3000 "$OUT/last.md"
