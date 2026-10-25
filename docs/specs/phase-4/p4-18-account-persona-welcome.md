# Account settings, approved personas and a resumable welcome

10 October 2026. Design only for [#100](https://github.com/elewa-git/opencrane-new/issues/100),
[#101](https://github.com/elewa-git/opencrane-new/issues/101) and [#102](https://github.com/elewa-git/opencrane-new/issues/102),
under #82 and #33. Repository: `<worktree>`, branch `work/p4-18-design`. HEAD, local origin/main and GitHub
main matched `dd3880237b87f98bab1793a5e1ceec1addfdfbbc`.

## 1. Basis, delivered parts and scope

Read the requested issue bodies, Design sections and discussions; #33, #82, #85, #88, #94–#98, #49/#50 and #121; merged #162,
\#285 and #322. Read AGENTS.md, plan.md, the engineering standard, glossary, Phase 4 tickets/spec/decisions, the event catalogue,
the lifecycle spec, handoff PLAN (API A, ONB rows/gap), ADR decisions and relevant code. The accepted notes are
`<home>/.fleet/reviews/p4-15-design.md` and `<home>/.fleet/reviews/p4-6-design.md`; #97's accepted defaults remain in
force. Inspected all 26 ONB phone states, representative desktop states and INT-60/61, THR-01–04/14 references under
`<home>/dev/design-handoffs/v2/`. Frames prove design only.

\#162 supplies `/account`, Preferences, Assistant and My tools navigation and the settings shell. Account currently reads only
the session name. `/auth/me` reports authentication and token claims, not current membership, editable settings, email or
onboarding progress. Its roles must not become current role authority. `/api/chat`'s `personalContext` supplies
member/displayName/assistantId, but a missing computer row cannot distinguish no assignment, provisioning and read failure.
`/api/assistants` currently lists team assistants only. `assistant.settings_changed` names persona in changedFields but stores
no persona text; its catalogue's next-wake configuration wording is unsuitable for private personas.

\#285 preserves invitation `personalAssistant: none|provision`, legacy provision and bootstrap. #85 later chose verified email
binding at acceptance without a Zitadel directory credential; do not restore its older invite-time directory lookup promise.
Return uses a new member id. #322 supplies conversation archive/read events and projection replay, without public commands or a
bounded list. Current main also contains activity/close metadata; #88 remains unfinished. #94 supplies person preferences and
authorised remember; #95 correction/forget and #98's preference filters/editor/trail remain prerequisites. #96/#97 private
admission stays disabled until its real disk/swap/core and forwarding checks pass. No new dependency is needed.

Deliver current-session account editing, four saved survey steps, immutable persona review and a model-free welcome. Keep D21:
no global sign-out, devices, billing, hierarchy or new IdP feature. The existing current-browser logout is not an all-device
logout service. Choices grant no membership, tools, skills, desktop access, models or budget authority. Onboarding gates only
its own screens; an existing member's workspace rights come from IAM.

## 2. Ownership, data and isolation

Bind every route to configured silo + verified issuer/sub + the current admitted member id. Reuse #121's shared member guard,
strict same-origin writes, typed refusals and no-store. Do not add another authorisation preamble while #121 is pending: public
new routes wait for that guard. An authenticated but unadmitted account uses invitation acceptance, never a survey command to
join. Reject supplied person/silo/principal/assistant/grant claims, including admin requests for another person's persona. A new
admission cannot recover old settings or welcome.

Use one new `personal-<memberId>` subject, wire `ev.personal.<memberId>`, for account override, survey, persona and welcome. Its
identity is the admitted person, independent of an assistant. Name and onboarding content share ordering; they never enter
shared chat feeds or OpenFGA. Keep remembered preferences on existing `scope-<scopeId>` subjects, kind `preference`, owner equal
to this member. Do not add a second preferences stream/table or assistant-wide persona.

Account separates preferred display name from SSO name/email and organisation. Name/email come from verified session claims;
absent claims say “Not provided”, never guess from email. Name the configured provider, and label an invitation email separately
if displayed. Silo name comes from configured silo/org events. Role comes from current membership/ownership; groups come from
current flat membership with local/supplied source. All are read-only here. Preferred name is optional, trimmed, bounded to 200
characters and rejects control characters; null clears the override. Own UI labels fall back to SSO name, then admitted display
name. Changing it changes no identity, role, groups or previously approved persona text.

Survey name is an onboarding answer. Prefill from account once; changing it does not secretly submit an account command. Explain
the distinction and offer the separate account save later. Step 2 records work description and, if needed, selected current
group ids as descriptive context. Verify selections against current membership; never create membership. Do not copy group facts
or mutable group names into persona text automatically. Task choices express wishes.

Render SOUL.md as a private review and a server-authored per-thread instruction envelope. Inside that envelope put JSON-escaped,
labelled persona data; never promote user text to a system/developer message, interpolate TOML, load its URLs or execute an
embedded instruction. The fixed trusted rules say that wishes cannot weaken Ask/Block, IAM or budgets. Gateway checks enforce
this even if malicious text asks otherwise. Escape browser text; render no raw HTML. Default persona use is the requester's
personal-assistant turns only. Person preference facts may reach their separately authorised private team turns through #97,
never group settings.

Use existing server encrypted-payload custody for survey, persona and welcome answers, keyed by a namespaced personal identity,
not a fabricated conversation. Add a small membership-event reaction to prepare that key even for `none`. Backfill joined/bootstrap events through the existing handler upgrade,
checking current membership first. It writes infrastructure custody only, is idempotent and never creates an assistant. Commands use an existing key and append once; if
custody is unavailable, refuse without saving. Keys stay in the secret store adapter; events contain references/ciphertext only.
Replay reads keys, never provisions them. Display-name events contain the explicit account label; no survey content enters the
public member record. Restart retains encrypted history; it is not deletion. Memory Forget does not erase independently authored
survey/persona/welcome text. Never generate these records from recalled memory facts.

When qualified, resolve the exact approved revision server-side before a personal turn. Use #97's preparation/evidence path and
\#96's fresh restricted process/thread, requester-bound tokens and non-swappable RAM/tmpfs. No SOUL.md file, shared prompt,
rollout, compaction, report, log or cache on computer disk. Memory-free turns carry neither persona nor private history. Keep
the existing 24 KiB history and combined frame/tool limits. Persona preparation alone does not qualify the runtime, wake a
computer, call a model or install tools.

Share the 16,384-byte initial block cap: fixed warning + escaped whole persona + preferences and pins, including
metadata/delimiters. Reserve the whole persona first, then apply #97's existing category/id prefix, 32 fact-reference ceiling
and no backfill. Persona counts towards bytes, not the 32 fact references; record its separate revision reference. Refuse an
oversize whole persona, never truncate it. Suggested persona text limit is 4,096 UTF-8 bytes, as ONB-21. Omitted facts stay
searchable/recallable. Do not enlarge the cap or turn bytes into token counts.

Load history/content first with its own ten-second deadline and incremental summaries; then start the two-second write/turn
check. Watch only the small member/assistant/team/payer/grant streams actually granting that operation. Settings normally need
member authority only. Keep personal-stream versions and memory revisions as content checks/CAS, outside access watching. Use
exact subjects and indexed identity candidates, no wildcard history reads in these new paths. Reads check current access once
with no authorityFence. Ordinary turn/file/settings activity cannot deny a reader or close a viewer. Keep authority.test.ts and
authority-volume.test.ts unchanged; add separate public regression cases.

## 3. Commands, events and replay

Proposed contracts below are additions, not existing APIs. Every new personal event has schemaVersion 1, memberId, exact
subject, scoped commandId, server source and checked principal. Validate identity in the registry parser as well as
commands/projections. Use envelope event id, time and global position for receipts. Bound commands and encrypted envelopes to 16
KiB; survey free-text and welcome answers to 4 KiB, task choices to 16, optional pronouns to 100 characters. Reject overflow
explicitly. Validate enum/step/script identifiers server-side.

| Command | Event on personal stream | Checks and result |
| --- | --- | --- |
| Save/clear preferred name | `account.display_name_changed` | Expected name position; changes only preferredDisplayName. |
| Save survey step | `onboarding.survey_step_saved` | Current survey generation, expected progress position, step 1–4 and typed answers; require preceding steps. Editing an earlier step invalidates later current answers and candidate eligibility, preserving history. |
| Restart survey | `onboarding.survey_restarted` | Expected progress; new generation, empty current answers. Approved revision remains active. Before completion, old welcome answers become historical; after completion, welcome stays complete. |
| Review/edit/replace persona | `onboarding.persona_revised` | Complete current survey for generated proposal; full checked replacement for edit. New monotonic revision/id with survey generation, renderer version and encrypted text. Old revisions never change. |
| Approve this version | `onboarding.persona_approved` | Exact current candidate revision/id and expected approval/progress position. Explicit selection, not an approval of “latest”. |
| Start welcome | `onboarding.welcome_started` | Never completed before; current survey complete; approved eligible revision for assigned variant. Freeze welcomeId, scriptVersion, survey generation, persona revision, actual assignment/variant and start time. |
| Answer next question | `onboarding.welcome_answer_recorded` | Current welcome/generation/script, exact next step id and expected answer position; one answer per step. Final acknowledgement is explicit. |
| Complete welcome (internal only) | `onboarding.completed` | System principal `onboarding-completion`; verify start, all ordered answer ids and exact final answer. Store confirmation key, scriptVersion, variant and completion reference once. |
| Archive/restore welcome | `onboarding.welcome_archive_set` | Own completed welcome, expected archive position; participant-local set, independent of completion. |

Survey: step 1 preferred name + optional pronouns; step 2 work description + current group context; step 3
tone/length/citations; step 4 desired tasks + optional own task. Continue saves one step before advancing; Back only navigates,
and Skip only clears an optional field. Review creates a deterministic proposed revision. Include defaults for language,
challenge, initiative, optional habits and memory/risk boundaries in its visible text. Edit that text through ONB-21; no fifth
survey or generated-persona model call is needed. Restart records a new generation; finishing it creates a new immutable
candidate, never overwrites or approves. Unloaded progress cannot be treated as empty: Start again creates only a RAM draft
until a fresh server version allows a checked restart/save. No blind reset during an outage.

Approval selects r2 even if its text is later replaced by r3. Show “Approved r2; new draft r3”; r2 remains active until explicit
approval of r3. An old device reviewing r2 cannot approve r3, nor newly approve r2 after r3 became the current candidate.
Identical approval repeats return the original receipt. Bound approval and candidate creation to the same personal stream CAS;
there is no cross-stream “check then select latest” race. New approval affects future turns, not already dispatched work. Check
its version immediately before private dispatch; record the used revision and never hot-swap text inside a running turn.

Preferences use #94 remember and #95 correct/forget with expectedRevision and #98's filters, pins and trail. ONB-52 can edit one
explicitly selected settings-preference fact containing language/challenge/initiative/habits as a bounded structured user
statement. One Save changes that one fact atomically; generic preferences remain visible through MEM-50. If several facts
express conflicting wishes, show them for human review; do not guess a singleton/latest winner. Add creates a fact, edit targets
its returned id/revision, and removal means Forget. Unpin does not disable a preference. Survey/persona wishes are an approved
baseline, not silently copied preference facts. Current live preference facts guide future answers; conflicts with the baseline
are disclosed for review. Saving memory preferences neither approves a persona nor reopens a welcome. Memory deletion never
imports an old preference snapshot on replay.

Use an immutable TypeScript script table, initially `welcome-v1`, with one ordered question: “What would make this week easier?”
The answer is a bounded statement, not a task dispatch. Label the assigned speaker as a scripted welcome, without working/model
evidence. Its confirmation says “Your welcome is complete. You can start a new chat when you are ready.” Avoid the frame's
“preferences are saved” unless real memory receipts support that claim. Retain old script/renderer versions for historical
reads; never run today's script over old events. The start pins the approved persona for presentation; later edits do not
rewrite it. Server transitions, not answer text, decide what happens next. No keyword, ordinary message, agent report, forged
step id, client complete flag or general member role can finish onboarding.

The final-answer event is durable completion intent. Register one `complete-welcome` reaction for
`onboarding.welcome_answer_recorded`. It invokes a separate conditional completion command; the answer command never appends
twice. That command has a deterministic id from the frozen welcome/final-answer ids, a strict system principal and no
browser/model endpoint. Confirm current membership before appending; removal pauses progression, never restores authority. If
two workers/devices race, the first completion remains permanent and the other returns it. If restart wins before completion,
the old generation cannot complete. A fresh worker restart reconciles unfinished intent from events; GET Check status itself
never queues work or resends.

No-assistant members may save survey progress and continue without persona approval. Verify the recorded invitation choice and
exact deterministic personal-assistant stream; do not infer absence from an empty computer query or IAM outage. If assignment is
still pending, offer an explicit Continue without an assistant with the truthful provisioning status. Start freezes the
no-assistant variant and reason; its only answer is explicit “Continue to workspace” acknowledgement. System confirmation names
OpenCrane, not an invented assistant. Direct/group drafts remain available; personal agent-session creation waits for real
assignment and normal grants/admission. An assigned assistant with an unavailable computer can still use the scripted welcome.
Later provisioning changes current account availability only; it cannot rewrite the frozen variant, answers, completion or
archive state. Later persona setup is an explicit action.

Fold `personal_settings` and immutable `persona_revisions` using TypeScript under the existing ProjectionRunner
transaction/checkpoint. SQL stores/selects results only; no triggers, views or stored rules. Store current survey generation/answers, candidate and approved refs, welcome ordered refs/completion
and archive position; encrypted content stays encrypted until an authorised read. Paged revision history: default 20/max 50,
metadata list then independently authorised content detail. Catch up projections to captured exact subject positions or return
applying/unavailable. Never report absent state from a behind projection. Rebuild these tables from events with reactions off:
no model, tools, provisioning, key writes or completion appends. Existing completion/approval/archive survive identically. Normal
worker recovery may finish already recorded intent; offline replay may not. Update registry, streams, catalogue
projection/reaction tables and handler subscriptions together for each event added. Do not emit `assistant.settings_changed` for
persona changes or update computer configuration.

Status separates persisted state (not_started, survey, review, welcome_ready, welcome_active, completion_pending, complete) from
request outcome (saving, recorded/applying, confirmed, conflict, safe_failed, unknown, unavailable, access_changed). Record
receipts only after append. Identify retries by principal/subject/command id and full normalised operation/target/input; same
id/different input is 409. Final-answer status returns the stored completion reference or completion pending. Point-read the
stored event on duplicate acknowledgement; do not trust JetStream's duplicate window. A completion retry reconciles to the same
completion. Unknown uses GET for the original command id, never POST. Not found is still unknown while the original request may
arrive; only established non-append failure permits a fresh submit. Reload reads server progress/recent own receipts without
needing browser-local command state. Clear RAM drafts/protected reads on session/person/access change; abort and ignore late
replies.

## 4. Screen/API map and phone contract

New routes use `/api/account` GET; `/api/account/name` POST; `/api/personal/changes/:commandId` GET; `/api/onboarding` GET;
`/api/onboarding/survey` POST (save_step/restart); `/api/onboarding/persona` POST (revise/approve);
`/api/onboarding/persona/revisions` GET; `/api/onboarding/persona/revisions/:revisionId` GET; `/api/onboarding/welcome` GET/POST
(start/answer only); `/api/onboarding/welcome/archive` POST. Completion remains internal. Writes carry commandId and the
relevant expected position/generation/revision. Reads return allowed actions/confirmed refs/times, not client authority tokens.
Standard failures: 401 expired session, generic 403 access refusal, 404 unknown/foreign revision or welcome with no details, 409
stale/reused id, 422 fields, 503 unavailable. Match #121's typed response contract.

| Screen / frames | API and interaction |
| --- | --- |
| Sign-in ONB-01–03 | Existing /auth/login/callback/me and invitation acceptance. Use configured-provider copy; never invent Microsoft claims or a new sign-in method. |
| Account ONB-50/51/41 | /api/account combines checked identity/silo/membership, name position and separately checked assignment/persona availability. Name POST then original status GET; links /account/preferences, /account/assistant and /account/tools. |
| Preferences ONB-52 + MEM-50 | Own /api/memory/scopes then facts?kind=preference via #98; remember, correct, forget and /changes/:commandId via #94/#95. No shared scope picker; expose saved revision and Only you. |
| My tools INT-60/61 | /account/tools reuses #49/#50 requester-owned management and their /api/my/tools contracts when landed. Until then show Not available yet, without sample connections, Connect or organisation-register fallback. |
| Survey ONB-10–17 | Onboarding GET resumes first unconfirmed step; survey POST saves one checked step. Real dated receipts; 409 reload/review; unknown reads original status. Role/groups come from Account read, not editable grants. |
| Persona ONB-20–24 | Persona revise/approve POST, current GET, authorised revision detail. Plain text, exact version approval, edit/replace, restart review and approved timestamp; r2 remains active while r3 is a draft. |
| Assistant page; revision history | Account + current onboarding + bounded revision list/detail. Separate assignment, candidate and approval statuses; no model/tool selection or wake. Missing frames below. |
| Welcome ONB-30/31 | Welcome GET and start/answer POST. Dedicated WelcomeConversation uses composer presentation only: no ChatSession send, picker, Stop, attachment, microphone, Files or computer panel. |
| Completed ONB-32/32-RM/33 | Welcome GET renders final answer, deterministic confirmation, dated completion crease, read-only notice. Archive POST/status; Start a new chat navigates to a draft and sends nothing. |
| No assistant ONB-40/41 | Frozen welcome variant + live account availability. Acknowledge then await completion; colleague/group buttons open current authorised human drafts. Review persona disabled when unassigned. |
| List THR-01–04/14 + ONB-33 | Extend #88 bounded list response with discriminated kind: conversation or welcome. Own welcome id/route, fixed title, completion-time activity, unread 0; archive/restore only, no Close or participation controls. |

Welcome is not a fourth conversation mode. Keep its projection and archive event separate: #322's conversation preferences
require a real participant join and cannot accept welcome ids. Integrate at #88's authorised list assembly, not by inserting
conversation/participant/feed rows. Include the one own completed welcome in recent/archived filtering, title search and
ordering before pagination. Bind its completion/archive revision into #88's cursor generation; conflict refreshes page one.
Never append it to every page. No illustrative totals, new unread marker, conversation.created, message.posted, agent turn,
wake, reservation or model request.

At 390px reuse the 56px header, 44px menu and visible Back to workspace; settings have no composer. Use 16px side padding,
stacked choices/actions, wrapping labels and full-screen edit/review/history overlays with Back/Cancel. Survey content scrolls
vertically; fix clipped Back/actions in ONB-12–15. Focus each new step heading. Dock welcome text input above the real
keyboard/safe area, never render the pictured keyboard. Completed/denied welcomes have no input. Trap modal focus, restore
opener, link field errors and announce each result once. Glyphs accompany words; no protected text in announcements. Reduced
motion freezes loaders and draws the crease fully. Delayed reads after revocation must not repopulate any screen.

## 5. Missing frames: ready-to-paste Claude Design prompts

Six screen/state groups have no complete frame. ONB-41 is an Account card, not the Assistant page; ONB-52 has no save outcomes;
ONB-20–24 have no revision history. ONB-15 cannot stand in as account/preference/welcome evidence. Reuse existing frames for
survey/review controls; the remaining language/habit/boundary choices are editable visible persona text, not a new page. Each
prompt is self-contained. Only the owner sends these; no design/model call was made here. Back-end PRs proceed; UI PRs
implementing these missing groups wait for the owner's handoff.

```text
Extend OpenCrane v2 with the missing Assistant settings page for a member managing their own personal assistant. Show checked
assignment, current draft and approved revision/time as separate facts; ready, no persona, newer draft, unassigned,
provisioning, unavailable, loading and access-changed states. Review/edit/restart opens the existing persona flow; revision
history opens its own view. Unassigned disables Review with a reason. Include Only your personal turns use this and SOUL.md is
private data, never a shared file. At 390px retain Back to workspace, menu, stacked cards and 44px full-width actions; no
composer, picker, model/tool controls or wake. Reuse ONB-41/50/51, ONB-20–24 and INT-60/61. Use DM Sans/Mono, paper #fbfcfc, ink
#16191a, teal #0db5cc, focus #0a8497, 12px dog-ear, 6a glyph-plus-words and static reduced motion. Return named 1280/390 states
and focus notes.
```

```text
Extend ONB-52 Preferences for a member saving their own selected preference fact. Include empty/Add, loaded revision, dirty,
validation/4 KiB, saving, saved with real time/revision, conflict/review newer revision, known failure/nothing changed,
unknown/Check status, checking/still unknown and access changed/data cleared. Show language, challenge, initiative, optional
habits and Only you; several conflicting facts link to Review. Save changes one selected fact; unknown checks the same reference
and never resends. No memory-policy override or shared scope. At 390px stack choices, wrap notices and keep 44px full-width
actions above the keyboard, without a chat composer. Reuse ONB-52/51, MEM-50/33–35 and ONB-15. Use DM Sans/Mono, paper #fbfcfc,
teal #0db5cc, ink #16191a, focus #0a8497, 12px dog-ear and 6a states. Return named 1280/390 and reduced-motion frames.
```

```text
Design private persona revision history for a member inspecting their own saved versions. Use immutable revision id/number,
created time, current-candidate marker, approved marker and approval time. Show empty, loading, bounded Load more, unavailable,
denied/cleared, long text and selected historical detail. Opening a version never approves it. Only the current candidate has
Approve this version in its separate review. Replace from an old version creates a new draft; r2 remains active while r3 awaits
approval. At 390px use stacked rows and full-screen detail with Back, wrapped ids/text and 44px targets. Reuse ONB-20–24/50,
THR-02/04 and MEM-20. Use DM Sans/Mono, #fbfcfc paper, #16191a ink, #0db5cc teal, #0a8497 focus, 12px dog-ear, 6a states and
static reduced motion. Return named 1280/390 frames, transitions and keyboard/focus notes. No diff editor or files.
```

```text
Extend ONB-50 Account with preferred-display-name save states for the signed-in member. Show optional override and separate
read-only verified SSO name/email, configured provider, silo and current role/group sources. Include clear override, dirty,
validation, saving, dated saved receipt, conflict/review, safe failure retaining draft, unknown/Check status, checking/not found
still unknown, session expired and access changed clearing content. Check status reads the original reference, never repeats
Save; no global sign-out/devices. At 390px retain Back/menu, wrap sources, stack 44px full-width actions and allow vertical
scroll above the keyboard; no composer. Reuse ONB-50/51/15, settings shell and 6a states. Use DM Sans/Mono, #fbfcfc paper,
#16191a ink, #0db5cc teal, #0a8497 focus, 12px dog-ear. Return named 1280/390 frames with focus, announcements and static
reduced-motion states.
```

```text
Extend scripted welcome ONB-30–33 for a new member answering the next saved question. Show frozen script/persona revision,
ordered answers and genuine receipt times. Include start pending/unknown, answer validation, saving, safe failure retaining
answer, unknown, Check status/checking/still unknown, another-device answer/review, final answer saved but completion
pending/unavailable, completed once and access changed clearing the transcript. Checking reads the original reference and never
sends or completes anything. Final copy: Your welcome is complete. You can start a new chat when you are ready. At 390px dock a
text-only 44px composer above the actual keyboard; pending actions disable another submit; completed replaces input with
read-only actions. No model/participant/attachment/voice/Stop. Reuse ONB-15/24/30–33, THR-03/04; DM Sans/Mono, #fbfcfc paper,
#16191a ink, #0db5cc teal, #0a8497 focus, 12px dog-ear and 6a states. Return 1280/390 frames and static crease variant.
```

```text
Extend ONB-40 with the missing pre-completion no-assistant welcome for a new member. Show verified Not assigned or Provisioning
separately from a service-read failure. Offer explicit Continue without an assistant, then saving acknowledgement, unknown/Check
status, completion pending and dated read-only completed variants. Explain that persona approval is optional here and later
assignment never rewrites/reopens this welcome. Only after completion show Message a colleague/group actions opening unsent
human drafts; agent-session action waits for assignment. Use OpenCrane as speaker, no invented assistant or monitoring promise.
At 390px use the 56px header/menu, wrapping text and stacked 44px actions without a composer. Reuse ONB-40/41/32/33 and
THR-01–04; DM Sans/Mono, #fbfcfc paper, #16191a ink, #0db5cc teal, #0a8497 focus, 12px dog-ear and 6a states. Return named
1280/390 frames, interactions, focus/announcement notes and a static completion crease.
```

## 6. Ordered implementation PRs and failing-first checks

Prefer this order, server before screens, at most two stacked PRs. Skip gated rows only for independent outcomes. Each ceiling
counts non-generated additions/deletions, tests, contracts, README updates and a branch-named release note. The user's requested
split overrides whole-feature PR guidance; every partial description says “Part of #N”, never Closes prematurely. Recut measured
oversize changes without moving required refusal guarantees into an unlanded follow-up. No product PR is created by this note.

| Order / issue / ceiling | Independently landable outcome and failing-first public checks |
| --- | --- | --- |
| 1 / Part of #100 / 450 | Account read: verified sources, current membership and truthful assignment; use #121. HTTP rejects removed/wrong-org/silo/person; expired claims, absent email, delayed computer and IAM outage never invent data. No writes exposed. |
| 2 / Part of #100 / 560 | Name event/fold, save/clear, own /api/chat label and original status read. HTTP/replay proves override/fallback, strict fields, same-id changed input, lost reply, stale devices and removal before append; SSO/role/grants unchanged. |
| 3 / Part of #101 / 590 | Survey events/read projection and private-key preparation reaction; no survey writes exposed. Event/replay reads restore four-step progress, preserve ciphertext, bound content and reject wrong identity/generation; duplicate membership delivery prepares one key, none provisions no assistant. |
| 4 / Part of #101 / 560 | Survey save/restart HTTP, checked progress and status. Reload resumes confirmed step; skipped/forged steps fail; edit invalidates later answers; unknown GET makes no write; restart CAS and two devices preserve active approval; slow history and unrelated turn/file churn leave access checks usable. |
| 5 / Part of #101 / 590 | Deterministic persona revise, immutable projection and paged history/detail. Public reads prove original versions unchanged, malicious text stays data, 4 KiB/multibyte bounds, stale generation refuses, foreign details reveal nothing and replay makes no model/key calls. |
| 6 / Part of #101 / 450 | Exact-revision approve/status API. Two devices create r3 while approving r2: mismatch refuses; repeat returns same receipt; restart retains old approval; persona cannot alter assistant settings/grants. Approval timestamps survive replay. |
| 7 / Part of #102 / 580 | Frozen welcome script/start/ordered answer API and projection, final answers explicitly pending. Tests reject forged/old script steps, duplicate changed answers, ordinary chat completion, unavailable assignment as none; reload resumes next unanswered question, zero turn/wake/spend. |
| 8 / Part of #102 / 590 | Completion-only system command/reaction and restart reconciliation. Crash after final answer/before or after completion; two workers complete once; removal/restart blocks old intent; no-assistant acknowledgement finishes; later provisioning cannot rewrite; replay appends nothing. |
| 9 / Part of #102 / 560 | Own welcome archive/status and bounded discriminated list integration. Two-device stale opposite archive conflicts; unknown checks original; recent/search/pages include row once; archive/restore never reopens or creates chat; foreign ids/refreshed admission refuse. |
| 10 / Part of #101 / 550 | Approved persona reference/preparation in #97's qualified restricted personal-turn path. Public dispatch refuses unqualified/memory-free/wrong-requester paths; combined cap and fresh-thread canaries, change-before-dispatch, Pod loss and output isolation. Enable only after live disk proof. |
| 11 / Part of #100 / 550 | Account sources/name states/links on existing shell. Browser checks reload, 390px/keyboard, name conflict/unknown GET-only, no-assistant card and stale-reply purge. Missing account save frames gate this PR. |
| 12 / Part of #100 / 530 | ONB-52 form and MEM-50 navigation reuse #98, plus Assistant entry links. Browser save/edit/forget real own fact, conflict, unknown, unavailable and phone cases; no shared scope or duplicate authority. Missing preference states gate this PR. |
| 13 / Part of #101 / 550 | Survey steps 1–2 and shared save/resume states. Public browser/HTTP checks step validation, Back/Skip, truthful groups, interruption/reload, unknown and 390px focus. Until later steps land, explain unavailable continuation truthfully. |
| 14 / Part of #101 / 480 | Survey steps 3–4 and transition to existing persona read. Browser choices survive replay, task choices grant/install nothing, long tasks wrap and keyboard controls match ONB-13/14. Later approval controls remain unavailable until their screen lands. |
| 15 / Part of #101 / 580 | Persona review/edit/replace/approve/restart using ONB-20–24. Browser r2/r3 race, restart consequence, size errors, unknown receipt and 390px modal/focus; approved welcome link uses landed API. |
| 16 / Part of #101 / 580 | Assistant settings and bounded revision history/detail. Browser loading/unassigned/provisioning/stale approval/denied and old-version replacement; no implicit approval or wake. Both missing-frame handoffs gate this PR. |
| 17 / Part of #102 / 590 | Dedicated active/completed welcome and truthful no-assistant acknowledgement. Browser resume, pending/unknown/concurrent finish, one crease and read-only input removal; pickers/agent controls never mount, 390px actual keyboard/reduced motion. Missing welcome-state handoffs gate this PR. |
| 18 / Part of #102 / 490 | Welcome list/archive navigation and current no-assistant draft actions. Browser recent/archived/search/pagination, two-device restore, no auto-unarchive/reopen, later provision unchanged transcript and phone menu. Source plus fresh journey completes #102/#33 only when qualified. |

Rows 1–8 and account/survey/persona UI can land before #85/#88/#98 finish: #285 already supplies none and verified admission
exists; incomplete removal/admin UI is not their gate. They still require #121 for new routes. Row 9 needs #88's bounded
list/archive APIs, not all of #88's close/cleanup UI; #322 alone is insufficient. Row 10 preparation needs #97's integration
contract; source may land with injection disabled. Runtime enablement waits for #96/#97 qualification. Row 12 waits for #95/#98
preference APIs/editor; it does not duplicate those features. Row 18 needs #88's working list screens and rows 9/17. My tools is
a truthful link before #49/#50; active connections wait for them. Backend work does not wait for missing frames. Defined screen
PRs do; existing frames proceed.

Ceilings total 9,830 changed lines, larger than the tickets' combined original budgets. This includes complete authority,
recovery, history, isolated turn preparation and 18 planned outcomes; measure actual diffs and reuse landed helpers/forms before
adding anything. For each PR demonstrate one public behaviour failure, implement it, then repeat with the next case; do not
write a bulk suite against imagined internals. Use authenticated HTTP/event-store reads/replay and browser interactions, real
disposable NATS/PostgreSQL/OpenFGA, controllable clocks and recording model/tool endpoints. Preserve existing authority test
assertions. Implementation requires nice -n 10 lint/typecheck/test/check:events and affected builds, updated people/robot
READMEs/diagrams/contracts, independent review (maximum two passes) and green CI/main. Do not overlap full suites/fleet batches
with live-view qualification. Fresh dev qualification must cover assigned/none/pending members, two devices/two people,
restart/replay/revoke, long histories and 390px. Turn injection additionally needs real pinned Codex/gVisor disk/swap/core
canaries. Helm/managed-cluster qualification belongs later.

## 7. Open questions and recommended defaults

- Which provider does sign-in name? Use a safe deployment-configured provider label, otherwise “single sign-on”; Microsoft only
  when configured. No IdP discovery or Zitadel admin credential.
- Does a survey name update Account? Default no hidden second command. Prefill once; offer an explicit account save. Own
  preferred-name labels remain private here; public directory name propagation needs an explicit visibility decision, never
  automatic survey disclosure.
- How does SOUL.md share the cap? Whole persona first inside the same inclusive 16 KiB block; then #97's unchanged fact order/32
  refs/no backfill. Publish this adjustment alongside #97.
- Which turns use persona? Personal-assistant turns only by default. Team/private turns retain their own person preferences
  through #97; broader persona use needs an explicit product choice.
- How are survey wishes and memory preferences related? Independent member-authored persona baseline and current person facts;
  no automatic copy/import. Disclose conflicts for review.
- How much welcome scripting? One question whose answer is final, then confirmation; no-assistant uses acknowledgement.
  Remaining wishes appear in editable review text. Pin versions; add questions only in a new reviewed script. No paid model,
  extraction, summarisation or monitoring to complete onboarding.
- Can pending assignment finish? Yes, explicit no-assistant variant after checked pending state; outage alone cannot prove that
  state. Later assignment never starts a second welcome.
- What does restart retain? Historical encrypted answers/revisions and active approval. Reset unfinished welcome with the survey
  generation; a completed welcome is permanently closed.
- Are preference fields one save? One selected person preference fact, not a multi-fact batch. Show conflicting extra facts for
  review; no hidden singleton mapping or partial-save promise.
- What costs money outside the box? Welcome/account/survey/replay cost 0 model euro cents and need no paid service. Ordinary
  later model turns, including persona bytes, are billable through existing integer-cent admission. **OUTSIDE THE BOX — PAID:**
  ordinary model use and any paid qualification. Qualification uses only the remaining authorised 500-cent envelope/provider
  cap; otherwise NOT RUN. No paid Claude Design call is authorised here; the owner supplies the missing handoff. No cloud
  KMS/vault or paid provider is added.

## 8. Evidence and stop point

PASS: requested read-only source/issue/frame inspection and this external design artefact. NOT RUN: product code, tests, builds,
stacks, model calls and all fresh/live qualification. Existing private-memory capability remains PARTIAL/disabled; this design
is not a runtime PASS. Only this note was written. Repository files stayed unchanged and network use was GitHub reads. Later dev
access is tailnet-only, never tailscale funnel. Any necessary Zitadel changes stay inside OpenCrane 2 Dev; the privately configured owner test user stays
a separate owner test account. OSI application licences and Debian main OS rules remain mandatory; no new runtime component is
proposed.
