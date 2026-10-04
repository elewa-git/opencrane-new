# Spec: Phase 4 — Company product

## Problem statement

People can use a personal assistant and governed tools, but cannot yet organise
company work around groups, ask a shared assistant privately, retain useful
knowledge safely or schedule recurring work. Administrators need usable member,
access, model and spending controls. New colleagues need a complete welcome flow,
and the company must be able to change owners without losing control.

## Solution

An admin invites colleagues, creates flat groups and gives each group a shared
assistant. People exchange ordinary messages without invoking AI. From their own
group message they explicitly select `@agent`, work in a linked agent session and
review a result before publishing it back. Each requester has their own execution
thread on the assistant's one computer, their own credentials and personal memory.
Shared knowledge stays in the group; children share one root budget.

People can inspect, correct and forget remembered facts, choose preferences and
pinned facts, and return after a restart without losing authorised work. Nightly
maintenance improves one memory scope at a time. Routines run as their recorded
owner using explicitly selected company connections. Every screen works at 390px.

Implementation starts only after Phase 3's fresh-journey PASS is in the ledger.
This planning change does not establish that gate: inspected main has partial
Phase 3 delivery and qualification gaps. Reuse delivered features and complete
remaining Phase 3 work there. [Ordered tickets](tickets.md) and
[decision defaults and research](decisions.md) define the boundaries.

## User stories

1. As an admin, I want to create flat groups, so that people can work together without an organisational hierarchy.
2. As an admin, I want to add and remove group members, so that access follows current membership.
3. As a member, I want to see why I have access, so that group membership and explicit grants are understandable.
4. As an admin, I want to invite colleagues and see pending, expired and wrong-account states, so that joining is recoverable.
5. As an admin, I want to change roles and remove access safely, so that leavers cannot continue work and owned work has a successor.
6. As an owner, I want to add a successor before stepping down, so that the silo always has an owner.
7. As a person, I want a direct chat with another person, so that ordinary conversation does not spend an AI budget.
8. As a group participant, I want a human group chat, so that colleagues can exchange messages without activating an assistant.
9. As a participant, I want a server-backed recent list and unread position, so that I can resume across devices.
10. As a participant, I want to archive independently of closing, so that my list choices do not end everyone else's work.
11. As a participant, I want a closed conversation to remain read-only, so that its conclusion cannot silently change.
12. As a group member, I want to use the group's assistant, so that shared tools and knowledge help my work.
13. As a requester, I want my own execution thread and account, so that another member cannot borrow my memory or credentials.
14. As an admin, I want multiple assistants for a group when needed, so that separate computers are an explicit choice.
15. As a group participant, I want to summon an assistant explicitly on my own message, so that normal messages stay human-only.
16. As a requester, I want an interrupted child creation to recover without duplicating the source message or work, so that retry is safe.
17. As a participant, I want starting, working, waiting, retrying and terminal summaries, so that I know what a child is doing.
18. As a participant, I want a full-page child with breadcrumbs and Back restoring my position, so that I can move between related conversations.
19. As a child participant, I want serial follow-up turns, so that I can refine an answer without another mention.
20. As a requester, I want approvals to stay mine, so that shared visibility does not share authority.
21. As a participant, I want to review exactly what returns to the parent, so that private work is not published accidentally.
22. As a late child participant, I want the child's existing history, so that I can catch up without receiving implicit parent or file access.
23. As a revoked participant, I want private cached content removed immediately, so that an old tab does not disclose it.
24. As a requester, I want delegated work to retain my identity and root allowance, so that retries and children cannot create extra budget.
25. As an owner, I want exhaustion and Stop to reach descendants, so that outstanding reservations do not permit more work.
26. As a person, I want preferences remembered privately, so that answers suit how I work.
27. As a group member, I want to remember shared knowledge without an approval step, so that colleagues can use it promptly.
28. As a person, I want recall to search only allowed scopes, so that useful facts never leak between people, groups or silos.
29. As a person, I want to correct a fact with its source, so that old mistakes stop influencing later work.
30. As a person, I want to forget a fact and its derived copies, so that replay or dreaming cannot bring it back.
31. As a person, I want capped preferences and pinned facts at turn start, so that important context fits without loading my entire history.
32. As a member, I want a readable memory trail and Undo, so that I understand what was stored and where.
33. As an operator, I want nightly maintenance to stay within one scope and budget, so that consolidation is safe and affordable.
34. As an operator, I want replay without model calls, so that recovery is predictable and cannot spend or change facts.
35. As a member, I want no memory saved on the assistant's disk, so that a shared computer cannot expose my private context.
36. As a new colleague, I want a four-step survey and persona review, so that my personal assistant starts with my preferences.
37. As a new colleague, I want the welcome chat to resume and end clearly, so that onboarding is complete once and remains readable.
38. As a colleague without an assistant, I want a truthful welcome state, so that I am not trapped waiting for a service I do not have.
39. As a person, I want account and preference settings with SSO fields marked read-only, so that I know which details I can change.
40. As an admin, I want to review installed tools and group access, so that installation never silently grants permission.
41. As an admin, I want to connect, verify, rotate and retire model providers, so that model availability has visible evidence.
42. As an admin, I want to manage model access and inspect routing, so that people use permitted models for their tasks.
43. As an admin, I want settled and reserved spending by paying group and assistant, so that I can set hard EUR monthly ceilings.
44. As a routine owner, I want a scheduled task with a company connection and paying group, so that it can run when I am away.
45. As a routine owner, I want pause, resume, retirement and explicit approval waits, so that automation stays under my control.
46. As an admin, I want routines to pause when their owner or connection loses access, so that they never switch identities silently.
47. As an auditor, I want membership, memory, delegation, routine and publication decisions linked to existing audit evidence, so that I can explain outcomes without opening private content.
48. As a phone user, I want each flow, refusal and recovery state usable at 390px with keyboard and assistive technology, so that company work is accessible away from my desk.

