# Live view pauses while access checks are unavailable — #77, PR 2 of 2

**Status: PARTIAL.** All source gates pass on the final stack. Fresh-install live
qualification and real Kasm pause/replay remain **NOT RUN** in this change.

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
