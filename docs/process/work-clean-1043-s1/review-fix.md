# Deadline guard proof

Fix round 1, 18 November 2026. Test commit: `00cc2da25`. Strict typing cleanup: `0468fd89f`.
Both review findings concern proof. Production code and all deadline lengths
are identical to `3d5968c82` and the source used by the fresh CORE journey.

## Findings

1. PASS: credential send now advances manual time after the final locked
   `SELECT 1` completes. All tracked-position reads precede this boundary.
   The test allows sending at 0 and 1,999 ms, refuses at exactly 2,000 ms,
   and checks that no material reaches the send callback on refusal.
   The existing stopped-clock success case remains.
2. PASS: authority tests distinguish expiry before work from expiry while
   a head read is pending. Actor tests distinguish expiry before queue work
   from expiry after a history read. Refusals leave authority confirmation
   unset, actor state unchanged and the saved budget position unchanged.
   Paying-group tests advance time across an awaited head read. Tests allow
   1,999 ms and refuse exactly 2,000 ms. Internal clock-call assertions were
   removed; outcomes and controlled time now provide the evidence.

## Individual guard removals

Each removal was made alone, tested, then restored. No mutation is committed.

| Removed guard | Result of its focused test |
| --- | --- |
| Credential send final deadline comparison | FAIL: send resolved instead of refusing |
| Authority before head reads | FAIL: an expired read started |
| Authority after head reads | FAIL: confirmation resolved instead of refusing |
| Actor queue entry | FAIL: expired work started |

The authority entry probe throws a distinct fixture error if a read starts.
The actor entry probe holds the caller's timer pending and throws a distinct
fixture error if access work starts. Later guards therefore cannot supply
those tests' expected refusals. Real storage has its own normal deadline in
actor boundary tests, so a one-millisecond NATS timeout cannot decide the
actor's result.

## Check log

The first actor allowance attempt timed out because its storage append shared
only the remaining one millisecond. The first storage isolation attempt used
an infinite append deadline, which the append contract rejected as invalid.
The final fixture leaves the optional storage deadline unset and uses the
normal storage budget. No product change, retry, sleep or timeout change was
made. Typecheck then caught an incompatible optional Vitest callback argument
and an explicitly undefined optional deadline. A named wrapper and deletion of
the optional field corrected these test-only types. Named helpers share the
storage fixture behaviour. Changed code was checked
against the engineering standard's cleanup table; no size limit was raised.

## Journey

PASS: the existing fresh CORE journey at 1280 px and 390 px still covers
identical product code. See [the original receipt](journey.md). No behaviour
changed in this fix, so no new dev stack was claimed. The separate approval
journey remains NOT RUN.

## Gates

- PASS: both changed files, 84 tests, twice (20.40 s and 21.40 s).
- PASS: each of the four individual guard-removal probes failed as expected.
- PASS: full typecheck, including package and dev-stack checks.
- PASS: event catalogue check, 174 matching event types.
- PASS: Knip, with the same two existing configuration hints.
- PASS: changed-file ESLint, with no warnings, changelog lint and Markdown lint.
- PASS: public privacy and secret scans before push.

Tests used the shared disposable PostgreSQL test database and at most two
workers. Compilation, tests and lint ran under `nice -n 10`. No full root
suite ran. Fetch confirmed `origin/main` remains `6c41131b5`, the existing
branch base; no rebase was needed and none is in progress.
