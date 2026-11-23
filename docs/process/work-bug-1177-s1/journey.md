# Concurrent tool publication

Date: 23 November 2026 UTC. Builder's own checks only.

Journey on a fresh dev stack: PASS

## Main comparison

Source: `5576ecd1ddb82149eff8132d613293d1acfb05ab`.

The admission samples from 06:42:55 to 06:48:11 UTC showed both secondary slots
free, no package stack and one-minute load below six. Claimed slot 1 and supplied
`--id 1` literally to fresh startup, status and teardown.

Fresh startup passed CORE at 390 px and 1280 px. This included real sign-in,
streamed stub replies, reload, Stop, uploads, the desktop grant refusal, live
viewing during a reply and revocation. The dispatcher stayed up without a
heartbeat error and reached the current event-log position.

- [Main mobile chat and Stop](main-core-390.png)
- [Main desktop chat and Stop](main-core-1280.png)

The guarded TLS launcher reported both server and models ready. A separate
Playwright driver reused the standard sign-in and owner setup and submitted the
current reviewed publication through the HTTP API. It reused the current review
helper from the earlier comparison; main's older default CORE helper submits a
legacy publication, which does not request gateway configuration.

| Position | Event | UTC |
| --- | --- | --- |
| 451 | `mcp.server_registered` | 07:04:01.616 |
| 452 | `mcp.server_discovered` | 07:04:03.017 |
| 453 | `mcp.server_reviewed` | 07:04:03.670 |
| 454 | `mcp.server_published` | 07:04:04.177 |
| 455 | `gateway.configuration_requested` | 07:04:04.632 |
| 456 | `mcp.catalogue_checked`, failed | 07:04:04.779 |
| 457 | `mcp.catalogue_checked`, failed | 07:04:10.197 |
| 458 | `mcp.catalogue_checked`, unchanged | 07:04:10.266 |

Both failed checks reported `catalogue_watch_unavailable`. The failed check
invalidated the pending review before gateway acknowledgement. The unchanged
90-second readiness wait failed. The dispatcher remained running and caught up
through position 459. Main therefore passed configuration request and dispatcher
uptime in this attempt; complete publication readiness failed.

The PostgreSQL advisory lock has no heartbeat. A focused diagnostic held the
dispatcher's SQL write for six seconds with no spare pool connection. It passed
and dispatched a second event afterwards. Neither that diagnostic nor this fresh
main run reproduced the reported NATS heartbeat error. This change makes no claim
to fix that intermittent error or establish that #1174 caused it.

A separate real-NATS regression reproduced another cause of a missing configuration
request. Publication wins the conditional append while a successful unchanged
catalogue capture is running. The watch records that normal conflict as a failed
check, invalidates the saved review and makes gateway preparation reject the
publication. Both capture and append barriers failed before the fix in
`5d6689a93`, including `PublicationUnavailable` from gateway preparation.

Sanitised startup and service logs, event snapshots and all available screenshots
were retained in the private task receipt before teardown. The guarded launcher
stopped, `down.sh --id 1` succeeded and slot 1 reported `free`. Paid calls: zero.

## First changed-source attempt

Source: `f8a38ee69`. Admission passed from 07:37:23 to 07:42:38 UTC;
[the ten samples](admission.csv) show both slots free, no package stack and load
below six. Claimed slot 1 and passed its id literally. Fresh CORE passed both
widths, and the dispatcher stayed up without a heartbeat error.

- [First-attempt mobile CORE](attempt1-core-390.png)
- [First-attempt desktop CORE](attempt1-core-1280.png)

The guarded launcher was ready. The browser registered the demo integration and
NATS saved its discovered catalogue. The collector then waited for the next link
without pressing the screen's explicit Check status button. It timed out before
review or publication. This attempt is FAIL; tool publication, configuration request
and gateway acknowledgement are NOT RUN in this attempt.

- [Collector failure at 390 px](attempt1-publication-failure-390.png)
- [Collector failure at 1280 px](attempt1-publication-failure-1280.png)

Logs and screenshots were saved before teardown. The guarded launcher stopped and
`down.sh --id 1` succeeded. The collector now waits for completed discovery and
presses Check status before continuing. Product source, assertions and timeouts
are unchanged. A further attempt requires another fresh stack.

## Second changed-source attempt

Source: `f8a38ee69`. The [second admission samples](admission-final.csv) ran from
08:01:27 to 08:06:40 UTC. Claimed slot 1 and passed its id literally. Fresh CORE
passed both widths; the dispatcher stayed up without a heartbeat error.

- [Second-attempt mobile CORE](attempt2-core-390.png)
- [Second-attempt desktop CORE](attempt2-core-1280.png)

The corrected browser collector registered the demo, pressed Check status after
discovery, chose Ask for `change_delivery_slot`, reviewed access and confirmed the
publication. Confirmation was disabled until the acknowledgement checkbox was checked.

- [Confirmation at 390 px](attempt2-publication-confirmation-390.png)
- [Confirmation at 1280 px](attempt2-publication-confirmation-1280.png)

