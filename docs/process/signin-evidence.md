# Zitadel sign-in evidence

Issue #11, 2 October 2026, branch `work/zitadel-signin`.
Final findings fixed on top of `747102fc38cf3a4dcfb1d9aa45d48bdad5c8ef98`.
This receipt is committed with the fixes; the final handoff records its HEAD SHA.
The dev stack runs from `/home/jente/dev/wt/zitadel-signin` and is left running.
Resource names, public IDs, redirect URLs and secret-file references are in the
[dev-stack README](../../infra/dev-stack/README.md). No dependency was added.

## Final review findings and checks

| Finding | Fix and runnable evidence |
| --- | --- |
| ID token exposed to JavaScript | Native form POST to `/auth/logout`; empty **303 See Other** with the provider URL only in `Location`, marked `no-store`. Removed the JSON schema/response and Angular fetch/navigation code. Server tests check the body, redirect parameters, scheme validation and logs. Live probes check manual/follow fetch, XHR, DOM and page cookies without passing the token into page JavaScript. |
| Unsupported account-specific logout claim | Withdrawn. Zitadel ends all accounts in the browser. The journey uses separate contexts for its two business identities; it does not assert that another account survives logout. Keyboard form submission must return home without a chooser, remove the OpenCrane cookie and be followed by a credential-based sign-in. |
| “1 seconds” announcement | Template selects “1 second” and plural otherwise. Component and visual-browser countdown checks assert the singular wording. |
| Existing CSRF boundary | Exact configured Origin and a valid, correctly pinned session remain required before clearing anything. Server tests cover missing/hostile Origins and missing/invalid/expired/wrong-org sessions. Live probes cover hostile/missing Origin and no session. |

The public organisation name is deployment configuration in the `opencrane-org`
meta tag. A non-empty invitation query parameter selects presentation only;
membership still requires its existing event-backed command. Secrets are never
configuration in this public page. No Zitadel management settings or resources
were changed during the review fixes.

## Real-service journey

Run `infra/dev-stack/up.sh --fresh`, which deletes the local Compose volumes,
recreates service credentials and runs the journey. Cloud accounts and their
private credential files survive. The journey uses Chromium, tailnet HTTPS,
real Zitadel, PostgreSQL, NATS and OpenFGA; no success-path session is minted.
The sign-in and sign-out flows use the registered application unchanged, with no
prompt/hint overrides or substituted provider responses. Errors name a fixed
stage, never a token or provider error body.

