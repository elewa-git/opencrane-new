# Qualification ledger

The [local operator guide](p5-14-pr1/operator.md) and
[machine-checkable local index](p5-14-pr1/qualification.json) cover P5-1–P5-14,
including both scanner rows. The [source receipt](p5-14-pr1/receipt.md) records
this index's checks only. Full local operator execution, P5-13 and hosted acceptance
remain NOT RUN. Original receipts retain their historical failures and partial results.

Each row separates merged source from proof on a fresh installation. Source is
`No`, `Part` (open issue with a merged PR) or `Yes` (closed issue), followed by the
UTC merge date and commit of the newest merged PR naming that issue. Live results
are `PASS`, `FAIL`, `PARTIAL` or `NOT RUN`; a recorded run names its UTC date,
tested commit and committed receipt. Later merges do not reset earlier live proof.
`NOT RUN` means no committed fresh-install journey with sufficient attribution was
found for that capability; source checks and intercepted browser captures do not qualify it.

The first fill checked issue states and merged PRs on 17 November 2026. Numeric
search matches were checked for an explicit issue reference; unrelated timings and
PR numbers are not capability work. The [first-fill notes](work-clean-1041-s1/ledger-evidence.md)
explain limited coverage and identify the receipt lines behind each PASS.
Update the columns as described in [orchestration step 8](orchestration.md#one-change-start-to-finish).

Read the [old tables at commit 4ac3e85ea](https://github.com/elewa-git/opencrane-new/blob/4ac3e85ea/docs/process/ledger.md)
for historical checks. Their source, review and fixture verdicts are separate from
fresh-install proof. Phase 5 remains in the index linked above.

## Phase 1

| Capability | Issue | Source merged | Proven live on a fresh install | Receipt |
| --- | --- | --- | --- | --- |
| #10 Local dev stack | [#10](https://github.com/elewa-git/opencrane-new/issues/10) | Yes 2026-10-17 `6fc60fc94` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| #11 Zitadel sign-in | [#11](https://github.com/elewa-git/opencrane-new/issues/11) | Yes 2026-10-02 `ea1f71c73` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |

## Phase 2

| Capability | Issue | Source merged | Proven live on a fresh install | Receipt |
| --- | --- | --- | --- | --- |
| P2-1 Computer image | [#26](https://github.com/elewa-git/opencrane-new/issues/26) | Yes 2026-10-02 `04084949f` | NOT RUN | — |
| P2-2 Assistant and computer lifecycle | [#27](https://github.com/elewa-git/opencrane-new/issues/27) | Yes 2026-10-02 `f5c4eef4a` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| P2-3 Bridge and conversation core | [#28](https://github.com/elewa-git/opencrane-new/issues/28) | Yes 2026-10-02 `113854436` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| P2-4 Model gateway and spending cap | [#29](https://github.com/elewa-git/opencrane-new/issues/29) | Yes 2026-10-02 `3e5c899b5` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| P2-5 Chat workspace | [#30](https://github.com/elewa-git/opencrane-new/issues/30) | Yes 2026-10-03 `ed21e0b42` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| P2-6 File upload | [#31](https://github.com/elewa-git/opencrane-new/issues/31) | Yes 2026-10-04 `7b8b1d370` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| P2-7 Daily fresh-install journey | [#32](https://github.com/elewa-git/opencrane-new/issues/32) | Part 2026-10-23 `e7179378f` | NOT RUN | — |

## Phase 3

| Capability | Issue | Source merged | Proven live on a fresh install | Receipt |
| --- | --- | --- | --- | --- |
| P3-1 Per-tool Allow, Ask and Block | [#42](https://github.com/elewa-git/opencrane-new/issues/42) | Yes 2026-10-03 `17c61d35e` | PASS 2026-10-03 `b63234c` | [Receipt](p3-1-live/README.md) |
| P3-2 Bound one-time approvals | [#43](https://github.com/elewa-git/opencrane-new/issues/43) | Yes 2026-10-04 `3972492d9` | PASS 2026-10-25 `f801d5b6b` | [Receipt](demo-stage-b-local-live/receipt.md#fresh-run-with-complete-approval-proof-25-october-2026) |
| P3-3 Remote MCP registration and discovery | [#44](https://github.com/elewa-git/opencrane-new/issues/44) | Yes 2026-10-04 `39fe9dae5` | PARTIAL 2026-10-04 `d172909` | [Receipt](p3-3-mcp-discover.md#secondary-live-qualification-4-october-2026) |
| P3-4 Publish tool routes and grants | [#45](https://github.com/elewa-git/opencrane-new/issues/45) | Part 2026-11-17 `b7288b23c` | PARTIAL 2026-10-25 `f801d5b6b` | [Receipt](demo-stage-b-local-live/receipt.md#fresh-run-with-complete-approval-proof-25-october-2026) |
| P3-5 Governed tools in chat | [#46](https://github.com/elewa-git/opencrane-new/issues/46) | Part 2026-11-08 `36fa0e6c1` | PARTIAL 2026-10-25 `f801d5b6b` | [Receipt](demo-stage-b-local-live/receipt.md#fresh-run-with-complete-approval-proof-25-october-2026) |
| P3-6 Hosted MCP images | [#47](https://github.com/elewa-git/opencrane-new/issues/47) | Part 2026-11-11 `85ead939e` | NOT RUN | — |
| P3-7 Changed-tool review | [#48](https://github.com/elewa-git/opencrane-new/issues/48) | Part 2026-11-17 `b7288b23c` | NOT RUN | — |
| P3-8 Personal bearer connections | [#49](https://github.com/elewa-git/opencrane-new/issues/49) | Yes 2026-11-17 `df068a68c` | PARTIAL 2026-11-16 `7fb923bf7` | [Receipt](work-main-personal-tool-reads/journey.md#personal-key-consent-journey) |
| P3-9 OAuth connections | [#50](https://github.com/elewa-git/opencrane-new/issues/50) | Part 2026-10-30 `371087d3c` | NOT RUN | — |
| P3-10 Isolated personal MCP instances | [#51](https://github.com/elewa-git/opencrane-new/issues/51) | Part 2026-10-15 `3dab5f455` | NOT RUN | — |
| P3-11 Odoo Community fixture | [#52](https://github.com/elewa-git/opencrane-new/issues/52) | Yes 2026-10-03 `5ca26b64a` | NOT RUN | — |
| P3-12 Governed Odoo reads and writes | [#53](https://github.com/elewa-git/opencrane-new/issues/53) | Part 2026-10-20 `8b7dd8acd` | NOT RUN | — |
| P3-13 Monthly group and assistant budgets | [#54](https://github.com/elewa-git/opencrane-new/issues/54) | Yes 2026-10-03 `f5e30686c` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| P3-14 Stop on budget exhaustion | [#55](https://github.com/elewa-git/opencrane-new/issues/55) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P3-15 Uncertain effects and settlement | [#56](https://github.com/elewa-git/opencrane-new/issues/56) | Part 2026-10-12 `3efc8ecbd` | NOT RUN | — |
| P3-16 Authenticated computer viewer | [#57](https://github.com/elewa-git/opencrane-new/issues/57) | Yes 2026-10-04 `bbf0babec` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| P3-17 Take control after pausing agents | [#58](https://github.com/elewa-git/opencrane-new/issues/58) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P3-18 Authorised screenshots | [#59](https://github.com/elewa-git/opencrane-new/issues/59) | Yes 2026-10-06 `b4837d6d1` | PARTIAL 2026-10-04 `bd938b53f` | [Receipt](p3-18-live/qualification.json) |
| P3-19 Permission-scoped audit history | [#60](https://github.com/elewa-git/opencrane-new/issues/60) | Yes 2026-10-03 `b8aee579e` | PASS 2026-11-17 `641f4ef3c` | [Receipt](work-clean-255-s1/journey.md) |
| P3-20 Package and Git egress | [#61](https://github.com/elewa-git/opencrane-new/issues/61) | Part 2026-11-07 `4c0a4de14` | NOT RUN | — |
| P3-21 Browser egress isolation | [#62](https://github.com/elewa-git/opencrane-new/issues/62) | No | NOT RUN | — |
| P3-22 Complete governed-work qualification | [#63](https://github.com/elewa-git/opencrane-new/issues/63) | Part 2026-10-25 `105071aaa` | NOT RUN | — |

## Phase 4

| Capability | Issue | Source merged | Proven live on a fresh install | Receipt |
| --- | --- | --- | --- | --- |
| P4-1 Groups and membership | [#83](https://github.com/elewa-git/opencrane-new/issues/83) | Yes 2026-10-23 `d923f332d` | PASS 2026-10-23 `610f345ab` | [Receipt](p4-journey/runs-2026-10-23/fresh-2/receipt.json) |
| P4-2 Ownership transfer | [#84](https://github.com/elewa-git/opencrane-new/issues/84) | Yes 2026-10-23 `d923f332d` | PASS 2026-10-23 `610f345ab` | [Receipt](p4-journey/runs-2026-10-23/fresh-2/receipt.json) |
| P4-3 Member invitations and roles | [#85](https://github.com/elewa-git/opencrane-new/issues/85) | Part 2026-10-18 `c223c73da` | NOT RUN | — |
| P4-4 Direct person-to-person chats | [#86](https://github.com/elewa-git/opencrane-new/issues/86) | Yes 2026-10-07 `bbb42e287` | PASS 2026-10-23 `610f345ab` | [Receipt](p4-journey/runs-2026-10-23/fresh-2/receipt.json) |
| P4-5 Human group chats | [#87](https://github.com/elewa-git/opencrane-new/issues/87) | Yes 2026-10-11 `8fbf9e344` | PASS 2026-10-23 `610f345ab` | [Receipt](p4-journey/runs-2026-10-23/fresh-2/receipt.json) |
| P4-6 Conversation lifecycle | [#88](https://github.com/elewa-git/opencrane-new/issues/88) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P4-7 Shared group assistants | [#89](https://github.com/elewa-git/opencrane-new/issues/89) | Part 2026-10-06 `4ed6b7a1d` | PARTIAL 2026-10-23 `610f345ab` | [Receipt](p4-journey/runs-2026-10-23/fresh-2/receipt.json) |
| P4-8 Recoverable child chats | [#90](https://github.com/elewa-git/opencrane-new/issues/90) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P4-9 Child progress and serial turns | [#91](https://github.com/elewa-git/opencrane-new/issues/91) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P4-10 Publish child results | [#92](https://github.com/elewa-git/opencrane-new/issues/92) | Part 2026-10-17 `8f10ade77` | NOT RUN | — |
| P4-11 Delegation allowances and stopping | [#93](https://github.com/elewa-git/opencrane-new/issues/93) | Part 2026-10-23 `71cce9a27` | NOT RUN | — |
| P4-12 Scoped memory recall | [#94](https://github.com/elewa-git/opencrane-new/issues/94) | Part 2026-10-25 `f34ccba16` | PARTIAL 2026-10-25 `9ddb2b47e` | [Receipt](memory-fresh-personal/receipt.md) |
| P4-13 Correct and forget memory | [#95](https://github.com/elewa-git/opencrane-new/issues/95) | Part 2026-11-17 `b7288b23c` | PARTIAL 2026-10-25 `9ddb2b47e` | [Receipt](memory-fresh-personal/receipt.md) |
| P4-14 Private member execution | [#96](https://github.com/elewa-git/opencrane-new/issues/96) | Yes 2026-10-20 `d22d189c0` | NOT RUN | — |
| P4-15 Isolated preferences and pinned facts | [#97](https://github.com/elewa-git/opencrane-new/issues/97) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P4-16 Manage knowledge and preferences | [#98](https://github.com/elewa-git/opencrane-new/issues/98) | No | NOT RUN | — |
| P4-17 Nightly memory dreams | [#99](https://github.com/elewa-git/opencrane-new/issues/99) | Part 2026-11-11 `acc4f934f` | NOT RUN | — |
| P4-18 Account and personal settings | [#100](https://github.com/elewa-git/opencrane-new/issues/100) | No | NOT RUN | — |
| P4-19 Onboarding persona | [#101](https://github.com/elewa-git/opencrane-new/issues/101) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P4-20 Welcome chat | [#102](https://github.com/elewa-git/opencrane-new/issues/102) | Part 2026-11-10 `b3b307b63` | NOT RUN | — |
| P4-21 Provider connection and verification | [#103](https://github.com/elewa-git/opencrane-new/issues/103) | Yes 2026-10-07 `71c70b873` | PARTIAL 2026-10-23 `610f345ab` | [Receipt](p4-journey/runs-2026-10-23/fresh-2/receipt.json) |
| P4-22 Model access and provider retirement | [#104](https://github.com/elewa-git/opencrane-new/issues/104) | Part 2026-11-08 `63ede1647` | PARTIAL 2026-10-18 `12e2b1794` | [Receipt](p4-22-managed-dev-stack/receipt.md) |
| P4-23 Group tools and company connections | [#105](https://github.com/elewa-git/opencrane-new/issues/105) | Part 2026-10-20 `f9dfbc7d5` | NOT RUN | — |
| P4-24 Routines | [#106](https://github.com/elewa-git/opencrane-new/issues/106) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P4-25 Routine recovery and approvals | [#107](https://github.com/elewa-git/opencrane-new/issues/107) | Part 2026-11-07 `f61fd9505` | NOT RUN | — |
| P4-26 Spending and group ceilings | [#108](https://github.com/elewa-git/opencrane-new/issues/108) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P4-27 Admin overview and change history | [#109](https://github.com/elewa-git/opencrane-new/issues/109) | Part 2026-11-17 `df068a68c` | NOT RUN | — |
| P4-28 Complete company qualification | [#110](https://github.com/elewa-git/opencrane-new/issues/110) | No | NOT RUN | — |

## Measurements

### Pilot VM sizing

On 24 November 2026, the one-person packaged journey passed sign-in, chat, PDF upload,
decoded desktop viewing, history refusal and spending at 1280 and 390 pixels on
approved rebased product source `9cb7e672c`. Whole-node peaks were **2.739 CPU cores and
5.46 GiB including swap**; the package peaked at **2.274 CPU cores and 2.96 GiB
working set**. The 94 samples covered the journey. Installation was not sampled.

These observations do not qualify a minimum machine or spare-capacity recommendation.
The owner dropped concurrent three-person sizing from this ticket. The
[final receipt](work-pilot-1162-s1/journey.md#24-november-rebased-packaged-journey)
links the browser results, measurements and sanitised screenshots. Earlier attempts,
including failed attempts, remain historical evidence in that receipt; superseded
measurements are not current sizing guidance.

Host protection remains PARTIAL under the recorded accepted development-box switch.
Bootstrap ran on this box only as a dry run and refused existing Docker before writes.
Real Ubuntu bootstrap and reboot remain NOT RUN. No host setting changed.

### Lint size debt

On 13 November 2026, the [size-debt receipt](clean-120-s1.md#final-full-lint)
recorded 39 function and 298 parameter suppressions, seven rejected probes,
21 checker tests and 52 CI script tests, and uncached full lint. Source checks passed.
Its [fresh secondary attempt](clean-120-s1.md#fresh-secondary-stack) reached bootstrap,
provider setup and website readiness, but the fleet-task guard refused CORE entry;
the claim was released. That attempt did not qualify a capability.

### Approval listing reads

Measured on 17 November 2026 with real disposable NATS, PostgreSQL and OpenFGA.
The [read-count tests](../../apps/server/test/approval-listing-reads.test.ts) use the
HTTP listing route and observe `subscribe`, `readStream`, `readEvent` and `head`.
[Recorded counters](work-clean-255-s1/measurements.json) retain the observed values.
Times are observations on the shared host, without timing assertions or a changed deadline.

| Situation | Result | Observed reads and time |
| --- | --- | --- |
| 100,000 unrelated events; audit projection current; one card; three idle listings | PASS | Zero subscription events and zero unrelated events through named streams; three indexed `readEvent` calls in total. Access and card-state validation still made 21 named-stream reads returning 16 events, and 15 `head` calls. |
| Audit projection stopped; 10,000 unrelated later events, a new request and decision, and a cancellation | PASS | One subscription returned all 10,003 later events, none at or before the saved position; one indexed `readEvent`; eight named-stream reads returned eight events; five `head` calls; 4,402.34 ms for the listing. Both cards had the expected current state, also after rebuilding the audit projection. |
| 50 approvals; audit projection current; one listing | PASS | 50 indexed `readEvent` calls; 56 named-stream reads returned 103 events; five `head` calls; no subscription; 266 NATS `connection.request` calls; 504.68 ms. |

A separate complete listing-file repeat returned the same counts: 2,957.98 ms for
the stopped projection and 385.33 ms for 50 approvals. Skipping the unprojected
range by hand made the new-approval assertion fail; the original code was restored.

The 50-card fixture has 49 rejected approvals and one cancelled approval. The NATS
request count includes the listing's access checks and saved card histories. It
excludes OpenFGA HTTP requests, SQL queries, fixture setup and projection replay.
The HTTP listing itself is one request. Counts describe discovery separately from
the small authority streams and per-approval history needed for current checks;
they do not claim that all event-store reads disappear.

The missing-rows regression failed before the fix: the removed fallback read all
100,033 saved events through `subscribe`. A prior fixture setup using individual
team-creation events timed out during projection replay, before any listing
assertion. The fixture now uses unrelated streamed chat events so the existing
projection runner batches replay; the test timeout was not increased.
Fresh-stack qualification is recorded in the [journey receipt](work-clean-255-s1/journey.md).

## Packaged connected provider

| Capability | Issue | Source merged | Proven live on a fresh install | Receipt |
| --- | --- | --- | --- | --- |
| Packaged connected-provider chat | [#1110](https://github.com/elewa-git/opencrane-new/issues/1110) | No | PASS (24 November 2026, `f7acfefaa`, restricted free stand-in) | [Receipt](work-pilot-1110-s1/journey.md#fresh-packaged-run-on-24-november-2026) |

## Choosing the chat provider

| Capability | Issue | Source merged | Proven live on a fresh install | Receipt |
| --- | --- | --- | --- | --- |
| First chat default on a later connection | [#1190](https://github.com/elewa-git/opencrane-new/issues/1190) | This PR, `8bd4f6907` | PASS 2026-11-26 `8bd4f6907` (dev stack and free stand-in) | [Receipt](work-bug-1190-s1/journey.md) |
## Packaged scanner refresh

| Capability | Issue | Source merged | Proven live on a fresh install | Receipt |
| --- | --- | --- | --- | --- |
| Refresh the scanner in a running package | [#1198](https://github.com/elewa-git/opencrane-new/issues/1198) | No | FAIL (26 November 2026, `ac8f8861a`) | [Receipt](work-scan-1198-s1/journey.md#fresh-packaged-run-on-26-november-2026) |

## Still NOT RUN

The evidence does not qualify these conditions yet:

- Managed-cluster, HA, failover and disaster-recovery qualification.
- Real-phone and physical-device journeys, real screen-reader qualification and Safari browser coverage.
- Firefox and WebKit browser qualification.
- Real-provider wake latency and fresh full-install qualification for the wake repair.
- Real OpenAI/paid-provider coverage outside the explicitly recorded one-turn receipts; the opt-in paid suite remains skipped.
- Fresh-install live authority-reads qualification for [issue #70](https://github.com/elewa-git/opencrane-new/issues/70).
- Live-provider approval step-up and native Codex MCP continuation; the credential-free approval browser journey passed separately from its skipped root-suite invocation.
- Rendered Office previews. Upload's latest complete fresh handback journey was FAIL, rather than NOT RUN.
- MCP live-view reliability across complete startup journeys; the isolated MCP assertions passed but complete runs failed.
- Fresh screenshot capture and persistence across startup; retained capture and reload passed, but the fresh viewer failed under #77.

## Long-conversation tool decisions

17 November 2026, issue #1148. Real NATS, PostgreSQL, OpenFGA and gateway; approval
required. See [the measurement receipt](work-bug-1148-s1/measurement.md) for the
failure, read path and manual strength check. Before numbers include the background
summary after the gateway has already timed out; its existing ten-second deadline
stops the 5,000-message read early.

| Earlier messages | Before: conversation / total events | Before: decision / conversation read ms | Before HTTP | After: conversation / total events | After: decision / conversation read ms | After HTTP |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 103 / 126 | 1,149.59 / 619.30 | 403 | 3 / 26 | 353.60 / 10.59 | 403 |
| 1,500 | 1,503 / 1,506 | 2,023.50 / 5,846.08 | 503 | 3 / 26 | 246.20 / 6.94 | 403 |
| 5,000 | 2,152 / 2,155 | 2,012.00 / 10,000.18 | 503 | 3 / 26 | 335.28 / 8.02 | 403 |

Fresh secondary CORE: PASS at source head
`76a45566cf8f876283f49548ce6a207ac4b407d5`, including the post-status browser run
at 1280 and 390 px. The [journey receipt](work-bug-1148-s1/journey.md) includes
captures, source gates, earlier incomplete or failed attempts and explicit skipped
live coverage. The final shutdown exited 0 and the slot reported free.
