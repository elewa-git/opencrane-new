# Scheduled pilot backup

Journey on a fresh dev stack: **NOT RUN**.

Implementation stopped after the second and final review pass left a blocker.
No secondary slot was claimed, no installation was started, and no screenshot or
live backup result is claimed. Package preparation, upload/chat, scheduled backup,
operator listing and deliberate target failure are all **NOT RUN**. No claimed
stack needs cleanup.

## Remaining blocker

If restarting services fails, the collector appends `resume_failed` to its lock.
If that write or its sync also fails, the assignment to `resumed` does not finish.
Cleanup can then delete the hidden set and lock while services remain stopped.
The final review reproduced this with an injected full-volume error.

The failed assumption is: recording recovery failure on the backup volume cannot
itself fail. The repository requires owner disposition when a repair fails the
second review pass. No further implementation or review cycle was started.
The owner must authorise a further repair and its review, or choose a smaller
outcome. This draft must not merge in its current state.

## Own source checks

- **PASS:** the first collector test failed for its missing implementation before
  production code was written. The schedule test failed because the CronJob was
  missing. Later negative tests reproduced secondary-table lag and lost locks.
- **PASS:** 11 collector cases and five existing credential cases passed twice.
  Three real-SDK cancellation cases passed twice: listing, headers and body.
- **PASS:** all 251 chart-render cases passed twice; 28 related package cases passed.
- **PASS:** changed-file type-aware ESLint, including otherwise ignored infrastructure.
- **PASS:** Knip, event catalogue and changelog checks. No event contract changed.
- **PASS:** final Markdown check across 522 files.
- **FAIL:** root typecheck passed the workspaces, then rejected the package test
  fixture's inferred checkpoint type when adding `groups`. The final dev-stack
  typecheck step was **NOT RUN**. No code repair was made after the review stop.
- **FAIL:** the additional README guard reports two unchanged main-branch problems:
  the ClamAV README is an unlisted length offender, and the dev-stack README is
  longer than its recorded allowance. The changed package README was shortened
  and no longer appears in this output.
- **NOT RUN:** application image build, licence promotion and live qualification.

## Implementation and limits

The code reuses the existing event snapshot collector and the storage lease. It
shares the cancellable HTTP transport with lease issuance, uses one byte digest
helper, and imports projection names and backup validation schemas. Part capture
is separate from publication and cleanup. No runtime dependency or image is added.
The existing reviewed Node/kubectl, PostgreSQL dump, NATS and MinIO tools are listed
in the operator guide with their licences. A rebuilt application image still needs
source, layer, licence and promotion checks before installation.

The diff contains 654 added plus deleted lines of shipped package code and chart
configuration, excluding tests and documentation; Docker context entries add four
lines. Restore, computer homes, three event-log copies and off-machine durability
are outside this slice.
