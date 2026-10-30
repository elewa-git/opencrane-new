# P4-24 PR 12h evidence

Part of #107. Rebased base: `391d849f6`. Failing-first test commit: `59a71ce0e`.
The first run failed because the new command did not exist.

Scope: internal paused reassignment without an occupied run. The command accepts
only ownerId plus the routine/change references and reviewed position/revisions.
It changes ownerAdmissionId from current membership, increments definition/control
revisions and preserves scheduleRevision, schedule, next occurrence and ciphertext.
No event or dependency was added. New input ownerId does not match RISKY_FIELD_NAME;
all remaining event/receipt fields reuse existing contracts. Security rules are unchanged.

Tests use disposable NATS/OpenFGA and PostgreSQL. They check current authority,
receipt lag, removal during dependency failure, races, lost replies, duplicate expiry,
restart, queued revocation, slow history, unrelated activity and cold IAM/content replay.
The event position advances once; completed occurrences and earlier spending stay intact.

Original implementation checks: PASS — lint (including Knip), typecheck,
check:events (157 event types),
lint:changelog, 31 focused tests twice and 460 unchanged event-security tests once.
All checks ran under `nice -n 10`. PostgreSQL used a throwaway database with
PG_TEST_URL set; its container and volume were removed afterwards.
Live qualification: NOT RUN. No stack or model call. Occupied-run reassignment,
Ask/Stop evidence, Resume, profile changes and HTTP routes remain unbuilt here.

## Retry corrections — 30 October 2026

The admin check now runs before routine-access preparation. A saved demotion keeps
the typed refusal when ownership history fails, without retrying permission.
Authorised identical retries recover the saved reassignment receipt even after the
new owner retires the routine. Current admin and recipient access still apply.
New reassignments still require paused work without an occupied run.

Failing-first commits: `aa4f96707` reproduced the demotion error, and `ee52dce98`
reproduced the lost receipt after retirement. Each failed for the reported reason
before its fix. The retirement regression uses both real commands and checks that
the retry returns the original event identity without appending anything.

Own checks on code at `c1bd5b516`: PASS, 113 tests in seven files twice:
server reassignment, admin pause and retirement; authorisation routines and guards;
event routines; and routine projections. PASS, lint (including Knip and
lint:changelog), typecheck and check:events. Code lint reported 34 warnings and no
errors; none of those warnings are in the changed files.
Both full targeted passes used disposable PostgreSQL with PG_TEST_URL set.
The container and volume were removed afterwards. All checks used `nice -n 10`;
tests used one worker. Logs: `/tmp/p4-24-pr12h-fix-*.log` on this host.
Full root suite and fresh-install live qualification: NOT RUN. Execution stays disabled.