## Implementation decisions

- **Reuse the platform.** Extend existing commands, event schemas/catalogue, projections, OpenFGA, handler runtime, gateway, budget actor, bridge and Angular screens. The event store remains the only truth. Each command performs one conditional append to one stream; reactions connect streams through durable, idempotent intent. No cross-database transaction, SQL business rules, second conversation engine, server model loop or workflow framework.
- **Groups and membership.** “Group” is the product name for existing `team` events and OpenFGA relations. Keep groups flat. Membership, silo role, conversation participation and resource grants are separate. Use `team#member`, assistant `acts_for`, resource `use` and participant checks with live silo membership. Add memory read/write relations only where needed; a read grant never implies write. Owner/Admin manages local groups; identity-provider-managed membership is read-only when supplied. Removal fences new calls within two seconds and revokes affected sockets. Admin rights do not disclose personal conversations or memory.
- **Owners and leavers.** Transfer is one owner-authorised command and one event that adds the successor while retaining the old owner; stepping down is separate. Use one silo ownership stream to serialise all owner additions, removals and demotions, including concurrent attempts. Existing member-role and OpenFGA state are derived from it for owner transitions; no alternate member command may bypass its last-owner guard. Seed the existing owners idempotently before enabling these commands. Refuse self-removal of the last owner with a named successor action. Removing a member first requires reassignment or explicit retirement of owned shared assistants/routines; personal content stays private and history is retained.
- **Conversation modes.** Persist immutable `direct`, `group` or `agent_session` at creation. Direct means exactly two people; group means an explicit participant set; only an agent session binds one assistant. Refactor the existing schema's mandatory assistant field into mode-correct alternatives within the first human-chat feature. Admission and bridge dispatch both guard mode. Human messages produce no turn, computer wake, model call, approval or reservation. A typed name or plain `@agent` is not authority; a selected assistant and explicit child command are required. Creation retries return the original result without reopening or adding participants.
- **Conversation lifecycle.** Reuse HTTP commands and position-based WebSocket replay. Persist recent activity, participant unread/archive and join/end positions; close is monotonic and archive is reversible per person. Current access is checked on every history page, attachment and live subscription. Late explicitly admitted child participants see all child history, but never gain parent or private-resource access. Ended access does not retain a live subscription or permit reads beyond its boundary; current revocation can deny all reads. Unknown, foreign and never-authorised identifiers share one non-disclosing response.
- **One computer, separate requesters.** A shared assistant belongs to one group, with one computer across its conversations. Each member works as a sub-agent in their own requester-bound thread; never resume Alice's private execution context for Bob's follow-up in a shared session. Serial turns apply per agent session, while separate member sessions may run concurrently. Safe shared transcript context can be read afresh. Personal-memory-bearing execution and its reports/results stay in requester-private sessions; only shared-context output or an explicit human-reviewed release enters the shared child timeline. A task needing another computer selects another assistant. Per-thread proxy capabilities, turn tokens, model/tool grants and the requester's own profile remain mandatory. Shared desktop access requires its separate audience grant.
- **Child creation and access.** On an own, parent-visible group message, select the permitted group assistant and one paying group. Freeze an explicit child audience from currently authorised parent participants; later joins are explicit, and parent removal also ends inherited child access. Record creation intent on the parent, then idempotently create the child and its first input through separate commands. Recover after each boundary without duplicate child, message or dispatch. Recheck parent and child rights before first activation. A separately invited child-only participant may see the child but gets a restricted origin and cannot publish to the parent. Closed or revoked parents prevent new summons and publication; existing authorised children can remain independently open.
- **10a–10g presentation.** The parent keeps its ordinary source message plus a fenced summary; it never receives streamed child tokens or tool logs. Summaries cover starting, working, waiting, retrying, completed, completed after retry, failed, cancelled, closed and restricted. Reveal question text, result previews, filenames and counts only to an authorised audience; otherwise show only “Agent thread restricted”. Use immutable-id deep links, full-page child navigation, independent unread/close state, origin block and Back restoring parent position. At 390px the origin collapses and the composer remains above the keyboard. Retry counts and “nothing changed externally” require evidence, not design example text.
- **Publish-back.** The product contract takes precedence over 10d's automatic final post: completion offers a human-reviewed draft; final and interim posts both require explicit publication. Append sanitised text and authorised references to the immediate parent only, attributed to the publishing person and linked child. Publication requires current child read and parent post rights and a unique command id. Show exact audience and content before sending. A file link grants nothing: include only final assets already authorised for every intended recipient, or complete a separately reviewed existing file-share operation first. Never copy personal memory, private approval details or arbitrary child history automatically. Closing the parent refuses publication without changing either history.
- **Delegation and money.** Extend native Codex sub-agent reports with verified parent/root/thread bindings; the current singleton delegation claim is insufficient. Same computer, original requester, narrowed permissions and fixed paying group throughout a root tree. Before admitting descendants, the budget actor records one root allowance on its existing silo stream. Each call reserves within the remaining root allowance and existing global, paying-group and optional assistant ceilings; do not reserve or charge the root twice. Retries retain the allowance; serial follow-ups after terminal completion create a new root. A child cannot mint a root, change payer or expand scope. Stop, revocation, root exhaustion and any applicable ceiling fence new dispatch under old reservations and cancel descendants. Already-dispatched charges settle once; uncertainty stays held. Show root spend and child outcomes in the Subagents panel, not a new run-tree ledger.
- **Memory tools and storage.** Implement stateless network MCP 2026-07-28 `remember`, `recall`, `correct`, `forget` behind the existing authenticated proxy and gateway. ext_authz supplies a trusted, thread-bound intersection of assistant grants and requester rights, never caller-selected scope headers. The MCP rechecks scope, operation, silo and current access on every call. Store facts through `memory.written`, `memory.corrected`, `memory.forgotten`; PostgreSQL projects current facts and parameterised full-text search. Include scope identity/kind, stable fact id, revision, source references, kind, pin/expiry and encrypted payload/key reference. No embeddings, graph store, cross-group promotion or organisation/department scope. Memory content is data and cannot grant tools, change identity or override policy.
- **Memory audience.** Person scope belongs to that person; assistant-notes scope belongs to that assistant and is visible only to its permitted audience; group scope is shared with current members. Assistant notes on a group assistant are shared context and must never receive a member's personal facts. Preferences write to person scope; shared knowledge writes to the current group with no approval. Group writes bind group-visible source material or an explicit member-authored shared fact. Automatic extraction into shared scopes runs with shared context only; a private-memory-bearing thread cannot silently promote its output into group or assistant notes. A scope picker may choose an allowed destination, but is neither an approval workflow nor a way to copy another group's facts.
- **Correction and forgetting.** Conditional revisions protect edits from concurrent writers and dreaming. Corrections supersede earlier content, maintain source links and invalidate stale recall/context. Forget immediately tombstones reads, then idempotently destroys the fact's payload keys and removes projected/indexed content. Revisions and derived facts must not preserve forgotten text under a surviving key; conservatively invalidate dependent facts and require fresh source-based recomputation. Persist retrieved memory in turn evidence as fact/revision references, not raw recall payloads in permanent chat history; rebuilding context resolves only still-authorised, live references. Generated private snippets remain volatile or bound to the same deletable lineage. Replay respects tombstones and missing keys. Do not claim deletion of independently authored chat messages or backups; show this boundary and retain payload-free audit. A stale job cannot resurrect a forgotten source. Undo on a newly stored fact means forget; undoing an edit creates another checked correction, never rewrites events.
- **Turn memory without disk.** Inject only current allowed preferences and pinned facts into that requester's instructions, with one total UTF-8 cap and stable selection; retrieve other facts through bounded recall. No memory files, shared SOUL.md, prompt cache, rollout, compaction, report outbox, logs or crash dump may persist those bytes on the computer. Reuse the existing bridge, but keep memory-bearing execution state in private non-swappable RAM/tmpfs and rebuild after Pod loss from authorised server history plus fresh memory reads. Persistent workspace/browser state remains available to memory-free work. Before enabling memory, prove that local tools cannot write remembered content to persistent paths; the conservative default disables persistent file/shell/browser-write tools in a memory-bearing turn and offers a fresh memory-free work turn. A prompt instruction or end-of-turn deletion is not an isolation control. This limitation is explicit until a stronger confined path is qualified.
- **Preferences, pins and knowledge UI.** Adapt 3a–3c and 6a–6b to person, assistant notes and one group only. Personal and group writes show a receipt with Undo, never a required approval or “pending department approval”. Batched receipts and search/edit/forget use the same authorised API. Preferences and pins are versioned, visible and editable; overflow is reported and remains recallable. Decisions reuse the safe conversation audit view. The Subagents panel lists outcomes but opens a full-page child where 10c supersedes the older panel-transcript design.
- **Dreaming.** A nightly handler job per dirty scope uses the existing cheap automation model through the gateway and an explicit paying group/root allowance. A recorded active owner and assistant supply current authority through an ordinary maintenance turn on that assistant's computer, with scopes narrowed to this job; no server-side model loop or gateway identity exception. Group dreaming has no person scope, and personal dreaming has no group scope. Merge duplicates, flag contradictions and expire stale facts through source-linked `memory.corrected` events, never `memory.consolidated`. Do not silently rewrite pinned user facts or resolve contradictions as truth. Bind the input fact revisions; conflicts, forgotten sources, lost access or exhausted budget stop application. Duplicate delivery cannot rerun a completed scope/date/revision batch. An uncertain model attempt is recorded and held, not automatically called again. Replay restores recorded facts and job outcomes without any model/tool dispatch.
- **Onboarding and account settings.** Deliver #33's four-step survey, persona review/edit/restart, first chat and completion crease, including the no-Agent variant. The four screens retain preferred name/optional pronouns; role and current flat-group context; tone/length/citations; and desired tasks. Group selections describe context and never edit membership; desired tasks do not install skills or grant tools. Survey answers and approved persona revisions are events. SOUL.md names the reviewable persona, not an authoritative file on the computer; resolve it as per-thread instructions using the same no-disk boundary. The review/welcome also covers language, challenge, initiative, working habits and memory/risk boundaries; preferences never relax gateway approval policy. Keep onboarding a bounded resumable workflow: ordinary chat cannot mark it complete, and it mints no new membership/tool authority. A deterministic reviewed welcome exchange is sufficient. End with the person's answer, the assistant's confirmation and the crease; display the completed welcome as a distinct read-only list item with independent archive. Never mount participants/model pickers. In 11a, direct/group chat remains available and agent-session creation stays unavailable until actual assignment; no invented assistant name or proactive monitoring promise. Account settings replace the rail, show SSO identity read-only, and link persona/preferences and My tools.
- **Administration.** Complete the supplied Overview, People & groups, Models & providers, Integrations and Change history screens around existing APIs. Invitations use the verified identity-binding contract; email delivery unavailable means a copyable invitation link, not “email sent”. Keep role and groups separate, explain access sources and show removal consequences. Provider setup is Provider → Key → Verify → Models → Access → Done; clear accepted keys from browser memory, show stored/reachable/model-answer evidence separately, warn before a budgeted test and permit “connected, not tested”. Retirement lists dependencies and requires replacement or explicit pause. Tool modes remain Allow automatically / Ask / Block, with Ask available for reads and drift quarantined. Spending reuses integer-cent EUR monthly/daily rules, settled/reserved totals and fixed paying-group attribution; no currency or price engine. Unknown outcomes offer Check status for the original change reference, never a fresh submit.
- **Routines.** A routine records owner, assistant, instructions, schedule/time zone, company connection/profile and paying group. Default to a daily or weekly schedule with explicit next UTC occurrence. pg-boss schedules intent; `routine.due` with a stable occurrence id starts one authorised agent-session turn through existing admission. Recheck owner membership, assistant, grants, connection, tool policy, payer and budget at each firing and call. No personal credential fallback. Ask pauses for the recorded owner with the existing use-once card and expiry; Block refuses. Pause/resume/retire and cancellation are event-backed; an ownership/connection change invalidates old pending authority. Missed or duplicate occurrences never cause a burst or repeat an uncertain external effect. Recent outcomes link to the ordinary session, audit and spending views; no workflow designer or skill registry.
- **Whole-screen contract.** Every screen and state in this spec and every ticket gets desktop/390px comparison evidence, including dialogs, empty/loading/error, unknown-outcome, access-changed and long-content states. Reuse current Angular components and supplied tokens, not handoff HTML or obsolete app names. At 390px use stacked admin rows, a top navigation menu, full-width primary actions, 44px targets, keyboard focus, polite status announcements and reduced motion. Mount only mode-applicable controls; unsupported functions are absent or truthfully labelled.