The event snapshot contains the current publication at 456, configuration request
at 457, gateway observation at 458 and tool confirmation at 459. Both preparation
jobs had completed with zero retries. The dispatcher remained up and caught up to
position 460. Backend publication and acknowledgement therefore passed.

The screen also requires Check status after publication. The collector omitted
that second status action and timed out while waiting for the confirmed screen to
appear automatically. This attempt is FAIL; visible browser confirmation is not
qualified by the backend snapshot.

- [Pending screen at 390 px](attempt2-publication-failure-390.png)
- [Pending screen at 1280 px](attempt2-publication-failure-1280.png)

Logs and screenshots were retained before teardown. Sanitised host logs and the
last 100 Docker log lines were saved. The OpenFGA tail was withheld by the sanitiser
because it contains structured key fields; an earlier intermediate copy also exceeded
the collector buffer. The guarded launcher stopped, teardown succeeded
and slot 1 reported free. The collector now presses Check status after the saved
gateway acknowledgement too. Product source and timeouts remain unchanged.

## Final changed-source journey

Source: `f8a38ee69fc0932bb892ad320649271b3a0a81e2`. The
[final admission samples](admission-qualified.csv) ran from 08:31:48 to 08:37:05 UTC.
Both secondary slots were free, no package stack was running and one-minute load
remained below six for five minutes. Claimed slot 1 and supplied `--id 1` literally
to fresh startup, status and teardown. Fresh startup and the publication collector
both exited successfully.

1. Completed CORE at 390 px and 1280 px: real sign-in, streamed stub replies,
   reload, Stop, uploads, live-view grant refusal and revocation, budgets, audit
   access and projection replay.
2. Started the guarded TLS launcher and signed in through the browser. Registered
   the demo remote integration, pressed Check status after discovery and selected
   Ask for `change_delivery_slot`.
3. Reviewed access and opened publication confirmation. Verified the confirmation
   button was disabled until the review acknowledgement checkbox was checked.
4. Checked the acknowledgement, confirmed publication and pressed Check status
   after the gateway acknowledgement. Saw “The current publication is confirmed.”
   Captured both the confirmation and ready screens at both widths.
5. Matched the exact publication command, review revision, fragment digest, source
   sequence, configuration digests and gateway process across the saved events.
   Both preparation jobs completed with zero retries. The dispatcher remained up
   without a heartbeat error and caught up to the sampled event-log position 458.
6. Copied screenshots and sanitised startup/service logs before teardown. Stopped
   the guarded launcher, ran `down.sh --id 1` and checked the slot was free.

| Position | Event | UTC |
| --- | --- | --- |
| 451 | `mcp.server_registered` | 08:52:05.328 |
| 452 | `mcp.server_discovered` | 08:52:06.394 |
| 454 | `mcp.server_reviewed` | 08:52:09.916 |
| 455 | `mcp.server_published` | 08:52:10.025 |
| 456 | `gateway.configuration_requested` | 08:52:10.484 |
| 457 | `gateway.configuration_observed`, loaded | 08:52:11.291 |
| 458 | `mcp.configuration_observed` | 08:52:11.481 |

- [Mobile CORE](core-390.png)
- [Desktop CORE](core-1280.png)
- [Mobile confirmation](publication-confirmation-390.png)
- [Desktop confirmation](publication-confirmation-1280.png)
- [Mobile confirmed publication](publication-ready-390.png)
- [Desktop confirmed publication](publication-ready-1280.png)

Paid calls: zero. Catalogue changes, expiry and write-error refusals were checked
by the focused tests, not injected through this live demo. Native tool execution,
long-chat approval and packaged installation are NOT RUN. The earlier collector
failures remain recorded above. No product source or timeout changed between the
three changed-source attempts. Sanitised host logs and Docker tails were saved in
the private task receipt; the OpenFGA tail was withheld by the sanitiser because it
contains structured key fields.

## Source checks

- PASS: two runs of the 12 focused cases, including all six new catalogue cases,
  the unchanged pool-starvation regression and five gateway preparation cases.
- PASS: 21 selected existing watch, renewal, approval-safety and restart cases.
  The other 201 cases in that file were not run.
- PASS: removing failed-check invalidation made the write-error refusal test fail.
  The production source was restored before the final checks.
- PASS: full typecheck and a final models-package typecheck; event catalogue; knip;
  changelog; ESLint on changed code with no warnings; Markdown; README and read checks.
- NOT RUN: web tests and web build as source gates; no website source changed.
- PARTIAL: attempts to reproduce the intermittent NATS heartbeat failure ran,
  but neither the blocked-write diagnostic nor fresh main reproduced it.

The first existing-watch run found a reused renewal event id in the refactor.
Restoring a distinct event after the expiry event fixed all three renewal failures.
No timeout or refusal assertion changed. These were the builder's own checks.

Made right: shared the two existing catalogue test builders, split capture persistence
from watch orchestration, and reused one comparison for catalogue schema and revision
promises. The dispatcher and queue source remain unchanged. No dependency was added.
