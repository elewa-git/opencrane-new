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
