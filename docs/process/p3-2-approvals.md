# P3-2 — Bound approval evidence

Receipt date: 3 October 2026. Source: the commit containing this receipt, stacked on
`b63234cb65548e6d839ae8a99241af5c2b0aea84` (P3-1). Environment: Linux, Node 22, disposable NATS and OpenFGA, isolated databases
under `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`, real agentgateway,
recording credential-free upstream. The shared dev stack was not changed.

## Architecture

The event store holds the complete request and terminal states; PostgreSQL and
OpenFGA retain the existing replayable context projections. Reviewed safe scalar
fields generate an encrypted action ledger, never arbitrary model prose. Missing
review data, hidden fields, nested arguments and malformed JSON refuse. The original
upstream body retains its number lexemes. Request identity includes all bindings,
so retry cannot reopen an answered request. Each decision and consume command makes
one conditional append. Current checks and the authority fence precede consume;
decision audit and the final fence precede forwarding. Loss of an acknowledgement
can burn an approval but cannot cause a second upstream call.

The API uses the original requester, session-bound CSRF and exact Origin. Conditional
OIDC step-up binds the original session and approval, checks the same subject and
organisation, and accepts only verified, non-future `auth_time` within five minutes.
The 8g card restores from the server and keeps submitting, confirmed-safe retry and
unknown outcomes distinct. Terminal cards collapse permanently.

## Validation

| Check | Result / observed outcome |
| --- | --- |
| Clean `npm ci` | PASS; no new third-party dependency |
| `npm run lint` | PASS; code, dependency direction, unused code, Markdown, local links and fixture checks |
| `npm run typecheck` | PASS across all workspaces |
| `npm run check:events` | PASS; 76 event types agree |
| `npm test -- --maxWorkers=2` | PARTIAL invocation: 1,095 passed, one existing budget race failed under load, 11 skipped; isolated rerun below passed |
| Isolated gateway timing rerun | PASS; both last-reservation races and tool-mode/revocation case (3 tests), with the two-second limit unchanged |
| `APPROVAL_BROWSER=1` approval suite | PASS; 15 tests using real gateway/NATS/Postgres/OpenFGA plus Chromium |
| Final access-freshness regression | PASS; removal refuses review reads before OpenFGA catches up, alongside requester/step-up and renewed-token race checks |
| Lossless vectors and event/OIDC security suite | PASS; 344 tests |
| `npm run build -w apps/web` | PASS; existing bundle/style budget warnings remain warnings |
| `npm run test -w apps/web` | PASS; 8 files, 50 tests |

The full test invocation exited 1; it is not represented as a clean full-suite exit.
The one remaining failure was the existing eight-request budget race admitting zero
calls under the freshness deadline while other tests were active. Both budget races
and the revocation timing case passed when rerun alone. Earlier runs also exposed
schema validation/import mistakes, which were repaired and rechecked. No assertion
or deadline was weakened. Live k3d and paid-provider tests stayed gated off; the
browser test skipped by the root command ran separately with its flag enabled.

The approval suite asserts one upstream call across duplicate asks, two decisions,
two concurrent retries and gateway restart; zero calls for refusal cases. It covers
exact forwarded bytes, hidden/ambiguous fields, changed schema/profile/turn, revoked
rights, both fence positions, lost consume acknowledgement, unreadable review keys,
requester/admin substitution, session/Origin/CSRF and conditional step-up. Final
read-authorisation checks also refuse removed participants while OpenFGA lags. The OIDC
fixture separately proves missing/stale/future authentication, session swaps and a
different requester are refused. Browser evidence includes requested/reloaded and
terminal/reloaded cards, submitting, lost response, safe retry, keyboard focus,
44px controls and reduced motion. All effect counts are from the recording upstream.

Images: [requested desktop](../design/chat/comparison/p3-2/requested-1280.png),
[requested phone](../design/chat/comparison/p3-2/requested-390.png),
[used desktop](../design/chat/comparison/p3-2/used-1280.png),
[used phone](../design/chat/comparison/p3-2/used-390.png). Compared against the
[8g frame](../design/chat/wireframes/03-8g-ask-card.png); text wraps instead of
reproducing the reference's overlapping example. Account/profile disclosure is
explicit for the credential-free fixture. The browser serves the built app with the
real approval API; chat WebSocket continuation is outside this fixture.

Safe local logs: `/tmp/p3-2-{lint-done,types-done,test-final,timing-isolated,approvals-done,security,build-done,webtest-done,read-green,renewal}.log`.
Agentgateway SHA-256: `daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`.
NATS binary SHA-256: `387ce54e7a0a249d877a579ed641d715bab047d7e061bfa42b4d07f6a0401341`.
OpenFGA image: `v1.21.0@sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55`.

## Not run

Fresh shared-stack and k3d lifecycle/bridge qualification, paid model calls, live
OIDC-provider sign-in, native Codex MCP
continuation (P3-5), credential release and charged tools (P3-8), Odoo write/readback,
managed-cluster behaviour, independent review and post-rebase/main CI. The real
fixture uses a credential-free connection and profile `none`; it makes no personal
credential-custody claim. Browser step-up navigation and local OIDC tests do not
claim a live-provider journey. No paid calls, push, merge or deployment occurred.
