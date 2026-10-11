# Tool access and company connections for groups

Design for [#105](https://github.com/elewa-git/opencrane-new/issues/105), 10 October 2026. Read-only checkout
/home/jente/dev/wt/p4-23-design, work/p4-23-design. HEAD, origin/main and GitHub main:
dd3880237b87f98bab1793a5e1ceec1addfdfbbc. Only this note was written; no product edits, stacks, tests, model
calls, spending or handoff requests. Network reads: GitHub only. Implementation/checks/review/fresh journeys:
NOT RUN.

## Sources and current delivery

Read the requested issues/comments/Design sections, named source, AGENTS.md, plan.md, standards, ADRs
0001–0006, Phase 4 spec/P4-23/D24, Phase 3 D02/D11/D16, API contracts and handoff PLAN rows. Build on the
accepted p3-4-rest-design.md, p3-6-design.md and p3-8-design.md in /home/jente/.fleet/reviews/.
p4-24-design.md was absent; #106/#107 govern routines. Inspected INT/PPL READMEs and all mapped PNGs at both
widths.

| Dependency / evidence | On this main | Remaining boundary |
| --- | --- | --- |
| [#83](https://github.com/elewa-git/opencrane-new/issues/83), merged #137/#187/#190 | Flat groups, membership commands, FGA receipts, group screens/removal. | No hierarchy or group deletion. PPL-11's add-member screen still needs binding; group creation grants nothing. |
| [#45](https://github.com/elewa-git/opencrane-new/issues/45), merged #204/#222 | Register/detail, remote registration/discovery, tool-mode screens. | Exact review, digest-acknowledged publication, MCP grant commands/reads and removal remain work in its accepted note. Do not rebuild them in #105. |
| [#48](https://github.com/elewa-git/opencrane-new/issues/48), open [#329](https://github.com/elewa-git/opencrane-new/pull/329) | Existing drift clears publication. | Dated snapshots/stable policyRevision are proposed in #329, not on main; watch/final dispatch/restore remain later slices. |
| [#49](https://github.com/elewa-git/opencrane-new/issues/49) | Connection events exist; no usable custody/release/selection commands. | Latest comment says design accepted and custody PR 1 building; this updates the task's earlier “not started”. No delivered connection capability is implied. |
| [#104](https://github.com/elewa-git/opencrane-new/issues/104), merged #269/#280 | Model access/candidates, give/revoke and receipt routes. | Mirror their typed commands and separate content/IAM status; no new model or provider engine. |
| [#85](https://github.com/elewa-git/opencrane-new/issues/85), merged [#315](https://github.com/elewa-git/opencrane-new/pull/315), open [#331](https://github.com/elewa-git/opencrane-new/pull/331) | Member access/departure reads, direct/group sources, person/assistant checks; availability unavailable. | Extend the #315 read. #331's removal is not landed; coordinate reviewed dependency inputs without assuming its commands exist. |
| [#89](https://github.com/elewa-git/opencrane-new/issues/89) | Group assistant/private member threads and fixed payer, backend #161 and screens #245/#247. | Per-requester credentials and live isolation are unfinished. Native offered tools currently require a personal, memory-free turn. |
| [#106](https://github.com/elewa-git/opencrane-new/issues/106) / [#107](https://github.com/elewa-git/opencrane-new/issues/107) | Reserved routine events; no routine product/commands. | Later supply configured dependencies, firing checks, visible pause and owner-bound Ask. Do not create a scheduler in #105. |

Source proof: FGA resource#use accepts person, assistant and team#member. authz/members.ts maps member to
person and applies grants plus receipts atomically; groups.ts projects team grants, model-access.ts excludes
MCP. tool-policy.ts/mcp-catalogue.ts fold catalogue/modes; publication's boolean is not live acknowledgement.
integration-facts-map.ts reports Connected and Allowed for unavailable. mcp.ts/turn-tools.ts admit only
accountMode none; connection event names have no working custody commands.

## 1. What the feature records and checks

An Owner/Admin manages audiences/company profiles; a member uses tools as their authenticated requester,
including on a shared assistant. Role, installation, account ownership, connection and publication create no
use grant. The four cards describe evidence and perform no grants.

| Fact | Evidence returned by the proposed facts read | What it cannot establish |
| --- | --- | --- |
| Installed | Registration/admission/discovery event ids, source/digest, dated checks, lifecycle and instance generation where hosted. | Registration alone is a draft, not an admitted running installation or permission. Publication is a separate field. |
| Connected | For selected context: verified profile identity, owner kind, scopes, expiry, generation, admin blocker and recorded check; `none` says No account needed. | A saved secret or tool-list check cannot prove a governed call, upstream effect, grant or current reachability. No selection means no selected account. |
| Allowed for | Recorded person/group/assistant grant sources, event times/positions and content/IAM receipts. | Audience membership is not assistant permission, publication, credential ownership or approval. Applying grants cannot authorise use. |
| Available to the assistant | For an explicitly named requester/assistant/tool: both live rights, acts_for/membership, current reviewed publication/freshness, selected eligible profile, scopes and mode. Return checkedAt and reasons. | A dated read is an explanation, never a reusable dispatch capability. Ask means eligible to request approval, not approved. |

With no requester/assistant selected, show availability Not checked for a person and assistant. Distinguish
unavailable IAM from Missing grant. Use recorded evidence dates, never browser loadedAt; installation status
cannot imply everyone can use it.

Give/revoke uses existing `grant.given` / `grant.revoked`, resourceType `mcp_server`, resourceId serverId,
explicit granteeKind `member|team|assistant`, granteeId and actor. Each command conditionally appends once to
`grantStream('mcp_server', serverId)`. Owner/Admin, exact silo/session/Origin, strict body, expectedSequence
and commandId follow `models/access-changes.ts`. Check same-silo active grant targets; allow revoking departed
targets. Preserve typed revokes and broad legacy revoke replay. Do not copy model starting-grant provisioning:
MCP installation creates no starting grants. No-effect revokes append nothing and have no saved receipt;
explain this response.

The handler writes the corresponding resource#use relation and applied receipt to OpenFGA. Group membership
supplies only the requester's side. Require requester use AND assistant use, current silo membership,
acts_for, permitted session/turn/thread, computer generation, fixed payer and all ordinary gateway checks. A
grant to the assistant's group never substitutes for that assistant's own resource grant. Use server-level
audiences and per-tool modes in this delivery. Gateway currently checks `mcp_server`; the frames' per-tool
grant wording must not imply `mcp_tool` enforcement. Do not introduce a second ACL system just to reproduce
sample copy.

`team.member_removed` ends that membership's derived tool rights within two seconds of its stored event, even
while content/FGA lags. Check relevant event positions and IAM receipts at admission and final dispatch; stale
positive FGA replies cannot allow. Direct grants and another remaining group source stay independent. Silo
removal denies all calls despite surviving old tuples. Rejoin follows #85's fresh admission, not restoration
of old grants/profiles. Already-sent external actions may finish; revocation stops new dispatch and
invalidates unconsumed approvals, not past effects.

Every tool, including a read, has Allow automatically / Ask / Block. Ask requires the original requester's
use-once approval; routine Ask later belongs to the recorded owner. Block denies before credential release.
Hints never approve tools. New and changed definitions remain Block pending exact review, with explicit
`costCents: 0`. Drift quarantines the whole server, including unchanged tools. Keep old choices as review
evidence only. Old versions/approvals cannot keep serving; no rollback button. Fresh catalogue evidence, exact
re-review and acknowledged publication are all needed to restore. Retain #329's stable policyRevision; an
unchanged watch cannot end Ask. Follow #48's final revision precondition; unsupported mutable remote servers
stay closed.

Personal profiles remain the interactive default account kind, for personal and team assistants. “Default”
never means auto-select the first profile: #49 requires explicit selection of the requester's own profile.
Missing/cleared/expired/disabled selection blocks calls. Never use the assistant owner's, an admin's or a
company account silently. Company use needs recorded admin opt-in, an eligible reviewed profile and explicit
requester selection. State: “Odoo sees Kijani orders bot. OpenCrane records Alex as the requester.” For a
routine, replace Alex with its recorded owner, and name assistant/payer. The company belongs to the silo with
an admin custodian; correct “admin-owned” copy.

Reuse #49's proposed `connection.selected` on `connection-selection-<user>-<server>`; selection is separate
from creation/opt-in/grants. Bind profileId, selection revision and account kind to the trusted turn; bind
current credential generation to offers, approvals and final permits. Model arguments, labels and client
headers select nothing. Changing selection affects new turns; never mutate an admitted turn's account/payer.
\#106 records its own explicit company profile/revision on routine creation/update.

\#45 owns review/publication/guarded dispatch and MCP grants; #49 owns company opt-in, immutable custody,
verified identity, selection, ≤30-second one-request leases and release audit; #50 owns OAuth. #105 consumes
them. Keep accountMode none enforcement until #49 supports reviewed personal use plus explicitly eligible
company selection per call; never switch all users to company mode. Missing dependencies remain Not available
yet/closed. Shared native tools wait for #89/#49 isolation and request binding; do not relax mayOfferTurnTools
here.

## 2. Bounded reads and consequence reviews

Reuse access/candidate/receipt shapes from #104 and the #315 member-access response. New reads return
checkedAt, complete, unavailableSections, relevant positions, reviewRevision and per-section
`current|applying|unavailable|absent_on_version` evidence. Admin reads expose safe names/ids/grant reasons,
never personal history, prompts, credential values or another person's account details beyond permitted safe
metadata. Member reads stay own-context; do not open admin routes to ordinary members.

| Read (proposed under `/api/org/integrations/:serverId`) | Required bounded data |
| --- | --- |
| `GET /access` | Server-grant rows with direct/group/assistant source, total, receipt state and expectedSequence; revoked facts retained for reconciliation. |
| `GET /access/candidates?kind=member\|team\|assistant&after=&limit=` | Same-silo current choices, group member count, next cursor; reuse #104 labels and target validation. Add bounded `q` only when picker search is implemented. |
| `GET /access/explanation?requesterId=&assistantId=&toolName=` | Direct plus each current group source, assistant grant, acts_for, selected personal/company profile status, per-tool mode/scopes, review/publication/freshness refusal reasons. |
| `GET /facts` and `GET /review` | Four independent dated facts and enabled-tool scope union, plus exact review/config/grant/profile revisions. Review describes proposed modes and separately saved grant receipts. |
| `GET /removal-review` | Deduplicated affected people with groups expanded, grants lost/retained, granted/configured assistants, routines, selected profiles, enabled tools/scopes and stage consequences. |
| `GET /connections/:profileId/disable-review` | Company-profile users/assistants/routines that depend on this explicit selection, current generation, scopes, reviewRevision and what continues on other already-selected profiles. |
| Existing `GET /api/members/:memberId/access` | Extend #315 eligibility with tool/publication/profile reasons; reuse PPL-20–22. Do not add a second member inventory or a new frame. |

Default list pages 20, maximum 50; candidate API may retain #104's maximum 100. Query ≤100 characters, ids
≤200 safe characters, strict inputs and no-store replies. Consequence review ceilings: 100 audience grants,
100 groups, 500 distinct expanded people, 100 assistants, 100 routines and 100 profiles; stop on the first
exceeded limit. Return known rows with complete:false and null exact totals for incomplete sections, never a
truncated list labelled complete. Pagination is for browsing, not permission to hide omitted consequences.
Read histories with a separate ten-second/10,000-record ceiling, before the two-second write check. Limits are
recommended initial contracts.
Enabled-tool scopes come from the reviewed typed scope map, never descriptions. Union only
reviewed Allow/Ask tools; Block contributes no scopes. Check each tool against actual granted scopes.

Collect grant/member/group/profile ids from silo-filtered indexed projections; resolve their exact event
references/streams and receipts. Fold overlaps in TypeScript: one person in two granted groups and a direct
grant counts once. Distinguish “has a grant” from “currently callable with this assistant”; connection absence
does not erase impact. For group-grant removal, show people losing their last source separately from those
retaining direct/other-group grants. Server removal affects all its recorded audiences. “12 in Sales plus
Grace” means 13 only if Grace is outside Sales; never copy frame totals.

The current #315 loader uses category wildcards and #104 has a model-specific wildcard starting-grant lookup.
Do not extend/copy either into this path. Replace the touched inventory loading with bounded indexed ids and
exact stream reads, preserving #315's revoked-grant and removed-membership receipts even when its displayed
rows become empty. Use existing ordered projection/replay runners to index relevant recorded links and
category presence. SQL stores, filters and joins rows; TypeScript decides meaning/completeness. No wildcard event
reads, whole-chat inventory reads or generic dependency framework.

An assistant grant is a recorded dependency, not proof of a configured or successful use. Label it “Assistant
granted access”. Return configured uses only from recorded bindings; never infer them from instructions. Until
\#106, show “Routines are not available on this version” and `absent_on_version` only after current
projection/event evidence establishes no routine records. This is not a live routine PASS or “0 paused”. If
routine history exists but cannot be interpreted, return unsupported_history and complete:false. If
history/checkpoints are unavailable, show Routines: unknown. Both block removal. #106 must extend this same
read and replay when it enables creation; #107 supplies recorded pause outcomes. No placeholder names,
schedules or invented counts.

Missing dependencies, unfinished publication, lagging content/IAM or incomplete account metadata block
destructive completion on the server as well as disabling its button. POST removal/disable carries commandId,
expectedSequence and reviewRevision. Load and compare relevant input positions before the short caller check;
stale review returns 409/review_required. Use server/profile conditional append to order its lifecycle. Do not
require the entire silo log or conversation checkpoint to stay unchanged: another message, upload or turn must
not make an otherwise valid review stale.

There is no atomic transaction across grants, memberships and routine streams. Count evidence describes its
checked snapshot. Removal intent disables the server; disable intent invalidates the profile before
asynchronous cleanup/pause. Concurrent new selections/bindings must recheck that lifecycle before becoming
executable, and firing/final dispatch must refuse it. Reactions include newly discovered dependants in
status; never mark all pauses/cleanup complete until current relevant inputs and receipts agree. #106 must
prove create-versus-disable/removal races before enabling routine creation.

Removal never deletes the upstream user/account or its records. Keep audit/conversations and grant history;
end usable server access immediately. Local profile revocation and exact custody deletion are separate #49
child changes, not “Odoo account deletion”. Show their Applying/unknown results separately. Company disable
preserves grants, other personal profiles and history; it stops only this company profile's new releases.
Dependent routines will pause with connection_disabled and cannot switch credentials. Already-dispatched work
settles normally; unknown external effects are never repeated.

## 3. Commands, events, statuses and replay

E = existing name; P = accepted prerequisite proposal. Commands append once to one stream. HTTP orchestration
lists separate child receipts; no bulk grant, publish-and-grant transaction or SQL truth.

| Action | Event/stream | Checks and resulting state |
| --- | --- | --- |
| Give/revoke audience | E `grant.given` / `grant.revoked`, MCP grant stream | Current Owner/Admin, expected position/typed target; Applying until content and IAM receipts agree. #45 implements. |
| Remove group membership | E `team.member_removed`, `team-<group>` | Existing #83 command; derived access revoked within two seconds, unrelated direct access retained. |
| Review / set mode | P `mcp.server_reviewed` / E `mcp.tool_mode_set`, `mcp-<server>` | Exact catalogue/tool revision and zero-cost evidence; restrictions immediate, widening awaits publication. |
| Publish / withdraw / remove | E `mcp.server_published` / `mcp.server_unpublished`; P `mcp.server_removed` | #45 intents bind reviewed revision/config digest and consequence review; Removing denies first, Removed requires confirmed applicable cleanup. |
| Apply / observe gateway | P `gateway.configuration_requested/observed`, `gateway-config-<silo>`; P `mcp.configuration_observed` | #45's complete generation and exact live digest acknowledgement; Applying/unknown until matching proof, no late restoration. |
| Catalogue check / drift | E discovery/changed; P `mcp.catalogue_checked` | #329/#48 dated snapshots, expiry and policyRevision; whole server Paused for review until current review/ack. |
| Create/rotate/revoke profile | E `connection.created/refreshed/revoked`, exact profile stream | #49 stages references outside command; verified binding/generation, immutable custody; no use grant. |
| Opt in / choose / disable company | #49 creation's explicit company opt-in; P `connection.selected` / `connection.disabled` | Silo-owned profile/custodian, explicit user selection on its own stream; disable on company profile stream binds reviewed impact and generation. |
| Consume / release / observe call | P `tool.dispatch_started`; E `credential.released`, `tool.dispatch_recorded` | #45/#49 live single-use permit, current intersection/profile/mode/approval/budget; audit confirmed before injection, no secrets in events. |
| Pause routines later | Existing `routine.paused` via #106/#107 command on each routine stream | Own child command/reference, observed disabled source revision, current ownership; no scheduler or firing reaction in #105. |

Update typed schemas/registry and docs/architecture/events.md together. No placeholder events. Extend existing
catalogue/group/grant/connection/selection/member projections; rebuild with existing checkpoint/switch
mechanisms. TypeScript computes status; SQL stores projections, with no business triggers/views/procedures.

Distinguish durable append, content applied, IAM applied, live config acknowledged, credential invalidated and
local cleanup confirmed. Grant Saved does not mean Ready; connection Connected does not mean Available.
Refused/unavailable reads differ from Outcome unknown after a possibly saved append. Status includes original
actor, operation, command/change id, expected position, request digest, dated receipt and per-stage results.

Use #45's `GET /changes/:commandId` and `/access/changes/:commandId`, and #49's profile/selection
change-status reads. Retain safe ids across reload, never tokens. Status checks read the same change and never
resend. Exact repeat returns the original receipt after rechecking access; changed actor/payload/expected
position conflicts. Event history provides deduplication beyond NATS's duplicate window and backup restore.
404 or projection lag is still unknown. Only definitive refusal/closed append window proves not applied.
Pending multi-command review shows partial grants explicitly.

Pure replay rebuilds register, grants, memberships, selections, dependencies and audit without
install/scan/config delivery, secret access, credential release, tool/model calls, computer wake or routine
firing. Preserve original dates/expiry; replay cannot renew freshness, resurrect approvals or prove today's
gateway acknowledgement. Separate live reconciliation may complete only the same current intent after checking
its receipts. Lost cleanup replies check exact custody/workload identity, never delete by name alone. Removal
is terminal for this registration: any reinstall needs fresh review and grants. Because remote ids are
currently deterministic, #45 must fence retained grants on reuse or use a fresh registration identity; no
re-enable path may silently revive old tuples.

Keep access checks small: exact member/assistant/team/payer/grant and applicable role authority streams only.
Read history/definitions/dependencies first with their own deadline. Reads check access once, use no write
fence, and never watch a conversation. Profile/selection/policy/config revisions are separate final-dispatch
preconditions, not new chat-reader watches. Preserve the existing two-second limit and bounded leases; new
activity never refuses readers/closes viewers. Leave `authority.test.ts` and `authority-volume.test.ts`
unchanged; add focused feature tests elsewhere.

## 4. Screens, routes and missing handoffs

Reuse IntegrationRegister, IntegrationFacts, ToolPolicyScreen, AccessGrantEditor, ConnectionProfileForm,
People group detail and shared status/sheet components. E = route exists; P = proposed. I =
`/api/org/integrations/:serverId`. Keep #45's proposed `POST I/access/changes` and GET receipt path; its
strict body mirrors model `POST /access`. Do not add both POST aliases. #49 owns company routes under
`/api/integrations/:serverId/company`; final path names follow its landed contract.

| Frames (both widths) | API / behaviour |
| --- | --- |
| INT-01,02,03,04,05,07,08 | E GET `/api/org/integrations`; existing empty/loading/all/attention/review/search/stale/menu. Use real lifecycle/facts; no fixture audiences. |
| INT-06,37 | P GET I/facts plus E GET I/tools; four independent cards and safe dependent rows. #37's sample read-call timing/routine appears only with actual recorded evidence. |
| INT-20,21,22,23 | #49 safe company metadata/create/status and #50 validation check; scopes/explicit opt-in/saving/discovery-only. Connect does not select, grant or publish; verified account is not an editable label. |
| INT-30,31,32 | E GET/POST I/tools, P GET I/access and /access/candidates, POST /access/changes. Reuse modes; INT-32 adds real groups and preserves direct sources. Adding a group requires missing handoff A. |
| INT-33 | P GET I/access/explanation for named requester/assistant/tool; direct/group plus assistant plus selected connection, with IAM unavailable distinct from denied. |
| INT-34,35,36 | P GET I/review, POST I/review and /publication, GET original change; grants have separate receipts. Correct “publishing grants only what's listed” to “Publishing grants no access”. |
| INT-40,41,42,43,44 | #48 comparison/catalogue-check/status and #45 review/publication; old/new escaped definitions, whole-server quarantine, fresh-check/ack restoration. Unchanged row's saved Allow does not permit calls while paused. |
| INT-50,51,52 | P GET I/removal-review, POST I/removal, GET I/changes/:commandId; real deduplicated impact, missing data blocks, separate route/access/profile/cleanup results. Never promise owner notifications without receipts. |
| INT-90,91,92,93,94,95,96 | Definitive no-change, missing scopes, unavailable services, stale edits, role loss, unknown and original status respectively. #91's reads continue only if their own checks pass; #92 cannot assert no change after a lost reply. |
| PPL-10 | E GET `/api/groups/:id`; list actual group grants, link to I/access. Count server grants separately from enabled tools; do not label one server grant “2 tool grants”. |
| PPL-11 | E member directory + POST `/api/groups/:id` action add; reuse inline picker and receipt read. Membership editing is #83/#85 work, not the integration audience picker. |
| PPL-13 | Existing group-removal review/POST/status; use actual lost/retained sources and two-second promise. No loss of independent direct grant or private-content disclosure. |
| PPL-20,21,22 | E member detail/access reads (#315), extended tool availability; reuse member access/loading/purge frames, no new frame. Correct per-tool assistant-grant sample to server-grant explanation. |

At 390px use the existing menu button, stacked labelled rows and full-screen details/reviews with Back; no
admin composer. Wrap names, scopes, references and consequences. Actions full width, targets ≥44px, scrollable
review body with no hidden content behind sticky controls. Trap modal focus, start on title, Escape cancels,
return focus to opener. Use glyph plus words, polite start/result announcements and static reduced-motion
loops. Never reproduce the PNG demonstration dividers/clipping. Long labels must remain readable. Correct
historical Off/Allow/Ask-first-on-writes to D24's exact mode labels for every tool. Correct old 4f
old-version-serving claims to quarantine; v2 INT-41 already says this.

These ready-to-paste Claude Design prompts cover missing screens, including inherited gaps owned by
prerequisites. Request 1280/390px and reduced motion. Gap UI waits for the owner's handoff; backend PRs
proceed. This task submits no prompts and calls no design model.

**A. Add a group/person/assistant in the audience editor (#105; chips are not a picker).**
> Design OpenCrane integration audience selection for Owners/Admins. Purpose: add existing flat groups, people and assistants. States: empty/loading/search/no match/selected/already added/overflow/IAM unavailable/stale/access lost. Data: bounded candidates, group counts, direct/group sources, revision. Arrow keys navigate, Enter selects, Escape closes, remove chips explicitly; selection stays a draft until Save. At 390px use a full-screen labelled stacked picker, Back, wrapped names and 44px/full-width actions. Reuse INT-32, PPL-11 and INT-93–96; DM Sans/Mono, rice-paper/plain sheets, dog-ear/crease, teal #0db5cc/focus #0a8497, orange #f47920, green #2a7d4f, red #c1392b, ink #16191a. Show that both requester and assistant need grants.

**B. Company detail, rotation/reconnect and disable consequences (#49/#105; no frame).**
> Design a silo-owned company connection for Owners/Admins with named custodian. Purpose: maintain or disable that account safely. States: connected/expired/rotating/disabled/stale/missing dependencies/unknown/checking/confirmed; routines absent on version, real dependent routines, and unknown are distinct. Data: verified upstream account, scopes/generation, requester attribution, deduplicated users, assistants/routines and child receipts; no token readback. Review Disable, cancel, check original change, explicitly reconnect/replace; no fallback or upstream account deletion. At 390px stack facts and consequences in full-screen sheets with Back, wrapped scopes and 44px/full-width actions. Reuse INT-20–23/50–52/90–96 and RTN-11/53 anatomy; DM Sans/Mono, rice-paper, dog-ear/crease and teal/orange/green/red/ink #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens.

**C. Explicit personal/company selection (#49; setup is not selection).**
> Design Choose account before a member's tool turn. Purpose: explicitly bind their own personal profile or an opted-in company account. States: none/own connected/company eligible/missing scopes/disabled/stale/saving/unknown/selected. Data: safe verified account, ownership kind, scopes, revision and both attribution names. Radio cards, Use this account, Clear or Connect; connecting does not select or send a draft. At 390px stack wrapped cards with 44px targets and full-width confirmation. Reuse INT-20/33/74/95/96 and My tools shell; DM Sans/Mono, paper/dog-ear/crease and teal #0db5cc/focus #0a8497, orange #f47920, green #2a7d4f, red #c1392b, ink #16191a. Never list another person's or validation profile.

**D. Manage grants after publication (#45/#105; wizard is insufficient).**
> Design published integration Manage access for Owners/Admins. Purpose: change one existing server grant without republishing. States: current/staged give or revoke/consequence review/saving/content and IAM Applying/confirmed/no effect/conflict/unknown/role loss. Data: sources, real candidates including groups, last-source losses, expectedSequence and per-command references. Save one grant, cancel or check its original receipt; no all-or-nothing audience promise. At 390px use full-screen editor/Back, stacked rows and full-width 44px actions. Reuse INT-32/33/34/37/93–96; DM Sans/Mono, rice-paper/plain sheets, dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a status tokens.

**E. Expanded affected people, assistant/routine dependencies and limit reached (#105).**
> Design Owner/Admin consequence details behind integration removal/disable review. Purpose: inspect actual people expanded from groups and recorded dependants. States: loading/current/overlapping sources/retained direct grant/empty/routines absent/unsupported history/limit reached/read failed. Data: deduplicated rows, source groups, dependency kind, safe owner/assistant/profile ids, checkedAt/completeness; unknown totals never become zero. Browse bounded pages/Back/Refresh; incomplete review disables removal. At 390px stack labelled cards with wrapped names, 44px controls and no horizontal table. Reuse INT-33/50/51 and PPL-20; DM Sans/Mono, rice-paper/plain cards, dog-ear/crease and teal/orange/green/red/ink #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens. Reveal no private content.

**F. Applying gateway acknowledgement (#45 inherited gap).**
> Design Owner/Admin publication progress after intent is saved. Purpose: distinguish grants/content/IAM from gateway acknowledgement. States: Applying/failed delivery/unknown/reload/checking/matching digest Ready. Data: original references, expected/observed generation and digest, times and independent stage results. Check status only; no Publish again. At 390px stack stages, wrap digests, Back and full-width 44px actions. Reuse INT-36/37/95/96; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a glyph tokens. File written or generic readiness never means acknowledged.

**G. Removal blocked by unresolved publication (#45 inherited gap).**
> Design Owner/Admin removal review blocked by Applying/unknown publication. Purpose: resolve the original publication before a new destructive review. States: pending/checking/still unknown/failed conclusively/resolved/new review. Data: integration, original publication reference, dated known impact and unknown stages. Only Check status/Cancel/Refresh review; no second mutation. At 390px use full-screen sheet, stacked reasons and full-width 44px actions. Reuse INT-36/50/51/95/96; DM Sans/Mono, rice-paper/plain sheet, dog-ear/crease and teal/orange/green/red/ink #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens.

**H. Partial grant-save result before publication (#45 inherited gap).**
> Design Owner/Admin review when separate audience commands have mixed results. Purpose: review confirmed changes before publication. States: some saved/others refused/unknown/IAM Applying/stale/ready to review. Data: each target/action/reference and exact saved audience; no fake transaction. Check each original status, cancel or start a newly reviewed remaining change after definitive failure; do not undo saved grants automatically. At 390px stack result cards, Back and full-width 44px actions. Reuse INT-34/36/52/95/96; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a status tokens.

**I. Integration Removed, distinct from personal profile (#45 inherited gap).**
> Design Owner/Admin integration detail after removal. Purpose: explain access disabled separately from cleanup. States: Removing/confirmed Removed/unknown route or custody cleanup/new setup unavailable. Data: original removal reference/time, inert grants and stage receipts, upstream account retained. Check status/Back; Set up again requires fresh registration/review/grants, never restores old access. At 390px stack facts with wrapped ids and full-width 44px actions. Reuse INT-37/50/52/76 styling only; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a glyph tokens.

**J. Exact tool definition review and published mode change (#45 inherited gap).**
> Design Owners/Admins reviewing exact saved definitions and changing modes on a published server. Purpose: approve a specific revision. States: unreviewed Block/escaped definition/missing zero-cost evidence/restriction effective/widening awaiting publication/stale/unknown. Data: schemas, descriptions, digests, mode and review revision; text is data. Review then confirm publication; no remote icons, model review or per-tool audience editor. At 390px wrap definition text in full-screen details/Back and use full-width 44px actions. Reuse INT-30/31/34/35/41/93/95; DM Sans/Mono, rice-paper/plain cards, dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens.

**K. Credential-free four facts (#45 inherited gap).**
> Design Owner/Admin remote fixture detail without an account. Purpose: represent No account needed truthfully. States: reviewed/unpublished/Applying/published nobody granted/requester-only missing assistant/current eligible/expired catalogue. Data: dated install/review/ack/grant evidence, named requester/assistant and reasons. Manage access/Check status only, no Connect. At 390px stack four cards with wrapped references, Back and full-width 44px controls. Reuse INT-06/33/37; DM Sans/Mono, rice-paper/plain cards, dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a glyph tokens.

**L. Approval naming upstream account (#49 inherited gap).**
> Extend requester approval cards to explain personal/company attribution before Approve once. Purpose: know whose upstream rights act. States: pending/expired/profile disabled or rotated/policy changed/used/outcome unknown; routine owner variant waits for routines. Data: requester, verified account/kind, bound profile revision, action and expiry, no credential. Explicit approve/deny; changing account invalidates this request, no switch inside approval. At 390px put account facts before full-width 44px buttons in scrollable details above composer. Reuse WRK-10/11, INT-20/33/95 and orange approval edge; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens.

**M. Discovery-only validation account (#50 inherited gap; INT-23 is only a result).**
> Design an admin validation-account setup/review for quarantined discovery. Purpose: read tool lists without user tool authority. States: absent/scopes consent/provider handoff/identity confirmation/checking/result/expired/wrong account/unknown. Data: admin, server/quarantine revision, discovery scopes/account/expiry/reference. Connect, confirm, check lists or revoke; no tools/call, audience grant or company selection. At 390px use stacked facts, full-screen consent/Back, wrapped scopes and 44px actions. Reuse INT-23/67–73/90–96; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens. Keep Discovery only, gives nobody access visible.

**N. First verified identity confirmation (#49/#50 inherited gap).**
> Design first account confirmation for a member or company custodian before activation. Purpose: accept provider-verified identity, never a typed label. States: verified awaiting confirmation/accepted saving/wrong identity/cancelled/expired/stale/unknown. Data: safe provider/account, owner kind, actual scopes/expiry/reference; no token/code. Confirm or cancel/check status; reconnect cannot replace a different identity. At 390px stack identity and scope cards before full-width 44px actions. Reuse INT-21/64/69–72/95/96; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens. Activation and selection remain separate.

**O. Changed scopes and reconsent (#50 inherited gap).**
> Design scope expansion review for the profile owner/company custodian. Purpose: consent to permissions newly needed by enabled reviewed tools. States: valid reads/additional scope needed/provider pending/partial consent/policy changed/confirmed/unknown. Data: current/additional scopes, affected tools, verified account and change reference. Continue to approved provider, cancel/keep permitted tools or check status; Block adds no scope. At 390px stack Before/Added permission cards, wrap names and use full-width 44px actions. Reuse INT-20/67–72/91/95/96; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens. Never auto-expand permission or resend work.

**P. Admin member-connection metadata and disable (#49 inherited gap).**
> Design bounded member/server connection list/detail for Owners/Admins. Purpose: inspect safe account state and stop releases without impersonation. States: empty/loading/connected/refreshing/needs input/admin disabled/stale/unknown/role loss. Data: member, server, safe account, scopes/expiry, blocker and reference; no secret. Filter/open/Disable with review/Cancel/Check original status; reconnect cannot clear an admin blocker. At 390px stack labelled rows with wrapped names, full-screen review/Back and 44px actions. Reuse INT-61/66/73/90–96 and PPL-20; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens.

**Q. Personal bearer detail/replacement entry (#49 inherited gap).**
> Design own profile detail and bearer replacement entry for members. Purpose: inspect safe identity/scopes and replace without token readback. States: connected/entry/saving/replaced/identity unverified/disabled/stale/service unavailable/unknown. Data: server, verified account, scopes/expiry/reference. Replace with new masked input, confirm/cancel/revoke/check status; clear input on acceptance, unknown, close and navigation. At 390px stack facts with keyboard-safe full-width entry and 44px controls. Reuse INT-61–66/90–96 and My tools shell; DM Sans/Mono, rice-paper/dog-ear/crease and #0db5cc/#f47920/#2a7d4f/#c1392b/#16191a tokens. Local revocation never promises provider-token deletion.

## 5. Ordered PRs, server before screens

Use serial branches from then-current main, no stacks. Each row lands independently and keeps unfinished
runtime paths denied. Limits include failing-first tests, schemas/catalogue, API docs, package
README/README.robot and a branch-named changes/unreleased note. Split before 600 changed lines; skip
prerequisite work already delivered.

| Order / owner / maximum changed lines | Concrete outcome | Failing-first proof before implementation |
| --- | --- | --- |
| 1 / #45 / 540 | Land its planned MCP grants/receipts, reusing #280. | Altered repeat, inactive/foreign/non-admin/stale target refused; same lost-reply receipt; person/group/assistant revokes deny real gateway with IAM delayed. |
| 2 / #45 / 480 | Land its bounded MCP access/candidate/facts reads after its review/ack/dispatch work. | Missing review/ack/intersection never Ready; no wildcard reads; applying content/IAM visible; outsider sees no rows. |
| 3 / #105+#85 / 550 | Index exact inventory inputs and replace touched #315 wildcard loader. | Real NATS/PostgreSQL/FGA: group overlap, empty revoked inventory still incomplete until receipts, 501 people/101 groups fail completeness; unrelated chat activity does not invalidate. |
| 4 / #105 / 500 | Access explanation and #315 tool-availability extension using the landed facts contract. | Direct/group/assistant reasons, absent profile vs IAM outage; own/admin privacy, foreign ids; read over two seconds not treated as lost access. |
| 5 / #105+#45 / 550 | Consequence review, enabled scopes, safe assistant dependencies and checked routine absence. | Duplicate member sources count once; unsupported routine history/missing inputs/pending publication block removal; stale relevant revision refuses, unrelated output does not. |
| 6 / #45 / 550 | Complete its reviewed removal/status and same-intent cleanup; #105 adds group impact only. | Real gateway denies before cleanup; lost replies/restart/legacy grants cannot restore; no upstream-account deletion; replay emits no external effects. |
| 7 / #49+#105 / 450 | Bind eligible company metadata/explicit selection into explanations after #49 custody/release lands. | Opt-in/connect grants nothing; default personal with no auto-selection; forged profile/account argument and missing selection send zero requests. |
| 8 / #105+#49 / 550 | Company disable impact/review binding and child status, using #49's disabled event. | Prepared old lease denied within two seconds; other selected personal profile retained; unsupported routine history refuses; unknown local cleanup never claims upstream deletion. |
| 9 / #105 / 590 | Zero-cost product-API dev gateway journey and replay proof. | Allowed group member one recorded call, outsider zero; requester-only/assistant-only zero, both one; group and assistant revokes within two seconds with IAM paused; credential-free plus explicit company attribution after dependencies. |
| 10 / #105 / 500 | Existing register/four-fact/member/group views bind real reads, including PPL-20–22. | 1280/390px, no invented counts/read-call timings/routines; unavailable vs denied; revoked-role late responses purged; direct sources retained. |
| 11 / #105 / 450 | Audience picker, prompt A, inside INT-32. | Keyboard/mobile search/overflow, selected groups with real counts, duplicate target blocked, stale/access-loss purge. |
| 12 / #45+#105 / 480 | Published single-grant editing, prompt D. | One command/receipt per grant, direct/group overlap, no-effect, IAM Applying and original lost-reply check; no republish. |
| 13 / #49+#105 / 450 | Explicit account selection, prompt C, after #49 selection API. | Named upstream/requester, Connect never selects, no fallback/foreign profile, new-turn binding and mobile confirmation. |
| 14 / #49+#105 / 480 | Company detail/disable, prompt B; reuse landed rotation/reconnect controls. | Incomplete review blocks Disable, per-stage receipt, unknown cleanup/account retained, disabled selection never falls back; mobile review. |
| 15 / #105 / 400 | Expanded consequences, prompt E, from bounded read. | Deduplicated people, last-source losses, absent vs unknown routines, limit reached prevents completion, privacy and 390px wrapping. |
| 16 / #45 / 350 | Gateway Applying/read-only recovery, prompt F. | Missing/wrong digest cannot Ready; reload checks same reference, no new POST; both widths/reduced motion. |
| 17 / #45 / 300 | Unresolved publication blocks removal, prompt G. | Pending/unknown publication disables action; only original status lookup; resolution requires refreshed review. |
| 18 / #45+#105 / 350 | Partial audience-save review, prompt H. | Saved/refused/unknown child receipts shown separately, no automatic rollback/resubmit; 390px labelled results. |
| 19 / #45 / 350 | Integration Removed detail, prompt I. | Access disabled vs cleanup unknown, preserved history/upstream account, no silent grant restoration, original change recovery. |
| 20 / #45 / 450 | Exact definition/published mode review, prompt J. | Escaped definitions, missing zero cost refuses Allow/Ask, restriction immediate/widening Applying, stale/lost reply and mobile details. |
| 21 / #45 / 300 | Credential-free four-fact detail variant, prompt K. | No account needed distinct from missing account; both grants and current ack required; no Connect control, mobile card evidence. |
| 22 / #48+#45+#105 / 450 | Bind existing comparison/removal frames to landed contracts. | Whole-server pause despite unchanged Allow, fresh-check/ack restoration, actual affected counts and separate cleanup stages at both widths. |
| 23 / #105 / 450 | Final browser journey on fresh dev installs; #106/#107 later extend it. | Create group → grant → publish → choose account → allowed call → remove member/disable → refused call → restart/replay; desktop/390px same receipts/counts. Routine pause NOT RUN until routines land. |

Execute #45 publication/transport, #48 snapshots/watch/revision and #49 custody/lease PRs in their accepted
sequences; these rows hide no large prerequisite. Prompts L–Q remain #49/#50 UI work. Test allowed member,
denied outsider, two-second revocation and requester/assistant intersection through real gateway/service
calls, never mocked FGA alone. Record upstream counts, elapsed revoke time, event ids, gateway digest/profile
generation and replay equality. Ask/read sends zero while waiting; Block/read and drift send zero. Use
zero-cost local recording upstream/scripted model fixtures; no real model is needed.

Implementation: lint/typecheck/test/check:events pass before landing and on main. Run
vitest/lint/typecheck/build under nice -n 10; no full suite/fleet batch during live-view qualification. At
most two independent review passes with a different model; remaining blockers go to owner. PRs include Why /
Functional outcome / Architecture / Evidence / Not in this PR. Source-ready needs green checks and explicit
remaining live work; done needs fresh live PASS. This design runs none; report PASS/FAIL/PARTIAL/NOT RUN
honestly.

## 6. Open questions and recommended defaults

| Question | Recommended default |
| --- | --- |
| Per-tool audiences or server grants? | Server person/group/assistant grants plus per-tool modes. Correct frames' selective assistant-grant claim. A real mcp_tool intersection is a separate decision/feature, never implied by this UI. |
| How can personal default coexist with company use? | #49 reviews eligible profile purposes; trusted explicit selection determines per-call account kind. Do not flip the whole server's singleton accountMode to company and silently affect every requester. Remain closed until its compatible contract lands. |
| Initial read limits? | 20/50 browsing, existing 100 candidate maximum, 500 expanded people and the ceilings in section 2. Overflow blocks destructive completion; owner may raise a measured bound later, never silently truncate. |
| What removal shows before routines exist? | Checked absent_on_version with explanatory words. Historical routine records or missing data mean incomplete, not zero. #106 extends the same read before creation is enabled. |
| New dependency races with disable/removal? | Deny lifecycle immediately; no multi-stream atomicity claim. New binding/firing/final dispatch recheck the source, reactions reconcile every current dependant; #106 proves its creation race. |
| Can removal silently restore grants on reinstall? | No. Keep registration terminal and old tuples inert; #45 chooses fresh identity or explicit grant cutoff for deterministic remote ids before enabling reinstall. |
| Shared-assistant native tool delivery? | Keep today's personal memory-free restriction until #89/#49 qualify requester/profile/thread isolation. Do not solve shared disk/browser isolation in this admin feature. |
| Company custodian departure? | Silo retains ownership; explicit audited admin custody transfer, or disable pending acceptance. Member departure blocks that owner's routine authority; never substitute another requester. |
| Does disable delete a token/account upstream? | No. Local authority invalidation is immediate; exact local custody cleanup is a separate receipt. No provider deletion/revocation claim without a separately supported, observed operation. |
| Any new runtime dependencies? | None planned. Reuse stdlib/installed components; any later added application package/binary needs OSI-approved licence review, with AGENTS.md's reviewed bundled-notice and Debian main OS-layer rules. |
| What costs money outside the box? | **COST OUTSIDE BOX:** paid model/API calls, cloud KMS/vault tiers, hosted registry/storage/egress, extra cloud compute or paid identity capacity. Out of scope; no purchase or call without recorded allowance. Default existing dev box/cluster/org and synthetic zero-cost tools. |

Tools remain zero-cost; all money fields are integer euro cents, never floats, and nothing spends outside the
recorded allowance or bypasses root/global/group/assistant hard stops. Dev stack first, Helm later. Tailnet
only through tailscale serve, never Tailscale Funnel. Future Zitadel changes stay solely in **OpenCrane 2
Dev**; journeys add `jente@elewa.ke` as a separate Owner user and use separate ordinary requesters. Tool
descriptions, upstream account names, scope text and Odoo data are bounded escaped data, never instructions,
authority or executable HTML. No model judges access or drift.
