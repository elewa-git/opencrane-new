# F4 Personal settings shell receipt

## Outcome

PASS for the settings shell and the first consumers in issue #134. The shell
reuses the F1 paper and SharedState, the F2 NavigationMenu, and F3's navigation
approach. Account reads only the signed-in name from `/auth/me`; profile fields
and personal tool connections that have no available API are labelled as
unavailable. Preferences and Assistant likewise show their current contract
gaps without placeholder controls or sample data.

## Visual evidence

`visual.json` records the 14 Chromium captures from the built Angular app at
1280px and 390px, with normal and reduced motion. It also lists the named
handoff frames checked during comparison: ONB-50 and ONB-52 from `07-onb`, and
INT-60 and INT-61 from `01-int`.

- Account captures use a disposable `/auth/me` name fixture. They show a
  read-only session name and state that remaining profile fields need P4-18.
- Preferences captures state that the P4-16 API and P4-18 screen are pending.
- My tools captures state that personal tool reads need P3-8 and P3-9; there
  are no fabricated connected-tool rows.
- Phone menu captures check the 44px targets, focus ring, arrow and boundary
  keys, Escape focus return, and reduced-motion animation behaviour.
- Each route is checked for horizontal overflow. The fixture is used only by
  the visual script and is not application data.

The screenshots are the retained evidence for the visual comparison. The
account fixture text is intentionally different from handoff sample content.

## Checks

- PASS — `npm run check:events` (86 event types agree).
- PASS — `npm run typecheck`.
- PASS — `npm run lint` (seven existing max-lines warnings; no errors).
- PASS — `npm run build -w apps/web` (existing bundle/CSS budget and CommonJS
  warnings).
- PASS — Angular tests, 127 passed.
- PASS — `npm run visual:f1-foundation` (56 captures).
- PASS — `npm run visual:f2-drawers` (38 captures).
- PASS — `npm run visual:f3-org-shell` (22 captures).
- PASS — `npm run visual:f4-settings` (14 captures; see `visual.json`).
- NOT RUN — Fresh-install silo qualification; no secondary stack was requested
  or used for this screen-only foundation work.

- PARTIAL — Full root suite:

  ```sh
  PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
    nice -n 10 npm test -- --maxWorkers=2
  ```

  Result: 1,566 passed, 15 skipped, and 3 failed across 101 files. The
  existing `live-view.test.ts` slow-authority connection case closed its
  WebSocket. The `live-view-unavailable.test.ts` recovery case received close
  code 4503 instead of 4003. The existing 100,000-event authority-volume
  model p95 was 1,128 ms against its 1,000 ms bound. Focused reruns were NOT
  RUN while other root test suites remained active on the shared host.
