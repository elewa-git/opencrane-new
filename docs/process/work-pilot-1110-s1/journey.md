# Packaged connected-provider journey

Journey on a fresh dev stack: PASS

## Fresh packaged run on 25 November 2026

Secondary slot 1 installed a new namespace and volumes from the approved product
commit `8bcc94db89abda8f7a460a32549ec8a977cd7b52`. Before the claim, both slots were
free with no other package running and 1,462 sampled seconds below a one-minute
load of six. The last sample was 2.81 and load peaked at 9.18 during the run.
Preparation received the private values file once by path. The installer logged
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` with its F1/F2 host refusals.
The task inherited the fleet marker. The installer set the models container's
marker directly, and `DEV_REAL_PROVIDER` stayed unset.

| Condition | Result |
| --- | --- |
| Approved images, fresh namespace and volumes, package readiness | PASS |
| Owner, admin and member sign-in, Settings and new-key form at both widths | PASS |
| Wrong key refused with HTTP 401 and absent from inspected UI and API replies | PASS |
| Right key, quoted test, model selection, chat default and switch-on | PASS. Both binding reads and the write returned 200 |
| Binding read recovery after HTTP 503 | NOT RUN in this installation. The binding reads succeeded |
| Synthetic 0600 file and 0700 directory with unchanged bytes after server Pod recreation | PASS |
| Expected member reply and Done at 1280 and 390 px after recreation | PASS |
| Provider key absent from inspected values, manifests, logs, API replies and saved events | PASS. Inspected 88 browser API bodies and 140 saved events |
| Fleet marker and restricted gateway routes before and after Pod recreation | PASS. All four model routes used the free stand-in |
| External model traffic and spending | PASS. The stand-in handled three model requests. The network capture recorded zero external model connections and dropped zero packets. Paid calls and cents were zero |
| Dispatcher, log retention and slot release | PASS. Zero restarts across two observed dispatcher Pods. Logs were saved before package and slot teardown |

The test-first commit `e1cbcd379` reproduced both installer marker mismatches,
the missing qualification upstream and the missing marker in the rendered models
container. The installer now refuses ordinary provider mode in fleet tasks before
Helm, refuses fleet-prepared runtime settings in an unmarked installer and passes
its decision to the models container. Removing the install-time admission check
made the regression fail again with installer exit 0. The check was restored.

The first hosted CI run found that the shared test fixture did not copy the
installer's new import. The fixture's existing import check reproduced that
failure locally. `4aa24ac81` adds the guard to the shared fixture list and
removes the duplicate copies from its callers. This changes test files only.
The 601 package, Helm and launcher tests passed twice. Typecheck, event catalogue
agreement, Knip, changelog, Markdown, public privacy and secret scans passed.
Scoped ESLint reported that repository configuration excludes the changed files.

- [Journey result](live/qualification-20261125/result.json),
  [fresh installation](live/qualification-20261125/installation.json),
  [browser and dispatcher diagnostics](live/qualification-20261125/diagnostics.json)
  and [model traffic evidence](live/qualification-20261125/network-evidence.json).
- Member replies at [1280 px](live/qualification-20261125/member-chat-1280.png)
  and [390 px](live/qualification-20261125/member-chat-390.png).
- [Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45521230411),
  [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45521234456)
  and [CI run that found the fixture omission](https://github.com/elewa-git/opencrane-new/actions/runs/45521186595).

## Fresh packaged run on 24 November 2026

Secondary slot 1 installed a new namespace and volumes from approved images for
`f7acfefaa022cdb4f44b35827c0470ff803288ce`. Both slots were free with no other
package running and 390 sampled seconds below a one-minute load of six before
the claim. Load was 1.75 at the final queue check and peaked at 12.49 during the
run. Preparation received the private values file once by path. The
installer logged `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` for this
dev host and recorded the F1/F2 host refusals. The fleet marker stayed present
throughout provider-mode qualification with the restricted free stand-in.
Paid calls and external charges were zero.

| Condition in this run | Result |
| --- | --- |
| Approved images, fresh namespace and volumes, package readiness | PASS |
| Owner, admin and member sign-in, Settings and new-key form at both widths | PASS |
| Wrong key refused by the stand-in with HTTP 401 and absent from inspected UI and API replies | PASS |
| Right key, quoted model test and settled model answer at both widths | PASS |
| Model selection, chat default and switch-on | PASS. Settings read 503, read 200 and wrote 200 in order |
| Synthetic 0600 file and 0700 directory with unchanged bytes across server Pod recreation | PASS |
| Member chat with the expected reply and Done at 1280 and 390 px after recreation | PASS |
| Final values, manifests, server logs, browser/API replies and saved events checked for disclosure | PASS. The run inspected 87 browser API bodies and 140 saved events |
| Dispatcher stayed running during installation and the browser journey | PASS. Zero restarts across two observed Pods |
| Private logs retained before teardown and secondary slot released | PASS |

The first browser run on approved source `790e6ef3b` reached switch-on and
proved remount custody. At 1280 px the runner stopped before sending any member
message. The trace shows a completed admin GET with HTTP 200 whose body Chromium
could no longer retrieve. The server log correlates it with the earlier
`/api/my/tools/needs` read. The replacement server Pod was ready. Both observed
dispatcher Pods had zero restarts. Server, models, computer bridge and dispatcher
logs were retained before teardown. An earlier preparation on the receipt-only
tip was stopped before browser launch and its claim was released.

The Chromium fixture reproduced the missing response body with the old
collector. The corrected runner inspects the original HTTP body while Chromium
holds the response, before the page can use it and navigate. The same
disclosure assertions still apply. The fix changes the journey runner only.
Fifteen focused checks passed twice. Typecheck, event catalogue agreement, Knip,
changelog, Markdown, public privacy and secret scans passed. Scoped ESLint
reported that the three changed runner files are excluded by repository configuration.

- [Complete journey result](live/qualification-20261124/result.json),
  [fresh installation](live/qualification-20261124/installation.json) and
  [run diagnostics](live/qualification-20261124/diagnostics.json).
- [First run result](live/qualification-20261124/first-result.json) and
  [browser and dispatcher diagnosis](live/qualification-20261124/first-diagnostics.json).
- Member replies at [1280 px](live/qualification-20261124/member-chat-1280.png)
  and [390 px](live/qualification-20261124/member-chat-390.png).
- [CI at the original receipt head](https://github.com/elewa-git/opencrane-new/actions/runs/45501456178)
  and both fresh approvals for the qualifying run
  ([application](https://github.com/elewa-git/opencrane-new/actions/runs/45512376563),
  [scanner](https://github.com/elewa-git/opencrane-new/actions/runs/45512382269)).

## Round 6 fresh package

**FAIL — the round 6 packaged journey did not complete in one fresh run.**
The custody check and both member replies passed on attempt 2. The corrected
standalone event check passed on attempt 4. The PR remains draft.

On 24 November 2026 UTC, secondary slot 1 installed a new namespace and volumes
from `790e6ef3b4a910e8e02371958940cad04b48f8bf` with exact-source approved images. It claimed the slot after
358 sampled seconds below six with both secondary slots free.
One-minute load at the final queue check was 2.21. The sampled peak
was 10.02. The install logged
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`; the F1/F2 host checks
retained their refusals. The private values file was supplied once by path.
The fleet marker stayed present and the qualification used the restricted free
stand-in. Paid calls and external charges were zero.

