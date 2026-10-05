# Live-view lease delays — issue 77

**Status: PARTIAL.** Deterministic lease regressions pass, but live qualification
failed in both ten-run batches. #77 remains open.

Work started from `65364a03b59babb3cacddd24978732edca831e5f` on
`work/i77-liveview`, 4 October 2026. This receipt separates deterministic source
checks from fresh-stack qualification. No dependency, event type, authority
fence or viewer deadline changes.

## Diagnosis and red-to-green evidence

The viewer does not call `currentAuthority`: it reads exact conversation,
member, computer and desktop-grant streams through `viewAccess`, then checks
OpenFGA. #70's exact-subject read probe was reused at that event-store boundary,
with real NATS, PostgreSQL and OpenFGA fixtures. Delays are injected at the
external read/HTTP/desktop boundaries, independently of host load.

| Trigger | Before the fix | Result after the fix |
| --- | --- | --- |
| One renewal NATS read takes 1,400 ms; later checks have 10/20/70 ms jitter | WebSocket CLOSED although newer checks renewed the lease | Viewer remains open and forwards desktop bytes; explicit revocation still closes within 2 s |
| One pair of OpenFGA replies takes 1,300 ms; later replies have 10/30/80 ms jitter | SDK reports unavailable at its 1,000 ms limit; live view converts this into Access changed | Unavailable does not revoke a still-valid lease; explicit denial still wins |
| NATS TCP replies are paused for 700 ms | Real NATS requests fail at their 250 ms deadline and close an otherwise valid viewer | Recognised transient store errors use the same unavailable path; the viewer recovers |
| First post-audit authority read takes 1,400 ms; later post-audit checks succeed | Socket hang-up before WebSocket upgrade | A newer successful, matching-computer post-audit check satisfies admission while its lease remains valid |
| Every post-audit check unavailable, or grant revoked after the start audit | Must refuse | No desktop opened |
| Computer reads take 450 ms, start audit takes 1,600 ms, desktop opening takes 1,800 ms and greeting fragments are separated by 1,800 ms | Control, no separate failure identified | Desktop opens and forwards the complete greeting; a 1,300 ms admission read is still refused |

The renewal failures came from treating an inconclusive check as an explicit
denial. Admission repeated that mistake even though a newer check had already
satisfied the same post-audit requirement. The fix introduces
one typed unavailable result, reuses the event store’s existing transient-error
classification, and remembers when the latest successful renewal
started. It never renews from an unavailable result. Explicit authority denials,
changed computers and malformed histories retain their refusal path.

The limits remain: checks start every **250 ms**, each check has a **1,200 ms**
deadline, OpenFGA has a **1,000 ms** deadline, and the permission snapshot expires
**1,500 ms after the successful check started**. A late reply cannot renew from
its completion time. The initial provisional lease is not proof of post-audit
authority. Existing total-outage, delayed-positive-after-revocation and delayed
audit regressions remain part of validation. Browser qualification also checks
that revocation removes the canvas within **2,000 ms**.

Measured probe samples before the admission fix: the delayed NATS read took
**1,415 ms**, while other exact reads took **4–81 ms**, returning one checkpoint
event each. The OpenFGA proxy's delayed replies took **1,304 ms**, while other
replies took **4–96 ms**. Slow-stream control admission took **596 ms**, opening
completed at **5,010 ms**, and the complete greeting arrived at **6,814 ms**.
These are service-boundary timings, not a throughput guarantee.

The later [transport probes](i77-live-view/delay-probes.jsonl) record actual
NATS `TimeoutError` results at **251–320 ms** during the brief network pause.
A sustained network outage closed the viewer in **1,485 ms**, with no lease
extension. All **eight** delay/recovery/refusal cases passed in **73.94 s**;
the earlier combined API run passed **20 tests** in **106.94 s**. The new outage
control and full root suite supply the final combined coverage.

## Upload investigation

