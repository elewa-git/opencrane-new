# Packaged connected-provider journey

## Current correction — 20 November 2026 UTC

The first diagnostic run on source `0e216de4f` is **FAIL** at the admin invitation.
The owner signed in, then the invitation request returned HTTP 503. Its retained
safe assertion records `503 !== 200`. Service logs show the ownership permission
update completed after that request. No provider key was entered. Startup and
service logs were copied before teardown; package teardown and slot release passed.
See [the diagnostic result](live/round-3-attempt-1.json) and
[the safe failure](live/round-3-attempt-1-failure.txt).

Test-first `ad5387c80` reproduces bootstrap reporting success with no ownership seed,
using real NATS and OpenFGA. Bootstrap now seeds ownership and uses its existing
readiness wait to require all current owner permission receipts. The initial owner
permission check stays in place. No invitation is resent and no timeout is raised.
Application approval `44723392714` failed its existing synthetic bootstrap check:
the fixture retained no events and still expected only two owner writes. The real
container test failed with that fixture, then passed twice after retaining the three
events and requiring the ownership receipt read. Its original image assertion stays
unchanged. This is a fixture check with the current owner entry point mounted; it
is not approval of the next saved image.

Test-first `90cd1f4d5` also reproduces the private probe calling the native Fetch
response's numeric `status` property as a function. It now reads the property and
keeps the same 401 and disclosure assertions. This is a deterministic runner fix;
it does not attribute that cause to the earlier Settings failure without live proof.

The corrected fresh packaged journey remains **NOT RUN** pending approved images
and another complete clear slot/load window. Paid calls and paid cents remain zero.

Latest fresh packaged journey at head `195414ef71ffe3e8a65a7b5c2d32d26eeed89cd6`:
**FAIL** during Settings setup. It passed package startup, sign-in, and the visible key
field checks at both widths. The runner recorded `errorType: Error` but no more specific
check. Wrong-key refusal, credential custody, model setup and member chat are **NOT RUN**.
The two live blockers remain open; this PR must not merge yet.

Date: 20 November 2026 UTC. Website fixture and navigation fix source:
`5c4c8146a1c167b4ef6e25038da7f3c31e9fa22d`. The last installed source was
`b2879c0d57e4450838c44282a3a7d60a6de2b2dc`. No application behaviour was changed in
this round. Paid calls: **0**; actual external charges: **0 cents**.

## Latest live run — 20 November 2026 UTC

**FAIL — fresh packaged install, source `195414ef71ffe3e8a65a7b5c2d32d26eeed89cd6`.** The
approved package installed and its services became ready. Owner, admin and member sign-in
completed. Settings screenshots and the new-key form were captured at 1280 and 390 px;
the runner confirmed one visible new-key field at both widths. It then exited during
`Settings setup` with `errorType: Error`. The runner did not save a more specific check,
so this receipt does not attribute a cause beyond that recorded failure. The wrong-key
401 refusal and disclosure check, right-key connection, quoted test, model selection,
switch-on, key modes before and after Pod recreation, and member replies are **NOT RUN**.

Paid calls: **0**; paid cents: **0**. Package teardown and slot release passed. Screenshots
are [admin Settings at 1280 px](live/admin-settings-1280.png),
[admin Settings at 390 px](live/admin-settings-390.png),
[new-key form at 1280 px](live/new-key-entry-1280.png), and
[new-key form at 390 px](live/new-key-entry-390.png). Sanitised startup and service logs
were retained privately before teardown. See [the run result](live/result.json).

## What a person sees

**PASS — rendered website fixture, not a fresh packaged journey.** At 1280 and
390 px, Models & providers offers Connect a provider. After entering a connection
name and choosing Next, its open setup dialog shows one password field labelled
“API key Required”. The closed replacement dialog contributes no second accessible
field with that name. The empty field fits both viewports and is directly usable.
No product label or visibility change was needed.

The check built the current website, reused its existing provider API fixture and
ran the corrected browser helper. It checked one open setup dialog, one visible
key field, one matching field in Chromium's accessibility tree, password type,
empty value and no horizontal overflow. No key was entered or submitted. The
screenshots were visually checked before publication:

- [1280 px key form](fixture/new-key-entry-1280.png).
- [390 px key form](fixture/new-key-entry-390.png).
- [Fixture assertions and source](fixture/result.json).

The driver now selects the page-header Connect button, scopes entry to the open
named dialog and uses the exact field label. It waits for the named Key step or an
enabled Check status control while the original command applies. It never sends
that command again. Back is scoped to the dialog footer.

## Live conditions

