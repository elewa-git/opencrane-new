#!/usr/bin/env bash
set -u
umask 077

unset P4_JOURNEY_ATTEMPT DEV_REAL_PROVIDER_FILE DEV_REAL_PROVIDER MODEL_KEY_FILE
unset DEMO_ALLOWANCE_CENTS
export P4_JOURNEY_ATTEMPT="nightly-$(date -u +%Y%m%dT%H%M%S)-$(node -p 'crypto.randomUUID()')"

script_directory=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
repository_root=$(CDPATH='' cd "$script_directory/../.." && pwd -P)
ledger_directory="$HOME/.opencrane/daily-fresh"
ledger_file="$ledger_directory/ledger.md"
started_at=$(date +%s)
source_commit=$(git -C "$repository_root" rev-parse HEAD 2>/dev/null || printf 'unknown')
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
  printf '%s | source commit %s | %s | %s | failed step %s | duration %ss | attempt %s\n' \
    "$receipt_time" "$source_commit" "$run_result" "$receipt_note" \
    "$failed_step" "$duration" "$P4_JOURNEY_ATTEMPT" >> "$ledger_file"
  chmod 600 "$ledger_file"
}

preserve_failure_artifacts() {
  local evidence_directory stack_directory screenshot private_log log_name
  if [ "$run_result" != FAIL ] || [ -z "$stack_id" ]; then
    return
  fi

  evidence_directory="$ledger_directory/$P4_JOURNEY_ATTEMPT"
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
    esac
    if node "$script_directory/sanitise-evidence.mjs" "$stack_directory" \
        "$private_log" "$repository_root" > "$evidence_directory/$log_name" 2>/dev/null; then
      :
    else
      printf '%s\n' 'Log withheld: sanitisation failed.' > "$evidence_directory/$log_name"
    fi
    chmod 600 "$evidence_directory/$log_name"
  done
  for screenshot in "$stack_directory"/*-failure*.png; do
    if [ ! -f "$screenshot" ] || [ -L "$screenshot" ]; then
      continue
    fi
    cp "$screenshot" "$evidence_directory/$(basename "$screenshot")"
    chmod 600 "$evidence_directory/$(basename "$screenshot")"
  done

  preserve_group_artifacts "$stack_directory" "$evidence_directory"
  receipt_note="failure evidence $evidence_directory"
}

preserve_group_artifacts() {
  local source_directory target_directory source_file relative_file target_file
  source_directory="$1/p4-journey/$P4_JOURNEY_ATTEMPT"
  target_directory="$2/p4-journey/$P4_JOURNEY_ATTEMPT"
  if [ ! -d "$source_directory" ] || [ -L "$1/p4-journey" ] || [ -L "$source_directory" ]; then
    return
  fi
  while IFS= read -r source_file; do
    relative_file=${source_file#"$source_directory/"}
    target_file="$target_directory/$relative_file"
    mkdir -p "$(dirname "$target_file")"
    chmod 700 "$(dirname "$target_file")"
    case "$source_file" in
      *.png) cp "$source_file" "$target_file" ;;
      */receipt.json)
        if ! node "$script_directory/sanitise-evidence.mjs" "$1" "$source_file" \
            "$repository_root" > "$target_file" 2>/dev/null; then
          printf '%s\n' 'Receipt withheld: sanitisation failed.' > "$target_file"
        fi
        ;;
    esac
    chmod 600 "$target_file"
  done < <(find "$source_directory" -type f \( -name '*.png' -o -name receipt.json \))
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
      stack_id=
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
