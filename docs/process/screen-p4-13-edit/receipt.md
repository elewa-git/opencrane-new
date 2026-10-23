# Personal memory correction screens

PASS: intercepted replies at 1280px and 390px, reduced motion. Captured edit,
accepted receipt, conflict, forgotten and unavailable detail. One POST per save. Receipts
held no fact text; forgotten text left inputs, rows and announcements. Quarantined and destroyed
detail kept a text-free row after conflict, acceptance, Cancel and Back to memory.
Dialog actions were at least 44px; no horizontal overflow, browser storage or address change.
The desktop editor keeps the shared centred ModalSheet, as the forget sheet does.
The reference uses a right-hand drawer. That cross-screen change is deferred.
MEM-35 messages use plain status text without the reference alert-card style.
NOT RUN: fresh-install journey, real keyboard and assistive technology. No dev stack or model call.
Source base: 3514576151991312484b9596f326c1d5963b05a7, with working-tree edits; date: 2026-10-23T03:45:49.221Z.

## Clearing retained fact text

Date: 23 October 2026. Source: `351457615`. Local Linux worktree with intercepted
HTTP replies; this was not a fresh install. The requested fetch and rebase completed
onto `79213b7ca43872c92cf44f769a5f85c96dce13f9`. No rebase step remained pending.

PASS: failing-first commit `4b0c178f9` produced eight expected failures before the fix.
The old rows still contained the original sentence for quarantined and destroyed detail,
after conflict and acceptance, at both configured widths. The other 40 editor tests passed.

PASS: two runs of all 94 memory tests across three files, including all 48 editor tests.
The [editor tests](../../../apps/web/src/app/memory/memory-panel-edit.spec.ts) and
[browser checks](../../../scripts/capture-screen-p4-13-forget.mjs) cover these paths.
The tests require text to leave the retained row, selected detail and editor. Cancel and
Back to memory cannot reveal it. Forgotten facts still lose their row. A temporary detail
read failure keeps the previous row and allows conflict recovery to reuse the draft after
a successful retry. An unspecified unavailable reason keeps its existing row behaviour.
Neither case is relabelled as forgotten.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
VITEST_MAX_WORKERS=1 nice -n 10 npm run test -w apps/web -- --watch=false \
  --include='src/app/memory/*.spec.ts'
```

PASS: production web build and two Chromium runs of
`nice -n 10 node scripts/capture-screen-p4-13-forget.mjs --edit`.
Each run checks quarantined and destroyed detail after both conflict and acceptance at
1280px and 390px: eight cases. Each retains one text-free row before and after Cancel and
Back to memory. Both runs also repeat the existing ten captures and their layout checks.
The build reported CSS budget and CommonJS warnings.

PASS: `nice -n 10 npm run check:events` (149 event types).
PASS: full lint, including knip, documentation links, fixture and licence checks,
and `npm run lint:changelog`. The command used `NODE_OPTIONS=--max-old-space-size=8192`
and `nice -n 10`. ESLint reported zero errors and 24 warnings outside the changed editor
files. No lint rule, limit or assertion was weakened.
PASS: `nice -n 10 npm run typecheck` across workspaces and package configuration.

NOT RUN: full root suite, fresh-install journey, actual phone keyboard and assistive
technology. No dev stack or model call was made. CI was not awaited. The PR stays draft.

## Correction and recovery checks

Date: 22 October 2026. Local Linux worktree with installed dependencies and intercepted
HTTP replies; this was not a fresh install. The rebase completed onto fetched main
`b4d3e37a312a76b1188c2c77a1e498199a2c5d26`. The tested source is
`a30161a3a` (used for the 22 October captures).

PASS: failing-first commit `e1fb4fb47` produced six expected failures before the fix:
quarantined and destroyed detail after conflict and acceptance, Edit reopening during
a delayed detail read, and labels changing independently of the submitted snapshot.
The other 32 editor tests passed. All 38 editor tests then passed with the fix.

Unavailable detail clears the draft, preview and snapshot. Only `forgotten` says the
fact was forgotten and removes its row. Other reasons say the text is no longer available
and keep the row. Both paths use the same wording after an accepted receipt.
Edit stays disabled until that detail read finishes, and its click handler also refuses
to open. Both displayed revision labels and the saved date use Save's snapshot.
The panel's rule for removing rows is unchanged.

PASS: each check below was removed on its own. The listed tests failed, then the check
was restored. Both scope and requester changes are covered for each late reply.
The tests assert that old text is absent, no result is emitted and no further request
is sent. Receipt tests reject another fact and another scope separately. Rights tests
cover both false and absent `canCorrect`.

| Check removed from `memory-edit.ts` | Test filter | Observed failures |
| --- | --- | --- |
| Liveness after the POST response | `late refused POST` | 2: access-loss emit called |
| Liveness after the POST JSON body | `late POST body` | 2: extra detail requests sent |
| Liveness after the detail read | `late detail` | 2: detail emit called |
| Receipt memory id | `another memoryId` | 1: unrelated receipt accepted |
| Receipt scope id | `another scopeId` | 1: unrelated receipt accepted |
| Renewed correction right | `renewed editing` | 2: editing resumed without rights |

The [committed tests](../../../apps/web/src/app/memory/memory-panel-edit.spec.ts) run with:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  nice -n 10 npm run test -w apps/web -- --watch=false \
  --include='src/app/memory/*.spec.ts'
```

For each removal, the include was `src/app/memory/memory-panel-edit.spec.ts` and
`--filter` selected the row above. All six probes exited 1 with the expected assertion
failures. No guard removal remains in the source.

PASS: both combined runs passed all 84 memory tests across three files. The second
run followed restoration of all removed checks.
PASS: workspace and package typecheck; check:events (149 event types).
PASS: web build and `npm run visual:screen-p4-13-edit` (ten captures). The build reported
CSS budget and CommonJS warnings. The unavailable captures are
[desktop](MEM-35-unavailable-1280.png) and [phone](MEM-35-unavailable-390.png).

The default-heap lint attempt was stopped after sustained high memory use. The full
lint retry passed using `NODE_OPTIONS=--max-old-space-size=8192` with `nice -n 10`.
The lint rules and limits are unchanged.
PASS: full lint, including knip, documentation and link checks, fixture checks, package
licences and lint:changelog. ESLint reported zero errors and 24 warnings outside the
changed editor files.

NOT RUN: full root suite, fresh-install journey, actual phone keyboard and assistive
technology. No dev stack or model call was made. CI on the pushed head is left to the
orchestrator's watcher.
