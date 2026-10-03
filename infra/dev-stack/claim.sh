#!/bin/sh
set -eu
for stack_id in 1 2; do
  if "$(dirname "$0")/run.sh" claim --id "$stack_id"; then exit 0; fi
done
echo 'Both secondary stack ids are claimed; down the owning stack to release one.' >&2
exit 1
