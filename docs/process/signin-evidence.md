# Zitadel sign-in evidence

Issue #11, 2 October 2026, branch `work/zitadel-signin`.
The dev stack runs from `/home/jente/dev/wt/zitadel-signin` and is left running.
Resource names, public IDs, redirect URLs and secret-file references are in the
[dev-stack README](../../infra/dev-stack/README.md). No new dependency was added.

## Architecture

- Reuse `libs/auth` for discovery, client-secret POST, code + S256 PKCE, state,
  nonce, organisation claims, encrypted cookies, expiry and `endSessionUrl`.
- Reuse the server's four auth routes. Browser failures clear cookies and reach
  the rejected screen; JSON consumers retain 400 responses. Session inspection
  also checks the current org pin. No login bypass or password endpoint is added.
- The dev launcher reads the client secret from its private path into the auth
  library's existing indirection. Fresh installs replace service credentials but
  preserve the cloud client and test-user credentials. The PAT reaches only the
  setup script's Authorization header, never a server process, event or log.
- Product membership is still events → PostgreSQL projections / OpenFGA. The
  journey binds real subjects through dev bootstrap invitations, then joins via
  the server. Stable member IDs avoid ambiguous duplicate identity bindings.
- One Angular sign-in component uses existing tokens and shared states. The
  transient handoff has Cancel; rejection offers SSO recovery. Credentials stay
  on Zitadel. Copy does not claim an invitation, private personal storage, email
  delivery or lockout counts that the backend has not confirmed.

## Live proof

The runnable check is `infra/dev-stack/up.sh --fresh` (which runs the journey),
with `infra/dev-stack/journey.sh` available for repeated checks without a reset.
`browser-signin.ts` uses actual Chromium, the tailnet HTTPS endpoint and Zitadel;
it never stubs an OIDC response or mints the success-path sessions.

| Check | Result | What it proves |
| --- | --- | --- |
| Setup rerun | PASS | Exact same org, project, client and users; no duplicate resources or credential rotation |
| Owner and member login | PASS | Real code exchange, organisation claim, secure HttpOnly SameSite=Lax cookie; UI works at 390px |
| Wrong organisation | PASS | Real token rejected by a second server whose expected org differs; rejected screen, no session cookie |
| Session expiry | PASS | Authentic two-second session replay is refused by `/auth/me` and the protected API after expiry |
| Logout, both users | PASS | Browser follows `endSessionUrl`, selects the account on Zitadel, returns home; next SSO requires credentials |
| Membership journey | PASS | Real session joins through HTTP; event reaches PostgreSQL, OpenFGA and a live WebSocket subscriber |
| Integration access | PASS | Owner gets typed event-derived rows; anonymous and ordinary member requests are refused |
| Replay | PASS | Both members and MCP catalogue verify against event replay |
| Fresh install 1 | PASS | Complete journey from deleted Compose volumes; cloud secrets retained |
| Fresh install 2 | PASS | Complete journey repeats after another fresh install |
| Listener check | PASS | Existing check unchanged: stack listeners only on loopback or Tailscale |

Wrong-org proof varies the **server pin**, using a token from OpenCrane 2 Dev.
It does not access another cloud organisation or require another organisation's
credentials. The short-session and pin probes bind temporary loopback ports and
close them afterwards; the running server's settings never change for a test.

## Design comparison

`npm run visual:signin` captures 1a, 1b and 1d at 1280 and 390 pixels and checks
for horizontal overflow. PNGs and side-by-side HTML/PNG comparisons are in
`/home/jente/.fleet/signin-shots/`: `{1a,1b,1d}-{1280,390}.png` and
`compare-{1a,1b,1d}-{1280,390}.png`. The original reference PNGs are alongside.
The capture freezes only the transient handoff timer in its own browser.

Visual adaptations: organisation-admin teal/button tokens take precedence over
the older sign-in button colour; 1d uses the shared rejection state and SSO action
instead of duplicate password fields or fictional lockout counts. Email controls
are disabled with an explicit unavailable explanation. Phone controls are at
least 44px tall; focus and reduced-motion styles use the shared conventions.

## Gates and limits

| Gate | Result |
| --- | --- |
| `npm run lint` | PASS (existing WebSocket length warning only) |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS — 70 event types agree |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test` | PASS |
| `npm run build -w apps/web` | PASS (existing app CSS size warning) |
| `npm run test -w apps/web -- --watch=false` | PASS — 36 tests |
| `npx tsc -p infra/dev-stack/tsconfig.json` | PASS |
| `shellcheck infra/dev-stack/*.sh` | PASS |
| `npm run visual:signin` | PASS — all six captures and overflow checks |

The initial contract tests correctly caught their old expectation that rejected
callbacks set no cookies; they now require both cookies to be cleared. The shell
test now expects the real session-inspection request. The corrected suites pass.

**NOT RUN:** email/magic-link delivery and screen 1c (no verified delivery mailbox;
unavailable in the UI); the owner's physical phones/computers; an account from a
second cloud org; deliberate cloud outage for the explicit offline fallback;
independent review, hosted CI and managed production installation. No review pass
was run, and nothing was pushed. Browser emulation is not physical-device proof.
