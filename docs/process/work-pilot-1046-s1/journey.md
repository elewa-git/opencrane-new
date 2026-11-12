# Installation organisation name journey

Journey on a fresh dev stack: FAIL

The name-specific browser steps passed at 1280px and 390px on a fresh secondary
stack. Overall qualification remains blocked: the built-in startup journey failed
its 44px minimum touch-target assertion for **Retry upload** at 390px, in
`infra/dev-stack/browser-upload.ts:15`, called from line 52. `up.sh --fresh`
therefore exited non-zero. This is not claimed to be a pre-existing failure.

## Live steps

Source revision: `f4a8a655f`. Test name: `Acme & Sons`. Secondary slot: `1`.

1. Claimed the slot through `infra/dev-stack/claim.sh`. Set `ORGANISATION_NAME`
   before `up.sh --fresh`, using the existing sign-in credential file by reference.
2. Ran `status.sh` after startup returned. Server, access service, file storage,
   website and model readiness endpoints were healthy despite the built-in
   journey failure.
3. Opened the slot's origin in separate Chromium contexts at 1280 × 900 and
   390 × 844. The sign-in card and decoded public meta value showed `Acme & Sons`.
   The existing unavailable email sign-in notice and read-only field remained visible.
4. Used real single sign-on with the slot's generated test owner. No responses
   were intercepted in these name-specific steps. Opened the workspace and, on
   the phone, session navigation. Both showed `Acme & Sons · Personal`.
5. Opened organisation integrations and, on the phone, organisation navigation.
   Both showed `Acme & Sons`. All three screens fit each viewport without
   horizontal overflow.
6. Saved and visually inspected the six screenshots below. Ran `down.sh` after
   the checks. **PASS: teardown completed and released the slot.** Every earlier
   claimed attempt was also torn down.

| Screen | 1280px | 390px |
| --- | --- | --- |
| Sign-in | [Screenshot](sign-in-1280.png) | [Screenshot](sign-in-390.png) |
| Workspace navigation | [Screenshot](workspace-1280.png) | [Screenshot](workspace-390.png) |
| Organisation navigation | [Screenshot](organisation-1280.png) | [Screenshot](organisation-390.png) |

## Own checks

- PASS: 342 node tests, then 257 changed page, chart and settings tests.
- PASS: 181 targeted web tests, then all 1,565 web tests in 81 files.
- PASS: production web build and three production-server tests; the new name
  case passed again.
- PASS: Docker build-context copy and the runtime-file allowlist test twice,
  using the two real web modules in a scratch image.
- PASS: repository typecheck, final dev-stack typecheck, 174 event types, knip,
  scoped ESLint with no warnings, changelog lint and Markdown lint.
- PASS: 58 startup tests after naming the web environment before its startup
  call, repeated after sharing the web heap cap with the build. The production
  build also passed with that 768 MiB cap and two build workers.
- PASS: local Chromium reproduction of the CSP-blocked logout redirect, twice.
- PASS: empty and whitespace names render “this organisation” on sign-in and
  “Your organisation” in the organisation shell and workspace. These are component
  render tests in `sign-in.spec.ts`, `app.spec.ts` and `workspace.spec.ts`.
- NOT RUN: a separate live restart with the name unset. Component render tests
  cover this fallback rather than another fresh startup on the shared host.
- NOT RUN: full root suite and full packaged-runtime image qualification.

## Earlier attempts and remaining blocker

The first fresh start reached website readiness, then refused the inherited
fleet-task marker before browser work. The next attempt was scoped to the
explicitly authorised secondary journey without that marker.

That attempt's built-in logout probe waited for a response event that CSP prevents
while blocking a cross-origin redirect. A local reproduction confirmed the POST
reaches the server, the cookie clears and the token stays unreadable. The probe
now observes the POST and retains its cookie-removal and token-exposure assertions.
The production content policy was not weakened.

With the corrected probe, the final fresh run reported the upload touch-target
failure above. The name-specific browser journey then passed on the healthy
services. Further upload work is outside this slice; qualification remains FAIL
and needs an owner scope/rework decision before merge.
