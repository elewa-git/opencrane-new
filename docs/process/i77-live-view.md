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

## Quiet-box qualification

This batch ran on 4 October 2026 from branch `work/i77-quiet`, on secondary
stack **2**. The first `/proc/loadavg` reading was **10.79 / 10.75 / 9.74**
with **8 CPUs**. The one-minute value exceeded 8, so I waited **6 minutes**,
checking every 2 minutes. The readings were **8.83 / 10.22 / 9.69** at 2
minutes, **9.82 / 9.29 / 9.36** at 4 minutes, then **6.09 / 8.52 / 9.10**
at 6 minutes. The initial qualification therefore began below the requested
one-minute threshold. Per-run host load rose to about **8.4–10.7** during the
repetitions; this was a lower-load run than the earlier 15–30 batches, but the
host did not remain below 8 throughout. [Host readings](i77-live-view/quiet/host-load.txt)
and [raw run records](i77-live-view/quiet/runs.jsonl) retain all three load
averages for each run.

The first claimed secondary stack's fresh startup failed during its built-in
journey and its EXIT trap stopped the stack. A second fresh startup also
reported that broad journey failure after the viewer services were available;
the repeat harness then completed all ten repetitions. Its EXIT trap ran
`down.sh --id 2`; a follow-up status showed the secondary services stopped.
No owner-stack command was run, and no Docker daemon or network settings were
changed.

This batch passed **8/10**, so live qualification remains **FAIL**. The
per-run receipts and failure screenshots are in
[the quiet run directory](i77-live-view/quiet/).

| Run | Width | Load before → after (1m) | Result | Revocation to cleared pixels |
| --- | ---: | ---: | --- | ---: |
| 1 | 390 | 9.68 → 9.95 | PASS | 560 ms |
| 2 | 1280 | 9.95 → 10.67 | PASS | 419 ms |
| 3 | 390 | 10.67 → 10.54 | PASS | 431 ms |
| 4 | 1280 | 10.54 → 10.52 | PASS | 395 ms |
| 5 | 390 | 10.52 → 10.15 | PASS | 467 ms |
| 6 | 1280 | 10.15 → 9.48 | PASS | 632 ms |
| 7 | 390 | 9.48 → 8.48 | FAIL; no successful admission response observed within 30 s | — |
| 8 | 1280 | 8.48 → 8.45 | PASS | 1,368 ms |
| 9 | 390 | 8.45 → 9.45 | PASS | 500 ms |
| 10 | 1280 | 9.45 → 8.74 | FAIL; admission returned HTTP 200, but “Viewing” did not appear within 20 s | — |

The failures do not both fit a slow-admission-read explanation. Run 7 timed
out while waiting for an HTTP 200 admission response, which is consistent with
a delayed or refused admission. Run 10 did receive HTTP 200 from admission at
about **9.45** one-minute load, then failed to show the viewer state. That
failure happens after the admission response and points towards a post-admission
viewer/session path, so load or a slow admission read alone does not explain
this batch. The evidence leans towards a logic or connection-state failure,
but does not prove its precise cause.

The repeat harness wrote overall run duration, result, failure text, and host
load, but it did not emit per-request admission or internal authority-read
timings for these failures. The existing safe
[admission timing record](i77-live-view/admission-times.jsonl) was not updated
by this batch and describes earlier requests; those timings cannot be assigned
to runs 7 or 10. No internal authority timing is claimed here. The harness
needs to retain safe per-request timing metadata before the remaining failure
can be fully separated into authority latency and viewer logic.

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
