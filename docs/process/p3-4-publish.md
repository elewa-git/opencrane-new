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

## Review fixes and secondary-stack qualification

4 October 2026, base `62e63da` (rebased onto `39fe9da`) plus the commit containing
this update. This section supersedes the initial fresh-install status above.
The agreed seams are journey scripts, the real gateway fixture and audit ingestion.

The journey regression first failed on `Approval journey requires a reviewed
publication` (`/tmp/p3-4-journey-unit-red.log`). Both journey scripts now use the
same discovered, reviewed Ask/Allow publication, wait for its exact acknowledgement,
and grant both requester and assistant. Approval-card metadata is part of the
reviewed publication digest. The old HTTP MCP stub, legacy envelope and name
header are removed. Dev entrypoints inject the local TLS fixture's network mapping;
production entrypoints retain normal DNS and TLS trust. The browser checks one-use
approval, denial, reload and an automatic Allow call, including exact forwarded
bytes and stripped credentials.

The audit failure is a pre-existing shutdown race: process `exit` can precede
unread stdout. Closing the reader at exit drops the final gateway observation.
Shutdown now waits for closed pipes, then all queued file writes. The deterministic
regression failed with only the first trusted id (`/tmp/p3-4-ingestion-red.log`);
the reviewer’s existing assertion is unchanged. The gateway source at pre-rebase
`693bc98` and rebased `62e63da` is byte-for-byte identical; the faulty shutdown
sequence is also present on parent `39fe9da`, originating before P3-4. The deterministic test also fails against an isolated copy of parent `39fe9da`
with the same missing second id (`/tmp/p3-4-parent-audit-red.log`); temporary
baseline files were removed. Neither the rebase nor P3-4 introduced this race.

Live environment: claimed secondary id **1**, project/namespace
`opencrane-dev-1`, loopback web port **25106**, local HTTPS MCP fixture **25111**,
real Zitadel sign-in and the stub model. No owner-stack command was run. Initial
attempts hit shared-host Docker/Kubernetes networking failures before qualification;
the missing default Docker bridge and the `pg-test` attachment were restored,
and the shared Kubernetes API recovered before retry. Owner-stack containers,
configuration and data were not changed. A later attempt caught and fixed the fixture recording request's IPv4
lookup setting, and the catalogue assertion was corrected to count both Ask and
Allow as allowed tools. The real approval flow also moves publication beyond the
first 50 audit records; the audit journey now follows the API cursor and the
browser’s Older history control. The first repeat attempt stopped in the existing
live-view check when access changed and the viewer cleared its controls; its
assertion was retained and plain `up.sh` retried. Screenshot:
`/tmp/p3-4-repeat-live-view-failure.png`. A second repeat timed out waiting for
the existing chat reply while host load averaged 27 on eight cores. Assertions
and timeouts were retained. After the long root suite, the retained computer had
idled to Suspended; that repeat stopped at the existing Ready precondition. A real
Zitadel-authenticated chat woke it (`/tmp/p3-4-repeat-wake.log`). Subsequent attempts
stopped at approval submission and the live-view connection assertion. These
failed attempts are not passing evidence. A second fresh run completed both
publication viewports but failed later when audit history returned 503
(`/tmp/p3-4-fresh-pair-audit-failure.log`). Its subsequent plain run stopped at
WebSocket initial catch-up (`/tmp/p3-4-repeat-catchup-failure.log`). The server
health check and projection workers were healthy afterwards; these failures
are not sufficient evidence to attribute every live failure to host load.
The final plain repeat reached the new approval card but all three approval POSTs
returned 503 after 2,417, 2,149 and 3,058 ms. Those timings are consistent with the
existing two-second authority fence expiring; the precise cause remains unproved.
No fence, assertion or timeout was relaxed. **Repeat qualification remains FAIL**;
the publication fix is not claimed capability-done.

