# Qualified personal start contract

Part of #97, P4-15 PR 5g. Base and PR 5f merge:
`e40c6614d11e6e03070774aea89ca1aeeb1bfac6` (#840).
The [delivery contract](../p4-15-pr5f/README.robot.md) owns the one-use consumer.
The [accepted specification](../../specs/phase-4/p4-15-turn-memory.md) owns the design.

The bridge reads deployment-owned qualification before choosing a restricted personal
start. Admission repeats that read and refuses a different execution mode. Missing,
foreign or withdrawn qualification cannot admit restricted personal work. The existing
unqualified default remains memory-free. An explicit memory-free request skips selection
and receives no transcript, initial memory or offered tools. Team and routine paths keep
their existing behaviour. Existing thread checks forbid upgrading or reusing private threads.

`releaseTurnCredentials` reads private history before short access checks. For a first personal
restricted start it calls `prepareInitialMemory`, then `load`, then prepares the accumulated
reference check with `prepareLoadedMemory`. Loaded evidence therefore precedes signing.
Access and references are checked around signing. The one-use consumer repeats current
qualification, reference, generation and access checks immediately before release.
Its callback sends the acknowledgement synchronously, with no awaited work before the send.
Membership refusals retain their safe reason. No history is added to an access stream set.

The server labels the original loaded JSON separately from private history and the new
message. Its image excludes computer source, so it assembles input locally. The existing 16 KiB
block, 32-reference, 24 KiB transcript and 120 KiB frame limits remain. The acknowledgement
including credentials is also bounded to 120 KiB. `initialInput` is private bridge data,
not an event or public API field. The runner uses it once without rendering it again or
journalling it. Explicit memory-free and shared turns refuse this input. No model selects
memory. Gateway admission still counts the whole model request with integer-cent limits.

Numbered start reports require saved initial-load evidence before renewing a pass.
The runner resends its existing number; equal and later numbers can renew after that load,
without initial-delivery inputs or new memory evidence. A saved start alone cannot bypass
a refusal caused by missing dependencies or qualification withdrawn before preparation.
Without loaded evidence, replay refuses initial delivery. Older unnumbered starts retain
their existing renewal path. Loaded-reference and access checks still surround signing.
Reconnection and cold replay cannot reconstruct the live consumer. Existing preparation
or loading evidence refuses a second preparation, including uncertain delivery. No token
or plaintext is stored in evidence. `reports.ts` still refuses generated memory output.
Native caller/catalogue launch and requester-only volatile reply delivery are unbuilt.
The static unqualified admission assertion, authority tests and security rules are unchanged.
No new event, dependency or licence is introduced.

## Own checks

2026-10-30. Local source only; no image or live silo was built. Tests use disposable
NATS, PostgreSQL databases, OpenFGA and gateway fixtures. Deployment filesystem and Docker
observations are simulated by the real collector's fixture; they do not qualify this host.
All checks use `nice -n 10`; tests use an explicit `PG_TEST_URL`.

- PASS: failing-first test commit `e835e776f`. Ten server regressions and the runner
  regression failed before implementation. Two refusal cases already passed.
- PASS: failing-first renewal test commit `5e20d8426`. The new renewal case failed
  before the fix because initial delivery asked for a database and event feed.
- PASS: all five changed test files, 255/255 twice. The earlier four-file run passed 205/205.
- PASS: the four tests for dispatch, delivery, initial delivery and credentials,
  290/290 twice after the renewal fix. The unchanged assertions run again.
- PASS: unchanged security, admission, report and renderer checks, 496/496.
  The wider run also exposed three older replay fixtures that lacked qualification;
  those fixtures were corrected and all 48 replay tests passed in both final runs.
- FAIL: the complete server memory test set passed 1036/1041, then 1039/1041.
  The two runs failed in different gateway, delivery and initial-delivery cases.
  Each failed case passed when rerun unchanged on its own or with the other failed case.
- PASS: lint, typecheck, event catalogue, Knip and changelog on the current base.
  A targeted lint and server typecheck also passed after moving the
  acknowledgement sender.
- PASS: focused release and replay checks after moving that helper, 26/26.
- NOT RUN: full root suite, fresh-install native qualification, persistence scans,
  paid model calls and CI. No owner or secondary development stack was started.

Logs are under `/tmp/p4-15-pr5g-*.log` on the build host.

## Numbered renewal fix checks

30 October 2026. Rebased onto `origin/main` at `3391faf4f` and checked that the
rebase finished. The failing-first test commit is `6823f8995`; the production fix
is `8b1ca52d9`. Commit `ad7173202` corrects JSON types in the new acknowledgement
assertion and requires a non-empty token. It does not change production behaviour.

The first full run began on `8b1ca52d9`; the assertion correction was made during
that run. The second full run used `ad7173202`. Both used the four requested files:
`turn-credentials.test.ts`, `memory-dispatch.test.ts`, `memory-delivery.test.ts`
and `memory-initial-delivery.test.ts`. The expected result was no failures.
Tests used disposable service fixtures, simulated deployment qualification,
an explicit `PG_TEST_URL` and `nice -n 10`. This was not a fresh installation.

- PASS: three new defect probes failed before the production fix. The repeated
  report without delivery evidence was already refused. All four new regression
  cases passed in both full runs after the fix.
- FAIL: run 1, one worker, 282/285. Initial loading refused in the saved-reference
  and empty-selection cases. The final-await closure case refused during preparation,
  before it reached the intended closure change.
- FAIL: run 2, two workers, 282/285. The completed-withdrawal retry and corrected-cause
  polling cases did not reach the native turn start during setup. The expiry case
  did not reach its injected clock change during final confirmation.
- PARTIAL: each of these six cases passed in the other full run. This shows varying
  results, but does not identify every cause or clear either full-run failure.
- PASS: the final focused run on `ad7173202`, one worker, 10/10. It repeated all six
  affected cases and all four new regressions with unchanged assertions.
- PASS: final lint, typecheck, event catalogue, Knip and `npm run lint:changelog`.
  The final lint run includes the corrected acknowledgement assertion.
- NOT RUN: full root suite, fresh-install qualification, persistence scans, paid
  model calls and CI. Admission remains disabled. No development stack was started.

Logs: `/tmp/p4-15-pr5g-fix2-targeted-1.log`,
`/tmp/p4-15-pr5g-fix2-targeted-2.log`, `/tmp/p4-15-pr5g-fix2-focused-final.log`
and `/tmp/p4-15-pr5g-fix2-*.log`.
