# Live-view lease engine: PR 1 of 2 (#77)

Receipt: 4 October 2026. Branch `work/i77-lease`, based on main `089fa31`
(including #139), plus this change. Linux shared dev host, Node 22.23.3,
locked dependencies installed with `nice -n 10 npm ci`. Disposable test services
only; no owner stack or Docker daemon settings changed. This is source evidence,
not fresh-install qualification.

## Functional outcome

Admission and upgrade retry unavailable access checks one at a time, 250 ms
apart, without starting an attempt at or after 5 s. Unconfirmed admission returns
503; unavailable upgrades return HTTP 503. Explicit denial still returns 403.

After the start audit resolves, a monotonic lease must confirm the same computer
before the desktop opens. Both byte directions check the lease and ticket expiry
at delivery. A lapse still closes with 4503 and audit reason `unavailable` in this
PR; the browser clears its canvas, shows Failed and offers Try again. Explicit
denial retains 4003 and Access changed. #139's timing stages are retained, with
`lease_pause` and `lease_resume` added.

## Red before implementation

On unmodified main production code, all listed PR 1 tests were written first.
The server run reported 13 failing assertions and 29 passing regression cases;
the new lease suite failed to import its absent module. Angular rejected the
absent `LIVE_VIEWER` export. Passing denial cases were kept as regression tests.
The required 499/500 ms margin test covers a lapsed lease. Fake-time tests move
`performance.now()` explicitly where Vitest's `setSystemTime` leaves it unchanged.

## Checks

Every check ran under `nice -n 10`. Root and live-view suites used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and two workers.
Root started after integer host load fell below 16, with no live-view
qualification batch running. Safe command logs are retained locally under
`/tmp/i77-*.log` on this builder host.

| Check | Result | Evidence |
| --- | --- | --- |
| Lease unit and property tests | PASS | 34 cases, 20 seeds × 30 simulated seconds; real 1,600 ms event-loop stall |
| Live-view integration tests | PASS | All 46 cases pass in the complete root run; 2 opt-in k3d cases skipped |
| Full root suite | PASS (complete rerun) | 1,532 passed / 15 skipped; 96 files passed / 4 skipped |
| Angular tests | PASS | 65 tests, including 503 retry and canvas removal on 4503/4003 |
| Angular production build | PASS | Existing bundle/style budget and noVNC CommonJS warnings |
| Typecheck | PASS | All workspaces |
| Lint | PASS | All six checks; final changed-file lint also passes |
| Event catalogue | PASS | 86 event types agree; additive unavailable reasons |

The first root run failed an existing approval-card read with HTTP 503 during
concurrent tab decisions, and timed out the dispatcher SIGKILL fixture's cleanup
hook after 10 s. Neither failing path enables live view. The full run began at
integer load 10; load later rose above 25. These failures are recorded, not
exempted from the required gate. Both failing cases passed unchanged in isolation at lower load (2 passed,
43 unrelated cases skipped, 19.97 s). A second complete root run began at
integer load 11 and passed all 1,532 executed tests in 1,547.62 s. No approval
or dispatcher code, timeout or assertion was changed. The initial full run
remains FAIL; the final complete gate is PASS.

## Remaining qualification

Fresh-install live qualification and independent review are NOT RUN by this
builder. PR 2 adds pause/resume delivery and browser handshake replay; the
10-run live batch follows PR 2 and the separate CPU ops change. Kasm surviving a
pause during its initial RFB handshake remains unverified. No capability-done
claim is made by this PR.

## Rebase verification — 4 October 2026

Rebased the reviewed source `722c2a5` onto `origin/main` at `2329adc`, including
timing (#139), denial ordering (#145), F1 (#148), the bridge split (#150),
upload recovery (#151) and
read retry (#149). The rebase completed; no rebase state remains.

- `view.ts`: replaced main's local deadline wrapper with the lease wrapper,
  using #149's shared `viewCheckMs` constant. Kept the lease engine, serial
  admission retries, audit fence, monotonic clock, 4503 and all timing records.
- `live-view.ts`: combined the SharedState and injectable viewer imports;
  kept F1's status rendering and focus styles, with explicit Failed → failed
  presentation and Try again at full width below 500 px. Kept main's named
  `socketClosed` method and called `stateForCloseCode` there, retaining 4503 → Failed.
- `view-lease.ts`: the second commit conflicted with the shared constant change.
  Kept the final review's timer-order comment and used `viewCheckMs` for the
  late-success check. Lease / deadline / cadence / cap remain 1,500 / 1,200 / 250 / 5.
- `view-access.ts` merged cleanly and matches main: late results become
  ViewCheckUnavailable, explicit denials take priority over outages within the
  deadline, and event-store retries share the same deadline.
- `CHANGELOG.md` and `ledger.md` merged by union. `benchmarks.jsonl` was unchanged;
  all main records remain. No test, deadline or fence was weakened.

Added the requested synchronous-timer comment to the in-flight cap test and
an assertion that failed admission renders SharedState's failed presentation.
The existing final independent verification verdict is LAND, conditional on
this rebase and its checks. Fresh-install qualification remains NOT RUN here.

Rebase checks used Node 22.23.3 on the same Linux host and the supplied
PostgreSQL URL. All commands ran under `nice -n 10`; full and focused Vitest runs used two workers.
The second failure replay used one worker to reduce added load.
Safe logs are in `/tmp/i77-rebase-evidence/` on the builder host. The tested
source is rebased `da2e1f5` plus the test comment, failed-state assertion and this evidence update.

| Rebase check | Result | Evidence |
| --- | --- | --- |
| Live-view, lease and event-store tests | PASS | 142 passed / 2 opt-in k3d cases skipped; includes read-retry tests |
| Web live-view spec | PASS | 5 tests, including failed SharedState rendering and 4503 canvas removal |
| Typecheck | PASS | All workspaces |
| Event catalogue | PASS | 86 event types agree |
| Angular production build | PASS | Bundle/style budget and noVNC CommonJS warnings |
| Lint | PASS after correction | Complete six-check rerun passed after correcting the initial Markdown heading error |
| Full root suite | FAIL | First run: 1,565 passed / 1 failed / 15 skipped; complete rerun: 1,564 passed / 2 failed / 15 skipped |
| Exact failure replays | PASS | Chat HTTP: 1 passed; gateway 400 and NATS-delay lease: 2 passed / 86 unselected cases skipped |

The initial rebased root run is FAIL: 1,565 passed / 15 skipped / one failure.
The unchanged `chat-http.test.ts` message POST assertion at line 81 received
403 rather than 200. That file and its chat/authorisation code match main.
The same test passed unchanged in isolation (one passed, 8.89 s). The failure's
cause was not reproduced; no deadline, assertion or chat code was changed.
The first failure is retained in `root-tests.log` and its isolated result in
`chat-http-reproduction.log`.

The complete rerun is also FAIL (1,718.79 s): the gateway's observed-provider-400
case timed out at its existing 40 s limit, and the NATS-delay viewer was closed
at the assertion that it remained open. The diagnostic records include a NATS
timeout and slow reads; host load exceeded 20 during the run. Four other full
root suites were running when it finished. This shows concurrent host load,
not a reproduced cause for either failure.

Both exact cases passed unchanged in isolation with one worker (2 passed,
86 unselected cases skipped, 31.36 s). Logs are `root-tests-rerun.log` and
`second-failure-reproduction.log`. No timeout, deadline, fence or assertion was
changed. The complete root gate remains FAIL despite the isolated passes;
source readiness requires a green complete gate before landing. The rebase
and requested focused checks are complete; fresh-install qualification remains
NOT RUN.