The first full root run used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`,
`--maxWorkers=2 --no-file-parallelism` and a temporary Node compile cache. It
reported 1,351 passes, five failures and 14 existing opt-in skips: NATS timeout and
a closed delayed-authority viewer in live-view, five-second timeouts in authz
projection and bridge replay, and a 40-second publication-journey timeout with a
NATS rejection. Host load was above 20 on eight cores during the run. All four
files then passed unchanged (29 tests); the publication journey took 13.5 seconds.
No assertions, test limits or skips were changed. The failed complete run and
successful focused retry are separate evidence; no clean complete-run claim.

| Review-fix check | Result | Evidence |
| --- | --- | --- |
| Journey setup, real HTTPS Ask/approve/one-use/Allow and deterministic audit drain | PASS, two focused tests | `/tmp/p3-4-fix-focused.log` |
| Unchanged trusted-decision regression plus deterministic drain | PASS | `/tmp/p3-4-audit-green.log` |
| Infra TypeScript | PASS | `/tmp/p3-4-infra-types.log` |
| Event catalogue | PASS, 83 types | `/tmp/p3-4-fix-events.log` |
| Secondary `up.sh --fresh` | PASS, both approval viewports, Allow, typed catalogue, audit pagination, budgets and replay | `/tmp/p3-4-review-fix/fresh/up.log` |
| `npm run lint` | PASS, eight existing size warnings | `/tmp/p3-4-fix-lint.log` |
| `npm run typecheck` | PASS | `/tmp/p3-4-fix-typecheck.log` |
| Web production build | PASS, existing bundle/CSS/CommonJS warnings | `/tmp/p3-4-fix-web-build.log` |
| Web tests | PASS, 11 files / 56 tests | `/tmp/p3-4-fix-web-test.log` |
| Full root suite | FAIL, 1,351 passed / five failed / 14 skipped; one NATS rejection | `/tmp/p3-4-fix-test.log` |
| All failed root files, unchanged | PASS, four files / 29 tests | `/tmp/p3-4-fix-test-retry.log` |
| Secondary plain `up.sh` | FAIL, approval submissions return 503; complete repeat unqualified | `/tmp/p3-4-review-fix/repeat/failure.log`, `/tmp/p3-4-review-fix/repeat/approval-responses.json` |
| `down.sh --id 1` | PASS; secondary containers, namespace and private directory removed | `/tmp/p3-4-down.log`, post-teardown checks |

Fresh screenshots: `/tmp/p3-4-review-fix/fresh/publication-live/` (requested,
approved, used and denied at 390px and 1280px). The remaining blockers are a clean
complete root-suite run and a complete retained-stack journey. Hosted CI, merge
and push are NOT RUN. This repair commit is for review, not a landing-ready claim.

## Requalification after authority reads (#70)

4 October 2026. Rebased `1ef81d0` onto `origin/main` at `65364a0` (#111,
implementing #70). The resulting source is `7b6131e`, plus the three test-fixture
repairs and browser-journey restoration in the commit containing this receipt. Rebase completion was checked by
ancestry and the absence of rebase state. Conflicts preserve upload wiring,
scoped authority reads, the gateway listener probe and drained audit output;
secondary MCP uses 25112/25212 alongside ClamAV on 25111/25211.

Environment: Linux dev box, Node 22.23.3, clean `npm ci`, real disposable
NATS/PostgreSQL/OpenFGA, the pinned gateway, Chromium and local model/MCP fixtures.
PostgreSQL uses `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
No paid calls, host daemon startup or host networking changes. Early verification
caught an incorrect conflict resolution and missing newly merged dependencies;
these were corrected before the complete runs. Two interrupted initial test
attempts are not passing evidence.

The first complete root run exposed three concrete fixture mismatches: the new
volume test used the old MCP publication/envelope, gateway-start lacked responses
for configuration acknowledgement, and audit-drain lacked the new TCP listener.
Their failing tests preceded the repairs. The volume fixture now uses the existing
publish helper and digest-bound route; the gateway fixtures provide the missing
external dependencies. Production code, assertions, timeouts and opt-in skips
were not weakened. All three repaired tests passed together.

| Check | Result | Evidence |
| --- | --- | --- |
| First complete `npm test -- --maxWorkers=2` | FAIL: 1,379 passed, 16 failed, 14 skipped; one unhandled NATS timeout; 1,950.47 s | [Original result](p3-4-live/requalification/root-first.txt) |
| Three repaired fixtures, two-worker limit with files serial | PASS: three tests, 64.76 s; includes 100,000-event comparison | [Fixture results](p3-4-live/requalification/fixture-fixes.txt) |
| Remaining 13 failed cases, unchanged, files serial | PASS: 13 selected tests; 124 other tests filtered out; 217.73 s | [Focused retry](p3-4-live/requalification/failed-cases-retry.txt) |
| Complete root repeat, `--maxWorkers=2 --no-file-parallelism --reporter=verbose` | FAIL: 1,394 passed, one failed, 14 skipped; one unhandled NATS timeout; 2,409.64 s | [Serial result](p3-4-live/requalification/root-serial.txt) |
| Publication-journey isolated retry after serial run | FAIL: 40-second timeout and NATS rejection | [Failed retry](p3-4-live/requalification/publication-failed-retry.txt) |
| Publication-journey last unchanged retry | PASS: 19.35 s test, 28.09 s run | [Last retry](p3-4-live/requalification/publication-last-retry.txt) |
| `npm run lint`, `npm run typecheck`, `npm run check:events` after repairs | PASS: eight size warnings; 86 event types | `/tmp/p3-4-requal/{lint,types,events}-final.log` |
| Infra typecheck; claim-port regression | PASS | `/tmp/p3-4-requal/infra-types-clean.log`; [Claim test](p3-4-live/requalification/claim.txt) |
| Web production build | PASS: existing bundle/CSS/CommonJS warnings | `/tmp/p3-4-requal/web-build.log` |
| First web tests | FAIL: 59 passed; chat workspace exceeded five seconds | `/tmp/p3-4-requal/web-test.log` |
| Complete unchanged web retry | PASS: 60 tests in 11 files | [Web retry](p3-4-live/requalification/web-retry.txt) |

