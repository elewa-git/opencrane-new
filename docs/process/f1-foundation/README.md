# F1 foundation review-fix receipt

Checked on 4 October 2026 from `work/f1-foundation`, base
`d96f288b1f5537b03c55f2c1493249496d68b549` plus the review fixes in this PR.
This is source qualification on the shared Linux builder, not a fresh customer silo.
Commands run at `nice -n 10`; the root suite waits for the integer load average to
fall below 16 and uses two workers and the supplied disposable PostgreSQL URL.

## Visual evidence

`npm run visual:f1-foundation` loads the built Angular assets in Chromium with
intercepted protocol fixtures. It captures twelve views at 1280px and 390px,
each with normal and reduced motion: **48 captures**. The views are the state
specimen; loading, loaded and stale integrations; workspace Grain and Flutter;
chat dog-ears; file preview; refused live view; models; tool policy; and refused
MCP installation. [visual.json](visual.json) records the source and checks.

The automated check covers persistent start/result status, busy content outside
status regions, silent repeated rows, specific call-site states, tab keyboard
navigation, focus retention, the composer ring, 44px phone tabs, no overflow,
rows near 80px on desktop, the 12px card fold and 6px citation fold, rice texture
and static reduced-motion loaders. The unit tests separately cover every glyph,
call-site mappings, safe failures, rejected and ambiguous captures, late aborted
captures and restored versus new completion creases.

## Comparison with the handoff

References: `/home/jente/dev/design-handoffs/v2/` and the corresponding
[checked-in design package](../../design/handoff-v2/PLAN.md).

- **INT-02/03/07, both widths: PARTIAL screen match.** The register now has one
  coloured specific status line with muted detail, desktop rows near 80px,
  loading counts shown as “–”, full-height phone paper and single-line phone
  tabs. INT-07's amber stale notice sits above the tabs, contains Refresh,
  names the last read in UTC and dims the retained rows. The current navigation,
  register fields, two Tools links and top-level refresh control remain; search,
  the redesigned navigation and complete row composition belong to F3.
- **Shared glyph/paper/loading rules: PASS.** The design source's glyph sizes,
  individual strokes and colours, including paused text `#8a5d1f` and paused
  glyph `#b0661a`, fold gradient and reduced-motion forms are
  used. Checking/Applying, state actions and specimen text use `#0a6f7e`:
  **5.85:1 on white and 5.49:1 on `#f6f8f8`**. `#0a8497` remains the focus colour.
- **WRK-01/02/03/84 and the workspace paper rules: PARTIAL screen match.** The
  captures prove the upgraded workspace loaders, citation/file-card folds,
  preview status and viewer refusal. The preview fixture is a text file; it
  does not qualify PNG screenshot transport, desktop readiness or saved-image
  readback. WRK-84's expanded screenshot composition is later workspace work.
- **Spending and integration editor rules: PARTIAL screen match.** Models,
  tool policy and MCP installation retain their existing editors and routes,
  with the corrected shared states and announcements. Tool-policy reads do not
  claim missing input, and budget reads do not claim provider readiness.
  Complete Spending screens and admission workflows are later work.

Full handoff screen parity and fresh-install live journeys: **NOT RUN** by this
fixture visual check. The optional `SCREENSHOT_BROWSER=1` pixel journey is also
**NOT RUN** by the root suite’s normal environment. The root integration suite
is separate evidence below.

## Checks and scope

| Check | Result |
| --- | --- |
| Lint | PASS; existing function-length warnings |
| Typecheck | PASS, all workspaces |
| Event catalogue | PASS, 85 event types agree |
| Angular build | PASS; existing size and noVNC format warnings |
| Angular tests | PASS, 96 tests in 13 files |
| Visual check | PASS, 48 captures |
| Full root suite with supplied `PG_TEST_URL`, `--maxWorkers=2` | PASS, 1,451 tests; 15 gated tests skipped |

The first root run passed 1,450 tests and failed the MCP restore-copy browser
assertion. The caller now explicitly names its unconfirmed restore state, with
a unit regression test. The second full run passed that journey but failed
unchanged screenshot and OpenFGA fixture tests; both had passed on the first run
and passed an isolated rerun (13 tests) without code changes. The final complete
run passed all 1,451 tests in 85 files, with four files skipped, in 1,124 seconds.
The normal command leaves fifteen gated cases **NOT RUN**: k3d lifecycle, bridge
and live view, screenshot and approval browser journeys, and real provider calls.

The requested corrections, regression tests and additional capture coverage
push the whole PR to about 2,100 added/deleted text lines, over the approximate
1,500-line target. Code has not been compressed to fit. All unrelated Models
refactoring has been removed; that file now changes only its shared-state
imports, status, evidence, reference and screen copy. For a stricter split, move
expanded editor/workspace capture orchestration and integration skeleton/stale
notice screen composition to F3. Keep the state mapping, contrast, announcement
and capture-guard fixes and their regression proof together in F1; those are
required to make the shared component safe to use.
