# Zitadel sign-in evidence

Issue #11, 2 October 2026, branch `work/zitadel-signin`.
The review fixes are based on `4fa0b26`, after rebasing onto the reviewed
`work/timing-tests` (`61d898d`). The rebase had no conflicts.
The receipt is committed with the fixes; the final handoff records its HEAD SHA.
The dev stack runs from `/home/jente/dev/wt/zitadel-signin` and is left running.
Resource names, public IDs, redirect URLs and secret-file references are in the
[dev-stack README](../../infra/dev-stack/README.md). No dependency was added.

## Review findings and checks

| Finding | Fix and runnable evidence |
| --- | --- |
| 1: logout CSRF | Exact configured Origin and a valid, correctly pinned session are required before clearing anything. `apps/server/test/auth-flow.test.ts` checks missing/hostile Origins, missing/invalid/expired/wrong-org sessions and valid logout. The live journey checks both Origin refusals with a real session and no clearing cookie. |
| 2: logout binding | The encrypted HttpOnly cookie retains the ID token; `buildLogoutUrl` supplies `id_token_hint`, `client_id` and the registered return URI. `/auth/me` returns only public identity fields. Auth contract tests check the hint and token exclusion; older cookies without a hint get local-only logout. The live journey uses two accounts in one browser context. |
| 3: handoff Cancel | Focus starts on Cancel; an aria-live five-second countdown precedes redirect. Component tests cover focus, countdown, cancellation and destruction. `npm run visual:signin` drives Enter and Space in Chromium, advances its clock before/after cancellation and verifies the redirect boundary at 4,999/5,000 ms. |
| 4: reliability | Rebased onto #19's reviewed fixture-port allocation, owned cleanup and real shutdown checks. Three consecutive full suites pass with the PostgreSQL control URL below. |
| 5: frame fidelity | A dedicated `#2f8d9a` SSO token, configured organisation name, invitation arrival copy, frame footer and 420px desktop cards. Captures crop the design source to the card and capture the live card at 1×. Assertions cover geometry, 56/44px horizontal padding, 14px content gap, colours, copy, overflow and 44px controls at 390px. |

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
Only the real login redirect is augmented with standard OIDC prompt/hint
parameters to exercise multiple accounts; provider responses and logout are
not replaced. Errors name a fixed stage, never a token or provider error body.

The logout check must observe a return navigation without account selection,
refuse silent login for the ended member, retain silent login for the owner,
then end the owner and refuse its silent login. Both accounts share the same
provider cookie jar. CSRF probes leave the real member session usable. The silent
refusal also recognises the exact `No active session found` JSON response
from [Zitadel Login V2 issue #12165](https://github.com/zitadel/zitadel/issues/12165);
when no sessions remain, that bug can instead require credentials. The check
accepts that explicit credential form, but other provider failures do not count
as proof of logout. The still-active owner must complete silent login successfully.

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

Safe gate logs: `/tmp/zitadel-{lint,typecheck,events,suite1,suite2,suite3,web-build,web-tests,stack-typecheck,shellcheck,visual}.log`.
All full suites used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`
and ran sequentially; no other Vitest launcher was active at the first start.

| Gate | Result |
| --- | --- |
| Root lint | PASS — 0 errors, 3 function-length warnings |
| Workspace typecheck | PASS — 11 workspaces |
| Event catalogue | PASS — 70 event types agree |
| Full suite, run 1 | PASS — 890 tests, 48 files, 111.39s |
| Full suite, run 2 | PASS — 890 tests, 48 files, 97.74s |
| Full suite, run 3 | PASS — 890 tests, 48 files, 96.28s |
| Focused auth regressions | PASS — 78 tests, 4 files |
| Web build | PASS — existing app CSS size warning |
| Web component tests | PASS — 40 tests, 4 files |
| Dev-stack TypeScript | PASS |
| Shellcheck | PASS — 4 shell entrypoints |
| Visual/browser check | PASS — 6 captures plus focus, Enter/Space cancellation and timing |
| Fresh journey 1 | PASS — 11 checks, `/tmp/zitadel-fresh1.log` |
| Fresh journey 2 | PASS — 11 checks, `/tmp/zitadel-fresh2.log` |

Four earlier fresh attempts failed while correcting the two-account harness:
login selection/input waits, response-body loss on cross-origin navigation and
Login V2’s asynchronous refusal pages. These are failed attempts, not passes.
An intermediate fresh journey passed too; the two final receipts above are
consecutive passes on the final harness and cover bound logout.

Source readiness: **PASS** for the listed gates. The requested dev-stack sign-in
and sign-out capability passed twice from fresh local services. The remaining
qualification limits below are not claimed as passes.

**NOT RUN:** email/magic-link delivery and screen 1c; the owner's physical devices;
an account from a second cloud organisation; hosted CI and managed production
installation. No review pass was run during these fixes, and nothing was pushed.
