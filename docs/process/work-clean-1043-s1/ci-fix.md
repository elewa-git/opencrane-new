# Bridge fixture clock

Fix round 2, 18 November 2026.

## Reproduction

FAIL: the unchanged bridge-turn-tools suite failed all 14 tests in 38.33 seconds.
The late-build case reached the unchanged 30-second timeout while waiting for
its grant callback. The other cases exposed the underlying error directly:
`store.clock` was undefined in the summary reader. Two pending processing
promises also reported that error. This local result reproduces the timeout
and identifies its cause, although CI reported nine timeouts.

The fake store was hidden behind a broad `WatchOptions` assertion. Its
`head`, `readStream` and `clock` contract is now checked before that assertion,
so the missing clock is also a compile-time failure. Existing tests already
pin the tool offers, resends, grant calls, membership refusal and late results.
No new product behaviour or weaker assertion is needed to expose this failure.

Command: `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres
nice -n 10 npx vitest run apps/server/test/bridge-turn-tools.test.ts --maxWorkers=2`.
Local output: `/tmp/clean-1043-round2-reproduce.log`.

FAIL as expected: the test-first fixture contract produces TypeScript error
TS1360 because `clock` is missing. This was checked before adding the clock.

## Fix

Supply `systemClock` on the fake store. The existing Vitest fake timers still
control the server's tool-build and resend timers, and `systemClock.now()` reads
that same faked `performance.now()`. The default clock is the correct fixture
choice here because server timing has not yet moved to an injected clock.
The system-clock implementation and every product file remain unchanged.

PASS: the bridge suite's 14 existing tests pass in 9.28 seconds with this fix.
No deadline, assertion, service timer or test timeout changed.

## Verification scope

The [test manifest](timing-tests.txt) contains every server and ops test with
`vi.useFakeTimers` or `spyOn(performance`, plus the test consumers of matching
shared helpers: 75 files in total. The bridge suite is included. The two complete
runs use this same manifest, the supplied disposable PostgreSQL database and
at most two workers, under `nice -n 10`. No root suite or dev stack is started.

The product diff from the previous head is empty. PASS: the existing fresh
CORE journey therefore covers identical product code at 1280 px and 390 px.
The separate approval journey remains NOT RUN.

## Static gates and cleanup

- PASS: full typecheck, including package and dev-stack configuration.
- PASS: event catalogue, 174 matching types.
- PASS: Knip, with its two existing configuration hints.
- PASS: changelog lint and changed-file ESLint, with no warnings.
- PASS: Markdown lint with no file arguments.
- PASS: public privacy and secret scans; repeat both immediately before pushing.

Checked the changed fixture against the engineering cleanup table. Reused the
exported system clock, kept the existing fixture shape, and checked the three
store fields used on this path before the broad bridge-options cast. No product
logic, test outcome assertion, dependency, error handling or size limit changed.
No package contract or README sentence became inaccurate.

## Timing-test results

- PASS: first complete run, 75 files, 3,585 passed and one skipped, 5,082.40 seconds.
  Local output: `/tmp/clean-1043-round2-tests-1.log`.
- PASS: second complete run, 75 files, 3,585 passed and one skipped, 5,418.86 seconds.
  Local output: `/tmp/clean-1043-round2-tests-2.log`.

Both runs tested code at `6dd26b13a`; subsequent changes record evidence only.
The second run used `--reporter=verbose`. The bridge suite passed all 14 cases
in both complete runs.

The run emitted WebSocket listener-count warnings. No listener limit was changed
and no warning was suppressed. The optional `APPROVAL_BROWSER` case at 390 px
is NOT RUN and is not counted as passed. Database cases ran with the supplied PostgreSQL URL.

## Base and journey coverage

PASS: the final fetch still reports `origin/main` at `6c41131b5`, the existing
base. No rebase was needed and none is in progress. A direct diff against the
fresh CORE source `f5076116416ffc4ea39c0ce1292b31eb69c5b108` finds no change in
app or library source, infra, scripts or tools. The existing journey therefore
covers identical product code. No secondary stack was claimed in this round.

The final timing search still finds all 70 directly matching test files in the
75-file manifest. Five additional files import matching timer helpers. No matching
file is omitted from either run.
