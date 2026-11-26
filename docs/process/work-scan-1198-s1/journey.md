# Scanner refresh on a fresh install

Journey on a fresh dev stack: FAIL

## Fresh packaged run on 26 November 2026

Slot 1 used product commit `ac8f8861abf77d60602ecded19ba79ff145016c0` and
six new volume claims. The claim succeeded at 17:29 UTC after five minutes
with one-minute load below six. An earlier qualifying window at 17:15 UTC
ended with a refused claim. [Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45807429814),
[initial scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45807430276),
[newer scanner approval on main](https://github.com/elewa-git/opencrane-new/actions/runs/45820515076).

| Step | Verdict | Observation |
| --- | --- | --- |
| Fresh packaged install | PASS | Package preparation, private settings, `package-up --id 1` and `package-check --id 1` passed. Package-up used `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`, the documented local host exception. |
| Scan and accept a PDF at 1280 and 390 px | PASS | Both uploads returned HTTP 201 and showed Ready. [1280 px](screenshots/upload-before-1280.png), [390 px](screenshots/upload-before-390.png). |
| `package-refresh-scanner --id 1` replaces the running scanner | FAIL | The command exited 1 and reported that the running package did not have the checked scanner refresh settings. The original scanner stayed Ready. |
| Scan and accept an upload after the swap | NOT RUN | The swap failed. |
| Refuse a mismatched image | PASS | Supplying the initial image pin exited 1 with the image mismatch refusal. The Ready scanner pod, deployment generation, engine pin and approval ConfigMap version were the same before and after. |
| Release slot 1 | PASS | `package-down --id 1` and `down.sh --id 1` exited 0. The slot reported free. |

The refresh code passed `jsonpath={.data.release.json}` to Kubernetes. The
JavaScript string consumed the backslash that marks the dot in the
`release.json` key as literal. The same read against the owned install
returned zero bytes with the command's argument and 308 decoded bytes with
the dot escaped. The refresh refused before publishing the replacement.

The [result](result.json) records image digests, manifest hashes, claim creation
times and the scanner observations. Startup logs, 18 service logs and package
events were retained privately before teardown. The private
`refresh-release-lookup.log` records the diagnostic read. The slot had no
`failure.log`.

Typecheck, Knip, the event catalogue and changelog checks passed in this run.

## Earlier slot-1 attempt on 26 November 2026

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