## Testing decisions

Prefer the existing authenticated HTTP/WebSocket → real gateway → recording
upstream seam with real disposable NATS, PostgreSQL and OpenFGA. Extend current
conversation, approval, budget, gateway, member-join and replay suites. Test public
outcomes, actual upstream counts, projected results and event history rather than
helper structure. Use controllable clocks for schedules, expiry and revocation.
Use real pinned Codex in gVisor and browser checks for thread/disk isolation;
stubs alone cannot prove these. Reuse existing visual comparison tooling.

| Journey / refusal set | Required observable proof |
| --- | --- |
| Membership and ownership | Create group, grant via membership, revoke within two seconds; same-id cross-silo requests deny; unavailable/stale OpenFGA fails closed; simultaneous last-owner demotions leave an owner; replay reconstructs all tuples. |
| Human chat and lifecycle | Direct/group send, refresh/reconnect, pagination, close/archive/unread and participant changes; no model/tool calls, computer wake or budget reservations; mode mutation, nonparticipant, closed and foreign requests refused. |
| Shared assistant and child | Two simultaneous requesters on one computer retain their own credentials, tokens and memory; crash at each creation boundary yields one child and activation; shared follow-up changes requester without inheriting private context; all 10b/10g states and back-navigation behave at 390px. |
| Child disclosure and publish | Frozen audience, explicit late child join/full history, independent parent rights, removed participant browser purge, guessed id and late HTTP/socket responses; restricted summary has no counts/text/assets. Publish retry creates one immediate-parent entry; parent close/revoke or private asset denies. |
| Delegation and money | Concurrent children and retries consume one root allowance/charge; altered root, payer, requester, computer or scopes denied; Stop/exhaustion cascades before further dispatch including old reservations; retain unknown usage and settle late observations once. |
| Memory rights and quality | All four tools in each allowed scope; deny cross-user, unauthorised assistant notes/group, cross-group and cross-silo reads/writes/search/pins; forged scope headers ignored; group member writes create no approval; realistic exact/partial terms, ranking, bounded results and empty search. |
| Memory persistence and deletion | Correction races, pin/preferences cap with multibyte text, stale turn invalidation, forget after dreaming/duplicate merge, key-deletion failure and restart, tombstones and dependent facts after full replay; compare fact ids/revisions/results with model endpoint disabled and zero calls. |
| No memory on disk | Plant distinct personal/group canaries; inspect persistent volume, Codex rollouts/compactions, SOUL/config, bridge outbox, tool logs, temporary files and crash artefacts during execution, after kill/resume and after replay. Attempt local file/shell/browser persistence. No private canary in another requester prompt, shared notes, instructions, summary or published content without explicit authorised sharing. |
| Dreaming | Advance a clock across nightly boundary; one scope/date batch, capped spend, duplicate merge, contradiction flag and expiry; pinned fact protection; crash/lost model reply and concurrent correct/forget cannot rerun effects or revive content; missing owner/grant/model/payer/price denies. |
| Admin/onboarding | Invite and wrong/expired account, no email service, role denial, safe removal and transfer; survey reload/edit/restart, no-Agent welcome, ordered completion and read-only/archive; SSO fields read-only; keys absent from storage/events/logs; verify skip and unknown-save reconciliation. |
| Routines | One daily/weekly firing, time-zone/DST edge, two schedulers, restart, missed occurrence and overlap; company identity at upstream; revoked owner/company profile or budget denies; Ask only original owner, timeout stops, no silent account switch; replay does not fire. |
| Regressions | Retain Phase 2 reload/Pod recovery and Phase 3 Odoo read/approved write, policy refusals, paying-group hard stop and audited takeover. Memory-capable recovery does not restore private session files. |