The P3-18 upload failure precedes viewer admission and involves a separate model
process (`secondary-models.ts` → `models-main.ts`). Lease refusal closes a viewer;
it cannot terminate that model process. The retained logs do not contain the
exception behind exit code 1: one says the container no longer exists, the other
only records stub startup. Shared service latency is possible, but a shared root
cause is not established. The independent crash/unfinished-turn investigation
is [issue 113](https://github.com/elewa-git/opencrane-new/issues/113). During this
work’s loaded viewer repetitions, the secondary model container remained
`running`, exit code `0`, `OOMKilled=false`.

## Live qualification

Live qualification is **FAIL**: the first batch passed **3/10** (two setup
failures, five viewer failures); the second passed **5/10**. Across both batches,
eight complete journeys cleared pixels within **395–1,158 ms** of revocation.
These results do not close #77 or establish a reliable live capability.
The preliminary fresh stack used the renewal-only fix because its server had
started before the admission fix was written. Its core journey reached the
390px second viewer open, then timed out with Disconnected. The first repeat
harness attempt was refused before viewer admission because its conversation
POST omitted Origin; the harness now supplies Origin and waits for the
conversation projection. Those setup failures are not viewer qualification. A second fresh attempt failed
in the sign-in refusal probes before fixture members joined; the focused harness
now bootstraps members through invitation/join events when needed. Both earlier
claimed secondary stacks were torn down successfully.

The third fresh attempt claimed secondary **2** with initial one-minute load
**10.88**. Its broad startup journey again failed at the second 390px viewer
connection while load was about **27**. The start/stop audit records
`access_changed` after **1,711 ms**. Its first two focused repetitions could not
reach the viewer because the dispatcher had exited with JetStream
“heartbeats missed”; only this claimed secondary’s worker was restarted.

Run 3 then passed end to end, clearing pixels in **395 ms** after revocation.
Temporary, non-pausing inspector probes on this secondary captured run 4:
the post-audit check expired after **1,316 ms**, with **no successful renewal**.
Computer reads took **704 ms** or failed with a NATS timeout after **796 ms**;
other concurrent exact reads reached **940 ms**. Admission refused with
179 ms left on the provisional lease. This is an unavailable admission fence,
not a late failure overriding newer proof. Inspector probes can affect timings;
they were removed after this diagnostic sample. No viewer deadline was changed
to make this case pass. The [probe records](i77-live-view/live-probes.jsonl) retain
the measured boundaries. The shell EXIT trap retained teardown responsibility through both batches.

The complete loaded batch is retained in [runs.jsonl](i77-live-view/loaded/runs.jsonl).
Load columns below are the one-minute averages before and after each run.

| Run | Width | Load before → after | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 | 390 | 29.67 → 25.61 | FAIL; conversation projection | [screenshot](i77-live-view/loaded/run-1-failure.png) |
| 2 | 1280 | 25.61 → 26.58 | FAIL; conversation projection | [screenshot](i77-live-view/loaded/run-2-failure.png) |
| 3 | 390 | 26.58 → 28.58 | PASS; revoked in 395 ms | [receipt](i77-live-view/loaded/run-3.json) |
| 4 | 1280 | 28.58 → 26.60 | FAIL; Viewing timeout | [screenshot](i77-live-view/loaded/run-4-failure.png) |
| 5 | 390 | 26.60 → 27.85 | FAIL; Viewing timeout | [screenshot](i77-live-view/loaded/run-5-failure.png) |
| 6 | 1280 | 27.85 → 27.85 | FAIL; Viewing timeout | [screenshot](i77-live-view/loaded/run-6-failure.png) |
| 7 | 390 | 27.85 → 29.69 | FAIL; Viewing timeout | [screenshot](i77-live-view/loaded/run-7-failure.png) |
| 8 | 1280 | 29.69 → 28.90 | PASS; revoked in 667 ms | [receipt](i77-live-view/loaded/run-8.json) |
| 9 | 390 | 28.90 → 25.63 | PASS; revoked in 1060 ms | [receipt](i77-live-view/loaded/run-9.json) |
| 10 | 1280 | 25.63 → 24.56 | FAIL; Viewing timeout | [screenshot](i77-live-view/loaded/run-10-failure.png) |

The second batch waited for `cut -d. -f1 /proc/loadavg` to fall below 16,
checking every two minutes. Load rose again during real sign-in. Its per-run
loads are below; this was **not** a consistently normal-load qualification.
No worker restart or inspector probe was used during this batch.
The [raw receipts](i77-live-view/runs.jsonl) include duration and all three load averages.

| Run | Width | Load before → after | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 | 390 | 21.02 → 20.53 | FAIL; admission response | [screenshot](i77-live-view/run-1-failure.png) |
| 2 | 1280 | 20.53 → 18.71 | PASS; revoked in 710 ms | [receipt](i77-live-view/run-2.json) |
| 3 | 390 | 18.71 → 17.41 | PASS; revoked in 1158 ms | [receipt](i77-live-view/run-3.json) |
| 4 | 1280 | 17.41 → 18.34 | PASS; revoked in 507 ms | [receipt](i77-live-view/run-4.json) |
| 5 | 390 | 18.34 → 17.21 | PASS; revoked in 1065 ms | [receipt](i77-live-view/run-5.json) |
| 6 | 1280 | 17.21 → 17.81 | FAIL; admission response | [screenshot](i77-live-view/run-6-failure.png) |
| 7 | 390 | 17.81 → 16.44 | PASS; revoked in 793 ms | [receipt](i77-live-view/run-7.json) |
| 8 | 1280 | 16.44 → 15.34 | FAIL; Viewing timeout | [screenshot](i77-live-view/run-8-failure.png) |
| 9 | 390 | 15.34 → 16.38 | FAIL; Viewing timeout | [screenshot](i77-live-view/run-9-failure.png) |
| 10 | 1280 | 16.38 → 17.71 | FAIL; pixel wait; Access changed | [screenshot](i77-live-view/run-10-failure.png) |

The [admission timings](i77-live-view/admission-times.jsonl) contain only safe
request metadata. The initial 403 in each journey is the expected no-grant
refusal. Additional 403 responses in runs 1 and 6 took **1,336 ms** and
**1,607 ms**, including refusal auditing. Later failures also occurred around
one-minute load **15–18**. The sampled admission failure shows unavailable
checks without newer proof; the remaining lower-load failures have not been
fully explained. Further diagnosis and successful fresh qualification remain
required; the passing delay regressions are not evidence that every live
failure has been fixed.

All three fresh attempts use a shell EXIT trap calling `down.sh --id`.
Final `down.sh --id 2` completed **PASS**, exit 0, in **53.49 s**. The fresh
startup took **360.12 s** and failed its broad journey; the two focused runners
took **637.68 s** and **439.51 s**, including real sign-in/out probes. The full
root suite started at **13:03:37 UTC**, with load **8.89 / 15.03 / 19.00**,
after the required integer one-minute load check passed. It completed **PASS**:
**1,391 passed / 14 skipped**, **80 files passed / 3 skipped**, **1,120.85 s**
wall time (**1,118.99 s** Vitest). The opt-in tests remain NOT RUN.

## Source gates and review

Independent source review: **PASS**, no blocking findings in either of the two passes. The reviewer checked
the four red reproductions, lease expiry, denial precedence, post-audit proof
and outage/refusal controls. All source gates pass; live qualification remains
a separate failed gate. The final source was hashed before its fresh startup:

| File | SHA-256 |
| --- | --- |
| `apps/server/src/computers/view.ts` | `7501cd91f1bc174cd4bcb83d191b26df0514333f0c18d41a06e91d429c94f985` |
| `apps/server/src/computers/view-access.ts` | `5e8f796b6c1ad183fe80e151022980a4a51fec7fb64c924786314b0c588aa120` |
| `apps/server/test/live-view-delays.test.ts` | `98dbef02b2614a5286c8854e1e96c44ab0270348a1a7e28ce930f63c0cac887f` |
| `infra/dev-stack/live-view-repeat.ts` | `d7e55968c5ca4e8fb6f1d222df051aee74eee934432f98959e2547ff0c8e453c` |
| `libs/event-store/src/jetstream.ts` | `b68b8b7ae0dd2d41954fd81c1ab09eecc393821e033a024021cb9bfbacc7f6a0` |
| `libs/event-store/src/index.ts` | `a41835fa0de7454098d5c9bb388320688febeb7b811b5883f77181bf6622853e` |

Node **22.23.3**, own worktree installation, PostgreSQL fixtures at
`postgres://postgres:test@127.0.0.1:55432/postgres`. No paid model calls.

| Check | Result | Wall seconds |
| --- | --- | --- |
| `npm ci` | PASS | Not timed |
| `npm run lint` | PASS; eight existing size warnings | 288.32 |
| `npm run typecheck` | PASS | 171.31 |
| `npm run check:events` | PASS; 85 types agree | 0.68 |
| `npm run build -w apps/web` | PASS; existing noVNC CommonJS warning | 20.47 |
| `npm run test -w apps/web` | PASS; 60 tests / 11 files | 32.22 |
| `npx tsc --noEmit -p infra/dev-stack/tsconfig.json` | PASS | 39.87 |
| Both live-view API files, `--maxWorkers=2` | PASS; 20 tests before adding the sustained NATS outage control | 106.94 (Vitest) |
| Final delay/control file, `--maxWorkers=2` | PASS; eight tests | 73.94 (Vitest) |
| Full root suite, `--maxWorkers=2` | PASS; 1,391 passed / 14 skipped; 80 files passed / 3 skipped | 1,120.85 |

Timings include command startup except where labelled Vitest. Earlier red/green runs and private command logs are retained at
`/tmp/i77-*.log`; the measurements and verdicts above are the retained public
evidence, not links that depend on those temporary files.

## Post-admission diagnosis — 4 October 2026

**Status: PARTIAL; live qualification FAIL (4/10).** This investigation started
from `bacbfdbe46ba042040a2491ad0bbacffc185a764` on `work/i77-diag`, including
PR #128. It read the quiet batch at `7a92027` on `origin/work/i77-quiet`:
8/10 passed, with one missing successful admission response and one HTTP 200
followed by no Viewing. Those old runs have no internal timing records, so their
exact cause cannot be established retrospectively.

The new batch reproduced the HTTP-200/no-Viewing symptom. **The demonstrated
failure is lease expiry during desktop startup, or before the first frame,
when authority checks cannot complete in time.** It is not evidence that an
old failed check overrides a newer, still-valid lease. The box was CPU-starved
during this batch; direct scheduler measurements below establish starvation of
the secondary server process. No authority, admission or revocation deadline
was relaxed, and no speculative behavioural fix was applied.

### Safe timing records

The server emits JSON records with `operation: "view.timing"` at info level,
except successful lease renewals under 250 ms, which use debug level.
`sessionId` joins ticket issuance to upgrade, audit, pod lookup, first upstream
bytes, first framebuffer forwarding, lease checks and stopping. Timing records
do not include a conversation ID. Lease checks include their phase, monotonic
`checkedAtMonotonic`, the current lease expiry as milliseconds from session
start, outcome and duration. Stop records include the lease expiry as well.
There is no separate start record because the outcome contains the elapsed
duration. Unavailable checks distinguish `event_store`,
`authorisation` and `deadline`; raw errors are never logged. The desktop helper
ignores stderr entirely because it can contain credentials or an unbounded
line. `first_upstream_bytes` records the Kasm connection becoming useful to the
viewer. Tickets, cookies, credentials, request headers and desktop content are
excluded from these records.

Timings have specific meanings:

- `time` is the logger's wall-clock timestamp. `elapsedMs` starts again on
  upgrade; join admission and upgrade by `time` and `sessionId`.
- `upstream_open` means the duplex transport was created. `first_upstream_bytes`
  is the first signal that the remote desktop has connected and sent RFB data.
- `first_upstream_bytes` is the first RFB data, normally the greeting.
  `first_browser_frame` is the first complete framebuffer update accepted by
  `ws.send`, measured from upstream opening. It can be an empty update; it is
  not delivery acknowledgement or proof of decoded browser pixels. The existing
  browser journey separately checks decoded, non-uniform pixels.

From an already claimed secondary, collect ten runs with:

```sh
node --experimental-strip-types infra/dev-stack/live-view-repeat.ts docs/process/i77-live-view/diag
```

The optional argument selects the output directory. Each run retains an
allowlisted server timing JSONL file and browser admission-status/connection
milestones, including failures. The collector reads only the selected
secondary's `server.log`. No browser frame payload is recorded.

### What failed after HTTP 200

[Run 1 timings](i77-live-view/diag/run-1-timings.jsonl) and
[browser milestones](i77-live-view/diag/run-1-browser.json) show:

1. Ticket issuance succeeded in **61 ms**. Upgrade authority took **87 ms**,
   start-audit persistence **25 ms**, and post-audit authority **189 ms**.
2. Pod lookup took **1,129 ms**. The browser WebSocket upgraded successfully
   in **1,486 ms**. Kasm connection was still pending; no upstream bytes or
   framebuffer were forwarded.
3. The last successful renewal started at `1791125872679` and completed in
   **987 ms**. Its permission snapshot therefore expired at `1791125874179`.
   Other checks became unavailable: an event-store failure after **750 ms**
   and check deadlines after **1,286 ms** and **1,221 ms**.
4. The server stopped at `1791125874434`, **255 ms after** the stored lease
   expiry. The desktop child then exited. A later positive check arrived at
   `1791125874910`, **476 ms after stopping**; it correctly did not reopen the
   viewer. Browser records show HTTP 200, socket creation and socket close,
   with no received bytes.

[Run 3](i77-live-view/diag/run-3-timings.jsonl) reached Kasm and received its
first bytes after **1,606 ms**, but authority expired before the first complete
frame. [Run 4](i77-live-view/diag/run-4-timings.jsonl) again expired before any
upstream bytes. Its last successful snapshot expired at `1791125979223`;
subsequent event-store checks failed after **711 ms** and **628 ms**, and it
stopped at `1791125979373`.

[Run 5](i77-live-view/diag/run-5-timings.jsonl) received a ticket, then the
upgrade authority check failed at the event-store boundary after **1,069 ms**.
It never wrote a start audit or opened a desktop. HTTP 200 admission therefore
does not by itself establish successful WebSocket admission.

[Run 7](i77-live-view/diag/run-7-timings.jsonl) forwarded a frame at
`1791126047458`, then expired **157 ms later** while the browser was trying to
focus the zoom control. Two event-store failures and a **1,171 ms** successful
check left only a short remaining lease. Later successful checks arrived after
stopping. This distinguishes a first-frame success followed by lost authority
from a desktop that never connected.
The [run 1](i77-live-view/diag/run-1-failure.png) and
[run 7](i77-live-view/diag/run-7-failure.png) screenshots both show Access changed
with the protected canvas removed.

### Host evidence and deterministic controls

The load gate passed at **5.64 / 4.78 / 6.24** immediately before claiming
secondary **2**. The earlier failed claim was at **6.27**. Both slots contained
only old ownership markers from `i77-quiet`; slot 2 had no containers or pods.
Its normal `down.sh --id 2` entrypoint, run from the recorded worktree, released
that completed secondary. This work then claimed it through `claim.sh`, set
`DEV_STACK_ID=2` and the requested `ZITADEL_KEY_FILE`, and ran `up.sh --fresh`.
The shell EXIT trap retained `down.sh --id 2` responsibility. No owner-stack,
Docker daemon, containerd, firewall, bridge or routing setting was changed.

The fresh broad journey failed, and the focused harness subsequently completed
all ten runs. Despite the initial gate, one-minute load during the repetitions
was **17.89–25.80**. This was a loaded batch, not a repeat of the quiet batch. Structured logging also adds some work; this
batch is not a measurement of the uninstrumented server.
[Host gate readings](i77-live-view/diag/host-load.txt) and
[run records](i77-live-view/diag/runs.jsonl) retain the measurements.

The retained [sampling script](i77-live-view/diag/scheduler-probe.py) produced
[scheduler samples](i77-live-view/diag/scheduler.jsonl) by reading the secondary
server's main thread and NATS main thread from `/proc/<pid>/schedstat` every
two seconds, together with `/proc/pressure/cpu`. Field meanings follow the
[Linux scheduler statistics](https://docs.kernel.org/scheduler/sched-stats.html)
and [pressure documentation](https://docs.kernel.org/accounting/psi.html). Between **15:00:28.049** and
**15:00:30.056 UTC**, the server spent **1,521 ms runnable but waiting for CPU**
and only **445 ms executing**. Adjacent two-second intervals show **979–1,483
ms** of runnable wait. This is direct server CPU-starvation evidence, rather
than an inference from load average alone. Sampling began during run 5; these
scheduler values must not be assigned to runs 1–4.

Across all scheduler samples, runnable wait ranged from **95 to 1,521 ms** per
two seconds. Failing runs 5–7 had **901–1,264 ms average runnable wait** per
two seconds, compared with **370–622 ms** in passing runs 8–10.

The [NATS cgroup readings](i77-live-view/diag/nats-cpu.jsonl) recorded only
**88.638 ms cumulative quota throttling** across **5,758 quota periods** at
**14:59:27 UTC**. Host CPU pressure
at that time was **79.91% over ten seconds**. NATS quota throttling is therefore
not a supported explanation for the multi-second delays. These records do not
measure the desktop's individual scheduling wait or isolate NATS processing
latency from server scheduling. The proven conclusions are server starvation
and missed authority checks; attributing every old quiet failure specifically
to Kasm or NATS would go beyond the evidence.

The eight existing delay/outage regressions passed before live qualification.
The added public HTTP/WebSocket control forwards a complete fragmented
framebuffer across a **1,400 ms** delayed check while other renewals succeed,
then verifies explicit revocation within **2,000 ms**. A second control reproduces
HTTP 200 and successful WebSocket upgrade followed by closure before the first
bytes when NATS replies remain unavailable. That is the required refusal path,
not a failing assertion to remove by extending the lease. No new functional
bug was established, so there is no claimed red-to-green behavioural fix.

### Ten-run results

Every row links its timing records; the adjacent `run-N-browser.json` file
contains browser milestones. First-frame durations are measured from upstream
opening. Two numbers mean the initial view and the reopened view during the
assistant turn, in that order. A dash means the stage was not reached.

| Run | Width | Load before → after | Upgrade ms | First frame ms | Result |
| --- | ---: | --- | --- | --- | --- |
| [1](i77-live-view/diag/run-1-timings.jsonl) | 390 | 21.66 → 23.13 | 1,486 | — | FAIL; lease expired before first bytes |
| [2](i77-live-view/diag/run-2-timings.jsonl) | 1280 | 23.13 → 21.48 | 1,170 / 2,011 | 2,944 / 2,681 | PASS; revoked in 604 ms |
| [3](i77-live-view/diag/run-3-timings.jsonl) | 390 | 21.48 → 22.45 | 876 | — | FAIL; first bytes received, lease expired before frame |
| [4](i77-live-view/diag/run-4-timings.jsonl) | 1280 | 22.45 → 25.19 | 2,810 | — | FAIL; lease expired before first bytes |
| [5](i77-live-view/diag/run-5-timings.jsonl) | 390 | 25.19 → 25.61 | — | — | FAIL; upgrade authority unavailable |
| [6](i77-live-view/diag/run-6-timings.jsonl) | 1280 | 25.80 → 25.80 | — | — | FAIL; conversation creation HTTP 409, no viewer attempt |
| [7](i77-live-view/diag/run-7-timings.jsonl) | 390 | 25.80 → 25.00 | 1,337 | 3,814 | FAIL; lease expired after frame, before zoom control |
| [8](i77-live-view/diag/run-8-timings.jsonl) | 1280 | 25.00 → 21.46 | 1,383 / 1,251 | 1,978 / 2,193 | PASS; revoked in 986 ms |
| [9](i77-live-view/diag/run-9-timings.jsonl) | 390 | 21.46 → 20.10 | 371 / 352 | 1,987 / 1,621 | PASS; revoked in 808 ms |
| [10](i77-live-view/diag/run-10-timings.jsonl) | 1280 | 20.10 → 17.89 | 1,123 / 582 | 1,300 / 2,137 | PASS; revoked in 857 ms |

The four passing journeys do not close #77. A successful fresh-install
qualification, including a ten-run batch without competing CPU starvation,
remains outstanding. The correct next operational step is to provide CPU
capacity for authority checks and desktop startup within the existing limits;
this change does not alter shared-host services or resource settings.

Final teardown: **PASS**. The trap completed and a read-only follow-up found
no secondary-2 directory or Compose containers; see the
[teardown receipt](i77-live-view/diag/teardown.txt). The initial live source
hashes are retained in [source-sha256.txt](i77-live-view/diag/source-sha256.txt).
Later production edits only expanded helper bodies and named option objects
for clarity. The review findings and resulting fixes are recorded in draft PR
[#139](https://github.com/elewa-git/opencrane-new/pull/139). The live batch
used earlier `view.ts` and `desktop.ts` sources; its measurements qualify that
source snapshot only. The full root suite was rerun on final HEAD after the
source fixes, so its result covers the final source revision.

Source validation is recorded separately below; live qualification remains
FAIL regardless of source-gate results.

### Final source gates

Node **22.23.3**, an independent `npm ci` installation in this worktree, and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The [validation gate](i77-live-view/diag/gates-load.txt) passed at **15.96**.
Before the full root suite, the separate [load check](i77-live-view/diag/root-load.txt)
waited two minutes for **17.13 → 12.12**, then started at **15:16:49 UTC**.
[Command receipts](i77-live-view/diag/gates.txt) retain exit codes and wall times.

The three earlier lint attempts covered intermediate diagnostic-test source
revisions. They do not describe the final source. The final lint result below
covers final HEAD; the root suite was also rerun on final HEAD.

| Check | Result | Wall seconds |
| --- | --- | ---: |
| `npm run lint` (final) | PASS; eight existing size-warning locations | 87.85 |
| `npm run typecheck` (final) | PASS | 78.23 |
| `npm run check:events` | PASS; 85 types agree | 1.51 |
| `npm run test -w apps/web` | PASS; 60 tests / 11 files | 34.93 |
| Infra TypeScript check | PASS | 24.97 |
| Earlier full root suite, `--maxWorkers=2` | PASS; 1,415 passed / 15 skipped; 83 files passed / 4 skipped | 1,384.34 including load wait |

The root command wall time includes the **120 s** load wait. Vitest itself
started at **15:16:51 UTC** and ran for **1,262.20 s**. The skipped opt-in
conditions remain **NOT RUN**; the full-suite result does not turn the failed
live batch into a pass. The [root summary](i77-live-view/diag/root-tests.txt)
and [final production source hashes](i77-live-view/diag/final-source-sha256.txt)
retain the check's source/evidence context. That earlier root run preceded the
review fixes and does not qualify the final source.

On the final production-source revision, lint, typecheck and `check:events` all **PASS**. The
live-view batch had **33 passed, 2 skipped and 1 timed out**: the 1,250 ms
admission-deadline case timed out in the concurrent batch, while both deadline
cases passed when run alone; a single-worker retry also passed the ticket
redemption case that had timed out in the root run. The full root suite had **1,448 passed, 15
skipped and 2 failed** across 90 files: a NATS request timed out during ticket
redemption, and the authority-volume timing check measured 1,026.99 ms against
its 1,000 ms bound. A single-worker retry of the volume test then received a
403 unavailable response from its decision service. The host was under
concurrent test load; these are failed runs, not passes. Live qualification
remains **FAIL**.

## Final qualification — 5 October 2026

**FAIL: 4/10 viewer runs passed.** The acceptance condition is ten of ten runs
with explicit revocation clearing the viewer within **2,000 ms**. Runs 1, 2,
3 and 8 passed that bound. Runs 4–7, 9 and 10 disconnected before reaching the
“Viewing” state, so revocation was not reached on those runs. The table reports
the per-run result, measured revoke-to-clear time, pause record, CPU pressure and
secondary server run-delay delta. Full receipts and timing files are in
[the final batch directory](i77-live-view/final/).

Before the final secondary claim, host readings were load average **18.05 /
16.66 / 14.92**, **8 CPUs**, and CPU pressure `some avg10=29.76%`
(`avg60=47.77%`, `avg300=52.08%`). Each run's CPU pressure is the harness's
`some avg10` value after waiting up to 120 seconds for pressure below 20%.
Run delay is the secondary server's `/proc/<pid>/schedstat` run-delay delta,
converted from nanoseconds to milliseconds. Pause duration is recorded only
when the browser journey completes; failed runs did not produce a pause count
or pause duration. Server-side `lease_pause` timing markers are called out in
the result where present.

| Run | Width | Result | Revoke-to-clear | Pauses / pause ms | CPU pressure some avg10 | Server run delay |
| ---: | ---: | --- | --- | --- | ---: | ---: |
| 1 | 390px | PASS | 421 ms | 0 / 0 | 48.06% | 6,403.5 ms |
| 2 | 1280px | PASS | 430 ms | 0 / 0 | 59.95% | 6,603.1 ms |
| 3 | 390px | PASS | 386 ms | 0 / 0 | 64.18% | 5,880.5 ms |
| 4 | 1280px | FAIL; disconnected before Viewing | NOT REACHED | Not captured | 50.74% | 11,096.4 ms |
| 5 | 390px | FAIL; disconnected before Viewing | NOT REACHED | Not captured | 41.65% | 6,729.9 ms |
| 6 | 1280px | FAIL; disconnected before Viewing | NOT REACHED | Pause marker; duration not captured | 49.35% | 8,456.8 ms |
| 7 | 390px | FAIL; disconnected before Viewing | NOT REACHED | Not captured | 24.48% | 5,907.1 ms |
| 8 | 1280px | PASS | 497 ms | 0 / 0 | 61.93% | 10,221.1 ms |
| 9 | 390px | FAIL; disconnected before Viewing | NOT REACHED | Not captured | 67.63% | 13,357.2 ms |
| 10 | 1280px | FAIL; disconnected before Viewing | NOT REACHED | Pause marker; duration not captured | 36.15% | 15,071.9 ms |

Failure timing evidence:

- Run 4 returned admission HTTP 200, upgraded and received its first browser
  frame at **2,535 ms**. It stopped as disconnected at **5,907 ms**; retries
  also closed before “Viewing”. No revocation was attempted.
- Run 5 returned admission HTTP 200 and received its first browser frame at
  **1,225 ms**, then disconnected at **3,491 ms**. A later check succeeded,
  after the browser socket had closed. No revocation was attempted.
- Run 6 received its first browser frame at **2,220 ms**. A renewal timed out
  after **1,201 ms** and emitted `lease_pause` at **4,292 ms**; a check succeeded
  **305 ms** later, but the socket disconnected at **4,614 ms**, before Viewing.
- Run 7 received its first browser frame at **1,309 ms**, disconnected at
  **2,414 ms**, then recorded an unavailable check (**1,253 ms**) and a denied
  check (**1,108 ms**). No revocation was attempted.
- Run 9 received its first browser frame at **2,079 ms**, disconnected at
  **4,267 ms**, then recorded a denied check at **4,969 ms**. No revocation was
  attempted.
- Run 10 emitted `lease_pause` at **3,063 ms** and resumed after a successful
  check at **3,205 ms**. It received its first browser frame at **2,684 ms**,
  disconnected at **5,139 ms**, and then recorded two unavailable checks
  (**1,213 ms** and **1,293 ms**) followed by a successful check. No revocation
  was attempted.

The first two attempts on updated main failed before viewer admission because
`browserLiveViewJourney` installed its state observer before the modal existed
and queried `aria-label` although the native dialog uses `aria-labelledby`.
For the final measured batch only, I temporarily moved that observer after the
initial unavailable dialog opened and targeted the labelled dialog. This was a
local dev-stack test-harness adjustment; it is not in the branch. Application
source and every viewer, lease and revocation deadline remained unchanged. The
checked-in harness was restored after the run.

The final `up.sh --fresh` journey with that temporary harness adjustment passed
the upload and live-view steps, then failed at the later audit privacy-canary
assertion. The post-batch `journey.sh` invocation failed earlier at the chat
`.caret` wait; upload and live view were not reached in that invocation. Stack
2 teardown **PASS**ed through the shell EXIT trap. No owner stack or Docker
daemon settings were changed.

On current `origin/main` (#158 included), lint, typecheck and `check:events`
**PASS**ed. The full root suite **FAIL**ed: **1,604 passed, 15 skipped, 1
failed test and 1 failed suite** across 106 files (100 passed, 4 skipped, 2
failed). `libs/models/test/gateway.test.ts` failed with JetStream “heartbeats
missed”; `apps/server/test/integrations.test.ts` failed its Chromium dev-proxy
refresh assertion. Isolated retries of both files then **PASS**ed: gateway,
80 passed / 1 skipped; integrations, 20 passed. The infra TypeScript check also
passed on the rebased revision with the temporary harness adjustment. Logs,
commands and timings are retained in [the final batch directory](i77-live-view/final/).
The live qualification remains **FAIL**.
