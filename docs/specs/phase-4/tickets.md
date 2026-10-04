# Phase 4 — Company product tickets

<!-- markdownlint-disable MD024 -->

Each ticket is a future issue body, following the Phase 3 format. The orchestrator
adds the published spec as Parent and resolves P4 ids to issue links. **Do not
publish these drafts automatically.** P4-2 delivers existing #24; P4-19 and P4-20
deliver #33 as linked slices, not duplicate onboarding/transfer issues.

All tickets inherit the [spec](spec.md), [decision defaults](decisions.md) and the
Phase 3 fresh-journey PASS start gate. Each is one demoable whole-feature PR;
estimates include tests/docs and exclude generated files. Keep each at or below
about 1,500 changed lines. Reuse delivered APIs/UI and standard platform features.
If measured scope exceeds that ceiling, split another complete user outcome before
building; no backend-only, screen-only or later consolidation PR. At most two
stacked PRs. A blocking edge names a required capability, not an organisational
preference; independent tickets can proceed once the shared gate passes.

Every ticket updates event schemas/catalogue and owning docs together, makes one
conditional append per command and includes current access/refusal, idempotency
and replay checks where relevant. Replay never repeats effects. Every screen,
modal and state needs desktop/390px comparisons, 44px phone targets, keyboard
focus, readable status words and reduced motion. This applies even where a ticket
reuses an existing screen. Required root lint/typecheck/test/check:events and
separate web build/tests remain landing gates. Source readiness names remaining
live qualification; a skipped check is NOT RUN. Fixes remain in their feature PR.

**Critical path:** Phase 3 live PASS → P4-1 → P4-7 → P4-14 → P4-15 → P4-16 → P4-17 → P4-27 → P4-28.
This is the expected isolation/qualification path, not a measured duration claim.
Child publication joins through P4-5 → P4-8 → P4-9 → P4-10; memory deletion through
P4-12 → P4-13; onboarding through P4-19 → P4-20; routines through P4-24 → P4-25.
P4-28 also requires every other feature ticket. Initial parallel frontier:
P4-1, P4-2, P4-4, P4-21. Work the frontier, not an artificial linear queue.

## P4-1 — Create flat groups and manage membership

### What to build

An Owner/Admin creates a named group, adds/removes members and sees their effective
access and source. Reuse the existing team catalogue and OpenFGA model; no group
hierarchy or rename project. Budget: 1,000–1,400 lines. Decisions D01–D03.

### Acceptance criteria

- [ ] Group create and membership commands emit existing team events; current memberships replay into the content projection and `team#member` OpenFGA tuples without direct tuple edits.
- [ ] Existing silo membership is mandatory. Duplicate commands converge; concurrent add/remove follows stream order; foreign silo, non-admin and inactive-member requests deny.
- [ ] Removing membership blocks group-derived access within two seconds, including live subscriptions and calls; lagging/unavailable IAM denies until caught up.
- [ ] People & groups lists flat groups and their members, distinguishes local versus supplied identity-provider-managed membership, and explains access sources without implying conversation or private-memory access.
- [ ] Compare desktop/390px list/detail/add/remove, empty/error/access-changed and long-name states. Rebuild the projection and OpenFGA, then demonstrate the same allowed and refused access.

### Blocked by

None (can start after the shared Phase 3 gate).

## P4-2 — Transfer ownership without losing the last owner (#24)

### What to build

An owner appoints a successor, both retain owner rights, and the previous owner
can later step down. Deliver the backend conflict and admin review screen as one
feature. Budget: 1,000–1,450 lines. Decision D04.

### Acceptance criteria

- [ ] One transfer command conditionally appends one event on the silo ownership stream; successor must be an active member. The old owner remains until a separate step-down command.
- [ ] Bootstrap the current owner set idempotently from existing events before enabling owner edits. Every owner addition/removal/demotion uses this stream's last-owner rule; member-role commands cannot bypass it.
- [ ] Event-derived membership/role views and OpenFGA converge on both owners; effective authority fails closed during incomplete projection. Replay yields the same set.
- [ ] Race two last-owner removals/demotions, retry transfer after lost acknowledgement, and refuse non-owner, inactive/foreign successor and last-owner removal. At least one owner remains in authoritative events.
- [ ] Audit records who transferred to whom. The 5c conflict names the rule and offers appointing another owner. Desktop/390px review, success, unknown-outcome and conflict states pass; no private content becomes visible through ownership.

### Blocked by

