# Reviewed MCP publication and the rest of a governed turn

<!-- Keep the accepted design text unchanged. -->
<!-- markdownlint-disable MD018 MD033 MD034 -->

Design for [#45](https://github.com/elewa-git/opencrane-new/issues/45) and [#46](https://github.com/elewa-git/opencrane-new/issues/46), 10 October 2026.
Read-only checkout: `<worktree>`, `work/p3-4-rest-design`.
HEAD, origin/main and GitHub main agreed at `d53e8e35aa949a9044685259eeda38540628d0c6`.
This is a proposal. Runtime checks, independent review and live journeys: NOT RUN.
Only this note is retained; no product changes, stacks, tests, model calls or spending.

## 0. Audit of main

Criteria follow issue order. DONE means cited source/evidence, not a new live PASS.

| Criterion | Status and proof on main | Missing work only |
| --- | --- | --- |
| #45.1: one reviewed route/CEL/authz/header generation; digest acknowledgement | MISSING. `apps/server/src/models-main.ts:80` loads MODEL_MCP_ROUTES; `libs/models/src/gateway.ts:244` writes startup config. `libs/events/src/data.ts:465` publication has only serverId/publishedBy; `libs/projections/src/tool-policy.ts:23` flips a boolean. | Review command, complete generation, live acknowledgement and Applying. |
| #45.2: deny unreviewed/unpublished/stale/quarantined; reconcile change | PARTIAL. #68: `libs/models/src/mcp.ts:46` checks published/connection, reviewed tools and zero cost. `libs/projections/src/tool-policy.ts` clears publication on rejection/drift. No generation comparison or publication command/status exists in `apps/server/src/integrations/routes.ts`. | Require reviewed, fresh, acknowledged generation at admission and final send; original-change recovery. |
| #45.3: exact methods and complete refusal matrix | PARTIAL. #68/#72/#258: `libs/models/src/mcp.ts`, `lossless-json.ts`, `decision.ts`; `libs/models/test/gateway.test.ts:872` proves modes, case/resource/header refusal. #270 proxy permits only the three methods, serves discovery/list locally, bounds bytes. External published decision path accepts only tools/call; generation CEL and route-wide session/header coverage are absent. | Generate coarse method rules, keep install-only discovery identity, close session/header gaps and qualify every refusal through generated routes. |
| #45.4: no token/client header/credential leakage; guarded real calls | PARTIAL. #68/#258/#270: `gateway.ts:15` replaces headers; gateway tests assert bearer/turn absence and stripped refusal marker. #78 `apps/server/src/integrations/remote.ts:20` pins DNS/TLS, but accepts only discovery/list. Published calls use plain backend hosts. No personal credential release exists. | Guard the tools/call socket, recording upstream proof on generated routes, safe logs/config; #49 supplies later credential leases. |
| #45.5: people/team/assistant grants; intersection; two-second revoke | PARTIAL. #68 `libs/authz/src/members.ts` applyGrant/granteeUser and `model/v1.fga` resource#use already handle person, assistant and team#member. `authority.ts:26` checks both grants and IAM receipts; gateway test at :930 refuses revocation before IAM catches up within 2 s. `libs/projections/src/model-access.ts:60` excludes MCP; product grant commands exist only for models. | MCP admin commands, content reads/receipts, real generated-route team/revocation proof; no group UX. |
| #45.6: four facts/review/removal on desktop/390; preserve account | PARTIAL. #204/#222 implement register/detail/remote add/modes in `apps/web/src/app/integrations/` and `tool-policy/`. `integration-facts-map.ts` explicitly returns Not available yet for Connected and Allowed for. Publishing, review marking, audience editing, dependencies and removal are absent. | Truthful evidence reads, review/publish/grant/removal screens and missing handoff frames below. |
| #46.1: pinned Codex/stateless/version regression | PARTIAL. #270: `apps/computer/Dockerfile`, `codex-config.ts`, `thread-loads.ts`, `test/codex-mcp-wire.mjs` pin 0.159.2, enable mcp_2026_07_28 and assert no initialise/session/GET. Backend spec §2.2 and ADR 0003 October updates prove protocol_version is rejected by strict config. | Pin protocol through image/flag and strict ingress; amend literal unsupported-key criterion. Fresh-stack qualification remains. |
| #46.2: private proxy/thread/signed context/unchanged bytes/isolation | DONE in source. #258/#270: `mcp-proxy.ts` liveCallGrant/forward and `decision.ts` requireMcpThread; `test/codex-mcp-wire.mjs` and gateway tests prove separate load URLs, thread matching, bytes and UID 1001 refusal. | Reuse, qualify on the fresh stack; no replacement proxy. |
| #46.3: same application turn waits; fresh grants; terminal decisions | PARTIAL. #283/#287: `approval-holds.ts`, `turn-runner.ts` renewGrant, `chat/bridge-approvals.ts`; 15-minute hold, repeated start report renewal, deduplicated wake, Stop before interrupt. Existing wire receipt measured 310394 ms through production proxy; separate 960001 ms hold did not use it. | Full-duration production-proxy proof, dated approval outcomes/causes, end-to-end journey. |
| #46.4: reconnect/wake/result without duplicate effect; other threads run | PARTIAL. #283/#287 source and saved offline held-approval capture prove capabilities, reconnect signals, one send, other-thread progress and 42 ms Stop. Holds are not restored after bridge/Pod loss. | Fresh-stack reconnect/Pod loss and uncertain-effect proof; explicit safe retry continuation after #311. |
| #46.5: remove blanket never; explicit native requests | PARTIAL. #311 `apps/computer/src/bridge.ts:45` refuses MCP elicitation and `item-reports.ts` records agent.native_consent_refused. `turn-runner.ts:392` still sets never; privateConfig also sets never. Other memory-free server requests lack a complete reply policy. | Saved on-request capture first; recognise only supported tool-call consent, answer other requests once and remove memory-free override. |
| #46.6: truthful WRK/mobile continuation; lost Pod checks status | PARTIAL. #221/#225/#297/#308 provide drawers, Activity jump, running/finished lines, restored pending cards and participant review. #311 supplies dispatch/native/missing-field/retry facts in `docs/api/approvals.md`, `libs/protocol/src/chat.ts` and `libs/projections/src/conversations.ts`. Web Decision type still excludes retry; tool details still lack attempts; approval cards lack decided/used/cancel times. | Bind new facts, add original-request status read and same-turn retry; never resubmit an uncertain call. Odoo readback remains #53. |

Read specified GitHub issues/comments/Design sections and PRs; #44 is closed by [#78](https://github.com/elewa-git/opencrane-new/pull/78).
Core policy/IAM/approval proof: [#68](https://github.com/elewa-git/opencrane-new/pull/68), [#72](https://github.com/elewa-git/opencrane-new/pull/72).
#45 screens: [#204](https://github.com/elewa-git/opencrane-new/pull/204), [#222](https://github.com/elewa-git/opencrane-new/pull/222).
#46 screens: [#221](https://github.com/elewa-git/opencrane-new/pull/221), [#225](https://github.com/elewa-git/opencrane-new/pull/225), [#297](https://github.com/elewa-git/opencrane-new/pull/297), [#308](https://github.com/elewa-git/opencrane-new/pull/308).
#46 backend: [#250](https://github.com/elewa-git/opencrane-new/pull/250), [#258](https://github.com/elewa-git/opencrane-new/pull/258), [#265](https://github.com/elewa-git/opencrane-new/pull/265), [#270](https://github.com/elewa-git/opencrane-new/pull/270), [#283](https://github.com/elewa-git/opencrane-new/pull/283), [#287](https://github.com/elewa-git/opencrane-new/pull/287), [#311](https://github.com/elewa-git/opencrane-new/pull/311).
The backend spec `<home>/.fleet/prompts/p3-5-backend-spec.md` has PRs 1–5 merged;
#311 covers parts of 7–8. Merge is not live proof; replace its seeded journey with product APIs.
Keep accepted `<home>/.fleet/reviews/p3-6-design.md` and open [#329](https://github.com/elewa-git/opencrane-new/pull/329)
compatible: stable policyRevision, dated catalogues, immutable snapshots, final dispatch and drift restore.
#329 is not on main; reuse its catalogue fold without weakening refusals.
Read AGENTS.md, plan.md, standards, tickets P3-4/P3-5, decisions D02/D04/D09–D11,
ADRs 0002/0003 and handoff PLAN P3-4/P3-5/Contract gaps; owner constraints govern this note.

## 1. Publication, transport and grants

An Owner/Admin reviews the exact saved catalogue, definitions, safe review fields,
zero-cost declarations, endpoint, connection/account mode and proposed tool modes.
Hints never mark review. Escape text; fetch no icons. Descriptions, review text and results are data.
Hash every definition field. Allow/Ask needs exact review and costCents: 0; Ask also needs review data.
Legacy incomplete snapshots stay readable but unavailable. Reuse #329 hash validation.

POST review conditionally appends `mcp.server_reviewed` to `mcp-<server>` with catalogueDigest,
connectionId, accountMode, tool choices/review digests, reviewedBy and stable policyRevision.
Review never grants/publishes; published mode edits restrict immediately, widening waits for ack.
Publish names that exact review, expectedSequence, commandId and desired route fragment digest.
Extend `mcp.server_published` as publication intent; a legacy boolean alone cannot authorise calls.

Save separate audience commands/receipts before publishing; publish never appends to grant streams.
The overall change lists child references and partial outcomes, without a cross-stream transaction.
Grants saved on a draft permit nothing before publication; publishing cannot approve a pending call.

One active dev-stack configuration worker serialises publication intents using the existing
leader/ordered-handler pattern. For each distinct intent, create one complete gateway generation,
without combining two admin changes. Compose existing model/memory routes and all current reviewed
MCP entries from explicit ids; do not scan wildcard event subjects. Record source event positions.
Append proposed `gateway.configuration_requested` on `gateway-config-<silo>` once per original
changeRef, with generation, rendererVersion, complete safe payload, source references and digest.
Each command appends once to one stream. Conflicts reread inputs; stale preparation cannot become Ready.

Render routes, CEL method/name rules, ext_authz, outbound headers and server/connection/review/
transport generation together from one immutable record; never patch pieces separately.
Hash the stable payload plus rendererVersion with SHA-256; derive the witness outside that payload.
Keep secrets/private review bodies/caller URLs out of config. Replace MODEL_MCP_ROUTES authority;
retain operator listeners and separate internal memory routes. Journeys use product publication.

Deliver on the dev box by writing a 0600 sibling file and atomically renaming the whole config.
Use agentgateway's file reload, not process restart: S0.2 README.robot.md:125 records real reload
and rejection keeping the old config. Re-qualify atomic rename on pinned v1.5.0 before enabling it.
Add a generation-specific directResponse acknowledgement route on a loopback-only control listener.
The current pinned [schema](https://github.com/agentgateway/agentgateway/blob/v1.5.0/schema/config.json)
defines directResponse; source inspection is not runtime acknowledgement proof.
Probe that route for exact generation/digest and active process identity, then append
`gateway.configuration_observed` and per-operation `mcp.configuration_observed` receipts.
Readiness, writing the file and a generic “loaded config” log cannot acknowledge a digest.
Rejected/late/missing acknowledgement leaves Applying/Unknown and calls refused. After restart,
probe the current process again; replay cannot establish live readiness. Helm delivery is Phase 5.

Inject generation/digest into ext_authz as generated constants, overwriting client values.
Refuse mismatched live generation/server mapping/publication/review/connection; also missing review,
unpublished/removing, rejected, quarantined, failed/expired catalogues and inactive entities.
When another server advances the global generation, its snapshot carries unchanged reviewed
entries too; matching current snapshot membership acknowledges those entries without re-review.
An old route's constant still refuses. Late acknowledgements cannot restore withdrawn intent.
Only changed reviewed policy cancels approvals; unchanged checks keep policyRevision stable.

Actual outbound path: computer proxy → agentgateway → guarded server transport → remote HTTPS.
Extend `integrations/remote.ts` narrowly to send validated tools/call bytes without rebuilding JSON.
Select destination only from the reviewed server/connection record. The transport listener is
reachable only by the gateway; the install identity retains discover/list only, never tools/call.
Bind a short-lived ext_authz dispatch permit to request/body digest, requester/assistant/turn,
reviewed revision, connection and acknowledged config generation.
Consume once through proposed `tool.dispatch_started` on that decision stream before any send.
Recheck current authority, publication and revision immediately before opening the pinned socket.
Resolve/validate DNS before the short access window; never occupy it with a 30-second lookup.
Refuse every non-public IPv4/IPv6 answer, mixed DNS, rebinding, redirect or TLS failure.
Pin address/TLS hostname per connection; forbid direct-backend bypass and pooling across checks.
#48 extends this same permit with fresh catalogue/instance identity and atomic expected-revision
checks. Mutable remote endpoints without that precondition remain unavailable under the accepted
strict drift guarantee; a watch alone cannot close the list→call race. #47 uses admitted hosted
identity in <silo>-mcp, never a public-address exception for arbitrary caller URLs.

CEL is coarse defence; typed TypeScript validates complete bodies. Accept exact server/discover,
tools/list and tools/call only, with separate discovery and live-call identities. Codex discovery
stays local to its reviewed list. Refuse batches, notifications without ids, duplicate decoded
keys at every depth, forbidden keys, case variants, resources/unknown methods, missing metadata
version/capabilities, legacy initialise/handshake, GET/DELETE/session, repeated protocol/name
headers and body/header mismatches. Pass session presence to the decision service so stripping
cannot hide a prohibited session. Enforce 1 MiB request without truncation, strict UTF-8, bounded
response and D10's 30-second outbound deadline; the computer's 1 MiB reply bound remains stricter
than discovery's 4 MiB. Failed body reads grant nothing. Keep lossless argument number text.

Rebuild the whole outbound header set per route. Allow protocol/method/name, JSON content/accept,
server-issued request id and reviewed non-sensitive declared headers only. Forbid cookies,
computer/turn bearer, session-id, arbitrary client/forwarding headers and internal permit headers
at the recorded remote upstream. Derive Host/TLS from the saved target. A declared header cannot
smuggle a credential or choose authority. Credential-free routes erase client credentials.
#49 later inserts only its request-bound ≤30-second lease after live checks; no gateway file key,
assistant-owner fallback or silent company account. Company use needs explicit admin opt-in and
selection, with named attribution. Keep profile/generation references compatible, no secret values.
Record synthetic token/header canary absence at the actual upstream for every generated route,
including both discovery methods; prove spoofed credentials are replaced, not merely omitted
from one log. Inspect generated files and saved logs for canary absence; never print real tokens.

Distinguish gateway→adapter from adapter→remote replies; adapter 502 proves neither outcome.
Save typed adapter observations idempotently through server commands against the decision permit.
Extend #311 tool.dispatch_recorded evidence for authenticated guarded-transport proof before
HTTP bytes leave. A failure after bytes may have left, or missing evidence, stays outcome_unknown.
Do not let generic gateway log “response_received” overwrite an adapter's remote uncertainty.

MCP grant commands reuse `models/access-changes.ts` receipts, original-payload checks and
`grantStream('mcp_server', serverId)`. Owner/Admin can give/revoke one member, team or assistant
grant per command, with granteeKind always present on new events; old broad revokes still replay.
Check active same-silo targets and expected grant position. Installation/admin ownership grants
no tool use. IAM writes person, assistant or team#member resource#use plus atomic applied receipt.
Add MCP content grant rows and bounded candidate reads by adapting model-access, not a second IAM.
Requester AND assistant permission, acts_for, membership and current event/IAM receipts are required.
A lagging revoke receipt denies even if FGA still allows; a grant is Applying until content and IAM
agree. Test direct, team-derived and assistant revokes and team membership loss within two seconds.
Keep unrelated direct grants after team loss. No group picker/creation/management UX here (#105).

Removal review returns affected audiences/assistants/routines, completeness, positions and checkedAt.
Unknown dependencies or pending/unknown publication disable Remove; Check status reads the original change.
Unpublish with removal intent immediately denies, then removes route/owned local resources;
#47 later cleans up only matching owned workloads. Preserve events, inert grant history and the
upstream account. Reinstall needs discovery/review/publication and explicit grant reactivation.

## 2. The rest of a live turn

Reuse #250/#258/#265/#270/#283/#287/#311. Offer only current acknowledged, reviewed, free tools;
private/restricted and team turns keep their existing restrictions. Team grants get gateway qualification without group-turn UX. Reload only the affected thread,
confirm unload, drop its old URL, resume same id/history and require new list discovery.
A failed confirmation fails that turn. Never restart Codex or silently use its old tools.
Keep the posted 15-minute total wait, bounded by approval expiry and turn end. Qualify near-deadline
approval through the production proxy, plus expiry observed at 16 minutes; five-minute proof is partial.

Read requestedAt/decidedAt/usedAt/endedAt from the saved approval event envelopes; retain the
original decision/use when authorised retries occur, and list later uses as separate attempts.
Add a typed optional cancelReason to approval.cancelled, with its own schema/catalogue row.
Use first recorded invalidating cause: turn_ended, turn_stopped, new_message, new_turn,
conversation_closed, turn_not_found; then unpublished, connection_changed, policy_changed.
Add grant_revoked/schema_changed/profile_changed only when a recorded fact proves it; #48/#49
produce their actual causes. Expiry uses expiresAt plus recorded endedAt. Old events omit the
unknown cause/time. Do not infer Odoo note/order changes without #53 evidence.

Before removing never, capture pinned Codex under on-request with local model replies only:
exact MCP elicitation params/response, thread/server binding, turn/start approvalPolicy support,
loaded resume, plain/escalated shell and file requests, private turns and request reply count.
Then remove memory-free thread/start never and set on-request on each memory-free turn/start,
including saved threads. Retain privateConfig/private start never with tools off and explicit
refusal; it is a separate restricted channel, not governed-tool consent.
Recognise only captured mcp_tool_call consent for a live offered server/thread; return accept
without persistence/“remember”. This permits reaching the gateway, never grants resource rights
or skips Ask. Unsupported MCP consent retains #311's refusal report, real request id and turn.
Reply once to shell/file requests with decline, permissions/user-input with unsupported error,
and other unknown requests with unsupported error. Add safe native_request_refused kind records
only for refusals not represented by #311; store no command/prompt text. No forged tool call id.

#311 retry authority does not dispatch. Complete it by retaining the original call bytes in the
bridge while the original HTTP call and logical turn stay live, after verified non-dispatch.
Read durable proof first. Authenticated bridge reports expose a short-lived retained-call signal;
canRetry needs both. Reuse approval-waiting/wake handling without deleting outcome_unknown holds.
POST decision: retry appends approval.retry_requested; wake renews grants and sends retained bytes
through one replacement permit, without model reconstruction.
Keep the original approval expiry, recent-sign-in requirement and 15-minute total wait deadline;
reconnect does not reset them. A duplicate wake/tab cannot send twice. If the response was already
returned, hold lost or turn ended, disable retry and explain it; never recover bytes from a new
message. Allow-mode recovery needs its own reviewed command and is deferred; no new blind path.

GET /api/conversations/:id/tool-requests/:logicalRequestId returns participant-scoped saved
attempts, turn, decisions, dispatch evidence, UTC times and approval references; no arguments/results.
Apply the person's participation interval. Missing record/transport receipt means unknown,
not non-dispatch. Check status only reads; #53 later adds separately dated Odoo readback.
Lost Pod/bridge fails its old turn, cancels unconsumed actions, discards holds and never sends
again. A possibly dispatched call stays unknown even if Codex reports failed/completed.
An HTTP response cannot prove a business write; timeout cannot justify a refund.

Live journey: add the privately configured owner test user as a separate Owner user in OpenCrane 2 Dev, preserving the
existing owner and testing an ordinary requester separately. On a fresh secondary stack use product
register/discover/review/grant/publish, wait for digest/IAM
receipts, then let pinned Codex call a zero-cost recorded fixture through its private proxy.
At 1280 and 390 px prove Allow first write, Block no send, Ask zero sends while waiting,
130-second wait past old token, requester Approve → exactly one unchanged send → same turn reply.
Prove Deny/expiry/Stop, another busy thread, reconnect duplicate wakes, revokes with IAM paused,
safe-retry authority → one replacement send, lost reply and Pod deletion → status-only recovery.
Run two fresh installations for #63; capture SHA/image/config digests, receipts and counts.
Stub model locally; Odoo rights/leases/readback remain #49/#53, never a fixture-only PASS for them.

## 3. Commands, events, statuses and replay

All mutations use session/org/Origin/CSRF and current roles, expectedSequence and commandId.
Read histories/definitions/dependencies before starting the two-second write check. Watch only
exact small access streams (member/assistant/team/payer/grants and applicable role authority).
Keep catalogue/publication checks separate from chat reader access. Never watch a whole personal
conversation, read its history inside that window or add wildcard reads. Reads check access once.
Activity cannot refuse readers. Keep authority.test.ts/authority-volume.test.ts unchanged.

| Command or observation | Stream/event and status |
| --- | --- |
| Review | mcp-<server>; new mcp.server_reviewed. Pending review → Reviewed; no effects. |
| Set mode | Existing mcp.tool_mode_set; exact review revision; restriction immediately effective, widening pending publication. |
| Publish / withdraw | Extend mcp.server_published / mcp.server_unpublished with changeRef, review/source references and desired fragment digest; Applying / Disabled. |
| Prepare / acknowledge config | gateway-config-<silo>; new gateway.configuration_requested / gateway.configuration_observed. Record complete snapshot/generation/digest and exact live receipt or failed/unknown result. |
| Observe publication | mcp-<server>; proposed mcp.configuration_observed from accepted #47/#48 design, binding original change, desired revision and gateway receipt; Ready only on a current match. |
| Give / revoke | Existing grant.given / grant.revoked on one MCP grant stream; Applying until content+IAM receipts. |
| Remove | Unpublish with removal intent, then proposed mcp.server_removed after confirmed cleanup; Removing / Removed. History/account retained. |
| Admit / consume / observe tool | Existing decision.recorded; new tool.dispatch_started consumes the internal permit; existing tool.dispatch_recorded records truthful guarded upstream outcome on decision-<request>. |
| Decide / retry | Existing approval.decided / approval.retry_requested / approval.used; conditional one-use append, no command sends bytes. |
| End approval / native refusal | Extend approval.cancelled with optional cause; existing expired/native_consent_refused; add native_request_refused only for other captured request kinds. |

Update typed events, registry and docs/architecture/events.md together for every addition.
TypeScript folds compute separate installation, review, publication, grant, connection and
availability facts; SQL stores rows/joins only. Extend catalogue/grant/change/feed projections
using existing runners. A Ready installation is not a connection or grant. Credential-free
Connected reads “No account needed”; personal/company status remains unavailable until #49.

Change reads bind original actor/resource/command/expected position/payload digest and list
append/content/IAM/config/cleanup separately. Reload retains safe ids/digests, never secrets/bytes.
A repeated identical command returns its original receipt; same id/different payload conflicts.
Look beyond NATS's duplicate window. Re-read permission even when returning a saved receipt.
Unknown append/apply replies offer GET on the original reference, never automatic POST.
“Not applied” requires definitive refusal or advancement beyond the original expected position
without that command after its append window; 404 or elapsed time alone proves nothing.
If publication intent exists but delivery failed, reconcile/reapply that exact recorded generation
only after proving current gateway status. Do not create new grants/revision/change ids on retry.

Replay rebuilds PostgreSQL/OpenFGA facts, never installs, applies config, scans, issues credentials,
wakes or calls tools. Live reconciliation separately checks authority and exact intent/receipts.
Keep receipt dates/expiry; rebuilds/replacement Pods cannot revive approvals or resend uncertain work.

## 4. Screens mapped to APIs and the 390px layout

Inspected README and both PNG widths for every requested frame in
`<home>/dev/design-handoffs/v2/01-int` and `02-wrk`. Use apps/web, not the old handoff app name.
E = existing; P = proposed. INT root is `/api/org/integrations`; C is `/api/conversations/:id`.
Proposed under INT /:serverId: POST /review, /publication, /removal; GET /facts, /review,
/removal-review and /changes/:commandId. GET /access and /access/candidates; POST /access/changes
saves one grant command; GET /access/changes/:commandId reads its receipt. All POSTs carry the
original commandId/expectedSequence; tool status uses the exact conversation GET in section 2.

| Frames | API and truthful outcome |
| --- | --- |
| INT-01,02,03,04,05,07,08 | E GET INT root list; loading/search/filter/menu/stale loadedAt. Clear protected content on access loss and ignore late replies. |
| INT-06,37 | P GET /:serverId/facts plus E tools; separate dated Installed, Connected, Allowed for, Available to assistant. Ready waits for current digest, grants and required connection. |
| INT-10 | E POST root remote registration + discovery reads. Catalogue/hosted choices wait for #47; no invented marketplace. |
| INT-20 | P review read states accountMode/scopes; none supported here. Personal/company connection commands belong to #49, OAuth to #50. |
| INT-30,31 | E tools read/mode command; P review/access/candidates commands. Add-flow people/assistant audience only; all tools begin Block. |
| INT-33 | P GET /:serverId/access/explanation with selected requester/assistant; grant sources, missing right and supported connection requirement. No company fallback. |
| INT-34,35 | P GET review/consequences, POST review then publication; exact definitions/zero cost/audience child receipts, scoped confirmation. |
| INT-36 | P publication/change GET. Existing frame shows Publishing/grants only; add Applying until digest acknowledgement via prompt A. |
| INT-50,51,52 | P GET removal-review, POST removal, GET original change; actual counts/unknown dependencies, deny before cleanup. No upstream-account deletion. |
| INT-76 | Personal profile Removed belongs to #49; integration removal requires prompt E, not reuse of a personal connection's fact. |
| INT-90,93,94,95,96 | P GET /:serverId/changes/:commandId: definitive no-change / conflict / access lost / unknown / per-stage results. Retry only proven not applied. |
| INT-91,92 | Missing scopes/secret outage belong to #49/#50; here show actual incomplete review/IAM/config unavailable reason without pretending an account was changed. |
| WRK-01,02,03,04,07 | E C history/WebSocket + existing files/Activity/drawer. Tool completion is report status; Odoo values/results in 03 wait for #53. |
| WRK-05,06 | E feed #311 facts; P original tool-status GET for linked attempts/UTC evidence. Native refusal uses real native request id, not invented call id. |
| WRK-10,11,12,13,14 | E C/approvals GET/POST. Bind canApprove/canDeny/missingFields; participants read, only requester decides. Submitting is local progress. |
| WRK-15 | Odoo confirmed readback belongs to #53; approval/use/HTTP 200 alone cannot show it. |
| WRK-16,17,18,19,20 | E approvals plus P times/cause fields. Used is terminal and may be uncertain; only proved schema/grant/profile causes. Note/order reasons wait for #53. |
| WRK-21,22 | E conditional auth step-up and restored approval reads. Do not call product SSO a tool-profile sign-in; #49/#50 own that connection requirement. |
| WRK-30,31,32,34 | P tool-status read and E retry authority + P live retained-call availability. 30/34 require proved non-dispatch; 31/32 only Check status. Lost Pod disables retry. |
| WRK-33,35 | #53 supplies Odoo change/readback/own-rights denial; no admin substitution and no guessed result. |

INT-32 is #105/P4-23's group extension. Implement team commands/fixtures without adding that UX.
At 390 px use the 44px menu, stacked labelled rows and full-screen review/details with Back;
wrap long names/digests, full-width primary action and no page horizontal scroll. Admin has no
composer; chat composer docks above keyboard. Preserve focus/return focus, explicit Approve/Deny,
glyph plus words, polite single announcements and static loops under reduced motion.

The following screens have no matching frame. Each quoted paragraph is ready to paste into
Claude Design. UI PRs covering these gaps wait for the owner's handoff; backend PRs proceed.

A. **Applying until digest acknowledgement, including failed/unknown config delivery.**
> Design OpenCrane Integrations for Owners/Admins after publication intent was saved. Show Publishing grants, then Applying gateway configuration, acknowledged Ready, reload still Applying, failed apply with old routes refused, and unknown acknowledgement. Data: integration, original change reference, review revision, expected/observed digest, recorded times and separate content/IAM/config results. Check status reads this change; no Publish again or Ready before matching acknowledgement. Produce 1280px and 390px frames plus reduced motion. At 390px stack stages and wrap references with full-width Check status. Reuse INT-36/37/95/96, four fact cards, 44px targets, rice-paper, dog-ear, crease, DM Sans/Mono and 6a glyphs; teal #0db5cc, orange #f47920, green #2a7d4f, red #c1392b, ink #16191a.

B. **Grant editing on an already published server, with IAM Applying.**
> Design Manage access for Owners/Admins on a published integration, outside the add wizard. States: current people/assistant grants, staged give/revoke, consequence review, saving, content/IAM Applying, confirmed, stale conflict, access revoked and lost-reply Check status. Data: bounded real candidates, direct grant rows, expected revision, affected people and child change references; state that requester and assistant both need permission. Save one grant command per change; do not re-publish unchanged routes. No group management. Produce 1280/390px and reduced-motion frames; 390px uses full-screen editor with Back, labelled stacked rows and 44px/full-width actions. Reuse INT-31/33/34/93/95/96 and published INT-37 anatomy; DM Sans/Mono, rice-paper, dog-ear/crease, 6a glyphs and teal/orange/green/red/ink tokens #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a.

C. **Removal blocked by pending or unknown publication.**
> Design an Owner/Admin removal review where an earlier publication is Applying or unknown. Show known pending, checking original publication, still unknown and resolved enabling a refreshed removal review. Data: integration, original publication reference, recorded stage/time and safe dependency completeness. Disable Remove; Check status reads the publication, Cancel returns without changes. No cancel-and-remove shortcut. Produce 1280/390px plus reduced motion; mobile full-screen sheet with Back, wrapped reference and full-width Check status, 44px targets. Reuse INT-50/51/95/96, rice-paper outside plain sheets, folded corner/crease, DM Sans/Mono, 6a glyphs and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a.

D. **Publication audience partially saved.**
> Design an Owner/Admin add-review recovery screen after several separate grant commands, when one saved, one is Applying and another is unknown or refused. Show review blocked, status checking, conflict requiring re-review and all prerequisites confirmed. Data: each audience operation/reference/content/IAM result, intended people/assistants and publication state; never an invented overall success count. Check each original reference; resume only proven unfinished work, without recreating saved grants. Produce 1280/390px and reduced motion; phone stacks labelled outcomes with Back and 44px/full-width actions. Reuse INT-34/36/52/95/96, plain fact cards, DM Sans/Mono, rice-paper/dog-ear/crease and 6a tokens #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a.

E. **Remote integration Removed, distinct from a removed personal profile.**
> Design an Owner/Admin integration detail after removal: Removing with access disabled, confirmed Removed with history retained, and unknown route/local cleanup. Data: integration source, recorded removal time/reference, disabled grant history and each real cleanup result. Say the upstream account is kept; Set up again starts fresh discovery/review and grants, never silently restores old access. Produce 1280/390px and reduced motion; stack facts on phone with Back and full-width actions, 44px targets. Reuse INT-37/50/52/76 only for styling, not personal-account wording; DM Sans/Mono, rice-paper/dog-ear/crease and glyph tokens #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a.

F. **Exact definition review and published tool-mode revision change.**
> Design Owners/Admins reviewing exact saved tool definitions and editing modes on an existing publication. States: unreviewed Block, expanded escaped definition, invalid/missing zero-cost evidence, staged Allow/Ask/Block, restriction already effective, widening awaiting acknowledged publication, conflict and unknown save. Data: name/schema/description/metadata digest, zero cost, safe review fields, old/new mode and revision. Treat text as data; no active HTML/icons and no AI review claim. Confirm exact revision before publishing; no group UX. Produce 1280/390px and reduced motion; phone full-screen details with Back, wrapping code and full-width 44px actions. Reuse INT-30/31/34/35/93/95, DM Sans/Mono, rice-paper/plain cards/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a glyph tokens.

G. **Native shell/file/permission refusal after on-request capture.**
> Design a workspace refusal for requesters and other current participants when unsupported native shell, file-change, permission or user-input consent was declined. Show recorded refusal, details loading/failed, and access lost. Data: safe request kind, bound turn, actual request reference and recorded time; omit commands, prompts and guessed tool ids. State no gateway permission was granted; offer details/Back, no Approve or fallback account. Produce 1280/390px and reduced motion; mobile wraps the quiet line and opens full-screen details above the docked composer with 44px controls. Reuse WRK-06/04/07, 8f/8i/8j, DM Sans/Mono, rice-paper/plain panels/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a glyph tokens.

H. **Lost Pod and original tool-status checks without Odoo readback.**
> Design a workspace for current participants after the computer disappeared or a dispatched fixture call lost its reply. States: old turn failed, call outcome unknown, Check status loading/unavailable/still unknown, recorded HTTP response without confirmed business effect, and access lost. Data: original logical request/turn references, dated attempts and trustworthy dispatch evidence; never claim Odoo readback or retry safety from missing evidence. Check status only reads; no Resend and no new-message retry. Produce 1280/390px and reduced motion; phone quiet line plus full-screen details/Back, docked composer and full-width 44px Check status. Reuse WRK-04/31/32, 6a unknown ring, DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a.

I. **Authorised safe retry with the original call still waiting.**
> Design requester and participant views after proved non-dispatch in a live Ask call. States: retry eligible, requester authorising, lost decision reply, authorisation saved awaiting renewed pass, replacement attempt running, finished, deadline/turn ended and original call no longer retained. Data: original approval/request references, dated proof and attempt rows, unchanged reviewed action and real expiry. Only requester chooses Try the same request again; it authorises one retained call, not a new message. Unknown checks status; ended calls have no retry. Produce 1280/390px and reduced motion; full-width primary phone action, 44px targets, stacked attempt rows and details Back above composer. Reuse WRK-05/10/14/30/31/34 and orange approval edge; DM Sans/Mono, rice-paper/plain panels/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a glyph tokens.

J. **Published credential-free integration with four truthful facts.**
> Design Owner/Admin detail for a remote credential-free fixture, replacing INT-37's company-account example. Show Reviewed pending publication, Applying, published but nobody granted, requester-only grant missing assistant, current grants and unavailable catalogue. Data: installation/review/config dated evidence, Connected “No account needed”, actual audiences and assistant availability with reasons. Review access and Check status use their real references; no Connect account or company fallback. Produce 1280/390px plus reduced motion; phone stacks four labelled fact cards, wraps evidence and uses Back/full-width 44px actions. Reuse INT-06/33/37 and 6a states, DM Sans/Mono, rice-paper/plain cards/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a.

## 5. Ordered PRs, each independently landable

Build serially from main, no stacks; count tests, catalogue, README/robot and branch-named
changes/unreleased notes in each limit. Leave CHANGELOG Unreleased alone. Write failing-first tests.
Keep unfinished paths refused; backend source alone cannot complete a capability. Split any diff
exceeding about 600 changed lines before building. Server/contracts precede new screens.

| Order / issue / max changed lines | Outcome | Failing-first proof |
| --- | --- | --- |
| 1 / #45 / 540 | Exact review command/fold and revision-aware restrictions, compatible with #329. | Discovery cannot mark review; definition/hash mismatch, absent cost, stale/admin/foreign input; replay keeps Block. |
| 2 / #45 / 560 | Publication intent + durable generation/change contracts; typed complete route/CEL/authz/header renderer. | Old boolean cannot Ready; every policy comes from same revision; concurrent intents get distinct serial generations; no secret in output. |
| 3 / #45 / 570 | Dev-stack file delivery, loaded-digest witness/receipts and removal of startup route authority. | Real agentgateway atomic reload; rejected file retains old route but no acknowledgement; wrong/late/replayed digest and lost apply reply stay refused. |
| 4 / #45 / 550 | ext_authz checks current generation and trusted final-send permit; tool.dispatch_started. | Real gateway stale-route call, spoofed generation, withdrawal between authz/send and reused permit: zero upstream requests. |
| 5 / #45 / 590 | Guard tools/call outbound socket and authenticated remote dispatch observations. | Recorded TLS upstream bytes/headers; private/mixed/rebound DNS, redirects/TLS, adapter crash before/after send; no false non-dispatch. |
| 6 / #45 / 510 | Complete generated-route protocol/header refusal qualification. | Real gateway batches, decoded duplicates, forbidden keys, case/resources/unknown, version/meta/header/session/GET/size matrix; upstream count unchanged; canary absence in files/logs. |
| 7 / #45 / 540 | MCP person/team/assistant give/revoke commands and receipts. | Non-admin/stale/foreign/inactive/reused-id payload; lost append reply original receipt; real gateway person/assistant/team/member revoke within 2 s with IAM paused. |
| 8 / #45 / 480 | MCP bounded access/candidate/facts and change-stage reads using model-access pattern. | Lagging content/IAM remains Applying; outsider denied; both grants needed; drop/replay equality; no wildcard history. |
| 9 / #45 / 500 | Removal consequences, dependency completeness and pending-publication block. | Unknown dependencies and Applying/unknown publication refuse removal; stale review counts not accepted; upstream account untouched. |
| 10 / #45 / 500 | Event-backed unpublish/remove and exact cleanup reconciliation. | Deny before route cleanup; lost reply/worker restart/replay never re-enable; old grants inert; #47 owned UID contract preserved. |
| 11 / #46 / 420 | Approval UTC decision/use/end times and typed recorded cancellation causes. | Every supported cause, old missing reason, retry use history, unknown cause omitted; history read before short access check; replay times identical. |
| 12 / #46 / 570 | Saved on-request wire capture, explicit native replies and removal of memory-free never. | Real pinned Codex local-stub capture; supported consent still Ask; unsupported requests one reply/refusal; private tools off; new output never refuses a reader. |
| 13 / #46 / 560 | Original-call status and retained-byte authorised retry continuation. | Proof required, forged observation refused, two-tab/wake race one replacement, lost/restarted/ended hold never sends, original expiry retained; projection/receipt loss stays unknown. |
| 14 / #45+#46, feeds #63 / 590 | Fresh-install governed fixture journey via product publication/grants, a separate, privately configured owner test user. | Real gateway recorded upstream, stale route and 2 s revokes; Codex same-turn approve/deny/reconnect/Pod loss, two widths and 15-minute wait/16-minute expiry observation; two fresh runs. |
| 15 / #45 / 540 | Publication/review/four facts screens and exact-change recovery, prompts A/D/F/J. | 390px/desktop/keyboard/reduced motion; never Ready before digest; partial grants, lost reply, stale edit and late revoked read. |
| 16 / #45 / 480 | Published people/assistant grant edits, prompt B. | Separate receipt per grant; IAM Applying; intersection explanation; mobile wrapping and no group UX. |
| 17 / #45 / 480 | Removal review/block/results, prompts C/E. | Missing dependencies/pending publication disable Remove; original status GET only; account kept, Removed/reinstall facts truthful. |
| 18 / #46 / 530 | WRK-05/06/13/16–20 server facts, times and native details, prompt G. | #311 attempts/native ids/missingFields/canDeny; no fabricated times/result/name; 390px and participant/requester control. |
| 19 / #46 / 480 | Status-only lost-Pod and live safe-retry screens, prompts H/I. | Unknown never POSTs; requester retry only confirmed retained call; used/ended states stay collapsed across reload; Odoo readback absent. |

Later landing gates: lint/typecheck/test/check:events and relevant web/build checks under nice -n 10;
respect live-view exclusion and two-pass independent review. No checks run for this design.
Backend qualification uses APIs while handoffs wait; repeat through final screens before completion.
#63 owns full Phase 3/Odoo qualification; dev PASS cannot imply Helm/HA/paid-provider PASS.

## 6. Open questions and recommended defaults

| Question | Recommended default |
| --- | --- |
| Gateway digest acknowledgement under atomic file rename? | Implement the loopback-only generated witness and prove pinned real reload first. If it fails, keep Applying/unavailable; use a reviewed dev-stack delivery alternative, never equate file write/readiness with acknowledgement. |
| Can literal protocol_version acceptance be satisfied? | Update #46 wording to image+flag pin and strict 2026-07-28 wire enforcement; do not add a key strict Codex rejects. No Codex upgrade here. |
| Codex _meta passthrough remains open? | Preserve bounded captured metadata unchanged for the credential-free fixture, as main does. Recommend strip non-protocol x-codex-turn-metadata before external personal-account production (#49/#53), with explicit owner decision and new wire tests; never alter approved arguments or claim whole-byte equality after stripping. |
| Approval wait and reload defaults? | Retain posted 15-minute total wait and confirmed per-thread reload. Qualify the full production-proxy duration; reduce a measured unsupported limit openly. No process restart/fork fallback without separate decision. |
| Supported native consent under on-request? | Accept only the captured live listed-tool mcp_tool_call request without persistence; gateway remains authority. Unsupported native requests decline visibly. Capture ordinary-shell behaviour before shipping. |
| Remote atomic revision guarantee? | Follow accepted #47/#48 note: immutable hosted per-start catalogue or atomic remote expected-revision refusal. Unsupported mutable remote servers stay unavailable; only owner can choose a weaker guarantee. |
| Safe retry after original call ended / Allow failure? | Disable it. #311 authorises an unchanged live Ask replacement; no new message/turn or reconstructed body can inherit it. Later broader recovery needs a reviewed contract. |
| Missing affected routines or person names? | Use bounded current projections; incomplete dependency review blocks removal. Keep “another participant” where only an id exists. No guessed counts/names or group UX. |
| Off-box costs? | Existing box, cluster, local registry and model/tool fixtures only; tools costCents: 0. COST OUTSIDE BOX: remote metered service calls, registry/egress, extra cloud compute, hosted identity/scanning and paid model qualification need recorded allowance before use. No such spending is authorised here. |

Tailnet access only, never Tailscale Funnel. Zitadel changes are limited to OpenCrane 2 Dev.
No new dependencies; later silo binaries/packages need OSI review with AGENTS.md's stated exceptions.
Money is integer euro cents; the separate provider envelope cannot exceed the recorded remaining
part of 500 cents, with provider-side limits. Product caps cannot enlarge it.
