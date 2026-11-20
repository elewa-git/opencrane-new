# Pilot backup restore journey

Journey on a fresh dev stack: PASS

Run date: 19 November 2026. Qualified source:
[d29df05b1](https://github.com/elewa-git/opencrane-new/commit/d29df05b1d51bc4478019cd77e3d505b8b7729fb).
Use successful CI [application approval](https://github.com/elewa-git/opencrane-new/actions/runs/44614979319)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/44614984931).
The pull request records the final-head image approvals and repeat after this
receipt is committed. The model uses the local stand-in; real-provider operation
is NOT RUN.

## Steps observed

1. Wait for both secondary slots to be free and for load to stay below 6 for five
   minutes, checking every 30 seconds. Claim a slot, run ordinary `up --fresh`,
   check it and run `down`. Apply the same admission rule before the packaged claim.
2. Run `package-prepare`, `package-up` and `package-check` with the exact-source
   CI-approved images. Sign in, create a chat and upload `project.pdf`.
3. Read project code `Willow-47`. Download the PDF at 1280 px and 390 px and compare
   its complete bytes and SHA-256 with the upload.
4. Start a Job from the installed scheduled-backup CronJob. Check the completed
   event, database and file set through the catalogue. Its exact saved event point is 46.
5. Attempt restore into the source. Require `non_empty` refusal and identical
   event history through position 47, recorded immediately before that attempt.
6. Send a later message and retain the completed set privately. Remove the source
   and release its slot. Repeat admission, claim a clean slot and install restore
   mode. Require new namespace and volume UIDs before importing the set; stop the
   destination catalogue.
7. Force exit 137 immediately after native events are restored and the database
   stage is durably recorded. Require the reader to remain stopped. Run the normal
   packaged restore CLI in a second Job and require all three parts to verify.
8. Sign in as the same person at both widths. Read the saved reply, require the
   later message to be absent and download the identical original PDF. Require
   anonymous history refusal and `restore_read_only` on an owner-claim write.
9. Require the exact saved event point after browser reads. Check that workers and
   scheduled backup remain held. Rerun the completed restore and repeat both
   browser widths, downloads and the unchanged event-point assertion.
10. Run `package-down` and `down`; check successful teardown and slot release.

## Results

| Condition | Result |
| --- | --- |
| Ordinary fresh secondary startup, status and teardown | PASS |
| Fresh packaged source sign-in, chat, upload and identical downloads at both widths | PASS |
| Scheduled backup and catalogue verification | PASS |
| Non-empty refusal without changing prior event history | PASS |
| Source removed; destination namespace and volumes are new | PASS |
| Crash after durable native events; reader stays stopped | PASS |
| Normal packaged CLI resumes and verifies all three parts | PASS |
| Restored sign-in, saved chat and identical downloads at both widths | PASS |
| Anonymous read refused; writes held; no appended events | PASS |
| Completed rerun and repeated browser checks | PASS |
| Package teardown and slot release | PASS |

## Screenshots

- [Source at 1280 px](screenshots/source-1280.png)
- [Source at 390 px](screenshots/source-390.png)
- [Restored at 1280 px](screenshots/restored-1280.png)
- [Restored at 390 px](screenshots/restored-390.png)

## Other evidence and limits

Changed tests: PASS twice. Thirty-one Vitest files executed 864 cases per
repetition, and five Node test files executed 117. Typecheck, `check:events`, knip,
changed-file ESLint with zero warnings, changelog lint, Markdown lint,
whole-stream-read lint and README checks passed. Privacy and secret scans passed
before the source push. Required CI for the qualified
source is [PASS](https://github.com/elewa-git/opencrane-new/actions/runs/44614873657).

Guard-removal checks: PASS. Nineteen restore/review guards, the routine input's
final authority callback and the actual SQL import's dump comparison each made
its own test fail when removed. All were restored. Production restore tests use
real NATS, disposable PostgreSQL and real `pg_dump`/`psql` clients. They keep
admission closed after refusal, interrupted import and database replacement.

The approval-browser opt-in case, desktop-view opt-in file and real-provider case
are NOT RUN. Independent review is NOT RUN by this builder; the orchestrator runs
that review.

Initial combined local runs exceeded unchanged Angular or route-process readiness
deadlines under resource contention. Separate browser runs used CI's existing
limit of two Angular build workers and passed twice. Serial route runs passed
twice at their original deadlines. The complete routine sender and session files also passed twice after their positive setup
fixtures reused the existing clock helper; execution, expiry, money, access and
memory assertions remain.
No timeout, money assertion, access assertion or memory check was loosened.

The earlier destination-preflight refusal remains unclassified. It is separate
from the earlier reused-approval-directory setup refusal. It did not recur in this
run. The harness retains the original child-process diagnostic if preflight refuses; later success does not classify the earlier
refusal. Startup and service logs are retained privately before teardown.
