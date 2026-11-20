# Packaged connected-provider journey

**PARTIAL — the requested full journey has not passed.** Paid calls: **0**;
actual external charges: **0 cents**. The latest installed source is
`1dc3d74061210c5dc97808051b7384801e9af722`. Its fresh run failed while creating the
provider. The branch was subsequently rebased onto main `ed3662d85`; that rebase
finished. A fresh run on the rebased source is **NOT RUN**.

These are the builder's own results. Hosted final-head checks are linked from the
PR Evidence section. No independent review result is claimed.

## Latest fresh run

**FAIL — 20 November 2026 UTC, secondary slot 2.** The new namespace and PVCs used
approved images. Owner, admin and member setup passed. Settings opened at both
widths. The provider-create request returned HTTP 200, and its content projection
completed. Setup did not reach the Key step within its existing deadline.

The dispatcher container restarted once. Its retained current log reports
connection-pool timeouts. The previous container log and termination reason were
not retained, so neither an OOM nor another restart cause is established. No
product fix for this stall is claimed. The collector now retains those missing
records for the next diagnostic run. No retry, sleep, longer timeout, larger
memory limit or weaker assertion was introduced to hide this failure.

- [Result](live/round-3-attempt-3.json).
- [Safe browser failure](live/round-3-attempt-3-failure.txt).
- [Fresh namespace, PVC and image binding](live/round-3-attempt-3-binding.json).
- [Container states, including the dispatcher restart](live/round-3-attempt-3-pods.json).

Sanitised startup, service and browser logs were copied before teardown into the
private receipt for `fix-round3/attempt-3`. All claims made by this worktree were
released. The owner stack was not used.

| Condition in this installed run | Result |
| --- | --- |
| Fresh namespace and PVCs; approved images; package readiness | PASS |
| Owner, admin and member setup | PASS |
| Settings at 1280 and 390 px | PASS |
| Create provider and advance to Key | FAIL |
| One visible new-key field at both widths | NOT RUN |
| Wrong key refused with HTTP 401 and never disclosed | NOT RUN |
| Right key, quoted test, models and switch-on | NOT RUN |
| Synthetic 0600 files and 0700 folder before/after Pod recreation | NOT RUN |
| Member reply at 1280 and 390 px | NOT RUN |
| Full values, manifests, logs and event disclosure checks | NOT RUN |
| Current startup/service logs copied before teardown | PASS |
| Previous dispatcher log and termination reason | NOT RUN |
| Package teardown and release of this worktree's claim | PASS |
| Fresh run after the final rebase | NOT RUN |

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

## Original review findings

- **BLOCKING — private modes on remount: PARTIAL.** Existing failing-first
  `3557f4d11` and fix `d29236da6` retain `OnRootMismatch` and startup repair/refusal.
  Focused checks passed twice. Live synthetic custody before and after Pod
  recreation remains NOT RUN.
- **BLOCKING — full packaged merge journey: PARTIAL.** Source fixes for restricted
  free-provider qualification, missing Settings controls, startup readiness and
  driver failures are retained. The latest fresh run failed on unapplied provider
  state with a dispatcher restart. Full end-to-end proof remains missing.
- **FIX — backup CronJob isolation: PASS (source).** Existing failing-first
  `76847bdd9` and fix `7fa01e9a9` resolve mounts to PVC claims across workloads and
  init containers. Aliased and same-name backup mutations remain covered. The
  focused checks passed twice. This is not a new backup live qualification.

## Queue, rebase and host checks

The single-journey observer required both slots free, no package stack, no other
journey, and load below six for five minutes. It sampled every 30 seconds; a held
status lock counted as busy. Each claim repeated the checks. The successful clear
windows ended near 10:44, 11:38 and 11:55 UTC. All three attempts used only the id
returned by `claim.sh`, and always ran teardown with that id.

**NOT RUN after rebase:** the diagnostic queue reached its 12:29 UTC cutoff.
Another secondary slot was busy or its lock held; load also interrupted earlier
windows. The last observation still had one busy slot, so no final claim was made.
The [safe queue record](live/round-3-queue.json) retains the checks. No other stack
was stopped or borrowed.

A later fetch found main at `ed3662d85`, adding host swap/crash-dump refusal. Rebase
completed, preserving those checks and both native-source checks. The existing
[accepted local exception](../../../infra/package/README.robot.md#accepted-local-exception)
permits a one-command local opt-in. It records the refused host checks as an
accepted dev-box gap; it never makes production F1/F2 pass. No host setting, real
provider flag or fleet marker was changed. The rebased local install is NOT RUN,
so no use of that exception or host qualification is claimed here.

## Source checks

- PASS: twelve driver checks twice, including both viewport status-control cases.
- PASS: all 38 focused bootstrap checks twice; removing the ownership receipt wait
  makes the new case fail. The corrected real-image fixture check passed twice.
- PASS: focused custody/provider/CronJob checks twice, ten cases per run.
- PASS after rebase: sixteen driver/native-source checks twice; full workspace,
  package and dev-stack typecheck; event catalogue agreement for 174 types; Knip;
  changelog; Markdown; public privacy and secret scans before pushes.
- Scoped ESLint was invoked for changed code. Infrastructure remains excluded by
  repository settings; its TypeScript projects passed. No lint limit was changed.
- Tests, lint, builds and typecheck used `nice -n 10`. No full root suite ran locally.

CI at `c1c1e28ca` failed the unchanged main restore-kube local-kubectl case at its
existing ten-second deadline. The helper and test matched main; an offline probe
and isolated case passed, but did not establish the hosted cause. No timeout fix
or old-head retry is claimed. The genuinely changed `1dc3d7406` CI run passed.
Final rebased-head CI and approvals are reported in PR Evidence.

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
