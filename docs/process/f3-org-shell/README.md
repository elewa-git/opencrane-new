# F3 organisation shell v2

Source receipt for issue #133 (parent #130), 4–5 October 2026, `work/f3-org-shell`.
Source: the commit containing this receipt, rebased onto main `af7dfc9` (including #147).
Linux, Node 22.23.3, locally installed lockfile dependencies and Chromium.
Disposable HTTP/RFB fixtures and the normal root-suite test dependencies are used;
this environment is **not a fresh silo**. The owner stack was not changed.

## Scope and contract

The 220px desktop sidebar and F2 phone NavigationMenu present Overview,
People & groups, Models & providers, Spending, Integrations, Routines and Change
history, with current-page semantics and Back to workspace. `/org` retains the
implemented integration register. Unknown addresses show Page not found. Trailing
slashes retain their destination; the state specimen has no current navigation destination. The shell accepts only
the current page and organisation name; unused viewer/access/count inputs were removed.

Integration reads, filters and last-loaded evidence belong to IntegrationRegister.
Spending owns the single existing budget editor, its integer-cent validation and
API B (`/api/org/models`). Models retains the pinned registry; provider and routing
editing is explicitly unavailable. Installer, tools and both audit routes remain.
Overview, People & groups and Routines use SharedState with truthful availability.
No production sample task, person, integration evidence or count was introduced.

## Original builder checks — 4 October

These checks ran at `2e3b0ef`, before the review fixes and rebase.
Status: **PASS** for source qualification. Lint and all workspace typechecks passed.
Full root suite: 95 files passed / 4 skipped; 1,521 tests passed / 15 skipped.
Integration suite: 20 tests passed, including the real-dependency Chromium journey.
Angular: 113 tests passed. Production build and check:events (86 types) passed.
Visual checks: 22 shell and 38 carry-over captures passed.

```sh
nice -n 10 npm run lint
nice -n 10 npm run typecheck
nice -n 10 npm run check:events
nice -n 10 npm run build -w apps/web
nice -n 10 npm run test -w apps/web -- --watch=false
nice -n 10 npm run visual:f3-org-shell
F2_CAPTURE_DIR=docs/process/f3-org-shell/carry-overs nice -n 10 npm run visual:f2-drawers
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2
```

The root suite waited until the integer part of `/proc/loadavg` was below 16.
The initial run started at 23:02:40 UTC with load 15.59 and failed five tests:
two old theme assertions, two integration journey assertions (one transient role
read, one old navigation label), and an old refused-view label. The assertions
were updated to the moved components and requested vocabulary. The focused theme
suite passed all 8 tests; the integration suite passed all 20 tests, including
the role read. The complete rerun started at 23:32:37 UTC with load 9.22 and
passed in 1,361.42 seconds (Vitest start 23:32:40 UTC, 4 October 2026).
No live-view qualification batch was running. Ordinary disposable test containers
are expected test dependencies.

Size exception: approximately 1,900 non-generated added/deleted lines with rename
detection, above the approximately 1,500-line target. The register and budget
extractions, five F2 carry-overs and required browser qualification remain one
coherent feature. No new dependencies or future feature implementations were added.

## Visual comparison

[Shell results and captures](visual.json) exercise 1280px and 390px, normal and
reduced motion. [Carry-over results](carry-overs/visual.json) cover the existing
workspace/overlay consumers with the same widths and motion variants.
Reference root: `/home/jente/dev/design-handoffs/v2/`.

| Frames, at both widths | Captures, normal and reduced copies | Comparison |
| --- | --- | --- |
| INT-03 | `integrations-*` | Sidebar width, ordered navigation, heading, paper and labelled stacked register rows match the shell anatomy; supported fixture rows and refresh/discovery links replace unsupported design actions. |
| INT-07 | `integrations-stale-*` | Warning triangle and 13px notice heading restored; tiles have a different background from stale rows, and tile/status glyphs dim to 60%. Compared with INT-07-1280/390; supported fixture rows replace the sample content. |
| INT-37 | `integration-tools-*` | Same Integrations selection and shell around the supported tool-policy route. Four detail facts and dependency reads await their owning feature; exact detail body NOT RUN. |
| OVR-01 | `overview-*` | Overview selection and shell match. Task/ready tables and attention counts await owning reads; explicit Not available yet replaces the sample body. Exact task body NOT RUN. |
| WRK-07 / WRK-52 / WRK-54 | `carry-overs/session-drawer-*`, `computer-viewing-*`, `computer-sheet-*` | Phone drawers have no crease; phone viewer is landscape with the toolbar above; refused view says Unavailable and clears pixels. |

Browser assertions cover semantic register rows, deep links, seven native navigation
links, active-page selection, arrow keys, Home/End, trapped Tab, Escape returning
focus, a 2px `#0a8497` ring, 44px phone targets and no horizontal page overflow.
Session selection waits for both loading and modal dismissal before composer focus.
Reduced-motion entrances appear immediately using the shared F1/F2 styles.

Independent review pass 1 is recorded in `/home/jente/.fleet/reviews/f3-review1.md`.
It found the stale notice regression and conflicts with main, plus routing,
accessibility, wording, dev-stack caller and readability fixes. This revision
addresses those findings. Independent pass 2 / fix verification: **NOT RUN**.
The empty-body 403 regression and moved Spending journey are builder evidence;
they do not demonstrate an independent review pass.
Fresh-install live qualification, physical phones and screen readers: **NOT RUN**.
This is foundation source evidence, not completion of the later product journeys.

## Independent pass 1 fixes — 5 October

Rebase completed onto `af7dfc9`; the branch retains main's Failed / Try again
behaviour and the Unavailable refused mapping. Removed unused shell inputs,
shared the page-label lookup and corrected unknown/trailing-slash/state-specimen
routes. Models says Models loaded without dated Ready evidence; Check status fits
its label and the Spending link has a 44px target. Register columns have accessible
text labels, including visible Status in phone rows. Desktop viewer controls have
spacing above and below. Dev-stack callers use Unavailable, Spending loaded,
Budget saved and `/org/spending`, while API B remains `/api/org/models`.

The review-fix runs use the commit containing this receipt (working tree based on
`56b8a63`), Linux, Node 22.23.3 and the installed lockfile dependencies. This is
not a fresh install. Builder logs and the complete F1 rerun archive are retained
at `/tmp/f3-fix1-evidence/`; four stale-notice captures are retained here with the
22 shell and 38 carry-over captures. Visual assertions cover the restored warning,
tile/glyph dimming, row labels, model wording/targets and route corrections.
Independent pass 2 / fix verification and fresh-install live qualification remain
**NOT RUN**.

Review-fix source qualification: **PASS**. Every lint, typecheck, build and test
command ran under `nice -n 10`. Both full root runs used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and `--maxWorkers=2`.
Each started only after the integer part of `/proc/loadavg` was below 16;
no live-view qualification batch was running.

| Check | Result | Observed result |
| --- | --- | --- |
| `npm run lint` | PASS | All six stages; seven existing code warnings, no errors |
| `npm run typecheck` | PASS | All workspaces |
| Dev-stack TypeScript check | PASS | `node_modules/.bin/tsc --noEmit -p infra/dev-stack/tsconfig.json` |
| `npm run check:events` | PASS | 86 event types agree |
| Angular production build | PASS | Existing CSS budget and CommonJS warnings |
| Angular tests | PASS | 17 files, 123 tests |
| `visual:f1-foundation` | PASS | 56 captures; restored stale-warning and dimming assertions |
| `visual:f2-drawers` | PASS | 38 captures |
| `visual:f3-org-shell` | PASS | 22 captures; route, label and target-size regressions |
| First full root run | FAIL | 96 files / 1,565 tests passed; one approval test failed; 4 files / 15 tests skipped |
| Focused approval rerun | PASS | One case passed; 26 other cases deselected |
| Final full root rerun | PASS | 97 files / 1,566 tests passed; 4 files / 15 tests skipped |

The first full run started at 00:18:48 UTC on 5 October, with command-start load
7.11, and took 1,779.71 seconds. The first request in the encrypted approval-card
API case returned “Request refused or decision service unavailable” rather than
an approval id (`apps/server/test/approvals.test.ts:55`). The focused case passed
unchanged in 44.24 seconds. The full rerun started at 00:54:33 UTC, with
command-start load 15.88, and passed in 1,533.11 seconds. No assertion or production
code was changed for those reruns; the initial failure was not reproduced.
