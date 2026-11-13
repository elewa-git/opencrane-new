# Ordinary third-party tool server journey

Date: 13 November 2026.
Source: `207644124155fadf0e67d0373fe427fccfdbba48`; later changes update documents only.
Environment: secondary development slot 2, started with `up.sh --fresh`.

## Result

Journey on a fresh dev stack: NOT RUN

`requireAutomatedJourney` in [the journey guard](../../../infra/dev-stack/journey-guard.ts)
refused the inherited `OPENCRANE_FLEET_TASK` marker:

> Automated journeys require a secondary stack and no fleet task

The marker was preserved. No browser journey ran and no screenshots were captured.
Website readiness was an HTTP check; it does not prove a person's journey.

## Stack attempt

Both slots were initially busy. Retrying the claim obtained slot 2.
The Zitadel setup credential was supplied by path only. No credential or raw private
stack log is included here.

| Operation | Observed outcome | Verdict |
| --- | --- | --- |
| `infra/dev-stack/claim.sh` | Claimed secondary slot 2. | PASS |
| `infra/dev-stack/up.sh --fresh` | Bootstrap, managed provider setup and website readiness completed; the automatic journey guard then refused. Exit 1. | FAIL |
| `infra/dev-stack/status.sh` | Command exited 0 before teardown. | PASS |
| Explicit `requireAutomatedJourney` check | Refused the fleet marker again. Exit 1. | NOT RUN |
| `infra/dev-stack/down.sh` | Exit 0; the slot directory and process records were removed. | PASS |

## Browser steps

| Person's action | 1280 px | 390 px |
| --- | --- | --- |
| Admin installs a standard HTTPS server without OpenCrane declarations. | NOT RUN | NOT RUN |
| Admin reviews each tool and saves Allow, Ask or Block. | NOT RUN | NOT RUN |
| Admin publishes the review and grants member and assistant access. | NOT RUN | NOT RUN |
| Member asks their assistant to call a reviewed tool in a live turn. | NOT RUN | NOT RUN |
| Server changes its list; the next call is refused with a visible review reason. | NOT RUN | NOT RUN |

## Source checks

These checks do not substitute for the browser journey.

| Check | Observed outcome |
| --- | --- |
| Complete dispatch and gateway-access regression batch | PASS: 253 tests, one worker, 1179.72 seconds. |
| Repeated changed/schema/dependency batch | PASS: 547 tests; the earlier corresponding batch passed 546 without the separate dependency case. |
| Changed ordinary, privacy and certificate cases | PASS: 13 focused cases before the complete regression batch. |
| Gateway-access file after restoring sanitised diagnostics | PASS: 23 cases before the complete regression batch. |
| Event registry and examples | PASS: 355 tests. |
| Snapshot, inventory and event-field security checks | PASS; the initially skipped database condition was subsequently exercised in the PostgreSQL replay run. |
| PostgreSQL catalogue replay | PASS: all 11 cases with the supplied disposable test database. |
| Web tests and repeated changed spec | PASS: 1,556 full web tests and all 8 initial-review tests on repeat. |
| Production web build | PASS, with existing stylesheet and CommonJS warnings. |
| Typecheck | PASS: root workspaces and infrastructure; subsequent changed models/server checks also passed. |
| Event catalogue | PASS: 174 event types agree. |
| Knip, changed-file ESLint, Markdown and changelog | PASS; changed-file ESLint has no warnings. |
| Fixture boundary, package licences and offline links | PASS. |

The wire checks use a real recording HTTPS server, NATS, PostgreSQL and the gateway.
They check standard calls, Ask approval, catalogue drift before execution, complete
paginated lists, exact outgoing metadata and preserved argument number text.
Cost records distinguish reported integer cents from missing or invalid reports.
The default demo catalogue digest and declared-server safeguards remain checked.

An earlier regression run caught raw dependency error text added during cleanup.
The original sanitised diagnostic contract was restored; private canary assertions
remain unchanged. Certificate refusal cases now hold local validation clocks steady
while network timers remain real. Separate cases still check permit and access expiry.
No product timeout or lint limit was raised.

Manual guard mutations failed the matching tests: catalogue comparison, metadata
stripping, declared-server unknown cost, cost-record consistency and certificate
verification. Both certificate tests returned 200 instead of the required refusal
when verification was removed. All five mutations were restored.

Independent review and hosted CI are NOT RUN by this builder. A browser PASS at both
widths remains required before merge.