Both full root failures are retained. The serial run cleared every first-run
failure except the publication journey, whose background reconciler reported a
NATS timeout. A diagnostic run with temporary timing output passed in 14.85 s;
that output was removed before the final unchanged retry. Passing and failing
isolated runs do not establish a single cause. Shared-host load was approximately
20–35 during much of the first run. **No clean complete-root-run claim** is made.

The full serial run passed the repaired volume benchmark. With 100,000 unrelated
events, p95 was 339.85 ms for model decisions, 325.76 ms for MCP decisions and
86.17 ms for destination authority. Thirty samples per route retained constant
read counts across zero/100,000 events: model 15 events/8 reads, MCP 30/11,
destination 6/4. [Exact measurements](p3-4-live/requalification/authority-volume.jsonl)
retain the zero-event comparison too; destination-authority timing is not an
end-to-end egress measurement.

The first secondary pair claimed id 1. Fresh startup failed after 364 s waiting
for Viewing at `browser-live-view.ts:87`; the screenshot showed Access changed.
Plain startup failed after 285 s with Promoted preview unavailable at
`browser-upload.ts:35`. [Fresh failure](p3-4-live/requalification/fresh-first-failure.txt)
and [repeat failure](p3-4-live/requalification/repeat-first-failure.txt) retain the
errors. `down.sh --id 1` passed and removed the generated directory. Neither
attempt reached complete publication qualification.

The second fresh attempt claimed id 2 and reached publication at both 390px and
1280px, but failed after 707 s in audit qualification. Upload's browser journey
opens a new conversation; its caller retained that URL instead of the original
chat containing the audit canary. The existing [audit assertion failed](p3-4-live/requalification/fresh-second-failure.txt)
before the fix. `browserChatJourney` now returns to the original chat after
upload checks and waits for its original message. This preserves the later
live-view and audit journeys' input without weakening either assertion. Infra
TypeScript passed. The already-running repeat was deliberately stopped after
109 s because it had loaded the old journey; it is NOT RUN as complete repeat
evidence. `down.sh --id 2` passed. The next claim initially found both slots owned
by other worktrees; neither ownership marker was changed.

The final pair claimed id 1 after queuing. Fresh startup failed after **633 s**
and plain startup failed after **391 s**, both waiting 20 seconds for Viewing
at `browser-live-view.ts:53`. The restored original chat message was found before
the viewer checks, but the complete post-fix audit journey remains **NOT RUN**.
[Fresh error](p3-4-live/requalification/fresh-third-failure.txt),
[repeat error](p3-4-live/requalification/repeat-final-failure.txt),
[fresh screenshot](p3-4-live/requalification/fresh-final-viewer.png) and
[repeat screenshot](p3-4-live/requalification/repeat-final-viewer.png) retain this
failure. These are live-view qualification failures consistent with the open #77
symptom; the exact cause is not established here.

The earlier second fresh run completed the publication checks before its audit
failure. Its [390px approval](p3-4-live/requalification/publication-before-chat-fix/approved-390.png)
and [1280px approval](p3-4-live/requalification/publication-before-chat-fix/approved-1280.png)
screenshots sit beside requested/used/denied receipts for both viewports. They
qualify those publication steps only, before the chat-URL repair; they are not a
complete fresh-install PASS.

**Held:** the requested fresh/plain PASS pair was not achieved, and the latest
complete root run is FAIL despite the passing focused publication retry. No
assertion, freshness fence or timeout was relaxed to obtain a pass. Review pass
two remains the existing review checkpoint; no third pass was requested. Hosted
CI and merge are NOT RUN.

Final `down.sh --id 1`: **PASS**. The generated directory, Compose containers and
Kubernetes namespace were absent afterwards. Every claimed stack in this run was
released. The owner stack was not restarted or reconfigured. The branch is prepared
for review with the qualification hold above; it is not merged or capability-done.
