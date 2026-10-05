# F4 Personal settings shell receipt

## Outcome

PARTIAL. The shell reuses the F1 paper and SharedState, the F2 NavigationMenu,
and F3's navigation approach. Account reads only the signed-in name from
`/auth/me`; profile fields and personal tool connections that have no available
API are labelled as unavailable. Preferences and Assistant likewise show
their current contract gaps without placeholder controls or sample data.

## Visual evidence

`visual.json` records the 20 Chromium captures from the built Angular app at
1280px and 390px, with normal and reduced motion. It also lists the named
handoff frames checked during comparison: ONB-50, ONB-51 and ONB-52 from
`07-onb`, and INT-60 and INT-61 from `01-int`.

- Account captures use a disposable `/auth/me` name fixture. They show a
  read-only session name and state that remaining profile fields are not
  available yet.
- Assistant captures at 1280px and 390px name the available assignment and
  the missing persona details and provisioning status.
- Preferences and My tools captures state that those personal settings are
  not available yet; there are no fabricated controls or connected-tool rows.
- Signed-out and server-error captures at both widths cover the ONB-51 states.
- Phone menu captures check the 44px targets, focus ring, arrow and boundary
  keys, Escape focus return, and reduced-motion animation behaviour.
- Each route is checked for horizontal overflow. The fixture is used only by
  the visual script and is not application data.

The screenshots are the retained evidence for the visual comparison. The
account fixture text is intentionally different from handoff sample content.

## Known differences from the handoff frames

- The 1280px settings sidebar has no viewer name or initials row. This matches
  the current organisation shell footer, which only has “Back to workspace”.
- Account (ONB-50) has no Email, Organisation or Role rows, preferred-name
  field, assistant card, Save button or “Open My tools” button.
- My tools (INT-60 and INT-61) has no introductory line.
- Preferences (ONB-52) has no “Personal · only you” label.
- The account logo is not the smaller, lighter mark shown in ONB-50.
- The Assistant page reports that persona details and setup status are
  not available; the assignment itself is available in the workspace.
- ONB-51's expired state has no card or detail line. “Sign in again” is a
  text link outside the state, while the frame shows a primary button inside
  it.
- ONB-51's failed state has a text “Try again” button rather than a bordered
  button in a red card, and its message differs from the frame's “Nothing
  changed”.
- Loading shows one “Checking…” line rather than the ONB-51 skeleton rows.
- The “These aren't your settings” state is not implemented because `/auth/me`
  does not return it.

## Checks

- PASS — `npm run check:events` (89 event types agree).
- PASS — `npm run typecheck`.
- PASS — `npm run lint` (six existing max-lines warnings; no errors).
- PASS — `npm run build -w apps/web` (existing bundle/CSS budget and CommonJS
  warnings).
- PASS — Angular tests, 142 passed across 19 files on the first complete run.
  A later full rerun under shared host load had three unrelated 5-second
  timeouts (139 passed). All three failing files passed when run alone; the
  failures came from host load. The changed `app.spec.ts` passed all 27 tests
  on a focused run.
- PASS — `npm run visual:f1-foundation` (56 captures).
- PASS — `npm run visual:f2-drawers` after #160 updated its fixture to send the
  access notice required since #153. The original timeout was a main bug, not
  a load failure.
- PASS — `npm run visual:f3-org-shell` (22 captures; shared shell styles
  preserve the organisation shell checks; the 1280px sidebar and 390px
  phone-bar regions are pixel-identical to the earlier captures).
- PASS — `npm run visual:f4-settings` (20 captures; see `visual.json`).
- NOT RUN — Fresh-install silo qualification; no secondary stack was requested
  or used for this screen-only foundation work.

- Size — 1,118 changed lines against the 500–850 line estimate.

- PARTIAL — Full root suite:

  ```sh
  PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
    nice -n 10 npm test -- --maxWorkers=2
  ```

  Result: 1,602 passed, 15 skipped, and 3 failed across 106 files. The
  authority-volume test received 503 because decision audit was unavailable;
  the integrations Chromium journey did not find its scoped validation
  connection; and the older Alice/Bob bridge replay timed out waiting for a
  service outcome. No focused reruns were run while other root test suites
  remained active on the shared host.
