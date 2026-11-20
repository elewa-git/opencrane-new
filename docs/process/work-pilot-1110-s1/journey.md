# Packaged connected-provider journey

**PARTIAL — the full journey has not passed.** Paid calls: **0**; external charges:
**0 cents**. The latest fresh installed source is
`5ad52ff2f6822f7d2f364430ce1493ce3ae4a2f9`. Its run failed while advancing provider
creation to Key. It had no dispatcher restart. Both live blocking findings remain
open; this PR must remain draft and must not merge on these receipts.

These are the builder's own checks. No independent review result is claimed.
Hosted checks and image approvals are linked in the PR's Evidence section.

## Latest fresh run

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

## Remaining blocker and owner hold

This is the authorised last fix round. The Key-step gate still fails live after
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

## Original review findings

- **BLOCKING — private modes on remount: PARTIAL.** Retained failing-first
  `3557f4d11`, repair/refusal and `OnRootMismatch`. Focused source checks passed
  twice. Live synthetic before/after Pod-recreation proof remains NOT RUN.
- **BLOCKING — full packaged journey: PARTIAL.** The first run passed setup and
  wrong-key HTTP 401, then failed at the chat default. With the pool fix installed,
  the dispatcher stayed running, but the driver timed out on its status control.
  A matching disappearing-button race was reproduced independently. The subsequent run also failed at Key; see the latest run above.
- **FIX — backup CronJob isolation: PASS (source).** Retained failing-first
  `76847bdd9` and claim-based checks across workloads and init containers, including
  aliased and same-name mounts. Focused checks passed twice. No new live backup
  qualification is claimed.

## Source checks and rebase

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
Keep both image approvals bound to the exact source. Set only reference paths in
private preparation and retain host-check fields and command output.

```sh
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
# Set ZITADEL_KEY_FILE to the authorised existing credential path.
infra/dev-stack/run.sh package-prepare --id "$stack_id"
# Set models.mode=provider and models.qualification=true in private package values.
PACKAGE_SKIP_PROVIDER_SETUP=1 nice -n 10 node --experimental-strip-types infra/package/prepare.ts
OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366 \
  nice -n 10 infra/dev-stack/run.sh package-up --id "$stack_id" --values "$PACKAGE_VALUES_FILE"
infra/dev-stack/run.sh package-check --id "$stack_id"
infra/package/forward.sh
nice -n 10 node --experimental-strip-types infra/package/provider-journey.test.mjs
# Copy sanitised startup, current/previous service logs and screenshots before teardown.
infra/dev-stack/run.sh package-down --id "$stack_id"
infra/dev-stack/down.sh --id "$stack_id"
```

The free upstream stays fixed to `model-qualification:43003`. Synthetic credentials
still pass through normal custody, access, price consent, model selection and
switch-on admission. No paid-provider, monthly-budget, key-recovery or private-memory
qualification is claimed.
