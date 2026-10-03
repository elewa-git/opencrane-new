# Spec: Phase 3 — Governed work

## Problem statement

People can talk to their assistant, but cannot yet trust it with company tools.
They need to control consequential actions, use their own accounts, understand
refusals and spending, and take over the computer when needed. Administrators need
to know which tools are available and what actually happened.

## Solution

On a fresh dev stack, a person connects their Odoo account, asks their assistant
to read a record, reviews a proposed write and approves it once. Odoo applies
that person's rights. They can capture a screenshot, view the computer and take
control while the agent pauses. Refusals, spending and takeover have an audit trail.

This extends Phase 2's model gateway, budgets, computer and integrations register.
Start implementation after Phase 2's live journey PASS. Source checks alone do
not complete Phase 3. [Ordered tickets](tickets.md) and
[decisions and research](decisions.md) define the delivery boundaries.

## User stories

1. As an admin, I want Allow automatically, Ask or Block for each installed tool, so that I control what assistants may do.
2. As a requester, I want a permitted automatic write to run without another prompt, so that my chosen policy is respected.
3. As a requester, I want to see the exact action, target, data sent, external system, account and consequence, so that I can make an informed decision.
4. As a requester, I want to approve or deny once on my phone, so that work can continue away from my desk.
5. As a requester, I want pending and answered cards restored after reconnect, so that I do not approve twice.
6. As a participant, I want someone else's approval to remain theirs, so that shared work does not share authority.
7. As an admin, I want remote and hosted MCP servers validated before discovery, so that adding a tool cannot open an unsafe network path.
8. As an admin, I want to review tools and grant access before publication becomes usable, so that installation does not grant everyone access.
9. As an admin, I want changed tools held for review, so that a server update cannot silently expand its powers.
10. As a member, I want OAuth or bearer connections tied to my profile, so that tools act with my own rights.
11. As a team requester, I want my assistant to use my account, so that a colleague's account cannot be borrowed.
12. As an admin, I want an explicit company connection option, so that shared-account use is visible and deliberate.
13. As a member, I want revocation and expired connections to stop calls promptly, so that old access cannot continue.
14. As a requester, I want an Odoo read and approved write using my account, so that useful work keeps Odoo's access checks and attribution.
15. As an owner, I want EUR hard budgets and one paying group, so that shared work cannot double-charge or escape a ceiling.
16. As a requester, I want a clear budget or permission refusal, so that I know why work stopped and what can happen next.
17. As a participant, I want an authenticated view of the shared computer, so that I can follow its work without controlling it.
18. As the requester, I want exclusive takeover after the agent has paused, so that we cannot type over one another.
19. As a participant, I want an authorised screenshot in the conversation, so that visual progress survives reload.
20. As an operator, I want uncertain effects separated from confirmed outcomes, so that recovery does not repeat a write.
21. As an auditor, I want decisions, approvals, credential releases, spend and effects joined by request, so that I can explain an action without seeing secrets.
22. As a requester, I want allowed package installs, Git access and browsing, so that the computer can work without bypassing the gateway.

## Implementation decisions

