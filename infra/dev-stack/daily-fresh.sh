#!/usr/bin/env bash
set -u
umask 077

unset P4_JOURNEY_ATTEMPT

script_directory=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
repository_root=$(CDPATH='' cd "$script_directory/../.." && pwd -P)
ledger_directory="$HOME/.opencrane/daily-fresh"
ledger_file="$ledger_directory/ledger.md"
started_at=$(date +%s)
main_commit=$(git -C "$repository_root" rev-parse origin/main 2>/dev/null || printf 'unknown')
stack_id=
failed_step='claim.sh'
run_result=FAIL
receipt_note=none

ensure_low_priority() {
  local current_niceness
  current_niceness=$(ps -o ni= -p "$$" | tr -d '[:space:]')
  if [ "$current_niceness" -lt 10 ]; then
    exec nice -n 10 "$0" "$@"
  fi
}

write_receipt() {
  local finished_at duration receipt_time
  finished_at=$(date +%s)
  duration=$((finished_at - started_at))
  receipt_time=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  mkdir -p "$ledger_directory"
  chmod 700 "$ledger_directory"
  printf '%s | main commit %s | %s | %s | failed step %s | duration %ss\n' \
    "$receipt_time" "$main_commit" "$run_result" "$receipt_note" \
    "$failed_step" "$duration" >> "$ledger_file"
  chmod 600 "$ledger_file"
}

preserve_failure_artifacts() {
  local evidence_time evidence_directory stack_directory screenshot private_log log_name
  if [ "$run_result" != FAIL ] || [ -z "$stack_id" ]; then
    return
  fi

  evidence_time=$(date -u '+%Y-%m-%dT%H-%M-%SZ')
  evidence_directory="$ledger_directory/$evidence_time"
  stack_directory="$HOME/.config/opencrane/dev-stack-$stack_id"
  mkdir -p "$evidence_directory"
  chmod 700 "$evidence_directory"

  for private_log in "$stack_directory"/*.log; do
    if [ ! -f "$private_log" ] || [ -L "$private_log" ]; then
      continue
    fi
    log_name=$(basename "$private_log")
    case "$log_name" in
      zitadel-*) continue ;;
      last-error.log|failure.log)
        cp "$private_log" "$evidence_directory/$log_name"
        ;;
      *)
        # Keep the last lines that explain a failed process without copying its whole log.
        tail -n 100 "$private_log" > "$evidence_directory/$log_name"
        ;;
    esac
    chmod 600 "$evidence_directory/$log_name"
  done
  for screenshot in "$stack_directory"/*-failure*.png; do
    if [ ! -f "$screenshot" ] || [ -L "$screenshot" ]; then
      continue
    fi
    cp "$screenshot" "$evidence_directory/$(basename "$screenshot")"
    chmod 600 "$evidence_directory/$(basename "$screenshot")"
  done

  receipt_note="failure evidence $evidence_directory"
}

clean_up() {
  local original_status=$?
  trap - EXIT

  preserve_failure_artifacts

  if [ -n "$stack_id" ]; then
    if "$script_directory/down.sh" --id "$stack_id"; then
      :
    else
      run_result=FAIL
      failed_step='down.sh --id'
      original_status=1
    fi
  fi

  write_receipt
  exit "$original_status"
}

trap clean_up EXIT
ensure_low_priority "$@"

if stack_id=$("$script_directory/claim.sh"); then
  case "$stack_id" in
    1|2) ;;
    *)
      run_result=FAIL
      failed_step='claim.sh returned an invalid slot'
      exit 1
      ;;
  esac
else
  run_result=SKIPPED
  receipt_note='skipped: no free slot'
  failed_step=none
  exit 0
fi

export DEV_STACK_ID="$stack_id"
failed_step='up.sh --fresh'
if "$script_directory/up.sh" --fresh; then
  run_result=PASS
  failed_step=none
else
  exit 1
fi
