# Routine leadership source checks

Date: 4 November 2026. Part of #106, P4-24 PR 8b.
Base: `4df894661`.

The routine worker holds a PostgreSQL session lock for one silo while it prepares
claims. The callback receives a cancellation signal and a check of that same
session. A lost session cancels the signal. The due command checks it after
awaited reads and passes it into the conditional append. The event store checks
the signal after its final access read, immediately before publication.

The new regression test pauses the real member access read during an append,
terminates the old session, verifies that a replacement holds the lock, and
then resumes the read. It also pauses after the access callback returns. Both
cases leave the event count unchanged. The test was committed before the fix.

No routine scheduler, tick, scan, sender, route or enable switch was added.
Automatic scheduling remains off. The claim still records
`executionAvailable: false` and does not start a computer, model or tool.

## Local checks

Tests used the provided PostgreSQL test URL and disposable NATS and OpenFGA
fixtures. Lint, typecheck and tests ran under `nice -n 10`. The full lint scan
used a 6 GiB Node heap.

| Check | Result |
| --- | --- |
| Leadership tests | PASS: 15 tests on each of two runs |
| Due claim tests | PASS: 46 tests on each of two runs |
| Changed server claim test | PASS: once on each of two runs |
| Typecheck | PASS: all workspaces and infrastructure projects |
| Lint, including knip and changelog | PASS: 34 existing line count warnings, zero errors |
| Event catalogue | PASS: 158 event types agree |
| Full root suite | NOT RUN |
| Fresh-install live journey | NOT RUN |

The full server routine-session file did not complete locally. The changed
claim test passed twice with the file filtered to that test. No owner stack or
development stack was changed.
