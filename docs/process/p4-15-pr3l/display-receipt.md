# Private personal reply display

5 November 2026. Part of #97. This continues #874 without changing its transport.
Source: `7c068d22cf9e9497d96f4b935a2562c2591e4130`.
Base: `47709d225c1fb7b33ec541887dd237b645fba795`.
The clearance schema was read after #871 (PR 3k) merged at
`6031183ebb29f8023edf914adb04913a58088884`.
Delivery keeps #863's accepted ordering at the final authority position read.

## Own checks

- PASS: tests committed before fixes in `53366bcb1` (missing display), `6cd099ec2`
  (missing diagram cancellation), `5d611f5d2` (lost browser focus) and `7c192e7e9`
  (ordinary partial replies lost their existing outcome).
- PASS twice: 170 Angular tests across workspace, Markdown, private replies and sockets.
  Command: `npm test -w apps/web -- --watch=false` with those four spec files selected.
  These include turn starts received before subscription catch-up finishes.
- PASS twice: `vitest run apps/web/test/private-reply-browser.test.ts --maxWorkers=1`.
  Chromium checks rendered text disappearing on sign-out in another tab, a missed
  notification, exact clearance, reload without resend and pending diagram cancellation.
- PASS: all 460 unchanged `libs/events/test/security-rules.test.ts` cases.
  Root tests used a disposable PostgreSQL container through `PG_TEST_URL`.
  The container and its volume were removed afterwards.
- PASS: full typecheck and a final web typecheck; event catalogue agreement (158 types),
  Knip, changelog validation and the production web build.
- PASS: existing Chromium Mermaid isolation, lazy loading, settings and limit checks.
- PASS twice: final `capture-p4-15-pr3l.mjs` checks at both widths. The first ran through
  `npm run visual:p4-15-pr3l`, including its production build.
- PASS: full lint, with zero errors and 35 existing function-length warnings.
  Tests, lint, typechecks and builds use `nice -n 10`.

## Screens and environment

The browser uses intercepted HTTP and WebSocket replies with synthetic values.
It starts no dev stack, makes no model calls and logs no reply text. This is not a
fresh-install journey. Checks cover no horizontal overflow, a 44 px citation hit area,
removed accessible labels, reduced motion and focus returning to the transcript.

| State | 1280 px | 390 px |
| --- | --- | --- |
| Live reply and diagram | [Desktop](live-1280.png) | [Phone](live-390.png) |
| Cleared and unavailable | [Desktop](cleared-1280.png) | [Phone](cleared-390.png) |
| Restriction and disabled admission | [Desktop](restriction-1280.png) | [Phone](restriction-390.png) |

The reference frames are THR-71 and THR-72. Personal restriction screens have no
memory-free button because that command choice is not implemented for personal sessions.
NOT RUN: fresh-install qualification and the full root suite. Native admission stays
disabled. Direct/shared sessions, server authority checks and event names are unchanged.

## Pending copy correction

5 November 2026. Source: `7a3a2f9b2`.
Fetched origin and rebased onto `5dbd530c2`. The rebase completed, and that main
commit is an ancestor of the branch. File-preview changes from main were preserved.

Failing-test commit: `e664ccaa1`. Chromium held two clipboard writes while clearing
a reply containing private code and a rendered diagram. After forced garbage
collection, all five WeakRef references still resolved: the reply component and
element, the diagram component and element, and its image. The assertion failed
before the implementation changed.

The correction ends application waits for copies, diagram imports and drawing when
the reply is removed. It also detaches callbacks from the abort signal and settled
promise, so the browser's pending operation cannot retain private content. Late
success or failure cannot restore copy feedback. The capture script now separates
live display, focused clearance, restriction notices and reload into named steps.

Own checks in this development worktree, using synthetic browser fixtures:

- PASS twice: 175 Angular tests across workspace, Markdown, private replies and sockets.
- PASS twice: `vitest run apps/web/test/private-reply-browser.test.ts --maxWorkers=1`.
  Chromium checks sign-out, display, clearance, focus and reload at both widths.
  The new memory regression holds copies with a rendered diagram and with diagram
  startup delayed. After clearance and garbage collection, every WeakRef stops
  resolving. Releasing late clipboard success and failure leaves the reply absent.
- PASS: all 460 unchanged event-security tests.
- PASS: repository typecheck and event catalogue agreement (158 types).
- PASS: targeted lint for the changed rendering code and browser scripts.
- PASS: full lint, including Knip and changelog validation, with no errors and
  35 existing function-length warnings.

Two earlier combined browser runs failed before delivery because the fixture socket
was not ready. The regression now waits for the app's initial loads before checking
subscription readiness. The final two runs passed with the same readiness timeout
and memory assertions.

All tests, builds, lint and typechecks ran under `nice -n 10`. Root test commands
used a throwaway PostgreSQL container on a random loopback port through `PG_TEST_URL`.
The container and its volume were removed. The full root suite and fresh-install
qualification remain NOT RUN. Native admission remains disabled.

The [collection checks](retention-receipt.md) record later heap snapshots, cancellation
timing, named failure diagnostics and ten browser runs under load.
