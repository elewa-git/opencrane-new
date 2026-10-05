# Live view pauses while access checks are unavailable — #77, PR 2 of 2

**Status: PARTIAL.** All requested focused rebase checks pass. Both complete
root runs are **FAIL**; the final run has one unrelated gateway-test timeout.
Fresh-install live qualification and real Kasm pause/replay remain **NOT RUN**.

Built on PR 1 (#147) in `work/i77-pause`, on 4 October 2026.
Failing-first and initial source checks used
`bbf9e6d193d4ce3424eed23664c38fab666956c5`. The final stack includes PR 1
review fixes at `722c2a53feabe7ed55760df8d4f2604bc39e627e`. No new dependency or lease-number change.
The [PR 1 receipt](i77-lease-evidence.md) records the lease engine and admission
retry behaviour on which this change depends.

## Functional result

A lapsed lease pauses pixel delivery while the WebSocket and desktop stay open.
Each desktop send and browser write checks the monotonic lease synchronously.
Paused framebuffer updates and bells are dropped. Only desktop setup (2 KiB)
and browser requests (8 KiB) can be held. A matching success with at least
500 ms left resumes in order: valid notice, held setup, held browser requests.
The proxy adds no framebuffer request.

The browser hides pixels at `until + smallest observed clock offset`. A server
paused notice removes noVNC and its canvas after the handshake. A valid notice
creates a replacement viewer, replays the four recorded setup frames and
checks and swallows its first 14 handshake bytes. The replacement remains
Paused until its connect event; noVNC sends its own full-frame request.
Before the first connection, the copy distinguishes checking access from
starting the desktop.

Explicit denial or a changed computer still closes with 4003/access_changed;
ticket expiry closes with 4003/expired. An uninterrupted 10 s without a valid
lease closes with 4503/unavailable. Existing protocol, upstream, slow-viewer,
disconnected and shutdown faults remain terminal. Pauses retain the capacity
slot. The existing timing records include lease_pause and lease_resume.

## Failing-first evidence

Tests were written before the pause implementation at the confirmed delivery,
channel, HTTP/WebSocket and component seams. PR 1 was also extracted into a
disposable source snapshot for a separate baseline pause run.

| Seam or regression | PR 1 result | PR 2 result |
| --- | --- | --- |
| ViewDelivery send-time gate, held setup/input ordering, queue bounds, expiry, integer notices and stop cleanup | FAIL; delivery/notice API absent | PASS; five tests |
| LeaseChannel strict notice shapes, text/binary separation, minimum clock offset, detach/drop, replay and handshake mismatch | FAIL; channel absent | PASS; five tests |
| Browser checking/starting copy, lease deadline, pause canvas removal and resume without another POST | FAIL; checking copy absent | PASS |
| Desktop open pending beyond lease lapse; paused upgrade holds greeting until valid | FAIL; PR 1 destroys the upgrade socket | PASS |
| First frame followed by a lapse; paused updates dropped and exactly the held request released | FAIL; PR 1 closes instead of pausing | PASS |
| Denial while paused; hidden revocation during slow successful checks and an outage | FAIL; no paused notice on PR 1 | PASS |
| Denial during a pending desktop open | Existing refusal control retained; fixture initially rejected its expected socket error | PASS; raw socket closes, eventual stream destroyed, access_changed audited |
| OpenFGA pause, NATS outage, three repeated-failure boundaries and admission lapse | FAIL; PR 1 closes at lapse | PASS; pause within 2 s, no later binary, 4503 after 9.5–12.5 s paused |
| Replacement viewer awaiting connect | FAIL on first PR 2 implementation; it showed Viewing too early | PASS; replay precedes the replacement connect |

The scripted access fixture captures its mode at check start so an outstanding
slow success cannot accidentally turn into a real authority read after the
mode changes. Fractional clock values verify that valid notices round their times to integers.
The desktop-byte helpers now ignore text lease notices. Existing
revocation, protocol, capacity, ping-flood and output-bound checks are retained.

## Source checks

Environment: Node 22.23.3, own locked `npm ci`, disposable NATS/OpenFGA and
PostgreSQL test fixtures. PostgreSQL uses
`postgres://postgres:test@127.0.0.1:55432/postgres`. Checks run under `nice -n 10`;
Vitest uses at most two workers. The root run waits for the integer one-minute
load average to be below 16. It started at 21:23:34 UTC with load 15.71. No owner stack or Docker daemon settings changed.

| Command | Result |
| --- | --- |
| `npm run lint` | PASS; seven existing function-size warnings |
| `npm run typecheck` | PASS; every workspace |
| `npm run check:events` | PASS; 86 event types agree |
| `npm run build -w apps/web` | PASS; existing CSS-budget/CommonJS warnings |
| `npm run test -w apps/web -- --watch=false` | PASS; 13 files, 71 tests |
| `npx vitest run apps/server/test/live-view*.test.ts apps/server/test/view-delivery.test.ts --maxWorkers=2` | PASS; 56 tests, two opt-in k3d tests skipped |
| `npm test -- --maxWorkers=2` with the PostgreSQL URL above | PASS on the final stack; 98 files / 1,546 tests passed, four files / 15 opt-in tests skipped; 1,199.01 s |

Safe local command logs are under `/tmp/i77-pause-evidence/` on the builder host.
The rebase keeps PR 1's timing getter and relative receipt fields alongside
the delivery gates. Lint, typecheck and catalogue checks passed again. The
lease, pause and timing group passed 45 tests, including four new PR 1 proofs.
The browser source is unchanged from its passing build and 71-test run.
The first complete root run passed 1,542 tests in 1,343.82 s. A second complete
root run on the final stack started at 21:52:04 UTC with load 7.72 and passed
1,546 tests in 1,199.01 s. The final handshake-fixture lint and server typecheck
also pass.

Independent source review and hosted CI are owned by the orchestrator and are
**NOT RUN** by this builder.

## Remaining live qualification

The browser journey now waits through pauses, retries pixel/zoom/target/capture
steps once if they leave Viewing, checks the active start-only audit and records
state transitions, pause counts and durations. Revocation must hide pixels
within 2 s, then end in Access changed with no canvas and access_changed audit.

The opt-in k3d browser test deliberately makes checks unavailable for 2.5 s,
requires Paused and no canvas, then requires a repainted 800×600 desktop after
recovery. This source test is added, but real Kasm replay is **NOT RUN** here.
The fresh-install ten-run batch at 1280 and 390 px runs after PR 2 and the ops
change. Keeping Kasm/Xvnc paused during a partly completed startup handshake
for up to 10 s is also **unverified**. These checks do not close #77 or claim the
live capability is done.

## Rebase onto main — 5 October 2026

The exact requested command, `git fetch && git rebase --onto origin/main 722c2a5 work/i77-pause`,
completed onto `af7dfc9` (#147 squash merge). Git reported completion, no rebase state remains,
and `origin/main` is an ancestor of the branch. Both PR 2 commits were retained.

Conflict and merge decisions:

- `apps/web/src/app/live-view/live-view.ts` conflicted in both commits. Kept main's
  F1 SharedState rendering, capture outcome states and timestamps, and F2 ModalSheet
  framing, focus/close wiring and separate HTML/CSS. Combined these with PR 2's lease
  channel, minimum-offset deadline, pause canvas removal and replacement viewer replay.
  Moved connecting/paused copy into the HTML and retained the review fix that hides
  checking copy once access is confirmed. Browser tests now assert the shared checking,
  paused and ready states within ModalSheet, alongside the original pause/resume proofs.
- `apps/server/src/computers/view.ts` merged automatically. Checked the result against
  main: PR 2's delivery gates, held bytes and notices retain main's timing records,
  relative lease expiry and admission/upgrade lease engine. Terminal denial, expiry,
  protocol and transport stops remain fenced; pause alone keeps transports open.
- `apps/server/src/computers/view-access.ts` needed no conflict resolution and is
  unchanged from main. The read retry's single shared deadline, late-check mapping,
  every authority fence and #145's denial-first order are preserved.
- `CHANGELOG.md` and `docs/process/ledger.md` merged by union, retaining every main
  entry and adding PR 2's entries. `docs/process/benchmarks.jsonl` is unchanged from
  main; PR 2 added no benchmark rows to union.

The lease settings remain 1,500 ms / 1,200 ms / 250 ms / 5 checks in flight.
No deadline, fence or existing assertion was relaxed. The real-noVNC pause/replay
specification from the second PR 2 commit remains present.

Validation uses Node 22.23.3 in this worktree, its own installed dependencies,
disposable service fixtures and `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Every gate, suite and build runs under `nice -n 10`. Safe local logs are in
`/tmp/i77-pause-main-evidence/`. This is source validation, not fresh-install qualification.

First validation source: rebased `09b69b1` plus the browser resolution/readability
changes and added SharedState/ModalSheet assertions committed with this receipt.

| Command | Result |
| --- | --- |
| `npm run lint` | PASS; six existing function-size warnings |
| `npm run typecheck` | PASS; every workspace |
| `npm run check:events` | PASS; 86 event types agree |
| `npm run test -w apps/web -- --watch=false` | PASS; 18 files / 119 tests, including real-noVNC pause/replay |
| `npm run build -w apps/web` | PASS; bundle/CSS-budget and noVNC CommonJS warnings |
| `npm test -- apps/server/test/live-view*.test.ts apps/server/test/view-lease.test.ts apps/server/test/view-delivery.test.ts --maxWorkers=2` | PASS; 97 tests / two opt-in k3d tests skipped; 226.90 s |
| `npm test -- --maxWorkers=2 --reporter=verbose` | FAIL; 97 files passed / two failed / four skipped; 1,575 tests passed / two failed / 15 skipped; 1,383.34 s |
| Exact failure replay, both files with `--maxWorkers=1` and the original test names | PASS; two tests passed / 14 unselected tests skipped; 83.38 s |
| Final browser ESLint and `git diff --check` | PASS |

The full root failures were:

- `apps/server/test/realtime.test.ts:261`: the paused-consumer test expected
  close code 1013 but received 1006. Its unchanged one-worker replay passed.
- `libs/models/test/authority-volume.test.ts:70`: the 100,000-event bound test
  expected MCP HTTP 200 but received 403. Its unchanged replay passed all routes,
  both before and after seeding 100,000 unrelated events.

Both failing tests and their production paths are unchanged from the tested main
snapshot. Host load was 22.41 near the first failure and 19.89 near the second;
load alone is not a reproduced cause. The complete root gate remains FAIL despite
isolated passes. No timeout, deadline, fence, heartbeat or assertion was changed.
These results do not claim source ready or capability done.

Main advanced during the run with #152 at `ce0e07b` (fixture cleanup and gateway
startup diagnostics). A further `git rebase origin/main` completed without any
conflict. Final combined-source verification uses `0a7ee4d` on that main commit.

### Final combined-source verification

All commands below use the same PostgreSQL URL and `nice -n 10` as above.
The final source is `0a7ee4d`; only this receipt and its ledger index change afterwards.
The branch contains main at `ce0e07b`, both pause commits and the browser conflict
resolution. No rebase state remains. Changelog and ledger union checks pass;
benchmarks, shared authority deadlines, gateway diagnostics and fixture cleanup
retain every main change.

| Command | Result |
| --- | --- |
| `npm run lint` | PASS; six existing function-size warnings |
| `npm run typecheck` | PASS; every workspace |
| `npm run check:events` | PASS; 86 event types agree |
| `npm run test -w apps/web -- --watch=false` | PASS; 18 files / 119 tests, including real-noVNC pause/replay |
| `npm run build -w apps/web` | PASS; existing bundle/CSS-budget and noVNC CommonJS warnings |
| Requested live-view, view-lease and view-delivery group, repeated inside the final root run | PASS; 97 tests / two opt-in k3d tests skipped |
| `npm test -- --maxWorkers=1 --reporter=verbose` | FAIL; 98 files passed / one failed / four skipped; 1,579 tests passed / one failed / 15 skipped; 3,212.48 s |

Both failures from the first complete run passed in this complete rerun:
realtime paused-consumer reconnect and the 100,000-event authority-volume bound.
The final failure is `libs/models/test/gateway.test.ts:759`, the native Codex
request-shape case, which exceeded its existing 40,000 ms limit. The case and
its production path are unchanged from final main. This is a new failure from
the combined full run, not an isolated-replay pass being counted as a green gate.
The first exact replay failed in its suite's `beforeAll` fixture: the gateway
exited with code 1 and `Error: readiness server starts`, so the selected case
was NOT RUN (81 cases skipped). The same command was repeated once with unchanged
limits and passed: one test / 80 unselected skips, 16.70 s. Both replay logs are
retained as `final-failure-replay.log` and `final-failure-replay-2.log`. The full
run's timeout is still a failure; the isolated pass does not turn the root gate green.

The complete root gate remains FAIL. Independent review, hosted CI and fresh-install
Kasm qualification remain pending; the PR stays draft. No timeout, deadline,
fence, heartbeat, queue bound, permission check or existing assertion was relaxed.
