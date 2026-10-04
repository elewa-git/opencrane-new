# F1 foundation review-fix receipt

Checked on 4 October 2026 from `work/f1-foundation`, source commit
`9688bb8d3bd99604934ba0baac7f31220d05f62d`, including the owner-approved
extra fix round after focused verification at `6441b66`. The following evidence
commit changes only this receipt, the ledger and the regenerated visual artefacts.
This is source qualification on the shared Linux builder, not a fresh customer silo.
Commands run at `nice -n 10`; the root suite waits for the integer load average to
fall below 16 and uses two workers and the supplied disposable PostgreSQL URL.

## Visual evidence

`npm run visual:f1-foundation` loads the built Angular assets in Chromium with
intercepted protocol fixtures. It captures fourteen views at 1280px and 390px,
each with normal and reduced motion: **56 captures**. The views are the state
specimen; loading, loaded and stale integrations; workspace Grain and Flutter;
chat dog-ears; file preview; refused live view; models; tool policy; and refused
MCP installation, plus focused citations and session panel file buttons.
[visual.json](visual.json) records the exact source commit and fresh capture time.

The automated check covers persistent start/result status, busy content outside
status regions, silent repeated rows, specific call-site states, tab keyboard
navigation, focus retention, the composer ring, 44px phone tabs, no overflow,
rows near 80px on desktop, the clipped 12px card fold and 6px citation fold,
rice texture and static reduced-motion loaders. At both widths the check submits
an edited refused address through Discover tools and Enter and observes each
corrected POST. It checks keyboard focus rings outside the inner clipped paper
and verifies that pointer focus has no ring. The unit tests separately cover
every glyph, call-site mappings, accepted corrected registrations after refusal,
safe failures, rejected and ambiguous captures, late aborted captures and
restored versus new completion creases.

## Comparison with the handoff

References: `/home/jente/dev/design-handoffs/v2/` and the corresponding
[checked-in design package](../../design/handoff-v2/PLAN.md).

- **INT-02/03/07, both widths: PARTIAL screen match.** The register now has one
  coloured specific status line with muted detail, desktop rows near 80px,
  loading counts shown as “–”, full-height phone paper and single-line phone
  tabs. INT-07's amber stale notice sits above the tabs, contains Refresh,
  names the last read in UTC and dims glyphs while keeping retained text at full
  opacity. The current navigation,
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
| Angular tests | PASS, 98 tests in 13 files |
| Visual check | PASS, 56 captures |
| Full root suite with supplied `PG_TEST_URL`, `--maxWorkers=2` | PASS, 1,453 tests; 15 gated tests skipped |

The fresh full root run started at 20:24 UTC with load 13.10 and passed
1,453 tests in 85 files, with four files skipped, in 1,422 seconds. The command was
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2`.
The final visual run started at 20:48 UTC with load 14.37 and regenerated all
56 captures from the source commit above. Both completed without failures.
The normal root command leaves fifteen gated cases **NOT RUN**: k3d lifecycle,
bridge and live view, screenshot and approval browser journeys, and real provider calls.

The first Angular run passed 97 tests and timed out one existing workspace test
at its five-second limit while the shared load reached 26. After waiting for
load 15.32, the complete rerun passed all 98 tests. The existing workspace test
was unchanged.

The requested corrections, regression tests and additional capture coverage
push the whole PR to about 2,400 added/deleted text lines, over the approximate
1,500-line target. Code has not been compressed to fit. All unrelated Models
refactoring has been removed; that file now changes only its shared-state
imports, status, evidence, reference and screen copy. For a stricter split, move
expanded editor/workspace capture orchestration and integration skeleton/stale
notice screen composition to F3. Keep the state mapping, contrast, announcement
and capture-guard fixes and their regression proof together in F1; those are
required to make the shared component safe to use.
