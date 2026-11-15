# Scheduled pilot backup

Journey on a fresh dev stack: **NOT RUN**. Preparation: **PARTIAL**.
Application image qualification: **FAIL**. The draft must not merge.

Date: 15 November 2026. Tested source:
`aa7ab5e76c1756286cf20b4be4e872e685649e75`, branch `work/pilot-15-s2`.
This was a journey-only run, with no product, test or image-review changes.
The scanner approval blocker is resolved for this exact source. The packaged
application could not be admitted because its image checks failed.

## Live steps and observations

| Step | Verdict | Observation |
| --- | --- | --- |
| Wait for source CI | PASS | [Run 43736252198](https://github.com/elewa-git/opencrane-new/actions/runs/43736252198) passed all nine jobs. |
| Obtain exact-head scanner approval | PASS | No run existed, so the documented manual dispatch was used on this branch. [Run 43736583996](https://github.com/elewa-git/opencrane-new/actions/runs/43736583996) passed and uploaded both unexpired artifacts for the tested source. |
| Wait for load and claim a fresh secondary slot | PASS | Waited while the 1-minute load exceeded 10. It was 0.82 immediately before `claim.sh`; slot 1 was claimed. |
| `package-prepare --id 1` | PASS | Fetched the CI approval and scanner archive through the normal guard and published its unchanged scanner digest. No local approval or bypass was used. |
| Private package settings | PASS | `prepare.ts` succeeded with the requested sign-in key-file setting. `PACKAGE_SKIP_PROVIDER_SETUP=1` reused the test sign-in setup in read-only mode. The fixed private stack directory was outside the repository. |
| `package-check --id 1` | PASS | Verified namespace ownership only; this does not prove installation or readiness. |
| Build and inspect this source's application image | PARTIAL | Build, Syft all-layer scan and candidate licence check passed. The candidate contained 580 checked components. The saved-image suite failed one of 14 tests; promotion also failed. See the blockers below. |
| `package-up --id 1` | NOT RUN | The image did not pass the required pre-installation checks. |
| A person uploads a file and chats | NOT RUN | No application installation was admitted. |
| Operator triggers the scheduled backup and sees completion | NOT RUN | Requires the packaged application. |
| Operator lists the backup and reads its event/database/file manifest | NOT RUN | No live backup was produced. |
| Deliberately broken backup part fails visibly | NOT RUN | Requires the packaged application. |
| Packaged screenshots at 1280 and 390 px | NOT RUN | No packaged browser was available. The existing pictures are earlier Compose startup evidence only. |
| `package-down --id 1` and `down.sh --id 1` | PASS | Both exited zero and released the secondary namespace and slot. |

The environment used the local stand-in model and retained the fleet task marker.
The owner stack was not touched. [Operator output](operator-output.txt) was saved
before cleanup and includes the scanner run id, hashes and safe gate diagnostics.
It contains no Secret data, credentials or private host paths.

## Application image blockers

The source-bound build succeeded. Its configuration digest was
`sha256:02fa0a5dd46dcbe993d4f3fabda1891683683d447913b546529676870e08f242`.
The saved-image layer/bootstrap suite ran 14 tests in 116.002 seconds; 13 passed.
`test_development_files_stay_within_the_narrow_allowlist` failed at
`infra/package/image-layers.test.py:157`: the package-file allowlist does not
include `scheduled-backup-run.ts`, which the new image contains.

The documented promotion command exited one with
`FAIL package promotion: evidence is missing or does not match`.
Running the same checker with its fixed diagnostic exposed the precise cause:
`Package promotion covers a different source revision`.
The checked-in application review and inventory cover
`1429086ff5eb20db05f1dccceb7c0095940b2fe1`; the requested source is
`aa7ab5e76c1756286cf20b4be4e872e685649e75`. The reviewed source has no scheduled
backup runner. Installing its older image cannot qualify this slice.

No code, allowlist, image review, inventory or promotion rule was changed during
this evidence-only run. No application image was published or promoted. Passing
the candidate licence check does not grant image promotion. A build with the
reviewed source, image and test expectations aligned is needed before the live
journey can continue. Scanner approval must match that future checkout too.

## Own checks in this run

- **PASS:** root typecheck, including every workspace, package and dev stack.
- **PASS:** Markdown check, event catalogue, Knip and changelog checks. Knip
  reported its two existing configuration hints.
- **PASS:** exact-head initial CI, scanner approval, package preparation, private
  package settings, namespace ownership, application build and candidate licences.
- **FAIL:** saved-image layer/bootstrap suite and exact-source image promotion.
- **NOT RUN:** changed-file ESLint and source unit tests; no code changed.
- Public privacy, secret scans and evidence-only follow-up CI are recorded in
  the PR Evidence.

## Earlier attempts

Earlier fresh Compose startup checks reported 37 passing observations. Scanner
approval was then refused at metadata with reason `malformed`, including after
the documentation-only rebase. Those attempts were cleaned up. They did not
qualify a packaged installation. The existing
[1280 px picture](compose-startup-chat-1280.png) and
[390 px picture](compose-startup-chat-390.png) remain supplementary Compose
startup evidence and are not packaged screenshots.

## Earlier builder source checks

The following results were recorded during implementation before this journey
run. No earlier live result is counted as acceptance for this attempt.

- **PASS:** four new fault-injection cases first failed with a missing `.lock`
  while restart and marker write or sync both failed. The failing tests were
  committed before the repair in `cfb300852` (after rebasing).
- **PASS:** final changed tests twice: 15 collector cases, three real-SDK storage
  cancellation cases and five existing credential cases; 23 cases per run.
  The final runs took 12.09 and 10.58 seconds.
- **PASS:** all 251 chart-render cases twice, in 78.33 and 35.32 seconds.
- **PASS:** root typecheck, including every workspace, package and dev stack.
  Package typecheck passed again after the final fault-fixture cleanup.
- **PASS:** changed-file type-aware ESLint, including infrastructure through its
  own TypeScript project, with the existing rules and production size limits.
- **PASS:** event catalogue, Knip and changelog checks. Knip reported two
  configuration hints. No event contract or dependency changed.
- **PASS:** Markdown check across all 523 selected files after rebasing, plus
  changelog and README checks. The separate main repair removed the inherited
  ClamAV and dev-stack README failures. No further edits were made to those
  READMEs or the package README. The package stays within its recorded allowance.
- Final public/privacy checks are recorded in the PR Evidence.

## Repair and scope

Restart success now controls cleanup independently of marker storage. A failed
restart retains the original synced lock and private partial set even if the
marker cannot be written or synced. Another run is refused. The operator receives
an explicit maintenance failure; `resume_marker` keeps both failure stages while
withholding credential-bearing dependency output.

The fixture uses the shared `BackupPoint` type. Fault injection checks the native
filesystem methods before wrapping them and keeps their original receiver. The
collector reuses its existing restart helper, schemas, byte digest, event snapshot
collector and storage lease. Part capture stays separate from publication and
cleanup. The largest production function has 59 counted lines; all have at most
five parameters. No dependency, size-limit increase or speculative module was added.

Shipped package source and chart: 672 added plus deleted lines; four Docker context
entries make 676 total. Tests, documents, receipts and test configuration are excluded.
Restore, computer homes, three event-log copies and off-machine durability remain
outside this slice. Independent review belongs to the orchestrator; this receipt
records only the builder's own checks.