- **One decision boundary.** agentgateway enforces; the existing decision service decides. Every call verifies both short-lived tokens strictly, binds the live computer generation and thread, and reads requester, assistant, delegation, membership/role/teams, conversation, tool/destination grants, mode, approval, connection/profile and paying-group budget. OpenFGA checks requester ∩ assistant on every decision; lag or missing context denies. Revocation takes effect within two seconds. No stale permission cache; memory scopes remain empty until Phase 4.
- **Policy before approval.** Modes are per installed connection and tool revision, edited by Owner/Admin. Read-only hints suggest Allow, destructive or unclear hints suggest Ask; neither hint grants authority. Unreviewed/new tools are Block. Explicit Allow includes the first permitted write. Ask remains available for reads. Block, revoked access and quarantine cannot be overridden by an approval.
- **Durable, use-once approvals.** Use `tool.approval_requested`, `approval.decided`, `approval.used` and `approval.expired`. Bind silo, requester, conversation, logical turn, assistant, server/tool revision, connection/profile and argument digest. Consume by conditional append before forwarding; a race admits at most one retry. Recheck all current authority. A lost reply never makes approval reusable. Awaiting a person preserves the logical turn; cancellation or a new turn invalidates it.
- **Lossless argument binding.** Digest a versioned RFC 8785-style form: sorted object keys, stable string escaping, ordered arrays and exact original number text. Reject duplicate decoded keys, `__proto__`, `constructor`, malformed JSON and non-object/batch envelopes; use maps for tool lookup. This deliberately differs from RFC 8785 number normalisation. The reviewed arguments and forwarded bytes must agree; ordinary parse/stringify is insufficient.
- **The 8g card.** Use the orange approval crease, complete action ledger, Approve/Deny, expiry and conditional sign-in notice. Only the requester can decide. Persist safe review details bound to the digest; do not reconstruct them from a tool name or model prose. Missing consequential details disables approval. Restore pending cards above the composer; terminal cards collapse to one line. All screens work at desktop width and 390px with keyboard access, readable states and 44px touch targets. General choice/free-text elicitation is deferred.
- **Install and watch.** Register URL or pinned image → validate → quarantined `server/discover` and paginated tool discovery → review schema digests/modes → publish route, CEL allowlist and ext_authz binding → grant through OpenFGA → connect → watch. Reuse OC1's guarded remote transport behind the gateway to validate every DNS answer and pin the checked address through TLS on actual calls, not just registration. Redirects and private/metadata/mixed answers are refused. Hosted images require trusted signatures, scans and licence evidence, run in `<silo>-mcp`, and reach only their declared upstream. They never run in the gateway or computer. Drift quarantines the server until re-review; publication is not Ready until applied configuration is acknowledged.
- **MCP 2026-07-28 only.** No handshake, session, GET stream or legacy fallback. Every network request supplies version/capabilities in `_meta` and matching method/tool headers. Require a complete DiscoverResult. Allow only `server/discover`, `tools/list`, `tools/call`; reject case variants, unknown methods and `resources/*`. Bound full requests/responses, never authorise truncated bodies. Generate a small header allowlist per route; strip computer/turn tokens and arbitrary headers, and overwrite credential headers on every route. Extend the authenticated per-thread computer proxy; keep shell/desktop callers excluded. Local stdio's temporary version exception does not permit network bypass.
- **Personal connections.** OAuth and bearer secrets live in the secret store, referenced only by id in events. Default to one stateless deployment with a per-call credential lease for the requester's selected profile. The gateway injects it; identity arguments confer no rights. Team assistants use the requester, never the assistant owner. Company connections are explicit opt-ins. Startup-only servers get one isolated instance per user/profile, scaled to zero when idle, with short-lived material only. Audit every release before forwarding; refresh, rotation and revocation do not expose secrets.
- **Odoo.** Run Odoo Community (LGPL-3) on the dev box with synthetic data and two users with different record/write rights. Use the OSI-licensed, narrowly scoped MCP choice in the decision log; its licence is checked separately from Odoo. Demonstrate a bounded read and an approved draft-record write, verified in Odoo under the requester's identity. No superuser fallback, arbitrary ORM method tool or Enterprise dependency.
- **Money and effects.** Extend the existing integer-cent price table, single-writer actor and streamed usage settlement. Reserve prompt bound plus output bound times `n`, rounding up, against global, paying-group and optional assistant ceilings once. Keep `n = 1`; refuse unsupported multiplicity and unpriced calls. Monthly periods reset at 00:00 UTC on the first; retain the existing daily safety cap and uncertain reservations. Exhaustion stops new dispatch even under old reservations and cancels affected descendants. Read final SSE/native LLM usage; handle the gateway's fractional timestamp defect. Missing usage holds the reservation; authorised evidence resolves uncertainty without retrying an external write.
- **View, takeover and screenshots.** Promote S0.5's separate authenticated proxy and Kasm server permissions. Participants view; only the current requester controls. Shared-desktop access also requires the computer audience grant. Before control, fence all new work on that computer, interrupt all active threads and confirm local tools are quiescent. In-flight external effects remain observable or uncertain. Persist takeover, then admit one writer. Close writer tunnels before release/resume. Disconnect, expiry, revocation or crash leaves the agent paused until safe recovery. Screenshots use the existing file path and conversation permissions; no public Kasm or image URL.
- **Egress and audit.** Deliver #18 through separate short-lived command/desktop capabilities, destination policy, SSRF/DNS controls and per-turn logs; never reuse Codex's caller capability. Audit decisions including refusals, context digests, approvals, credential releases, reservations, effects, egress and takeover. Event appends are authoritative; PostgreSQL, OpenFGA and gateway configuration are rebuildable. Each command conditionally appends to one stream; reactions reconcile effects without replaying them. Extend the typed catalogue and its documentation together. No SQL business rules or OC1 orchestration framework.

## Testing decisions