| Condition | Result |
| --- | --- |
| Fresh images, namespace, volumes and package readiness | PASS on attempt 4 |
| Settings and the Key form at both widths | PASS on attempt 4 |
| Wrong key refused by the stand-in with HTTP 401, and no visible or API disclosure through refusal | PASS on attempt 4 |
| Right key, quoted test and settled model answer at both widths | PASS on attempt 4 |
| Model selection, chat default and switch-on | PASS on attempt 4 |
| Synthetic 0600 file, 0700 directory and unchanged bytes across Pod recreation | PASS on attempts 2 and 4 |
| Member reply at 1280 and 390 px after Pod recreation | PASS on attempt 2. Attempt 4 stalled at 1280 px. The 390 px reply was NOT RUN |
| Final values, manifests, browser/API replies and event inspection in one run | NOT RUN to completion |
| Separate event check on attempt 4 | PASS — 110 saved events |
| Dispatcher restarts on attempt 4 | PASS — zero across 2 observed Pods |
| Logs retained before teardown, slot released | PASS |

The fourth run captured switch-on at both widths. The recreated server Pod was
ready, but the browser runner stopped advancing and produced no member image or
terminal result. The builder stopped the runner after observing the stall and
saved service logs before teardown. Closing the browser ended a pending response
body inspection. The underlying stall is unresolved. The
standalone event check used the same installed package and synthetic inputs as
that attempt. It returned only the number of saved events checked.

