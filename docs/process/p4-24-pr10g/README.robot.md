# Routine dispatch to delivery

For people, read [README.md](README.md) first.

Part of #106, P4-24 PR 10g, first part. Accepted design sections 1/2/3/6, rows 8–11.
Started after #884 merged at `70d0316790a09fe8de081159cfeb07ccf1768b85`.
Failing-test commit: `e53222727`. The native execution assertion timed out before the change.

## Contract

`dispatchRoutineCandidates` accepts an optional fourth callback. It receives the checked
`claimRoutineDue` receipt plus routineId and the original leadership signal/check.
Only new or recovered due results reach it; skip, missed, future and inactive results do not.
The callback must drain delivery, including the computer's start request, before returning
`sent`. A socket write alone is insufficient. `unknown` or rejection refuses the page.
The scan awaits it under its own deadlines and checks leadership again before progress.
The nine-second cutoff prevents another candidate; it does not cancel admitted delivery.

The server integration test supplies the adapter to `createRoutineComposition` and waits
for the scripted native peer and bridge work. It passes cancellation through the original
leadership check. The existing enabled/replay switch remains the only execution switch.
There is no production callback, worker registration, tick, route or new event/API field.
The test import adapter keeps server source out of ops. No dependency was added.
The reserved server/models README pairs are unchanged; this pair records the integration.

## Own checks

Own PASS: 543 selected tests and all 16 focused cases again; event catalogue and changelog.
Own PASS: full typecheck and all lint stages, including Knip; 37 existing lint warnings.
Initial fixture assertions and early lease release failed, then were corrected.
Checks use `nice -n 10`; logs: `/tmp/p4-24-pr10g-*`.
Full root suite and live qualification: NOT RUN.
The fixtures use disposable PostgreSQL, NATS and OpenFGA with a scripted native peer.
No owner stack, model call or company call is used.

## Remaining work

Production delivery registration and its bridge completion contract remain separate.
Company verification, explicit selection and forwarding, owner Ask/expiry, lifecycle
Stop/finish and fresh-install qualification still block production enablement.
The full preparation fault matrix, uncertain holds and unrelated activity retain the
existing composition tests; they are not newly exercised through dispatch in this slice.
Computer-process restart and company execution remain unqualified.