Test user-visible outcomes through the authenticated API → real gateway → recording
upstream seam, with real NATS, PostgreSQL and OpenFGA. Reuse the model gateway,
bridge, catalogue replay and S0.2/S0.5 suites. Add focused parser vectors for
lossless digests, and real gVisor/browser checks where HTTP cannot prove isolation.
Assert actual upstream call counts, Odoo record changes, event replay and races.
Mocks alone cannot establish these guarantees.

Every refusal below must produce a clear safe reason, no newly authorised effect,
and an audit record when persistence is available. If audit is down, deny and retain
safe gateway evidence for reconciliation; never claim that a missing event exists.

| Journey refusal set | Required cases |
| --- | --- |
| Identity and access | Missing, forged, expired or mismatched tokens; wrong silo/user/thread/conversation/computer generation; ended turn; inactive member/assistant/computer; missing requester or assistant grant; revocation within two seconds; stale/unavailable IAM or OpenFGA. |
| Policy and approval | Block, unreviewed tool, unknown tool, quarantine; pending/denied/expired/cancelled/used approval; foreign requester; changed arguments, turn, profile or schema; simultaneous decisions/consumption; required step-up absent; lost acknowledgement. |
| Protocol and input | Wrong/missing version or capabilities; method/tool header mismatch; handshake/session/GET; batch, duplicate/forbidden keys, case variants, resources and unknown methods; oversized/malformed input; hidden or precision-losing arguments. |
| Install and destination | Private/metadata/loopback/IPv6/mixed DNS, rebinding and redirect; invalid TLS; unsigned/changed/unscanned/infected/unlicensed image; unavailable scanner; failed publication; drift and stale watch evidence. |
| Connection and Odoo | Missing/revoked/expired/wrong profile; secret-store/refresh/release-audit failure; forged credential headers or identity arguments; implicit company fallback; Odoo ACL/record-rule refusal; uncertain write without automatic retry. |
| Money | Missing/non-positive/fractional/overflow output bound; unsupported `n`; unknown model/tariff/cost; concurrent reservations at each ceiling; exhaustion with outstanding work; period rollover; missing/duplicate/conflicting/late usage; budget actor unavailable. |
| Computer access | Nonparticipant view/screenshot; participant control; wrong requester; forged Origin/session/CSRF; raw RFB input/clipboard/oversize from viewer; slow viewer; pause failure, two controllers, expiry/revoke/disconnect/crash during control. |
| Egress and persistence | Direct socket/DNS/provider access; Codex proxy/token theft by tools; forged/expired/foreign command capability; disallowed host/port/tunnel; revoked turn; event append failure; replay must not dispatch or release secrets. |

The final journey runs twice from a fresh dev stack: install/connect, Odoo read,
Ask and approved write, denial and automatic policy, screenshot, participant view,
audited takeover, every refusal set and budget exhaustion. Include simultaneous
requesters on one assistant using their own profiles, via seeded authorised team
fixtures until Phase 4 supplies group creation. Capture desktop/390px comparisons.
Receipts name SHA/image digests, freshness, commands, expected/observed outcomes and
safe artefacts, using PASS/FAIL/PARTIAL/NOT RUN. Keep the shared live-provider
qualification envelope separate from product limits.

## Out of scope

Group administration and child-chat UX, memory, routines, delegation orchestration,
the general elicitation/A2UI catalogue, full Odoo coverage, production ERP data,
currency conversion/invoice reconciliation and a new policy language. Phase 5 owns
Helm, managed-cluster HA/failover, encrypted CSI/backup qualification and full
production hardening. Phase 3 retains the two-replica/PDB/high-priority requirement
for decision service, OpenFGA and budget availability; the actor remains one fenced
writer. A dev-stack PASS makes no managed-cluster claim.

## Self-review

Compared the draft with Phase 3's done-when, all eight MCP install steps, the IAM
context table and every gateway hardening item. Added the missing computer MCP
route, safe 8g review details, lossless number binding, configuration acknowledgement,
drift quarantine, audited credential leases, scoped hard stops and uncertain-effect
resolution. Added multi-thread takeover fencing, explicit screenshot permissions,
the #18 command/browser isolation, streamed usage and timestamp regressions. The
second check made post-publication SSRF transport and broker IPC explicit, and
corrected the file contract to a Phase 2 prerequisite. Replaced vague “negative
tests” with the refusal matrix above; separated existing code, spike evidence and
live qualification. All Phase 3 capabilities are **NOT RUN** by this documentation
change.
