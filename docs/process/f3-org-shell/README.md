# F3 organisation shell v2

Source receipt for issue #133 (parent #130), 4 October 2026, `work/f3-org-shell`.
Source: the commit containing this receipt, based on main `d4b62b2` (F1 and F2).
Linux, Node 22.23.3, locally installed lockfile dependencies and Chromium.
Disposable HTTP/RFB fixtures and the normal root-suite test dependencies are used;
this environment is **not a fresh silo**. The owner stack was not changed.

## Scope and contract

The 220px desktop sidebar and F2 phone NavigationMenu present Overview,
People & groups, Models & providers, Spending, Integrations, Routines and Change
history, with current-page semantics and Back to workspace. `/org` retains the
implemented integration register. Unknown addresses show a page-not-found heading
and availability state. The shell accepts optional viewer/access/count inputs;
no viewer role, task count or grant is inferred when evidence is absent.

Integration reads, filters and last-loaded evidence belong to IntegrationRegister.
Spending owns the single existing budget editor, its integer-cent validation and
API B (`/api/org/models`). Models retains the pinned registry; provider and routing
editing is explicitly unavailable. Installer, tools and both audit routes remain.
Overview, People & groups and Routines use SharedState with truthful availability.
No production sample task, person, integration evidence or count was introduced.

## Source checks

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
| INT-37 | `integration-tools-*` | Same Integrations selection and shell around the supported tool-policy route. Four detail facts and dependency reads await their owning feature; exact detail body NOT RUN. |
| OVR-01 | `overview-*` | Overview selection and shell match. Task/ready tables and attention counts await owning reads; explicit Not available yet replaces the sample body. Exact task body NOT RUN. |
| WRK-07 / WRK-52 / WRK-54 | `carry-overs/session-drawer-*`, `computer-viewing-*`, `computer-sheet-*` | Phone drawers have no crease; phone viewer is landscape with the toolbar above; refused view says Unavailable and clears pixels. |

Browser assertions cover semantic register rows, deep links, seven native navigation
links, active-page selection, arrow keys, Home/End, trapped Tab, Escape returning
focus, a 2px `#0a8497` ring, 44px phone targets and no horizontal page overflow.
Session selection waits for both loading and modal dismissal before composer focus.
Reduced-motion entrances appear immediately using the shared F1/F2 styles.

Independent review: pass 1 found an empty-body refusal retaining protected rows,
missing register semantics and readability fixes. These were fixed together;
pass 2 passed with no remaining blockers. Refusal regression uses an empty-body
403 after a loaded read. The integration browser journey follows the moved
Spending editor and checks its absence from Models & providers.
Fresh-install live qualification, physical phones and screen readers: **NOT RUN**.
This is foundation source evidence, not completion of the later product journeys.
