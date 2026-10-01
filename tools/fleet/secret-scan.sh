#!/bin/bash
# Fails (exit 1) if the staged diff, or the commit range given as $1, contains a secret.
# Checks common token shapes; also checks every file listed in $SECRET_FILES
# (colon-separated) by content without printing it. Known test placeholders
# (do-not-leak, dummy, placeholder, example, not-a-secret, fake) are allowed.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
if [ $# -ge 1 ]; then DIFF=$(git log -p "$1"); else DIFF=$(git diff --cached); fi
fail=0
IFS=: read -r -a files <<< "${SECRET_FILES:-}"
for f in "${files[@]}"; do
  [ -s "$f" ] || continue
  if printf '%s' "$DIFF" | grep -qF -f <(tr -d '\n' < "$f"); then echo "SECRET: the contents of $f are in the diff"; fail=1; fi
done
hits=$(printf '%s' "$DIFF" | grep -nE 'sk-[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}' | grep -viE 'do-not-leak|dummy|placeholder|example|not-a-secret|fake')
if [ -n "$hits" ]; then
  echo "SECRET-SHAPED: $(printf '%s\n' "$hits" | wc -l | tr -d ' ') line(s):"
  printf '%s\n' "$hits" | sed -E 's/(sk-|gh[pousr]_|github_pat_|AKIA|xox[baprs]-|AIza)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/\1\2…/g' | cut -c1-160
  fail=1
fi
[ $fail -eq 0 ] && echo "secret-scan: CLEAN"
exit $fail
