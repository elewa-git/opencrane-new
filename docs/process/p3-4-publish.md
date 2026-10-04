# P3-4 reviewed publication and access

Issue #45, parent #41; D02, D03, D08 and D11. Source: the commit containing this
receipt, stacked on P3-3 commit `d172909`. Date: 4 October 2026. Linux,
Node 22.23.3, disposable NATS/PostgreSQL/OpenFGA and pinned agentgateway 1.5.0
(`daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`).
PostgreSQL: `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
No dev stack, remote provider, paid call or new dependency was used.

## Outcome and architecture

One reviewed revision becomes one desired configuration event. Publication stays
Applying until the reconciler compares both effective configuration and active
routes and records the exact digest. Decisions require the current publication
and the digest embedded in the gateway's authorization path. The remote transport
requires a one-use body-bound permit, rechecks authority after DNS resolution,
and pins the checked address through TLS. A partial or stale route cannot release
an unreviewed call. Credential-dependent accounts stay unavailable pending P3-8.

Separate grant events project people, existing teams and assistants into OpenFGA.
Both requester and assistant need current permission; a missing projection receipt
denies during lag. Removal disables execution without deleting the upstream account.
The admin screen separates installation, connection, audience and assistant facts;
unknown publication restores its reference and offers Check status without another
installation. Conflicts load current state without repeating the rejected command.

Per-route `Mcp-Param-*` headers come from the reviewed schema's exact property paths
and the authorised body. They follow the
[MCP 2026-07-28 encoding contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#custom-headers-from-tool-parameters).
The inherited call envelope and name header are corrected to `params._meta` and
`Mcp-Name`. Client credentials and arbitrary headers are removed before upstream.

## Evidence

Tests use the agreed command/projection/replay, real gateway/recording upstream,
and authenticated Playwright seams. Red tests preceded publication, acknowledgement,
forwarding, protocol-list support, browser controls and schema header support.
An initial broad test process was terminated (exit 143); that run is not a pass.
The first full run exposed header-field and money-schema guard failures; both
were corrected before the final full run. The default chat browser check exceeded
its 180-second wrapper limit but passed directly. The final full suite uses its
supported `CHAT_BASE_URL` with an ephemeral loopback server for the production
build (the serving code from `scripts/check-chat-production.mjs`, with SPA
fallback for `/signin/handoff` as well as `/workspace`), plus
`NG_BUILD_MAX_WORKERS=2`, Node's temporary compile cache and
`--maxWorkers=2 --no-file-parallelism --reporter=verbose`. A second, contended
run was cancelled after migration timeout and timing-sensitive conflict failures;
both model cases then passed separately (`/tmp/p3-4-timing-check.log`). No
assertions, timeouts or configured skips were weakened. An intermediate run
also caught the temporary server's missing handoff route; its correction passed
`/tmp/p3-4-fold-final.log` before the final run.

| Check | Result | Builder-host evidence |
| --- | --- | --- |
| Publication, exact acknowledgement, replay, guarded transport, stale/partial generations and refusal counts | PASS, three tests including parameter encodings | `/tmp/p3-4-test-final.log` |
| P3-2 approval regressions and publication fixture | PASS, 23 tests, one existing opt-in skip | `/tmp/p3-4-focused.log` |
| Desktop/390px admin, Applying/Ready, dropped reply, reload, genuine grant conflict and removal | PASS | `/tmp/p3-4-test-final.log` |
| `npm run lint` | PASS, eight size warnings | `/tmp/p3-4-lint-final.log` |
| `npm run typecheck` | PASS | `/tmp/p3-4-typecheck-final.log` |
| `npm run check:events` | PASS, 83 types | `/tmp/p3-4-events.log` |
| `npm test -- --maxWorkers=2` (execution options above) | PASS, 1,330 passed; 14 existing opt-in skips | `/tmp/p3-4-test-final.log` |
| `npm run build -w apps/web` | PASS, bundle/CSS and CommonJS warnings | `/tmp/p3-4-build-final.log` |
| `npm run test -w apps/web -- --watch=false` | PASS, 56 tests | `/tmp/p3-4-web-test-final.log` |

Screenshots: `/tmp/p3-4-applying-1280.png`, `/tmp/p3-4-applying-390.png`,
`/tmp/p3-4-removal-1280.png`, `/tmp/p3-4-removal-390.png`,
`/tmp/p3-4-unknown-1280.png`, `/tmp/p3-4-unknown-390.png`,
`/tmp/p3-4-ready-1280.png`, `/tmp/p3-4-ready-390.png`.
The TLS fixture maps a checked public address to a local recording server; production
has no loopback exception. No actual external server or fresh dev install is qualified.

Independent review pass one required fixes for schema header forwarding, conflict
recovery, parent install controls during uncertainty and actual stale-route request
proof. Those changes are included. Pass two: **PASS**, no remaining blocking findings.
The final schema guard also required explicit, constrained header-name metadata;
the security and money guards pass 330 tests, including refusal of credentials/header
values and explicit integer bounds for zero-cost tools (`/tmp/p3-4-schema-final.log`).
Fresh-install journey, hosted CI, merge and push: **NOT RUN**. The orchestrator owns
rebase after P3-3 lands and subsequent live qualification; no capability-done claim.
