# Checked routine composition

For people, read [README.md](README.md) first.

Part of #106, P4-24 PR 10f. Design sections 2/3/6, rows 9/10 apply.
PR 8f merged as #880 at `f0f901d2117d455f7c38488c0e5e096d4f1a9048`.
Base: `cd74ed12d`. Test-first commit: `f7839a206`; the absent adapter failed collection.

## Contract

`apps/server/src/routine-composition.ts` exports `createRoutineComposition`.
Arguments: `{ enabled?, replay? }`, event store, conversation keys, trusted worker,
`{ routineId, occurrenceId }`, budget actor and stable sender attempt id.
The returned `send(wake)` accepts a trusted callback taking the saved assistant id and
returning the connected bridge and generation. No public request supplies a thread.
There is no route, tick, subscriber, production caller or new environment setting.

The entry consumes its invocation before awaiting work. It calls `loadRoutinePreparation`
and its access check before wake. `prepareRoutineComputer` then reloads history and access,
starts the native thread, saves session/input and allocates the root. Its returned selection
passes unchanged to `createRoutineSender`. The existing helpers own authority, budget,
publication and post-start credential checks. The adapter adds no event or business rule.

Disabled and replay entries return `unknown` before history, wake or writes.
A saved activation prevents another wake. Cancelling unused native preparation releases
its turn id. Before an allowance is saved, a fresh invocation can prepare a new native
thread for the same occurrence, recheck access and send once. Saved session and input
records are reused. Delayed cleanup cannot cancel replacement preparation.
Missing native preparation and uncertain saved stages return `unknown`; no receipt proves
an unsent activation. Recovery cannot replace an allocated native thread after its process
is lost. Existing allowance, payer and holds remain unchanged.
No new schema fields or dependencies were added. Protected root server/models README pairs,
files from #837/#838, bridge/credential files and authority/security tests remain unchanged.
This README pair documents the adapter because the root server files are reserved.

## Checks

The focused test uses disposable NATS and OpenFGA, a real WebSocket bridge and computer
journal, and a scripted native peer. PostgreSQL uses a throwaway container with its own
port; no owner stack is used. The fourteen-second wake uses controlled clocks.
The stage matrix faults before/after session, input, allowance, admission and saved start.
It also checks duplicate invocation, broker and actor restart, lost send reply, missing or
wrong preparation, another thread starting, and access loss before credential release.
The fixtures make no model or company calls.

Own PASS: full typecheck, then server typecheck after fixture fixes; event catalogue (158),
Knip, changelog validation, 26 focused tests twice and 460 security tests once.
Own PASS: all lint stages (36 existing warnings); docs repeated after a Markdown fix.
Every lint, typecheck and test command used `nice -n 10`.
Initial fixture run: FAIL, 11/21. It counted the actor restart record as composition work
and used a recursive transport spy. Both were fixed, as were fixture type and lint errors.
Forcing the adapter inactive failed the positive test at its expected sent assertion.
That temporary test transform changed no repository file and was removed afterwards.
Logs: `/tmp/p4-24-pr10f-*`; final focused runs are `checked1.log` and `checked2.log`.
Full root suite and fresh-install live qualification: NOT RUN.

## Preparation retry correction — 5 November 2026

Rebased onto `79afe7aff`; Git reported completion and the base is an ancestor of this
branch. Test commit `6bb9baba5` preceded production fix `4cd6f3468`.
The checks below exercised that source; the later documentation commit changes no code.

Expected FAIL: five early-stage recovery cases returned `unknown` instead of `sent`.
Three cancellation cases also failed because preparation could not reuse its turn id.
Logs: `/tmp/p4-24-pr10f-fix-red.log` and
`/tmp/p4-24-pr10f-fix-cancel-red.log`.

The fix releases only pending preparation. Delivery still consumes the id before its
identity checks. Delayed startup and closure work cannot remove a replacement.
The existing fault matrix now requires one execution and one set of saved records for
failures before allocation. Its later-stage refusal assertions remain in place.
Spies, fixture options and bound callbacks are named separately, and branches are expanded.

Own PASS: the first fix run passed 34 composition and preparation tests.
Own PASS: full typecheck, the 158-type event catalogue check and all lint stages,
including Knip and changelog validation. Lint reported 37 warnings; the routine preparation
function now has 84 lines against the 80-line warning threshold.
The first combined run was FAIL: 122 passed and one unchanged sender test timed out waiting
for execution. That case then passed alone with no code, assertion or deadline changes.
Own PASS: the final combined run passed all 583 tests: 26 composition, eight preparation,
89 unchanged sender and 460 unchanged security-rule tests. Both changed test files passed
in each combined run. All test commands used `nice -n 10`, one worker, serial files and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Logs use `/tmp/p4-24-pr10f-fix-` followed by `green.log`, `typecheck.log`, `events.log`,
`lint.log`, `tests1.log`, `tests2.log` or `sender-recheck.log`.
These tests use disposable NATS/OpenFGA and a scripted native peer, with the supplied
`PG_TEST_URL`. They do not use a fresh installation or make model calls.
Full root suite and fresh-install live qualification: NOT RUN.

## Remaining enablement work

Company verification, explicit selection and forwarding; bound owner Ask and expiry;
lifecycle Stop/finish integration; and fresh-install live qualification remain required
before an enable switch. Weekly downtime is separate. No company credential or Ask bypass
is supplied by this adapter. Automatic execution remains disabled.
