#!/bin/sh
# Refresh a candidate on the dev box; never change a running scanner's pinned database.
set -eu
if [ "$#" -ne 1 ]; then
  echo 'Usage: infra/clamav/refresh.sh /absolute/path/to/candidate-signatures' >&2
  exit 2
fi
case "$1" in /*) ;; *) echo 'Use an absolute scratch directory' >&2; exit 2;; esac
mkdir -p "$1"
docker run --rm --entrypoint sh -v "$1:/signatures" \
  clamav/clamav-debian:1.5.2@sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674 \
  -c 'cp -n /var/lib/clamav/*.cvd /signatures/; freshclam --datadir=/signatures --stdout --user=root; cd /signatures; sha256sum ./*.cvd ./*.cld 2>/dev/null > signatures.sha256 || test -s signatures.sha256'
echo 'Candidate refreshed. Review the hashes, build a new database image and pin its digest before deployment.'