- [Attempt 4 observations](live/round-6/result.json), [bindings and dispatcher diagnostics](live/round-6/diagnostics.json),
  [image and volume binding](live/round-6/installation.json) and [event check](live/round-6/event-disclosure.json).
- Key form at [1280 px](live/round-6/new-key-entry-1280.png) and [390 px](live/round-6/new-key-entry-390.png),
  and wrong-key refusal at [1280 px](live/round-6/wrong-key-refused-1280.png) and [390 px](live/round-6/wrong-key-refused-390.png).
- Settled model answer at [1280 px](live/round-6/model-test-passed-1280.png) and
  [390 px](live/round-6/model-test-passed-390.png), and switch-on at
  [1280 px](live/round-6/provider-switched-on-1280.png) and [390 px](live/round-6/provider-switched-on-390.png).
- Attempt 2 member replies at [1280 px](live/round-6/attempt-2-member-chat-1280.png)
  and [390 px](live/round-6/attempt-2-member-chat-390.png).

[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45498384591) and
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45498390820) for the fourth install.

### Earlier round 6 attempts

1. **FAIL at package startup** on `2bfb06ecf`. Two server Pods overlapped during
   the installer’s computer-gateway update. The old Pod’s models container was
   ready, the replacement’s was waiting, and a PostgreSQL advisory lock still
   had a waiter at teardown. The dispatcher recorded zero restarts. The Pod to
   connection pairing could not be collected before teardown. Test-first
   `bd9b83b4b` pins the rollout ordering. `82c58b375` makes the provider-mode
   server use `Recreate`, so the old process can release the budget lock before
   the new one starts. The default and explicit stub renders still match the
   original bytes. The second install showed the old server Pod gone before
   the new one appeared. [Startup result](live/round-6/attempt-1-result.json).
2. **FAIL at the event-disclosure command** on `82c58b375`. The run reached
   switch-on, proved 0600/0700 custody and unchanged synthetic key bytes across
   Pod recreation, and captured member replies at both widths. The values,
   manifests and server logs passed the inspection preceding the event command.
   The command exited before producing an event count. The native Node fixture
   in `739c7f32a` reproduces the missing `readEvents` export. `c26a1ec71` imports
   the reader from `@opencrane/projections`. The same command now counts real
   fixture events and refuses a matching event. [Result](live/round-6/attempt-2-result.json).
3. **FAIL during model selection** on `c26a1ec71`. The wrong key, right key and
   quoted test passed. The models read returned the saved selection, then
   Playwright waited to click a disabled Check status button that detached when
   setup advanced. The Chromium fixture in `8bbbf5c12` reproduced that failure.
   `790e6ef3b` uses the existing next-step driver to follow Access. The API
   model check and the Access heading must both pass. [Result](live/round-6/attempt-3-result.json).

Startup, service and browser diagnostics for the failed attempts were retained
privately before teardown. The first attempt’s slot had no `failure.log`.
Each attempt released its own claim. Paid calls and external charges were zero.

### Round 6 source checks

Test-first `c9839c155` reproduced the single-read failure on the Settings
control. `2bfb06ecf` reads fresh binding positions once after a 503. A second
failure gives an actionable message and sends no binding command. The bindings
route uses the same 503 when dependency preparation fails for another reason.
The source tests cover that contract, current positions, repeat refusal and 403.
Both refusal cases failed when a temporary change allowed a write after 403. The
committed code was restored. The server routes and history guard match main.

PASS twice on 109 Angular cases, 47 server binding-guard and managed-start cases,
323 chart, key storage and package cases after the rollout fix, two real NATS
checks of the event command and 14 browser-driver cases after the final driver
fix. Typecheck, event catalogue agreement, Knip, changelog, Markdown, README
structure, public privacy and secret scans passed. Scoped ESLint found zero
errors on covered files. Repository configuration excludes the six changed
infrastructure code files. Local tests and checks used `nice -n 10`.