These results describe the last completed packaged run. They do not turn the
website fixture or source tests into live proof.

| Condition | Result |
| --- | --- |
| Fresh packaged namespace, new PVCs and approved images | PASS |
| Application startup, free provider readiness and browser origin | PASS |
| Owner sign-in | PASS |
| API response-body inspection while navigating | FAIL: Chromium discarded the old response body |
| New-key field through the fresh packaged browser | NOT RUN to completion |
| Wrong key refused with HTTP 401 and never disclosed | NOT RUN |
| Right key, quoted test, model selection and switch-on | NOT RUN |
| Synthetic 0600 files and the 0700 key folder before and after Pod recreation | NOT RUN |
| Member chat with a reply at 1280 and 390 px | NOT RUN |
| Live values, manifests, logs and events disclosure checks | NOT RUN |
| Startup and service logs copied before teardown | PASS |
| Package teardown and release of this worktree's claims | PASS |
| Full fresh journey after the final navigation fix | NOT RUN: waiting cutoff reached |

[The live result](live/result.json), [safe browser failure](live/browser-failure.txt)
and [image bindings](live/images.json) identify the failed installed run.
Application approval
[44693318189](https://github.com/elewa-git/opencrane-new/actions/runs/44693318189)
and scanner approval
[44693322108](https://github.com/elewa-git/opencrane-new/actions/runs/44693322108)
passed for that exact source. Builders did not approve images.

[Service states](live/logs/round-2-services.json) and
[bounded server records](live/logs/round-2-server.txt) come from logs copied before
teardown. Full sanitised startup and per-container logs were retained privately at
`<home>/.fleet/receipts/pilot-1110-s1/fix-round2/attempt-1/` and `attempt-2/`.
Raw records that could contain private request data are withheld from the public
receipt. Earlier safe logs remain in `live/logs/`.

## Attempts and failing-first fixes

1. The supplied run failed because a page-wide API key locator selected the hidden
   replacement input before the new-key step was ready. No wrong key was entered.
   [Its diagnostic](live/previous-browser-failure.txt) is retained. `a53c56a00`
   reproduces that failure in Chromium; `593c17f77` follows the open setup dialog,
   exact labels and the visible Check status path.
2. A fresh install of `593c17f77` passed startup, sign-in and Settings screenshots at
   both widths. The driver then tried to click a disabled Check status button while
   setup advanced automatically. No key was entered. `d966766c3` reproduces the
   disabled-then-detached timeout; `b2879c0d5` waits for an enabled control or the next
   step. Logs were copied before teardown.
3. A fresh install of `b2879c0d5` passed startup and owner sign-in. Its response
   inspector was still reading an API reply when navigation discarded the old
   document. The rejected promise terminated Node before a new result was written.
   The retained failure and service logs establish this result; `live/result.json`
   records it explicitly rather than retaining the previous attempt's stage.
   `18ba6f843` reproduces the exact Chromium protocol error and separately proves
   that a failed disclosure inspection must refuse navigation. `5c4c8146a` waits
   for current network activity and pending body inspections before navigating.
   Inspection failures retain their rejected promises and still fail the journey;
   they are handled in time for its catch to save the receipt.

During cleanup, `4a5a3579d` adds a failing check for a disclosure error received
while the browser closes. The completion helper checks inspections before and
after shutdown, before recording PASS. This guard has not run in a fresh package.

The five driver regressions passed twice after the final change. The two Settings
cases each cover 1280 and 390 px. No retry, longer timeout, sleep, skipped response
check or weaker assertion was introduced in the driver.

## Single-journey waiting and release

Before each installation claim, both secondary slots were free, no package stack
was running and the one-minute load stayed below six for a full five minutes.
Checks ran every 30 seconds. The successful installation claims followed windows
ending at 07:02:53 and 08:20:53 UTC, each at 300 seconds.

A separate candidate window ended at 08:06:53 UTC, but another secondary stack
became busy during the final pre-claim check. This worktree cancelled its unclaimed
launch, started no services and waited for a new full window. It did not use the
other stack or the owner stack.

After the navigation fix, load rose above six again. The queue stopped at its
08:39:53 UTC cutoff. The last observation had both slots free but load 8.02, with
no complete low-load window. [The queue record](live/queue.json) marks the corrected
full journey NOT RUN. This worktree has no remaining claimed stack.

The fleet marker stayed present. Neither the installed package nor the browser
driver set or bypassed `DEV_REAL_PROVIDER`. Only synthetic provider credentials
were prepared; none reached Settings in the completed runs.

## Fresh packaged install recipe

The package uses a new owned namespace and new PVCs. It does not start a Compose
stack with `up.sh --fresh`: package preparation refuses a live Compose stack in the
claimed slot. Use the same guarded secondary path for the remaining live proof:

```sh
infra/dev-stack/claim.sh
# Export the returned secondary id as DEV_STACK_ID.
infra/dev-stack/run.sh package-prepare --id "$DEV_STACK_ID"
# Set models.mode=provider and models.qualification=true in private package values.
PACKAGE_SKIP_PROVIDER_SETUP=1 node --experimental-strip-types infra/package/prepare.ts
infra/dev-stack/run.sh package-up --id "$DEV_STACK_ID" --values "$PACKAGE_VALUES_FILE"
infra/dev-stack/run.sh package-check --id "$DEV_STACK_ID"
infra/package/forward.sh
node --experimental-strip-types infra/package/provider-journey.test.mjs
infra/dev-stack/run.sh package-down --id "$DEV_STACK_ID"
infra/dev-stack/down.sh --id "$DEV_STACK_ID"
```

Run preparation, startup, tests and builds under `nice -n 10`. Fetch successful
exact-source application and scanner approvals from GitHub. Keep the free upstream
fixed to `model-qualification:43003`, with provider mode, ordinary custody, access,
price consent, default selection and switch-on admission intact.

The runner captures both key-entry widths before typing, uses the wrong synthetic
key through Settings, checks its refusal and confirms HTTP 401 for that same key
from the server Pod. The private probe passes it through stdin and records only a
status. It then connects the right synthetic key, accepts the quoted test, chooses
models, selects the chat default and switches on. Before and after recreating the
server Pod it checks uid 1000, the 0700 key folder, 0600 files and unchanged credential
bytes. It expects a member reply at both widths and checks disclosure in API
replies, values, manifests, logs and events. Those live conditions remain NOT RUN
here. Always copy screenshots and logs before package-down and down.

## Source checks in this round

These are the builder's own checks. No full root suite ran locally.

- PASS: all five changed driver regressions twice after the final fix. Chromium
  reproduced both the hidden/disabled control failures and discarded-response
  failure before their corresponding fixes. A failed disclosure inspection still
  refuses navigation, and a late failure during shutdown refuses PASS.
- PASS: the five Models web suites twice, 130 cases each. The rendered current
  website fixture also passed the two viewport and accessibility checks above.
- PASS: focused provider custody and chart isolation checks twice, 10 cases each.
  They include remount mode repair/refusal, the separate qualification provider and
  the aliased/same-name backup CronJob regressions. This is source proof, not a live
  remount or backup qualification.
- PASS: full workspace, package and dev-stack typecheck; event catalogue agreement
  for 174 types; Knip; changelog; scoped ESLint; Markdown without file arguments;
  and the website development build. Knip retained its two existing configuration
  hints. Infrastructure is excluded by repository ESLint settings and checked by
  its TypeScript project.
- PASS: public privacy and secret scans before each push. Both new screenshots
  were visually checked and contain an empty field, no credential or private
  address. Tests, lint, typecheck and builds ran under `nice -n 10`.

`git fetch origin` found main unchanged at `c791103b3`. `git rebase origin/main`
finished with the branch up to date. Final hosted checks and exact-head approvals
are linked from the PR Evidence section.

## Original review findings

- **BLOCKING — private modes on remount: PARTIAL.** `3557f4d11` records the failing
  checks; `d29236da6` adds `OnRootMismatch` and startup repair/refusal before either
  application container starts. The focused checks passed twice in this round.
  The synthetic before/after Pod-recreation condition remains NOT RUN.
- **BLOCKING — packaged merge journey: PARTIAL.** `11891a853` pins restricted
  destination and wrong-key refusal; `f43c3a4dc` pins missing Settings controls;
  `8ec37ebc6` adds the separate free provider and checked commands. This round fixes
  the three driver failures above and preserves failures received during shutdown. The latest full live proof remains NOT RUN.
- **FIX — backup CronJob isolation: PASS.** `76847bdd9` records the missed aliased
  mount; `7fa01e9a9` resolves mounts to PVC claims across Pod specifications,
  including CronJobs and init containers. `a1671b1be` and `2eb0b9b4e` also pin the
  workload name. The focused mutation regressions passed twice in this round.

The changed functions were checked against the engineering cleanup table: shared
one owner for step progress and navigation, used named values and small functions,
removed replaced page-wide key entry, preserved errors, and added no dependency or
limit exception. No access, money or memory check was weakened. Paid-provider,
monthly-budget, key recovery and private-memory live qualification are not claimed.
