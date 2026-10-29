# P4-24 PR 12h evidence

Part of #107. Base: `9f12dedaf`. Failing-first test commit: `128f196dd`.
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

Own checks: PASS — lint (including Knip), typecheck, check:events (157 event types),
lint:changelog, 31 focused tests twice and 460 unchanged event-security tests once.
All checks ran under `nice -n 10`. PostgreSQL used a throwaway database with
PG_TEST_URL set; its container and volume were removed afterwards.
Live qualification: NOT RUN. No stack or model call. Occupied-run reassignment,
Ask/Stop evidence, Resume, profile changes and HTTP routes remain unbuilt here.
