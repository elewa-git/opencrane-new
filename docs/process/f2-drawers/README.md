# F2 drawers, sheets and mobile menus

Receipt: 4 October 2026, `work/f2-drawers`, stacked on F1 `d96f288`.
Source is the F2 commit containing this receipt. Linux, Node 22, Chromium and
locally installed dependencies (`npm ci`). This is source qualification, not a
fresh silo or a live publication/removal/computer-control journey.

`HingeDrawer` and `ModalSheet` take `open`, `title`, optional `description` and
`returnFocusTo`, emit `closed`, and project their body and `[overlayFooter]`.
`NavigationMenu` takes `open`, `label`, labelled link `items`, `activeHref` and
`returnFocusTo`, and emits `closed`. Workspace-owned status content is projected.
The caller owns visibility and business state. One native-dialog directive owns
modality, title focus, Tab wrapping, Escape and focus return, including teardown.
F1 supplies paper, dog-ear, tokens, shared states and reduced-motion rules.

## Visual comparison

Run the built-asset check without a daemon or development stack:

```sh
nice -n 10 npm run build -w apps/web
nice -n 10 npm run visual:f2-drawers
```

[Visual results](visual.json): 16 captures at 1280 and 390, normal and reduced
motion. Read fixtures exercise the actual workspace, file preview, computer
refusal and nested session-panel drawer. They do not grant computer access.

Compared visually with the local v2 handoff frames:

- INT-08 at 390: full-width left-hinged navigation, white header, 44px labelled
  close, plain rail and selected destination. Workspace session links replace
  the frame's organisation destinations; F3 owns the organisation shell.
- INT-35 at 1280/390 and WRK-84 at 1280: sheet lift, dimmed background, plain
  paper, separated header/body/footer, F1's documented 12px corner and full-screen
  phone Back/action layout. The first consumer is a file preview, using WRK-84's
  wider sheet; publication and its acknowledgement belong to P3-4.
- INT-50 at 1280/390 and WRK-51 at 390: right-edge crease shadow and full-height
  drawer; phone panels fill the viewport and have Back. Contents are the existing
  session panel and refused computer view; removal review belongs to P3-4.

Example captures: [desktop sheet](file-sheet-1280-no-preference.png),
[phone sheet](file-sheet-390-no-preference.png),
[phone menu](navigation-menu-390-no-preference.png),
[desktop drawer](computer-drawer-1280-no-preference.png).
Reduced-motion captures have `-reduce.png` suffixes.

The automated check verifies title focus, both Tab directions, inert background,
Escape/Back focus return, removed-opener fallback, nested dismissal, arrow keys
and Home/End, native link navigation, focus rings, hinge origins, corner/shadow,
44px phone controls, viewport bounds and immediate reduced-motion entrances.
It also checks 650px/800px resizing and focus on the transcript after an Activity jump.

## Gates and limits

| Command | Result | Evidence |
| --- | --- | --- |
| `nice -n 10 npm run lint` | PASS | Code, dependency, unused-code, docs, links and fixtures |
| `nice -n 10 npm run typecheck` | PASS | All workspaces |
| `nice -n 10 npm run check:events` | PASS | 85 event types agree |
| `nice -n 10 npm run build -w apps/web` | PASS | Existing bundle/style warnings and noVNC CommonJS warning |
| `nice -n 10 npm run test -w apps/web -- --watch=false --runner-config=/tmp/f2-angular-runner.mjs` | PASS | 12 files, 62 tests |
| `nice -n 10 npm run visual:f2-drawers` | PASS | 16 captures and keyboard assertions |
| Initial full root suite, PG URL supplied, `nice -n 10`, `--maxWorkers=2` | FAIL | 1,445 passed / 15 skipped / 3 failed; started at load 8; [initial log](root-initial.txt) |
| Final full root suite, PG URL supplied, `nice -n 10`, `--maxWorkers=2` | PASS | 85 files passed / 4 skipped; 1,448 tests passed / 15 skipped; [final log](root-final.txt) |

The temporary Angular runner config contained
`export default { test: { maxWorkers: 2 } };` to limit shared-host CPU use.

Independent review pass 1 identified Activity focus ordering and clarity fixes.
Both fixes are implemented and covered by the passing browser check. Pass 2 is
**PASS**, with no remaining blockers; the reviewer independently checked Activity
focus, Ask composer focus, keyboard navigation and focus trapping.
The initial root run also found a duplicate offline notice in the hidden menu.
The menu now projects that status only while open. The two server failures were
a NATS request timeout and a refused repeated screenshot response under load.
A focused retry passed all 17 server tests, then exposed the removed mobile
“Ask your agent” action. That action is restored, with composer focus after
menu dismissal. The complete chat-browser retry now passes all three tests.
The final full-root retry started at load 11 and passed in 1,206.69 seconds:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  nice -n 10 npm test -- --maxWorkers=2
```

No failed gate is waived. All source gates and both review passes are complete.

Live fresh-install, real-phone, screen-reader, Firefox and WebKit journeys are
**NOT RUN**. Publication, removal and remote control are outside this foundation
change; existing file and viewer permission/transport owners remain responsible.
