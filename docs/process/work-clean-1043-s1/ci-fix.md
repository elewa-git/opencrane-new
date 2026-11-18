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