The rebase onto `4553898593de57e95b825f71c693317cc103169d` finished, retaining
the changes in #1149, #1183, #1185 and #1171. The rebased head and rollout source passed
hosted CI and both package approvals with fresh artifacts. The last changes
were to the local test commands and their fixtures. The installed application
and chart code match the approved rollout source.
[Rebased CI](https://github.com/elewa-git/opencrane-new/actions/runs/45476373828)
and [rollout CI](https://github.com/elewa-git/opencrane-new/actions/runs/45488667705).

## Round 5 fresh package

On 24 November 2026 UTC, secondary slot 1 installed a new namespace and volumes
using approved images for `589bc623c481f9b6efaba0e9d7db0946d52c4f1c`. The rebase
onto `3bf5b9c16` kept the versions of #1170, #1174, #1176, #1178 and #1180 on
main. The duplicate dispatcher code and test commits from #1174 were removed.
The chart test compares the default render byte for byte with that main revision.

Both slots were free with no other package or journey detected. Load stayed
below six for 812 seconds before the claim, with 2.24 at the final queue check.
During installation and the browser run, the sampled one-minute load reached
16.24. The installer logged the documented
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` switch and retained the
F1/F2 refusals. The private values file was passed once to preparation by path.
The inherited fleet marker remained present. The qualification provider
stayed on its restricted free route.

| Condition | Result |
| --- | --- |
| Fresh image approval, namespace, provider volume and package readiness | PASS |
| Owner, admin and member sign-in, Settings and visible Key form at 1280 and 390 px | PASS |
| Wrong-key reachability refusal and HTTP 401 from the same stand-in credential | PASS |
| Wrong key absent from inspected API responses and visible text through that step | PASS |
| Correct-key reachability, quoted test consent and successful model result | PASS in the API and at 390 px |
| Settled model-result screenshot at 1280 px | PARTIAL — still checking the recorded test |
| Model selection reaches the Access step | PASS |
| Chat-default GET before the explicit selection | FAIL — HTTP 503 |
| Switch-on, member replies at both widths and post-recreation chat | NOT RUN |
| Synthetic 0600 file and 0700 directory before and after Pod recreation | NOT RUN |
| Final values, manifest, event, log and browser disclosure inspection | NOT RUN |
| Dispatcher container restarts | PASS — zero on both observed Pods |
| Logs retained and slot released | PASS |

The 390 px screen records one settled cent inside the qualification budget. The
request used the free stand-in and incurred zero external charges.

Two GET requests to the bindings endpoint returned 503. Both started before
`seed-provider-default` finished handling the model selection and completed
immediately afterwards. The existing provider binding guard regression exercises
a 503 when provider history changes during that read. Both dependency history
guard cases passed twice after the run. The timing is consistent
with that race, and the live response does not identify the internal cause.
The dispatcher logged five queue pool-acquisition errors earlier in the run.
Neither dispatcher container restarted during the installer rollout or browser run.

The Key-step stall did not recur. The conditional Key-step product fix was
unnecessary. This round used its one fresh packaged run. The bindings failure
remains open alongside live remount custody. The mode-repair regression and the
backup CronJob isolation regression both remain in the branch.

Startup, service, browser and continuous dispatcher logs were saved in the private
task receipt before teardown. The slot had no `failure.log` to copy. Both package
teardown and slot cleanup completed. These are the builder's checks.

- [Result](live/round-5/result.json), [request timing and restarts](live/round-5/diagnostics.json),
  and [image and volume binding](live/round-5/installation.json).
- [Queue observations](live/round-5/queue.json) and [load samples](live/round-5/load.json).
- Settings at [1280 px](live/round-5/admin-settings-1280.png) and
  [390 px](live/round-5/admin-settings-390.png).
- Key form at [1280 px](live/round-5/new-key-entry-1280.png) and
  [390 px](live/round-5/new-key-entry-390.png).
- Wrong-key refusal at [1280 px](live/round-5/wrong-key-refused-1280.png) and
  [390 px](live/round-5/wrong-key-refused-390.png).
- Quoted test at [1280 px](live/round-5/quoted-test-1280.png) and
  [390 px](live/round-5/quoted-test-390.png). The test was still
  [checking at 1280 px](live/round-5/model-test-checking-1280.png) and showed
  [the answer at 390 px](live/round-5/model-test-passed-390.png).

### Round 5 source checks

PASS twice on 675 chart, installer, preflight and custody cases, 75 focused
Vitest cases, 51 startup cases, 13 browser driver cases, three Angular cases and
two source image checks. Typecheck, event agreement, Knip, changelog, Markdown,
README structure, package licences and whole-stream read lint passed. ESLint
reported zero errors on the changed files and 34 infrastructure files excluded
by repository configuration. Local tests, lint and typechecking used
`nice -n 10` with focused suites.

Exact-source hosted checks and fresh artifacts passed for the installed revision.
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/45375976197),
[application package](https://github.com/elewa-git/opencrane-new/actions/runs/45376041262)
and [scanner package](https://github.com/elewa-git/opencrane-new/actions/runs/45376041637).

After the run, main advanced to `8a1001c0701cef0c380d37e6c715a8c4a2e79200`
with #1149. The final rebase kept its conversation reader inside the provider-mode
models process. The chart on main stayed byte-for-byte the same. This receipt
records the one authorised fresh run, with the installed image and source above.

## Last round 4 run

**FAIL — 20 November 2026 UTC, secondary slot 1.** The new namespace and PVCs used
exact-source approved application and scanner images. Both slots were free, no
other package/journey was running, and load stayed below six for 330 seconds before
claim. This task did not stop, borrow or use any other stack. The documented local
host exception retained its F1/F2 swap and crash-dump refusals. That is an accepted
dev-box gap, never production host qualification.

Owner/admin/member setup passed. Settings opened at 1280 and 390 px; the desktop
capture still shows the provider list loading. Creation reached its event and
permission reaction. The corrected driver followed the offered status reads, but
Key did not appear before its unchanged deadline. The safe failure is the driver's
explicit next-step error, rather than the earlier detached-button click timeout.
No later key, model, custody or chat step is claimed for this run.

The dispatcher stayed running with zero restarts. Its continuous first-container
stream and current service log were saved. The logs record 213 pool-acquisition
errors across queue and handler failures. The provider permission reaction first
failed on acquisition, then completed through its existing queue retry. The final
snapshot had ten idle handler connections and no blocked transactions. That is not
a measurement of earlier pool checkouts and does not prove there was no earlier
contention. No OOM, liveness-probe, pool-leak or complete setup-stall fix is claimed.

Load was 2.92 at the final queue check, peaked at **19.19** during startup and was
still above twelve near the browser failure. Fifteen-second load and available
memory samples and a process/resource sample were retained. Only this package
namespace was present when sampled during the high load. The failure happened
under heavy box load; the evidence does **not** establish that load is its only
cause. No timeout, retry, pool/resource limit, probe, access/money check or assertion
was loosened to make the run pass.

- [Result](live/round-4-attempt-3.json),
  [safe failure](live/round-4-attempt-3-failure.txt) and
  [dispatcher/reaction diagnosis](live/round-4-attempt-3-diagnostics.json).
- [Fresh namespace, PVC and image binding](live/round-4-attempt-3-binding.json),
  [Pod states](live/round-4-attempt-3-pods.json),
  [load samples](live/round-4-attempt-3-load.json) and
  [queue observations](live/round-4-queue-3.json).

Startup, service, browser and continuous dispatcher logs, host-check refusals,
termination states and wait/resource samples were copied into the private receipt
before teardown. Package teardown completed and the claim was released. The
worktree is retained for review.

| Condition in this installed run | Result |
| --- | --- |
| Fresh namespace/PVCs, approved images and package readiness | PASS |
| Owner/admin/member setup; Settings route at both widths | PASS |
| Complete desktop provider-list screenshot | PARTIAL — captured loading |
| Provider creation reaches its event and permission reaction | PASS |
| Advance to the visible Key step | FAIL |
| Dispatcher stays running with no restarts | PASS |
| Current/first-container logs, host record and load retained before teardown | PASS |
| New-key forms and wrong-key HTTP 401 | NOT RUN |
| Right key, agreed quoted test and model selection | NOT RUN |
| Default, switch-on and member replies at both widths | NOT RUN |
| Synthetic 0600/0700 custody before/after Pod recreation | NOT RUN |
| Final values/manifests/logs/event disclosure inspection | NOT RUN |
| Package teardown and claim release | PASS |
| Complete requested journey | FAIL |

## Round 4 owner hold

At the end of round 4, the Key-step gate still failed live after
the status-control corrections. The assumption that following those controls is
enough to finish provider setup is not established. Hold the two live blockers for
the owner under the [engineering discipline](../standards.md#engineering-discipline-make-it-work-then-make-it-right).
Do not make another change on that assumption or turn the last-round limit into a
PASS. The retained load and reaction evidence must inform the next decision.

A test-first fatal-dispatch starvation fix and a separately reproduced detached
status-control fix are retained below. They pass their own regressions; neither
is claimed to complete this slice. The original CronJob isolation FIX remains
PASS in source. Private remount custody and the complete packaged journey remain
PARTIAL because their required live proof is missing.

## Second round 4 attempt

**FAIL — 20 November 2026 UTC, secondary slot 1.** The new namespace and PVCs used
exact-source approved images. Both slots were free, no competing package/journey
was detected, and load remained below six for 329 seconds before claim. The local
host exception retained F1/F2 refusals as an accepted dev-box gap. No host setting
was changed or qualified for production.

Owner/admin/member setup and Settings at 1280/390 px passed. Provider creation was
processed, including its permission reaction. The driver then waited for an enabled
Check status locator until its original 30-second click deadline expired. The
saved live DOM state does not establish whether that button disappeared, became
disabled or whether Key was already visible. The separate fixture reproduces a
matching disappearing-button timeout; it does not prove that live sequence. No restart occurred. The current dispatcher log
and continuous first-container stream were saved before teardown. The final wait
snapshot had ten idle handler connections and no blocking transactions. Queue
workers still reported pool-acquisition timeouts; no claim that every pool failure
is fixed is made. Load peaked at 7.51, with 15-second samples retained.

Test-first `cb59372a6` reproduces the detached-control timeout in Chromium. The
pre-fix run failed at 1280 px before reaching 390 px; both widths pass with the fix. The fixture advances while Playwright moves to Check status. The
corrected action locator also retains the expected next heading, so re-resolution
can finish on that harmless target after the button disappears. The existing
next-step, visible-key, refusal, disclosure and deadline assertions are unchanged.
All 17 driver/native-source checks passed twice after this correction.

A private launch guard initially missed a Python import and stopped before claim.
It was corrected, and a new five-minute clear window was observed before the actual
run. It is not counted as a fresh installed journey.

- [Result](live/round-4-attempt-2.json),
  [safe browser failure](live/round-4-attempt-2-failure.txt) and
  [dispatcher/driver diagnosis](live/round-4-attempt-2-diagnostics.json).
- [Fresh binding](live/round-4-attempt-2-binding.json),
  [Pod states](live/round-4-attempt-2-pods.json),
  [load samples](live/round-4-attempt-2-load.json) and
  [queue record](live/round-4-queue-2.json).

| Condition in this installed run | Result |
| --- | --- |
| Fresh namespace/PVCs, approved images and package readiness | PASS |
| Owner/admin/member setup; Settings at both widths | PASS |
| Provider creation and its permission reaction | PASS |
| Driver advances to the visible Key step | FAIL |
| Dispatcher remains running with no restarts | PASS |
| First-container log stream, service/startup logs and load saved | PASS |
| New-key forms, wrong-key HTTP 401, quoted test and model selection | NOT RUN |
| Default, switch-on and member replies at both widths | NOT RUN |
| Synthetic 0600/0700 custody before/after Pod recreation | NOT RUN |
| Final values/manifests/logs/event disclosure inspection | NOT RUN |
| Package teardown and claim release | PASS |
| Full fresh run after the driver correction | NOT RUN |

## Earlier round 4 attempt

**FAIL — 20 November 2026 UTC, secondary slot 1.** Both slots were free, no package
or competing journey was running, and load stayed below six for 301 seconds before
claiming. Startup used a new namespace and PVCs and exact-source approved images.
The documented local host exception retained the F1/F2 swap and crash-dump refusals;
this is an accepted dev-box gap, never a production F1/F2 PASS.

Owner, admin and member setup passed. Provider creation advanced to Key. The new-key
field was visible at 1280 and 390 px. The wrong key failed reachability, received
HTTP 401 from the separate stand-in and was absent from inspected API replies and
visible text. The right key passed reachability. The agreed quoted model test
passed in the API and its 390 px screen; the 1280 px capture still shows the pending
status read. Model selection completed. The subsequent chat-default binding did
not finish within the unchanged deadline. Switch-on, Pod recreation and member
replies were not reached.

The dispatcher restarted once with termination reason `Error`, exit code 1.
It has no liveness probe, and the retained reason is not `OOMKilled`. The collector
requested the previous log before teardown, but Kubernetes returned “unable to
retrieve container logs”. That first container's log is **UNAVAILABLE**. The
retained current container log later shows a fatal pool-acquisition timeout at
`pg.ts:46` from `dispatchLocked`. Do not infer the first exit's exact cause from a
missing log. No OOM or liveness-probe fix is claimed.

Load was 2.37 at the final queue check and peaked at 11.42 during the run. Samples
were taken every 15 seconds, including available memory. The database wait snapshot
was taken after the dispatcher started shutting down and had no handler connections;
it cannot establish what held those connections earlier. The new regression
reproduces dispatch starvation without heavy box load.

- [Result](live/round-4-attempt-1.json),
  [safe failure](live/round-4-attempt-1-failure.txt) and
  [restart diagnosis](live/round-4-attempt-1-diagnostics.json).
- [Fresh namespace, PVC and image binding](live/round-4-attempt-1-binding.json) and
  [container states](live/round-4-attempt-1-pods.json).
- [Run load samples](live/round-4-attempt-1-load.json) and
  [queue observations](live/round-4-queue.json).

Sanitised startup, current service and browser logs, the previous-log refusal,
termination state, host-check record, database waits and resource samples were
saved in the private receipt before teardown. This task's slot was released.
The owner stack was not used.

| Condition in this installed run | Result |
| --- | --- |
| Fresh namespace/PVCs, approved images and package readiness | PASS |
| Owner, admin and member setup | PASS |
| Provider creation and one visible new-key field at both widths | PASS |
| Wrong key refused with HTTP 401 and no observed disclosure | PASS |
| Right-key reachability and agreed model test | PARTIAL — API and 390 px passed; 1280 px capture pending |
| Model selection | PASS |
| Chat-default binding | FAIL |
| Switch-on and member replies at both widths | NOT RUN |
| Synthetic 0600 files and 0700 folder before/after Pod recreation | NOT RUN |
| Complete values, manifests, logs and event disclosure checks | NOT RUN |
| Current logs, termination state and load saved before teardown | PASS |
| Previous-container log | UNAVAILABLE |
| Package teardown and claim release | PASS |
| Fresh journey with the pool fix | NOT RUN |

## Pool-starvation regression and fix

Test-first `5f262b120` uses real NATS and the shared disposable PostgreSQL fixture.
Dispatch holds one connection for its lifetime advisory lock; the test holds the
other connection as a reaction would. Saving an event then fails with the same
pool-acquisition timeout and `dispatchLocked` stack as the live fatal error.

Dispatch now uses its already held connection for setup, queue writes and the
checkpoint transaction. The regression also caught pg-boss reading queue settings
through its default adapter even when `send` receives a transaction. Those enqueue
reads now use that same transaction through a runtime-local async context. Workers
and maintenance keep using the normal pool outside enqueue. No connection limit,
retry, timeout, memory limit, probe, access check or assertion was loosened.

The readiness fixture now returns its saved state through the held client. The
crash fixture keeps the same commit barriers around transactions on that client.
Its SIGKILL, replay and effect assertions are unchanged. All 20 real dispatcher/runtime checks passed twice, including readiness withdrawal
and all three SIGKILL recovery cases. All 44 upgrade checks passed.

## Review findings after round 4

- **BLOCKING — private modes on remount: PARTIAL.** Retained failing-first
  `3557f4d11`, repair/refusal and `OnRootMismatch`. Focused source checks passed
  twice. Live synthetic before/after Pod-recreation proof remains NOT RUN.
- **BLOCKING — full packaged journey: PARTIAL.** The first run passed setup and
  wrong-key HTTP 401, then failed at the chat default. With the pool fix installed,
  the dispatcher stayed running, but the driver timed out on its status control.
  A matching disappearing-button race was reproduced independently. The last
  round 4 run also failed at Key.
- **FIX — backup CronJob isolation: PASS (source).** Retained failing-first
  `76847bdd9` and claim-based checks across workloads and init containers, including
  aliased and same-name mounts. Focused checks passed twice. No new live backup
  qualification is claimed.

## Round 4 source checks and rebase

PASS: seventeen final driver/native-source checks twice; eleven focused custody, provider
and CronJob checks twice; twenty real dispatcher/runtime checks twice; all 44
upgrade checks; full post-fix workspace/package/dev-stack typecheck; event catalogue
agreement for 174 types; Knip; changelog; Markdown; changed handler ESLint with zero
warnings. The branch-wide scoped ESLint invocation also passed; 34 infrastructure
files are excluded by repository configuration. Public privacy and secret scans
passed before each source push. Final package/dev-stack typechecks also passed
after the browser correction.

Tests, lint, builds and typechecking used `nice -n 10`. No full root suite ran.
The initial fetch found main unchanged at `ed3662d85`, already contained in the
branch. No rebase is pending. The fleet marker remained set, and DEV_REAL_PROVIDER
was never set or bypassed.

## Earlier runs and failing-first fixes

1. Source `0e216de4f` failed the owner invitation with HTTP 503. Retained logs show
   ownership permissions applying after that request. Test-first `ad5387c80`
   reproduces premature bootstrap completion with real NATS and OpenFGA. Bootstrap
   now seeds ownership and requires its current permission receipts before readiness.
   Removing that wait makes the new regression fail. Owner setup passed in the two
   later fresh runs. [Result](live/round-3-attempt-1.json) and
   [safe failure](live/round-3-attempt-1-failure.txt).
2. Source `c1c1e28ca` passed separate sign-in/setup and the one visible key-field
   checks at both widths, then failed at wrong-key reachability. A page-wide Check
   status locator matched the provider table and the open setup dialog. Test-first
   `bddd5a1a7` reproduces that exact Chromium strict-mode error at both widths.
   Verification and model-selection status reads now use the open named dialog.
   [Result](live/round-3-attempt-2.json) and
   [safe failure](live/round-3-attempt-2-failure.txt).
3. The second run's collector had a regex syntax error. Startup command logs and
   screenshots were retained, but its service logs were **NOT SAVED** before
   teardown. The safe browser failure was recovered before slot cleanup. The
   collector syntax was corrected and collection failure now holds teardown for
   recovery. The third run verified collection before teardown.

`7d0e6a018`, `b915ba02d` and `dbc5b2905` first pin missing failure details, bounded
HTTP statuses and safe control-ambiguity reasons. The result records the exact
operation, a fixed expected condition and a bounded category. It never copies
exception/request content, arbitrary error names, credentials or private paths.

`90cd1f4d5` reproduces the private probe calling native Fetch's numeric `status`
property as a function. It now reads the property, retaining the same 401 and
credential-disclosure assertions. This deterministic runner defect is not claimed
as the earlier live failure's cause without proof.

Application approval `44723392714` caught the old synthetic bootstrap fixture's
missing event state. The existing container assertion failed with that fixture,
then passed twice with the retained invitation, join and ownership seed and the
required ownership receipt read. The saved-image assertion was not weakened.
Later exact-source application/scanner approvals passed.

The commit ids above are the original pre-rebase ids retained in the PR history.
The [previous round's receipt](https://github.com/elewa-git/opencrane-new/blob/767c4256df5c1654aac6d12d27364f5f4631e145/docs/process/work-pilot-1110-s1/journey.md)
records the earlier driver regressions and screenshots.

## Fresh packaged recipe

Use a new namespace and PVCs through the claimed secondary package path. A live
Compose stack is refused by package preparation; this recipe uses package startup.
Verify both exact-source image approvals still have their artifacts. Wait until
both slots are free, no other package or journey is active and the one-minute
load has stayed below six for five minutes. Set only reference paths in private
preparation and retain the host-check fields and command output.

```sh
infra/dev-stack/claim.sh
# These commands use slot 1. Use the literal id printed by claim.sh throughout.
export DEV_STACK_ID=1
# Set ZITADEL_KEY_FILE to the authorised existing credential path.
infra/dev-stack/run.sh package-prepare --id 1
values_file=/path/to/private/package-values.json
# Set models.mode=provider and models.qualification=true in the private values file.
unset PACKAGE_VALUES_FILE
PACKAGE_SKIP_PROVIDER_SETUP=1 nice -n 10 node --experimental-strip-types \
  infra/package/prepare.ts "$values_file"
OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366 \
  nice -n 10 infra/dev-stack/run.sh package-up --id 1 --values "$values_file"
infra/dev-stack/run.sh package-check --id 1
infra/package/forward.sh &
forward_pid=$!
# Wait for the package's local browser port to open before starting the browser.
nice -n 10 node --experimental-strip-types infra/package/provider-journey.test.mjs
kill "$forward_pid"
# Inspect the slot's failure.log and copy sanitised logs and screenshots before teardown.
infra/dev-stack/run.sh package-down --id 1
infra/dev-stack/down.sh --id 1
```

The free upstream stays fixed to `model-qualification:43003`. Synthetic credentials
still pass through normal custody, access, price consent, model selection and
switch-on admission. No paid-provider, monthly-budget, key-recovery or private-memory
qualification is claimed.