The owner chose browser-wide provider logout. Zitadel documents that its current
[end-session implementation signs out all users in the browser](https://zitadel.com/docs/guides/integrate/login/oidc/logout).
The ID-token hint identifies the RP session for logout; it does not promise that
other browser accounts survive. The earlier two-account PASS and source-readiness
claims are withdrawn: the final review reproduced both silent member re-entry and
loss of the owner session. Those results did not qualify account-specific logout.

The replacement test checks the real empty 303 response, then probes page fetch
with manual and followed redirects and XMLHttpRequest. The probes report only
booleans and never inject the real ID token into the page. They check the DOM and
page-visible cookies too. Each probe must receive a real 303 and clear the local
cookie. Each probe uses its own browser context and real credential-based login.
Native Enter activation then follows the top-level POST/303 navigation to Zitadel
and home without provider interaction. No OpenCrane cookie may remain, `/auth/me`
must report signed out, and another POST with correct Origin must return 401
without clearing cookies. The next normal sign-in may show a remembered-account selector, but must then present credentials and
complete with the real password; selecting that identity or returning silently
cannot pass. “No chooser” is tested during sign-out. The current ID token
must be absent from all five stack process logs.

Wrong-org proof varies the **server pin**, using a real token from OpenCrane 2 Dev.
It does not access another cloud organisation. Expiry proof replays a genuine
two-second cookie after expiry. Both probes use temporary loopback servers.
The business journey proves HTTP join → event → PostgreSQL / OpenFGA / live
WebSocket, typed integrations, anonymous/member refusal and replay verification.

## Design evidence

Source: `Onboarding Wireframes.dc.html` in the supplied design handoff.
`npm run visual:signin` produces six card captures and six same-scale comparisons
in `/home/jente/.fleet/signin-shots/`:

- `{1a,1b,1d}-{1280,390}.png`: live cards at device scale 1.
- `reference-{1a,1b,1d}.png`: source frame crops without labels or notes.
- `compare-{1a,1b,1d}-{1280,390}.{html,png}`: both cards at their native 1× size.

The unsupported email path remains explicitly unavailable. Its explanation and
44px controls need more vertical content than the reference's smaller controls;
the desktop card still measures 420px and the content uses the frame's 14px gap.
Frame 1d uses SSO recovery and truthful rejection copy instead of local password
fields or invented lockout counts. Frame 1b names Zitadel, includes announced
progress and focuses Cancel. Physical-device qualification is separate.

## Gates

Safe gate logs: `/tmp/zitadel-final-{lint,typecheck,events,suite1,suite2,suite3,auth,web-build,web-tests,stack-typecheck,shellcheck,visual}.log`.
All full suites use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`
and run sequentially.

| Gate | Result |
| --- | --- |
| Root lint | PASS — 0 errors, 3 existing function-length warnings |
| Workspace typecheck | PASS — 11 workspaces |
| Event catalogue | PASS — 70 event types agree |
| Full suite, run 1 | PASS — 881 tests, 47 files, 105.02s |
| Full suite, run 2 | PASS — 881 tests, 47 files, 104.92s |
| Full suite, run 3 | PASS — 881 tests, 47 files, 134.91s |
| Focused auth regressions | PASS — 78 tests, 4 files |
| Web build | PASS — existing app CSS size warning |
| Web component tests | PASS — 41 tests, 4 files |
| Dev-stack TypeScript | PASS |
| Shellcheck | PASS — 4 shell entrypoints |
| Visual/browser check | PASS — 6 captures; geometry, colour, copy, 390px/44px controls, Enter/Space Cancel, focus and singular/plural countdown |
| Fresh journey 1 | PASS — 14 checks, `/tmp/zitadel-final-fresh4.log` |
| Fresh journey 2 | PASS — 14 checks, `/tmp/zitadel-final-fresh5.log` |

The first fresh attempt during these fixes failed in the token-exposure harness;
its receipt is `/tmp/zitadel-final-fresh1.log`. A diagnostic non-fresh journey
(`/tmp/zitadel-final-debug-journey.log`) located the failure at reauthentication
after a followed fetch. Such a request can change provider sessions despite CORS
hiding its response. Each exposure probe now uses an isolated browser context.
A second fresh start (`/tmp/zitadel-final-fresh2.log`) failed before the journey:
the server reported `EADDRINUSE` during a concurrent root suite. The final fresh
runs are sequential with the suites to avoid that port collision.
The third fresh attempt (`/tmp/zitadel-final-fresh3.log`) passed the logout and
exposure assertions, then failed while waiting for credentials on the next
sign-in. A diagnostic rerun (`/tmp/zitadel-final-debug2-journey.log`) and an
isolated browser probe found a remembered-account selector on that next sign-in.
No chooser appeared during logout. A further isolated probe proved that selecting
the remembered identity still requires the real password and leaves `/auth/me`
unauthenticated until it is supplied. The journey now allows that selection only
on the next sign-in, and still requires credentials. The original attempt remains
FAIL; it is not counted towards the two final fresh runs.
Failed attempts are not passes.
The component form test initially failed because the async response body had not
yet settled; waiting for the rendered form corrected the test (41/41 pass).

Source readiness: **PASS** for the listed gates. Live capability: **PASS** for the
browser-wide logout contract in two consecutive fresh runs on the final harness.
Sign-out shows no chooser; the next sign-in may select a remembered account and
must still require its password. Chooser-free next sign-in is **not** claimed.
All three full suites passed; no fourth full suite was run. The nine tests of the
removed JSON logout schema account for the reduction from 890 to 881 root tests.

**NOT RUN:** email/magic-link delivery and screen 1c; physical devices and a real
screen reader; an account from a second cloud organisation; hosted CI and managed
production installation. Native form/button semantics and keyboard activation are
checked, but do not substitute for screen-reader qualification. No review pass was
run during these fixes, and nothing was pushed. No Zitadel settings or resources
were changed.
