# Scanner refresh on a fresh install

Journey on a fresh dev stack: NOT RUN

## Slot 1 on 26 November 2026

1. CI passed for `ac8f8861abf77d60602ecded19ba79ff145016c0`. Both image jobs
   passed for that commit, and both sets of approval and image files were
   available. [CI](https://github.com/elewa-git/opencrane-new/actions/runs/45807430105),
   [application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45807429814),
   [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45807430276).
2. The slot and load checks passed once, at about 12:42 UTC. The slot-1 claim
   refused, and the next status check timed out. Slot 1 was free again at
   12:50 UTC. The load did not stay below six for five more minutes before the
   two-hour wait ended at 13:06 UTC.
3. The fresh install, uploads at 1280 and 390 px, scanner change and refusal
   were NOT RUN. No stack was claimed or started. There are no screenshots or
   startup logs for this attempt.

## Source checks

- PASS for the changed scanner, approval and upload tests, including 82 Vitest
  tests on the final code. Removing the manifest match made the new upload
  test accept bytes it should have refused.
- PASS for 275 chart and file-service checks, 291 CNPG install checks, the
  slot-specific claim test and the five registry publication checks.
- PASS for typecheck, the event catalogue, Knip, ESLint, changelog, Markdown and
  the public privacy and secret scans.
