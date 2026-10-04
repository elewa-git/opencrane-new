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
