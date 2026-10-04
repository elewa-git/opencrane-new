# P3-17 independent review pass 1 fixes

4 October 2026, branch `work/p3-17-takeover`, source base `2376afd` plus
this commit's diff. No new dependencies, OS packages or licence changes.

## Reproductions and fixes

Each reproduction failed before its fix at the confirmed takeover command/reaction
or real Playwright keyboard seam:

- Release retry: rejected with unchanged events and ready status, but execution
  became paused. The retry now has no execution effect.
- Delayed competing takeover: its unaudited pause landed after the winner's
  release. Refused intent appends now send no pause.
- Failed release append: a request that could not commit still sent a pause.
  Release now only closes the writer and conditionally appends its event; the
  committed release reaction checks quiescence before resuming checked work.
- Delayed committed pause: local pause landed after resume; stale delivery also
  recreated the pause marker after restart. The bridge serialises effects and
  retains committed versions for pauses and releases across restart.
- Interrupt failure: early rejection allowed a newer release to run while local
  pause was outstanding. All pause effects now settle before the queue proceeds.
- Browser keyboard: F8 left focus on the desktop canvas. Both key edges are now
  captured before noVNC. Use desktop keyboard enters the canvas through a native
  button; F8 focuses Release, Tab reaches Renew, Shift+Tab returns
  to Release. The test navigates and activates these controls with real keyboard
  input at 390px and 1280px; it never calls `element.focus()`.

## Qualification

PostgreSQL: `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
NATS and OpenFGA fixtures are disposable. The owner stack is untouched.

| Check | Result |
| --- | --- |
| `npm run lint` | PASS; no errors, existing size warnings |
| `npm run typecheck` | PASS; all workspaces |
| `npm run check:events` | PASS; 85 events |
| Focused takeover/bridge regressions | PASS; 26 tests |
| `npm test -- --maxWorkers=2 --testTimeout=30000` | PASS; 1,227 passed / 16 opt-in skipped; 868 seconds |
| `npm run build -w apps/web` | PASS; existing size/CommonJS warnings |
| `npm run test -w apps/web -- --watch=false` | PASS; 56 tests |
| Playwright keyboard at both widths | PASS; only Tab/Enter/F8, native entry, Renew/Release and no forwarded F8 |
| Revised image contents and permissions | PASS; source/routing match, root ownership and no credentials |
| Revised gVisor runtime journey | PASS; two threads/tool, release retry, stale pause, three crash recoveries |
| Independent review pass 2 | LAND at `93c80ee`, as confirmed by the owner; rebased source `9f8b5bf` |
| Fresh complete silo / paid provider | NOT RUN |

The initial root run reported three gateway/approval failures while several local
checks ran concurrently; those three tests passed in isolation. That known-red
run was interrupted before starting a clean full rerun. Early live runs also
failed authority deadlines under load; one runtime run timed out. A later isolated
runtime run passed. The keyboard-only test additionally exposed noVNC's canvas
being outside the Tab order; the native entry button fixed that path. The clean full rerun passed all 73 executed files (four opt-in files skipped).
Final results above are separate from those failed attempts.

The revised runtime image is a local source-only overlay of the reviewed P3-17
image. Local manifest digest:
`sha256:7e0d39c39547b0f5e1ad0c5662dc14773b8da6ed37f79942c57f950a12f0f4fa`.
It adds no dependencies. The original qualification imported it locally. The
tracked deployment manifest originally named the earlier image. The
[secondary-stack receipt](p3-17-live-evidence.md) records publication of this
reviewed image, the matching template digest and the current licence gate.

The live tests create only `computer-view-*` disposable namespaces, check gVisor,
and delete their namespace in `finally`. A timed-out worker left one namespace;
it was explicitly deleted and absence was checked before the next run. They use real Codex, local tools, Kasm,
private Pod control and isolated provider/identity fixtures. The runtime journey
also retries release and delivers the earlier committed pause after work resumes,
then verifies the pause marker remains absent.

```sh
npm run build:live-view-test -w apps/web
COMPUTER_TEST_IMAGE=ocn-p317-review:2376afd-fixes-v3 TAKEOVER_K3D=1 \
  PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npx vitest run apps/server/test/takeover-k3d.test.ts --maxWorkers=2
```