None (can start after the shared Phase 3 gate; delivers #24's outcome).

## P4-3 — Invite members and manage their roles and departure

### What to build

Complete People & groups and the inline invite panel around existing verified
invitation acceptance. Admins can inspect a member, change non-owner roles and
remove access with ownership consequences. Budget: 1,250–1,500 lines. D03–D05.

### Acceptance criteria

- [ ] Invite events bind the intended verified OIDC identity, expiry and role using existing join rules; acceptance cannot invent membership from an email address alone. Reuse deterministic assistant provisioning, including an explicit no-assistant choice.
- [ ] Inline invite supports active/pending search, truthful counts, expiry and wrong-account states. With no mail delivery, show a copyable bound link; a link is not proof of email delivery or permission to invite outside the configured organisation.
- [ ] Roles and groups are separate. Role changes/removal use current admin authority; owner transitions route through P4-2. Owned shared work must be reassigned or explicitly retired before removal; show retained private history and return semantics.
- [ ] Removal invalidates current access and sockets within two seconds. Rejoin creates only explicitly regranted access; old grants, credentials and ownership are not silently restored.
- [ ] Show “What this person can use — and why” using actual grants; unavailable dependency/ownership data blocks destructive completion. Audit and replay preserve invitations, changes and refusals.
- [ ] Compare chat 13b and admin 1a/1b, 5a–5e at desktop/390px, including read-only role, unknown outcome and last-owner conflict. No CSV export or directory-sync engine.

### Blocked by

P4-1 (group membership), P4-2 (owner-change guard).

## P4-4 — Start and use direct person-to-person chats

### What to build

Choose one colleague in New session and exchange ordinary messages with reload
and live delivery. Adapt the existing creation/admission seam to mode-correct
records as part of this visible feature. Budget: 1,000–1,450 lines. D06.

### Acceptance criteria

- [ ] Direct creation binds exactly two active people and no assistant; server derives silo/caller and verifies the selected colleague. Existing agent sessions and legacy missing-mode replay retain their behaviour.
- [ ] Immutable mode is validated in command, projection/protocol and bridge dispatch. Direct sends produce message events but zero agent turns, computer claims/wakes, model/tool calls, approvals or reservations.
- [ ] Idempotent creation/send retries return the original result; changed payload with the same key refuses. Mode edits, assistant binding, third participants, closed and nonparticipant posts refuse.
- [ ] Both people can read/reconnect in position order; guessed/foreign ids disclose nothing. Use authoritative history and subscription access, not local-only messages.
- [ ] New-session To line and direct transcript/composer work at desktop/390px. No model, Stop, memory or assistant controls mount in direct mode; loading/error/reconnect states are visible.

### Blocked by

None (can start after the shared Phase 3 gate).

## P4-5 — Create human group chats and manage participants

### What to build

Select several colleagues or a flat group to create an ordinary group chat.
Participants exchange messages; authorised participant changes remain independent
of IAM group membership. Budget: 1,100–1,450 lines. D03, D06–D07.

### Acceptance criteria

- [ ] Group creation snapshots explicit active participants and optional group association; no assistant binding. Group membership is not automatic private-conversation access. Every ordinary send has zero AI/computer/budget activity.
- [ ] The creator manages participant additions/removals under current access. Bind participant join/end positions; adding a group later does not mutate past audience invisibly.
- [ ] Duplicate creation or participant commands converge; authorisation, closed-state and concurrent removal checks run at admission and live delivery. Revoked browser state is purged and subscriptions end.
- [ ] The To line derives direct/group/agent-session modes before first send; the persisted mode then stays fixed. Unsupported combinations refuse rather than creating a local draft that appears saved.
- [ ] Group list/transcript/people picker works at desktop/390px, including long names, no participants available, denied selection and stale UI response. Replay preserves participants and mode.

### Blocked by

P4-1 (group selection), P4-4 (mode-correct human messaging).

## P4-6 — Resume, archive and close conversations independently

### What to build

People find recent conversations, retain unread positions across devices, archive
for themselves and permanently close authorised conversations. Budget:
1,000–1,400 lines. D07.

### Acceptance criteria

- [ ] Server-backed list sorts by recent activity, supports bounded pagination and exposes only authorised metadata; unread/read cursors and archive are durable per participant, not browser authority.
- [ ] Close is monotonic and read-only; archive/unarchive changes one person's list only. Retry cannot reopen, restore removed participants or recreate a closed conversation.
- [ ] Join/end boundaries survive replay and reconnect. Missing/foreign/never-authorised ids share the same unavailable response; removed access purges content, drafts, cursors, filenames and late responses.
- [ ] Agent-session messages still follow serial turn admission; direct/group remain human-only. History/live handoff has no duplicates or gaps after refresh and dropped connections.
- [ ] Desktop/390px recent/archived lists and close review cover empty/loading/pagination/unavailable/long-title states. Existing personal chat and file access remain checked.

### Blocked by

P4-5 (all three modes and participant changes).

## P4-7 — Work with a shared group assistant in private member threads

### What to build

An admin creates a group assistant and a group member starts their own session on
its one computer. Two members can work concurrently without sharing execution
identity. Budget: 1,250–1,500 lines. D08–D09.

### Acceptance criteria

- [ ] Create a team-kind assistant with group ownership, explicit grants and one lifecycle-managed computer. More assistants are an explicit route to more computers; repeated creation cannot claim duplicates.
- [ ] Group `acts_for` permits each member's requester-bound sub-agent/thread; no member resumes another member's execution context. Two simultaneous member sessions use distinct live tokens and their own profiles.
- [ ] Bind an explicit authorised paying group when shared work is created. The payer survives retries and cannot change mid-root; personal work retains its existing installation default.
- [ ] Gateway checks current requester ∩ assistant rights, membership/role/team, live computer generation, thread, conversation, approval, credentials and money. Missing or revoked context denies; shared desktop grants remain separate.
- [ ] Admin create/detail and member assistant selection/session screens work at desktop/390px, including provisioning/failure/removed/busy states. Event/OpenFGA replay restores ownership and grants.
- [ ] Prove two live requester profiles at a recording upstream and rejection of swapped thread tokens. Memory remains disabled until P4-15; do not fabricate shared personal context.

### Blocked by

P4-1 (real group membership and access).

## P4-8 — Summon one recoverable child chat from an own group message

### What to build

Select `@agent` in a group composer and open the linked child. The parent message
survives a failed start and retry creates only one child and first turn. Budget:
1,250–1,500 lines. D10.

### Acceptance criteria

- [ ] 10a autocomplete lists only permitted assistants; no assistant hides the affordance, denied summon stays plain text, and busy capacity shows a durable queued/starting state. Plain mention text alone never dispatches.
- [ ] Source must be the requester's own parent-visible group message. Record idempotent parent intent, freeze the authorised shared audience and payer, then create a mode-bound child plus first input through separate one-append commands.
- [ ] Inject crash/lost acknowledgement after source append, intent, child create, first input and activation. Retry/reconciliation returns the same child/message; no duplicate source or external dispatch.
- [ ] Recheck current parent/child participation, assistant grants and closed state before activation. Group membership alone does not grant child access, approval or private resources.
- [ ] Initial summary and full-page immutable-id route retain independent parent/child history. Creation failure offers retry of the same intent. Desktop/390px composer, source summary, queued and failed-start states match 10a/10b.

### Blocked by

P4-5 (human parent), P4-7 (shared assistant and requester threads).

## P4-9 — Follow child progress and continue with serial turns

### What to build

Complete 10b/10c/10e/10f/10g: child navigation, finite summaries, requester-correct
follow-ups and safe access changes. Budget: 1,200–1,500 lines. D07, D10–D11.

### Acceptance criteria

- [ ] Starting, working, waiting, retrying, completed, completed-after-retry, failed, cancelled, closed and restricted summaries use observed state; no invented attempt count or unsupported “nothing changed externally”. Parent receives no streamed tokens/tool logs.
- [ ] Full-page child has breadcrumb, collapsible origin, stable ids, run completion crease and independent unread/close state. Back restores the parent source-message position; phone layout follows 10f.
- [ ] Follow-up starts one serial turn with its sender as requester, uses only shared safe context and never resumes another member's private thread. Approval cards remain actionable only by their bound requester.
- [ ] Explicit late child admission permits existing child history but no parent/resource access. Child-only readers see a restricted origin; current parent removal ends inherited child rights without granting rights through cached audience.
- [ ] Restricted viewers see no question, title, filenames, counts or result preview. Revocation purges cached data and ignores late HTTP/socket replies; foreign/guessed ids use the same unavailable state.
- [ ] Desktop/390px comparisons cover every summary, long breadcrumbs, origin/Back and access change. Reconnect/replay preserve serial order and separate positions.

### Blocked by

P4-6 (lifecycle and unread), P4-8 (durable child).

## P4-10 — Review and publish a child result to its immediate parent

### What to build

A participant previews a final or interim update, then explicitly posts it to the
parent with a child link and eligible final assets. Budget: 900–1,350 lines. D12.

### Acceptance criteria

- [ ] Completion prepares a draft, never an automatic final post. The review names the exact text, audience, origin and publishing person; explicit publication appends to the immediate parent only.
- [ ] Require current child read and parent post authority. Child-only access, parent close/revocation, changed review payload and foreign ids refuse; a lost reply/retry creates one parent entry.
- [ ] Sanitise text and references; no automatic private memory, raw tool output, approval arguments or child history. Never mutate an existing parent entry.
- [ ] Assets must be final and already readable by the intended audience, or pass the existing separate explicit share operation first. A child link or filename cannot confer file access; refuse inaccessible assets without disclosing them.
- [ ] 10d final/interim presentation identifies “from Agent thread” and who published; link resolves under current rights. Desktop/390px preview, success, conflict, unknown-outcome and denied-asset states pass.

### Blocked by

P4-9 (child lifecycle/access and states).

## P4-11 — Delegate within one root allowance and stop descendants

### What to build

A requester delegates to native sub-agents on the same computer, sees their
outcomes, and can stop the entire tree without giving it extra budget. Budget:
1,250–1,500 lines. D13.

### Acceptance criteria

- [ ] Verify native parent-child reports and bind root requester, parent turn/thread, same computer, immutable paying group and narrowed scopes before a child receives a token. Extend singleton delegation validation; arbitrary claimed ancestry refuses.
- [ ] The existing single-writer budget actor conditionally records a root allowance and each call's reservation on the silo budget stream. Remaining root capacity and global/group/assistant ceilings are checked together; root accounting never duplicates the provider charge.
- [ ] Concurrent children, retries and lost replies cannot enlarge the root or change payer. New roots are server-admitted only; serial follow-ups after completion get a new allowance. Unknown charges stay held and late usage settles once.
- [ ] Stop, root/ceiling exhaustion and revoked access fence all further dispatch including old reservations, revoke descendant tokens and cancel active children; record already-dispatched/uncertain effects honestly.
- [ ] Subagents panel 6a shows running/completed/failed/cancelled outcomes and root reserved/settled cents, with authorised full-page thread links. Desktop/390px Stop, partial outcome and exhaustion states pass.
- [ ] Native same-computer sub-agent race and kill/recovery tests prove at most the admitted spend and no unapproved effect. Replay rebuilds results/budgets without spawning children.

### Blocked by

P4-7 (requester-bound shared threads), P4-9 (child navigation and outcomes).

## P4-12 — Remember and recall facts through the scoped memory MCP

### What to build

An authorised caller stores and finds person, assistant-notes and group facts
through the real gateway, and sees a bounded memory list/search view. Budget:
1,200–1,500 lines. D14–D16.

### Acceptance criteria

- [ ] `remember` writes `memory.written`; PostgreSQL projects current scope facts with full-text search. Stable ids, revision, source, kind, pin/expiry and encrypted payload/key references are typed and replayable.
- [ ] MCP 2026-07-28 discovery and calls use the existing proxy/gateway contract. Only ext_authz-issued scope/operation context is trusted, bound to current silo/requester/assistant/thread; forged headers, stale grants and direct access refuse.
- [ ] Enforce person ownership, assistant-notes audience and group membership on read/write/search. Group members can store shared facts with no approval; no organisation/department scopes or cross-group copying.
- [ ] Shared writes require group-visible source material or explicit member-authored shared facts. Personal-context model output cannot populate group notes/memory automatically; assistant notes are not a bypass for personal facts.
- [ ] Bounded search ranks realistic exact/partial terms, returns only current permitted facts and no forbidden-scope counts/snippets. Duplicate remember keys return the same fact; unavailable persistence never reports success.
- [ ] Minimal list/search/store UI has desktop/390px empty, stored, denied and unavailable states. Replay with external effects disabled produces identical facts/search; memory is not yet injected into Codex.

### Blocked by

P4-1 (group scopes), P4-7 (assistant audience and live thread authority).

## P4-13 — Correct and forget memory without resurrection

### What to build

People edit or forget a remembered fact and see its current state after reload,
replay and concurrent changes. Budget: 1,100–1,450 lines. D17.

### Acceptance criteria

- [ ] `correct` and `forget` MCP/UI paths enforce the same operation-specific rights as remember. Expected revisions guard concurrent edits; retries converge, stale edits show refresh/review rather than overwriting.
- [ ] Correction records `memory.corrected` with source links and supersession. Forget records `memory.forgotten`, immediately hides the fact, then idempotently deletes payload keys and projection/search text.
- [ ] All revisions and derived duplicates preserve deletability: forgetting a source invalidates dependent facts and cannot leave its text decryptable in a derived payload. Missing keys/tombstones remain effective on replay. Turn evidence stores fact/revision references instead of permanent raw recall payloads; dependent private snippets are volatile or deletable with their source, so context reconstruction cannot reintroduce forgotten facts.
- [ ] Test failure between append, key deletion and projection removal; restart completes cleanup without restoring recall. Stale correction/dream input cannot resurrect forgotten content.
- [ ] UI shows corrected/forgotten/conflict/cleanup-unavailable states and explains that independent chat messages/backups are not erased by this action. Undo of a store means forget; edits get a new checked correction.
- [ ] Desktop/390px edit, forget review and receipt states pass. Replay with model endpoint disabled yields the same remaining facts, zero model calls and payload-free audit evidence.

### Blocked by

P4-12 (memory facts and scopes).

## P4-14 — Resume private member work without persistent execution context

### What to build

A group member resumes work after Pod replacement while private execution
instructions and tool results remain off the computer's persistent disk. Establish
this boundary before injecting memory. Budget: 1,100–1,500 lines. D18.

### Acceptance criteria

- [ ] Keep sensitive Codex sessions/rollouts/compactions and bridge report payloads in protected, non-swappable RAM/tmpfs; audit all caches/logs/crash paths. Shared persistent SOUL.md and prompt files are absent.
- [ ] Existing server conversation events remain the durable transcript. On restart reconstruct only authorised safe context into a fresh requester-bound thread, with new tokens; never recover another member's private thread or automatically repeat an uncertain tool call.
- [ ] Preserve the one-computer-per-assistant lifecycle and ordinary memory-free workspace/browser persistence. Explicitly refuse local persistent file/shell/browser writes in the restricted execution mode; offer a fresh memory-free turn when those tools are required.
- [ ] Real pinned Codex under gVisor handles turn completion, Stop, crash and reconnect in restricted mode. Canary instructions/results never appear in the volume, outbox, session files, shared notes or another member's prompt, even during execution or attempted file writes.
- [ ] Show recovering, resumed, unavailable context and restricted-tool explanations in the existing chat at desktop/390px. No fake completed turn after lost context; safe recovery remains a visible whole outcome.
- [ ] If the pinned harness cannot enforce these controls, keep memory admission disabled and record the failing condition; no prompt-only workaround or deferred security proof counts as PASS.

### Blocked by

P4-7 (member-specific execution and shared computer).

## P4-15 — Start each turn with isolated preferences and pinned facts

### What to build

A member's assistant remembers their preferences and current group facts in the
right thread, with bounded initial context and recall for the rest. Budget:
1,150–1,500 lines. D15–D19.

### Acceptance criteria

- [ ] Resolve allowed scopes at turn start through current requester ∩ assistant authority. Inject preferences and pinned facts into that thread only, within the total UTF-8 cap and stable ordering; expose omissions without dropping stored facts.
- [ ] Native Codex calls all four MCP tools through the authenticated per-thread forwarding path. Ended/forged/mismatched thread, revoked scope and stale context fail closed with no secret or scope headers forwarded from clients.
- [ ] Two members concurrently receive only their person scope plus authorised shared scopes. Preferences always stay personal; group learning uses shared-context-only extraction and no approval. No personal facts enter shared assistant notes or instructions. Private execution reports/results stay in requester-only sessions; shared child output uses shared context or an explicit reviewed release, including after a late participant joins.
- [ ] Correction/forget/revocation invalidate affected live context: stop or rebuild before the next dispatch and do not keep forgotten facts in a resumed private session. A newly active requester cannot inherit a previous requester's memory.
- [ ] Test multibyte cap boundaries, pin overflow, denied scopes and Pod replacement. Inspect disk while canaries are in prompts/results, including attempted tool persistence; P4-14 restrictions stay enforced.
- [ ] Chat receipts show stored scope and Undo without approval, with desktop/390px denied, omitted-context and memory-unavailable states. Full recall stays bounded and available for allowed omitted facts.

### Blocked by

P4-13 (all four tools and invalidation), P4-14 (qualified runtime boundary).

## P4-16 — Inspect and manage knowledge, preferences and pins

### What to build

Complete the knowledge trail and settings for personal, assistant-notes and group
facts using the delivered memory APIs. Budget: 850–1,250 lines. D19.

### Acceptance criteria

- [ ] Adapt 3a–3c and 6b to the three permitted scopes, source links, edit/forget, pin/unpin and batched receipts. No department/org selector, cross-group store or group approval queue.
- [ ] Preferences and pins are event-backed edits affecting future/rebuilt turns. Cap overflow remains searchable with a clear omission notice; pinning never expands access.
- [ ] Personal auto-store and member group-store show receipts with Undo. Shared assistant notes disclose their audience; inaccessible fact ids and counts are non-disclosing.
- [ ] Decisions tab reuses authorised audit records; memory tab includes only visible facts. Stale responses after revoke cannot repopulate the panel; independent source resources still require access.
- [ ] Desktop/390px comparisons cover list/search, batch, source unavailable, conflicting edit, forget, empty and access-changed states; narrow panels become a full-width view. No new knowledge platform or embedded transcript renderer.

### Blocked by

P4-15 (working isolated turn memory).

## P4-17 — Dream nightly within one memory scope and budget

### What to build

Nightly maintenance merges duplicates, flags contradictions and expires stale
facts, with a visible source-linked result and reproducible replay. Budget:
1,200–1,500 lines. D20.

### Acceptance criteria

- [ ] Existing pg-boss/handler scheduling selects dirty scopes with stable scope/date/input-revision keys. Bind an active owner, assistant, one scope and explicit payer/root allowance before dispatching a maintenance turn on that assistant's computer for a cheap-model call through the gateway. No server-side model loop or special identity bypass.
- [ ] Inputs never combine person/group/assistant-note scopes. Group dreaming has no personal memory; missing/revoked owner/grants, unavailable IAM, unknown price or exhausted budget prevents dispatch.
- [ ] Record duplicate merges, contradiction flags and expiry as `memory.corrected` with source ids/revisions; never emit `memory.consolidated`. Preserve pinned user facts and do not invent resolutions of contradictions.
- [ ] Concurrent correction/forget, duplicate delivery, scheduler overlap, crash and lost model acknowledgement cannot apply stale output or trigger uncontrolled new calls. Uncertain attempts remain held with visible status.
- [ ] Forget a source after a merge and replay: neither its text nor dependent content returns. Rebuild facts/job state with model/tool endpoints disabled and assert zero external calls.
- [ ] Memory trail shows what changed, source, time and maintenance failure/held-spend states at desktop/390px. Controlled-clock integration demonstrates the nightly boundary, budget cap and idempotent replay.

### Blocked by

P4-11 (root allowance), P4-15 (isolated memory), P4-16 (reviewable memory trail).

## P4-18 — Use account and personal preference settings

### What to build

Complete 13a's account page and links to My tools and remembered preferences,
using the workspace navigation and existing identity/connection contracts.
Budget: 700–1,100 lines. D21.

### Acceptance criteria

- [ ] Settings replace the rail with Back to workspace. Show verified identity and silo; SSO/invite-managed fields are read-only and name their source. Do not invent department hierarchy or device counts.
- [ ] Editable preferred display name and preferences use authorised event-backed commands; SSO identity and role cannot be changed through them. Another person's settings and stale/revoked sessions refuse.
- [ ] Personal assistant card links to persona review once available; My tools links to existing requester-owned connection management. Do not show a working global sign-out without a supported endpoint.
- [ ] Desktop/390px account, preferences, no-assistant, saving/unknown/access-changed states pass. Reload/replay restore the saved choices and links without browser-local authority.

### Blocked by

P4-16 (preference editing and memory trail).

## P4-19 — Capture and approve the four-step onboarding persona (#33)

### What to build

A new colleague completes the four-step survey, reviews their personal assistant's
persona, and can edit or restart it before entering the welcome chat. Budget:
1,000–1,400 lines. D18, D21–D22.

### Acceptance criteria

- [ ] Frames 1e–1h retain preferred name/optional pronouns, role/current flat-group context, tone/length/citations and desired tasks. The review/welcome covers language, challenge, initiative, habits and memory/risk boundaries. Group/task choices grant no membership/tools and install no skills; save progress as onboarding events and resume after reload.
- [ ] Review/edit/replace/restart creates immutable persona revisions; explicit approval selects the revision for subsequent personal turns. Preferences cannot weaken IAM, budgets or tool-approval policy.
- [ ] “SOUL.md” is the reviewable persona rendered as isolated per-thread instructions, never a persistent shared file or independent source of truth. No survey answer leaks to group settings or another member.
- [ ] Onboarding commands require the existing verified person and cannot mint membership, grants or workspace authority. Duplicate submits and concurrent devices cannot approve mismatched revisions.
- [ ] Desktop/390px comparisons against all four survey frames plus review, validation, save-unknown and restart states. Persona persists by replay, not local storage; a no-assistant member can progress to the truthful welcome variant.

### Blocked by

P4-3 (invite and provisioning/no-assistant choice), P4-18 (account/persona entry point).

## P4-20 — Complete the resumable welcome chat (#33)

### What to build

Continue the survey in a bounded welcome exchange, end it once with the completion
crease, and retain it as a read-only welcome entry. Budget: 800–1,250 lines. D22.

### Acceptance criteria

- [ ] Frames 1i/5a use the approved persona and a versioned deterministic welcome script; owner answers are event-backed, ordered and resumable. A model is optional later, not necessary for completion.
- [ ] Finish with the person's answer, assistant confirmation and 8a crease. Only onboarding completion authority advances the workflow; ordinary conversation messages and forged step ids cannot do so.
- [ ] Completed welcome is a distinct read-only list entry, independently archivable, without manufacturing an ordinary conversation/agent turn. Retry or concurrent completion cannot produce a second finish.
- [ ] 11a works without an assistant: direct/group drafts work, agent-session creation waits for assignment, and copy promises no unconfigured monitoring or invented assistant; later provisioning does not rewrite the recorded welcome or silently reopen it.
- [ ] No participants or model picker mounts anywhere in onboarding. Desktop/390px comparisons cover all named frames, interrupted/reload/read-only/no-Agent and completion states; no memory is saved on the computer.

### Blocked by

P4-19 (approved persona), P4-6 (list and participant-local archive semantics).

## P4-21 — Connect and verify model providers from admin settings

### What to build

An admin connects or rotates a provider key and sees separately whether it was
stored, reachable and tested with a model. Reuse existing provider/gateway/secret
contracts. Budget: 1,200–1,500 lines. D23.

### Acceptance criteria

- [ ] Six steps follow admin 3b: Provider, Key, Verify, Models, Access, Done. Commands record configuration intent/reference; secret values exist only in the secret store and transient input, never events, logs or browser storage.
- [ ] Clear key input on server acceptance. Lost save acknowledgement returns to outcome unknown and Check status for the original change; repeat cannot rotate/create a second secret accidentally.
- [ ] Show saved/reachable/model-answer evidence separately. Warn before a priced, reserved test; skipped test is “connected, not tested”, not Ready/test-chat PASS. Unknown/unpriced cost denies.
- [ ] Owner/Admin only; forged Origin, wrong silo, revoked role, secret-store/gateway failure and stale configuration deny safely. Record the exact verification revision and invalidate it after rotation.
- [ ] Desktop/390px provider list/detail/setup/replace-key and shared admin states match 1c–1e and 3a/3b/3d. Replay reconstructs metadata without revealing keys or rerunning verification calls.

### Blocked by

None (can start after the shared Phase 3 gate; uses delivered secret/gateway contracts).

## P4-22 — Manage model access and retire providers safely

### What to build

Admins see enabled models, routing and who can use them, edit grants and replace
or pause dependants before retiring a provider. Budget: 950–1,400 lines. D23–D24.

### Acceptance criteria

- [ ] Reuse the eleven-model registry, price table and explicit task routing. Change model grants through events/OpenFGA for people, groups and assistants; requester ∩ assistant remains mandatory.
- [ ] Access explanations distinguish direct/group grants and missing connection/model availability. UI cannot enable unsupported models, stale grants or route around gateway policy.
- [ ] Retirement review lists actual assistant/routine dependencies and requires a valid replacement or explicit pause. Fence new calls at retirement; already-dispatched usage still settles, with no automatic repeat on a different provider.
- [ ] Group revocation applies within two seconds. Concurrent configuration, role revocation, missing IAM and stale test evidence produce truthful refused/unknown states.
- [ ] Desktop/390px model table, access editor, dependency review and retired-provider states match admin 3a/3c/3d. Replay preserves choices without reconnecting or calling providers.

### Blocked by

P4-1 (group grants), P4-21 (provider lifecycle).

## P4-23 — Review tool access and company connections for groups

### What to build

Finish admin Integrations Tools & access using the Phase 3 installer/policy/profile
flows, with real group audiences, access explanations and company-account
attribution. Budget: 900–1,350 lines. D24.

### Acceptance criteria

- [ ] Display Installed, Connected, Allowed for and Available to the assistant as separate facts from current evidence. Publication and installation never grant access by themselves.
- [ ] Edit people/group/assistant tool grants through events and OpenFGA. Modes remain Allow automatically / Ask / Block on every tool, including reads; new/drifted schemas remain blocked/quarantined until reviewed.
- [ ] Explicit company connection selection states that the upstream sees the company account while OpenCrane records the requester. Personal profiles remain the default for member turns; no silent company fallback.
- [ ] Review shows enabled-tool scopes, affected people and dependent routines/assistants. Removal requires an explicit consequence review and does not delete the upstream account; unknown outcome reconciles the same change.
- [ ] Real gateway calls demonstrate allowed group access, denied outsider, two-second revocation and requester ∩ assistant. Replay recreates grants and register state without installing/calling tools.
- [ ] Desktop/390px admin 4a–4g coverage reuses existing screens; correct historical mode labels and 4f's old-version-serving claim to current quarantine rules.

### Blocked by

P4-1 (real group audience).

## P4-24 — Schedule one company-connected routine and inspect its run

### What to build

A permitted owner creates a daily/weekly routine with one assistant, company
connection and paying group, and sees a single governed firing in its session.
Budget: 1,200–1,500 lines. D25–D26.

### Acceptance criteria

- [ ] Creation records owner, assistant, instructions, explicit company connection/profile, payer, schedule/time zone and next occurrence through routine events. Show “Runs as” and upstream company-account attribution.
- [ ] pg-boss emits one stable `routine.due` intent per occurrence; reactions create one input/root through existing assistant admission. Test two schedulers, duplicate delivery and crashes between due/message/activation.
- [ ] At firing and every call recheck owner membership, assistant, grants, company profile, tool mode and payer/root/global/group/assistant budget. Missing context, personal-only connection or revoked owner/connection pauses/refuses; no credential fallback.
- [ ] A simple permitted automatic tool call uses the company account at a recording upstream and produces a result linked to the session, audit and one spend attribution. Unknown external effects are never automatically retried.
- [ ] Show create/detail/next-run/recent result at desktop/390px, adapted from admin 7d; replay rebuilds routine state without firing. Controlled-clock test covers daily/weekly and time-zone/DST calculation.

### Blocked by

P4-7 (shared assistant), P4-11 (root allowance), P4-23 (company connection selection).

## P4-25 — Pause, approve and recover routines safely

### What to build

Routine owners can pause, resume, edit or retire work, answer governed Ask calls
and understand missed or interrupted runs. Budget: 1,000–1,450 lines. D25–D26.

### Acceptance criteria

- [ ] Event-backed pause/resume/update/retire preserve occurrence identity; paused/retired schedules dispatch nothing. Changes never rewrite an active root's identity, payer, reviewed arguments or connection.
- [ ] Ask waits for the recorded owner with the existing bound use-once card. Only that owner can approve; expiry, Block, removal, connection revision or ownership transfer invalidates pending authority and stops work.
- [ ] Revoked owners/connections pause the routine visibly. Reassignment is explicit, revalidates grants/payer and affects new occurrences only; it never silently selects the admin's credentials.
- [ ] Non-overlap is default. Record missed/overlapping occurrences as skipped; resume schedules the next future occurrence and never backfills a burst. “Run now” is an explicit new occurrence, not retry of uncertain work.
- [ ] Current owner can stop the active root; cancellation cascades while retaining observed/uncertain charges. Safe retry only reuses a proven-not-dispatched intent.
- [ ] Desktop/390px schedule changes, Ask (7e), paused/access-changed/skipped/unknown outcomes and recent history pass. Restart/replay with external calls disabled cannot produce extra firings.

### Blocked by

P4-24 (one real governed routine firing).

## P4-26 — Inspect spending and adjust company ceilings by group

### What to build

Complete the existing Models & budgets view with real group/assistant selection,
root/routine attribution and understandable refusal/uncertainty drill-downs.
Budget: 800–1,250 lines. D13, D27.

### Acceptance criteria

- [ ] Show global, paying-group and optional assistant monthly limits, existing daily safety cap, settled and reserved cents separately; same provider charge contributes once to each applicable aggregate without duplicate billing.
- [ ] Configure EUR cents as safe integers through the existing fenced budget actor. Preserve UTC monthly reset and unknown reservations across rollover; zero means hard stop and missing prices never mean free.
- [ ] Named group/assistant selection comes from current authorised data. Shared work/routines cannot change payer after admission; changing the personal default affects only new roots.
- [ ] Root/descendant/routine drill-down joins safe audit ids and explains blocked versus already-dispatched/uncertain charges without exposing private prompts or credentials. Lowering a ceiling applies the existing hard-stop cascade.
- [ ] Desktop/390px summary, edit/conflict, exhausted, rollover and unknown-spend states pass. Reuse existing gateway/actor race tests with real groups and prove replay agrees with totals; no new finance engine.

### Blocked by

P4-11 (root accounting), P4-24 (routine attribution).

## P4-27 — Give admins an actionable overview and change history

### What to build

Finish the admin shell as a task list across members, tools, models, spending and
routines, with truthful state/recovery actions and safe audit details. Budget:
800–1,200 lines. D28.

### Acceptance criteria

- [ ] Overview orders unknown/interrupted work, needs input, failures and Ready evidence; each row has one action and names affected people. No invented health score or unimplemented skill/workflow navigation.
- [ ] Navigation exposes People & groups, Models & providers, spending, Integrations, Routines and Change history only to permitted roles; read-only states name the role needed.
- [ ] Every mutation returns an existing event/command change reference with a status read. Check status reconciles unknown outcomes; only proven unchanged failures offer retry. Do not build a second generic change ledger.
- [ ] Audit adds membership/ownership, child publication, memory metadata, root delegation and routine links to existing evidence. Private text still requires scope/conversation rights; admin status alone never reveals memory or secret values.
- [ ] Desktop/390px admin 2a–2c and shared state 6a comparisons cover stacked rows, top navigation, stale data timestamp, busy row, unknown outcome and access change. Screen data restores after projection replay with no effects.

### Blocked by

P4-3 (member management), P4-10 (publication), P4-17 (memory maintenance), P4-22 (models), P4-25 (routine lifecycle), P4-26 (spending).

## P4-28 — Qualify the complete company product on fresh installs

### What to build

Run and record the combined MVP journey on fresh dev stacks, exercising every
Phase 4 done-when clause with real dependencies. This is qualification automation
and evidence, not a consolidation feature PR. Budget: 900–1,400 lines. D29.

### Acceptance criteria

- [ ] Run the journey twice from fresh installs: sign-in/invite/onboarding, group membership and shared assistant, direct/group human chat, child/follow-up/reviewed publication, delegation/root exhaustion, memory CRUD/search/pins, nightly dreaming, routine/company-account approval, admin revoke/transfer and return after restart.
- [ ] Exercise all spec refusal rows with two people, two groups, a child-only invitee and another silo. Record no upstream dispatch for refused calls, no AI side effects for human chat, two-second revocations and preserved last-owner authority.
- [ ] Prove approval-free group memory writes, simultaneous personal/group isolation, zero memory canaries on persistent disk, correction/forget after merge and replay with all model endpoints disabled. Zero model calls on replay is a counted assertion.
- [ ] Replay PostgreSQL and OpenFGA from events, inspect search/UI/audit/budget outcomes, replace the computer Pod and recover only authorised context. Duplicate routine/delegation delivery creates no extra effect or spend.
- [ ] Retain Phase 2 and Phase 3 regression journeys, including Odoo rights/approved write, hard stops and audited takeover. Mark inherited failures explicitly; a rendered screen or successful source suite is not live completion.
- [ ] Link desktop/390px comparisons for every delivered screen/state, accessibility results, SHA/image digests, freshness, commands, expected/observed results and safe artefacts. Report PASS/FAIL/PARTIAL/NOT RUN per capability and list every untested condition.
- [ ] Paid calls require the established remainder of the shared 500-cent test envelope and provider cap; otherwise paid qualification is NOT RUN. No Phase 5 managed-cluster, failover or backup-restore claim.

### Blocked by

P4-1, P4-2, P4-3, P4-4, P4-5, P4-6, P4-7, P4-8, P4-9, P4-10, P4-11, P4-12,
P4-13, P4-14, P4-15, P4-16, P4-17, P4-18, P4-19, P4-20, P4-21, P4-22, P4-23,
P4-24, P4-25, P4-26, P4-27 (all company-product capabilities).
