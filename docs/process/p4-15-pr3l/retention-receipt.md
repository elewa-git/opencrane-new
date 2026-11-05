# Private reply collection checks

5 November 2026. Source: `b716ff350`. Failing-test commit: `a0e7cc82c`.
Base: `67e1cff993b82410b52a8a04da249ba84c44ce16`.
`git fetch origin` and the rebase completed. The base is an ancestor of the branch;
no rebase remains in progress. These are own checks in the development worktree,
using synthetic replies and Chromium 153.0.8010.12. No fresh installation was used.
The investigation snapshots used application code at `f386fad4b`; that application
code is unchanged by this correction.

## Heap investigation

PARTIAL: the original CI-only retained objects were not reproduced. Twenty runs
of the delayed-render scenario and ten runs of both original scenarios collected
all watched objects. One earlier probe started during a build and failed at socket
setup. A probe with the browser and Angular tests sharing one CPU also failed at
socket setup, before the memory assertion. Neither was a retention result.

PASS: heap snapshots were taken with Mermaid startup delayed and both clipboard
writes held, before clear, after clear and after the late operations finished.
Before clear, the clipboard path reached the Markdown component through:
`finishCopies → completions → resolveCopy → Promise → failed → reject → Promise
→ Generator.receiver → AssistantMarkdown`.
The attached document also reached both elements and their Angular components.
After clear, none of the four marked objects remained in the snapshot, even though
the browser's clipboard promises were still held. The final snapshot also contained
none of them. No lasting render, timer, clipboard or change-detection reference was
found. This app does not use Zone.js.

The original CI failure has no heap snapshot, so its exact retaining object remains
unknown. These local captures do not prove which pending task or collection stage
caused it. Application cancellation code is unchanged.

## Changes and failure proof

The check now observes both returned copy promises settling and all three reply
controllers aborting. It crosses a browser task boundary to drain cancellation,
render rejection and focus callbacks, then runs three GC passes in separate tasks.
It does not dereference the watched objects between passes. Every reference must
still stop resolving while browser copies remain held. After releasing the copies,
it waits for the delayed script handler to finish and checks collection again.

The check now waits for the actual chat connection before asking the fixture whether
its subscription is ready. Network idle alone did not prove Angular had opened it.
The fixture timeout and all content and memory assertions are unchanged.

PASS: an intentional retained callback fails the memory assertion with all four
references still present. The diagnostic names `heldClipboardCallback`, the Markdown
component and its element, and records the paths to the diagram too. A snapshot is
saved on memory or cancellation failure. Weak references do not count as retainers;
a WeakMap path counts only when the map is also reachable.
The negative diagnostic test was committed before its fixture option was added.
It first failed with “Missing expected rejection”, then passed by requiring the
intentional leak to fail with the named references.

## Ten runs under load

Each run executed `nice -n 10 taskset -c 0 node
scripts/check-private-reply-retention.mjs`. A parallel Angular test run used the same
CPU and priority. It passed all 175 tests. Both commands set the requested
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these Angular and
intercepted-browser checks do not use that database.

| Run | Rendered diagram and held copies | Delayed Mermaid and held copies |
| --- | --- | --- |
| 1 | PASS | PASS |
| 2 | PASS | PASS |
| 3 | PASS | PASS |
| 4 | PASS | PASS |
| 5 | PASS | PASS |
| 6 | PASS | PASS |
| 7 | PASS | PASS |
| 8 | PASS | PASS |
| 9 | PASS | PASS |
| 10 | PASS | PASS |

## Other own checks

- PASS twice: 175 Angular tests across workspace, Markdown, private replies and sockets.
- PASS twice: `vitest run apps/web/test/private-reply-browser.test.ts --maxWorkers=1`.
  This includes sign-out, clearance, collection, the named-retainer refusal, late
  results, focus, reload and display at 390 and 1280 pixels.
- PASS: 460 unchanged event-security tests.
- PASS: repository typecheck and final web typecheck; check:events (158 types),
  Knip and `npm run lint:changelog`.
- PASS: full lint after the final test typing correction, with no errors and 36 warnings.
  The earlier run was stopped near Node’s default heap limit. The completed run
  used `NODE_OPTIONS=--max-old-space-size=6144`.

All tests, builds, lint and typechecks used `nice -n 10`. The two root browser runs
and event-security run used a disposable PostgreSQL 17.6 container on loopback port
35430 through `PG_TEST_URL`. The container and its volume were removed afterwards.
An initial targeted lint found an unsafe `any` from Vitest's matcher; an `unknown`
annotation fixes its type without changing the assertion.

Compressed snapshots, the clipboard reference path and individual run logs are in
`<user-home>/.fleet/p4-15-pr3l2-fix2/evidence/` on this machine. Files are synthetic;
no customer contents were captured. The snapshots are named `before-clear`,
`after-clear-copies-held`, `after-late-completions` and `intentional-retainer`, each
with the suffix `.heapsnapshot.gz`. Run logs are `pr879-run-1.log` through
`pr879-run-10.log`.

NOT RUN: the full local root suite and fresh-install qualification. Native admission
remains disabled. No server access, event, money, dependency or application changes
are part of this correction.