Final qualification runs the MVP journey twice from fresh dev stacks, with two
ordinary members, two groups with distinct facts, a child-only invitee, an admin
and a separate silo. Include sign-in → onboarding → group creation → human chat →
child → reviewed publication → delegation → memory correction/forget/dreaming →
routine → admin revoke/owner transfer → restart/replay. Each feature ticket owns
its focused proof; the final ticket exercises their combined user journey and
records gaps rather than consolidating unfinished implementations.

Receipts name source SHA/image digests, freshness, commands, expected/observed
results and safe artefacts, using PASS/FAIL/PARTIAL/NOT RUN. Paid tests use only the
remaining authorised shared 500-cent envelope with its provider-side cap;
otherwise record NOT RUN. Source gates and independent review remain required
before landing. A fresh dev-stack PASS makes no managed-cluster/backup claim.

## Out of scope

Nested groups, organisation/department memory, cross-group memory sharing,
Cognee, pgvector, document-ingestion knowledge platforms, general scope promotion,
a new policy language, general A2UI/elicitation catalogues, automatic unreviewed
publish-back, skill authoring/marketplaces, workflow builders, autonomous
cross-computer delegation, SSO directory synchronisation, bulk CSV export and
new sign-in methods. Memory-free workspace files remain Phase 2 features.
Do not add unsupported design controls such as global sign-out without an
existing verified endpoint. Phase 5 retains Helm, managed-cluster HA/failover,
backup/restore qualification and full production hardening.

