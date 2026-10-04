# F2 drawers, sheets and mobile menus

Review-fix receipt: 4 October 2026, `work/f2-drawers`, draft PR #146 / issue #132.
Initially rebased onto F1 `c9eaa86`, with completion and ancestry checked. F1 then
advanced during qualification; the final stack was rebased onto `6441b66` and
ancestry checked again. Source is the commit containing this receipt, following
rebased F2 `c097606`.
Linux, Node 22.23.3, Chromium, locally installed dependencies. This qualifies
source with disposable test fixtures; the environment is not a fresh silo.

The full independent review at `/home/jente/.fleet/reviews/f2-review1.md` was read.
All four blockers and every FIX item are addressed. Independent verification of
these fixes is **NOT RUN**; this receipt does not claim a second review passed.
The larger feature diff keeps the requested regression proof and clarity changes
in this PR; it exceeds the approximate 1,500-line target for this one feature.

## Contract and regression proof

`HingeDrawer` and `ModalSheet` take `open`, `title`, optional `description`,
`backLabel` and `returnFocusTo`, emit `closed`, and project body/footer content.
`backLabel` defaults to Back; an empty label selects the sole × control.
`ModalSheet.kind="computer"` uses the full-width computer sheet with an 18px
outside inset and 12px radius at desktop sizes. `NavigationMenu` projects guarded
buttons and plain links, and owns modality, keyboard navigation and dismissal.
The caller owns visibility and business state; the shared directive closes child
modals and emits their close signals before closing or destroying the parent.

- B1: the phone projects the rail's exact session buttons, including status,
  Projects and Archived. Angular tests exercise a real queued delivery, a running
  upload with retained bytes and New session opening a draft. Only Settings and Account are links.
- B2: a nested viewer close resets its state before the parent closes. Chromium
  opens a connected noVNC fixture at 800px, widens to 1280px, observes its socket
  close, finds zero open dialogs and clicks the composer. Desktop has one viewer.
- B3: Chromium measures a 1244 × 864 computer sheet at (18, 18) in a 1280 × 900
  viewport, with 12px radius and display width above 1000px. The display fills the
  remaining height (above 600px). Phone sheets fill
  390 × 900. Connecting, viewing, refusal and access-change captures are retained.
- B4: Back/Cancel/Close preview and phone Ask use F1's `#0a6f7e` token.
  Every visible overlay text node is checked against 4.5:1. Inherited muted rail,
  panel and transcript text also uses readable colours.

The browser check also covers one labelled header close control, hidden spoken
chevrons, the drawer/menu crease and shadow, sheet shadow/body dog-ear, active
weight 600, 19px ×, a single phone Session heading, actual Files opener focus,
scroll lock, overscroll containment, intrinsic disclosure/editable/media focus
controls, removed-opener fallback, Activity focus and reduced motion. The old
phone `.close` override is removed, so visibility no longer depends on CSS order.
Shared overlay keyframes now live in `overlay-motion.css`.

## Captures compared with v2 frames

```sh
nice -n 10 npm run build -w apps/web
nice -n 10 npm run visual:f2-drawers
```

The visual command builds a small host for the actual shared panels, then checks
the built workspace. [Results and capture list](visual.json): 38 captures, widths
1280/390 plus the 800px resize setup, normal/reduced motion. Assets and HTTP/RFB
responses are intercepted fixtures; no development stack or computer grant is used.
Playwright's WebSocket subclass exposes its inherited methods for noVNC 1.5's
single-prototype check. The fixture waits for viewer attachment before handshaking.

Reference root: `/home/jente/dev/design-handoffs/v2/` (`01-int/png`, `02-wrk/png`).
These comparisons qualify shared geometry, colour, close controls and motion;
fixture bodies and workspace destinations differ from the organisation journeys.

| Named frames | Capture (normal motion; reduced copies also retained) | Comparison |
| --- | --- | --- |
| INT-08-390 | [Menu](navigation-menu-390-no-preference.png) | Opaque rail, right crease, white active row at 600, 19px × |
| INT-35-1280 / 390 | [Desktop sheet](shared-sheet-1280-no-preference.png), [phone](shared-sheet-390-no-preference.png) | Sole Cancel, sheet shadow, dog-ear at body top |
| INT-50-1280 / 390 | [Desktop drawer](shared-drawer-1280-no-preference.png), [phone](shared-drawer-390-no-preference.png) | Sole Cancel, 16px inner crease and outer shadow |
| WRK-07-390 | [Session](session-drawer-390-no-preference.png) | One Session heading, Back followed by tabs |
| WRK-84-1280 / 390 | [Preview](file-sheet-1280-no-preference.png), [phone](file-sheet-390-no-preference.png) | Sole Close preview, body dog-ear and footer |
| WRK-51-1280 / 390 | [Connecting](computer-connecting-1280-no-preference.png), [phone](computer-connecting-390-no-preference.png) | Full-width computer sheet; access check before pixels |
| WRK-52-1280 / 390 | [Viewing](computer-viewing-1280-no-preference.png), [phone](computer-viewing-390-no-preference.png) | Near-full-screen viewer, sole ×, read-only toolbar |
| WRK-54-1280 / 390 | [Refused](computer-sheet-1280-no-preference.png), [phone](computer-sheet-390-no-preference.png) | Sheet geometry and empty pixels; existing permission copy says Not available |
| WRK-55-1280 / 390 | [Access changed](computer-access-changed-1280-no-preference.png), [phone](computer-access-changed-390-no-preference.png) | Sheet geometry, access-change state and cleared pixels |

The generic INT fixture qualifies panel chrome, not publication/removal behaviour.
The computer fixture uses a synthetic 1024 × 768 framebuffer, not a live desktop.

## Gates and limits

All CPU-heavy checks use `nice -n 10`; both test runners use two workers.
The temporary Angular config is `export default { test: { maxWorkers: 2 } };`.

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run lint` | PASS | Code, dependency, unused-code, Markdown, links and fixtures; [logs](checks-review-fixes.txt) |
| `npm run typecheck` | PASS | All workspaces, including browser qualification hosts |
| `npm run check:events` | PASS | 85 event types agree |
| `npm run build -w apps/web` | PASS | Existing bundle/style budgets warn; noVNC CommonJS warning |
| `npm run test -w apps/web -- --watch=false --runner-config=/tmp/f2-angular-runner.mjs` | PASS | 15 files, 105 tests |
| `npm run visual:f2-drawers` | PASS | 38 captures and browser assertions |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2` | PASS | Final F1 base; 85 files / 1,453 tests passed, 4 files / 15 tests skipped; start load below 16; 1,250.91 seconds; [log](root-final-base.txt) |

The first review-fix root run passed on F1 `c9eaa86`: 85 files / 1,451 tests
passed, 4 files / 15 tests skipped, start load 14, 1,333.79 seconds.
[That log](root-review-fixes.txt) precedes the final F1 rebase. Earlier implementation
logs: [initial](root-initial.txt), [final](root-final.txt).

Fresh-install, real-phone, screen-reader, Firefox and WebKit journeys are
**NOT RUN**. Publication, removal and computer control are outside F2; their
existing permission and transport owners remain responsible for live qualification.