## Further notes

The plan supersedes historical KurrentDB, SQL authority, SSE, organisation-memory
and server-side run compiler clauses in the copied product documents. Preserve
their user-visible outcomes, immutable modes and non-disclosure rules using OC2's
events, WebSockets and computer bridge. The design hierarchy and automatic final
publication are explicitly reconciled above. #33 and #24 are existing work items;
the orchestrator links this plan to them rather than publishing duplicate issues.

## Self-review

Compared this draft against every phrase of Phase 4's done-when, CON-01–CON-09,
the current source, all specified design frames and issues #33/#24/#41. Corrected
these gaps before committing:

- Split human direct/group admission from assistant work; an enum already present on main does not mean those modes work.
- Made group members requester-bound sub-agents, including Bob's follow-up in Alice's shared child, rather than sharing a private Codex context.
- Replaced hierarchy/approval knowledge designs with flat scopes and approval-free group writes; protected shared assistant notes from personal memory.
- Replaced automatic final publication with reviewed text and independently authorised asset references; added child-only late joins and restricted origin/navigation.
- Added a real no-disk boundary covering Codex rollouts, compaction, outbox and local tools, with an explicit restricted execution default and Pod-loss recovery proof.
- Required forgetting after consolidation, payload-key destruction, descendant invalidation, stale-job fences and replay with model endpoints disabled.
- Added single-stream last-owner races, group payer/root allowance races, company-account routine approval/owner revocation and no-Agent onboarding. Checked the four survey frames: restored name/pronouns and task preferences, without allowing survey choices to grant membership or install skills.
- Mapped each screen to 390px evidence and every done-when clause to an owning ticket in the decision log. Added final fresh combined qualification while retaining the Phase 3 start gate.

These are planning corrections, not implemented capabilities. Phase 4 live
journeys, independent review and runtime checks are **NOT RUN** by this change.
Documentation validation is recorded in [decisions.md](decisions.md).
