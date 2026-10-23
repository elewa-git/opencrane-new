# Isolated turn memory, preferences and pins

10 October 2026. Design only for [#97](https://github.com/elewa-git/opencrane-new/issues/97)
and [#98](https://github.com/elewa-git/opencrane-new/issues/98).
The critical path is #94 → #95 → #97 → #98 → #99, with qualified #96 also gating #97.

## Basis and current limits

Read the bodies, Design sections and discussions of #97, #98, #99 and #96; the accepted
[memory design](https://github.com/elewa-git/opencrane-new/issues/94) and [correct/forget design](https://github.com/elewa-git/opencrane-new/issues/95); AGENTS.md,
the engineering standard, plan.md Memory, D14–D20 and the event catalogue. Read the MEM HTML
definitions and handoff rules under `/home/jente/dev/design-handoffs/v2/06-mem/` and the
THR-72 definition. Inspected representative desktop/390px preferences, context, batch,
detail and Decisions PNGs. Frames are references, never implementation evidence.

Checkout `work/p4-15-design`, local origin/main and GitHub main matched
`6381633091ce1c7cd80b6acb11215f68a40f43a7` when read. Relevant merged code:

- `libs/events/src/memory.ts`, `libs/projections/src/memory{,-keys}.ts`: versioned writes,
  server-only revision keys, current searchable facts and payload-free changes. Projection
  correct/forget and historical dependency retention still await #95.
- `apps/server/src/memory/`: authorised human store/list/detail/status; caught-up reads;
  governed MCP advertises recall only. Shared chat sources are refused because current
  chats do not prove durable whole-group visibility.
- `libs/models/src/memory-context.ts`, `gateway.ts`: signed two-second recall context,
  current requester/assistant grants and route-specific replacement of `x-memory-context`.
  `contextPosition` records authority, not memory content freshness.
- `chat/private-context.ts`, `bridge.ts`, `reports.ts`: requester-only completed exchanges
  capped at 24 KiB; generated reports currently use the conversation key on the server.
- `computer/turn-runner.ts`, `private-codex.ts`, `thread-loads.ts`, `mcp-proxy.ts`: private
  turns start fresh ephemeral processes, refuse tools, and keep report text off the PVC.
  Ordinary tool reloads fingerprint tools only; proxy catalogues currently key by conversation.
- `web/app/memory/memory-panel.*`: read-only panel/detail with request guards and RAM state.
  Reuse this and #94 store/#95 edit/forget screens when their working versions land.

`chat/memory-admission.ts` remains disabled. #96 records swap/core-dump failures and unfinished
gVisor proof; the documented local bridge credential gap (#200) also gates tools and memory.
Do not infer qualification from merged code, a rendered frame or an older PASS receipt.
No new dependency, search engine, embedding call or generic knowledge framework is proposed.

## 1. What enters a turn

Resolve identity from the verified session and server-recorded turn binding. Bind silo,
requester, assistant, computer generation, conversation, turn, thread and content generation.
Do not infer the requester from the last sender or share their context through a computer id.

| Order | Eligible initial data | Required authority |
| --- | --- | --- |
| 1 | All live preferences in the requester's person scope, whether pinned or not | Active owner; recorded requester ∩ bound-assistant memory-read and MCP grants |
| 2 | Live pinned personal facts; do not include preferences twice | Same person authority |
| 3 | Live pins in the bound team assistant's owner-group scope | Current recorded group membership, OpenFGA membership and requester ∩ assistant operation grants |
| 4 | Live pins in this assistant's notes | Current assistant audience, actsFor and explicit requester ∩ assistant read grants |

A personal assistant supplies no group scope merely because its owner belongs to groups.
Never union every membership or another assistant's notes. Team notes disclose their whole
permitted owner-group audience; personal-assistant notes disclose the owner alone. Preferences
are always person-scoped. Pinning, joining a child chat, desktop access or an admin role grants
no memory permission. Missing grants omit the denied scope without ids, counts or previews.
IAM failure or uncertain authority refuses preparation; it is not an empty-memory success.

Use #95's common current-reference validator for live revisions, expiry, keys, tombstones and
dependent invalidation. Require projection catch-up to each captured scope position and one
projection generation. Query only the authorised scopes and eligible kinds, in stable category
then bytewise memory-id order. Do not reuse list search ranking as initial-context ordering.

Read bounded transcript and candidate content before the final two-second authorityFence.
Watch only small member, assistant, owner-group, grant, MCP-policy and admission payer streams.
Use separate content positions/revisions for content changes; never add conversation history
or memory streams to the access fence. Confirm access and content immediately before release.
Content changing during preparation yields unavailable/reprepare, never stale text. Check model
and root-budget admission against the actual combined request before issuing the dispatch grant.

Every memory-bearing personal or team turn uses #96's restricted execution mode. Start a new
ephemeral Codex process/thread, fresh token and private home for each turn, including later
turns in the same conversation. Keep the one-computer-per-assistant lifecycle and two-private-
turn concurrency limit. Memory-free turns remain an explicit fresh choice with no private
history or memory tools. Never upgrade a persistent memory-free thread by adding memory.

Keep all plaintext in protected, non-swappable RAM/tmpfs, including bridge, supervisor, proxy
and server delivery buffers. Keep swap and host/guest crash dumps disabled in qualified hosts.
No SOUL.md, shared prompt file, rollout, compaction, SQLite cache, tool result, report text,
HTTP log or debug dump goes to computer disk. Text-free ids/status may use the existing journal.
Keep shell, file, browser, code-host, external MCP, skills, plugins and native agent spawning
disabled. Permit only the four governed memory tools after their handlers and policies exist.
Allowlisting those tools must not enable a general tool environment or filesystem capability.

Stored facts are untrusted data, never executable instructions. Put server-authored rules in
the trusted instruction layer and JSON-escaped fact records in a separate labelled data block
in the turn input: scope/id/revision/kind/text. Preferences express wishes that may guide an
answer; they cannot replace system policy, identity, budgets or tool permission. Conflicting
preferences remain visible for human correction; stable ordering is not a safety override.
Do not interpolate text into TOML, tool definitions, role delimiters or capability claims.
Do not automatically follow remembered URLs. Escape browser text. Prompt wording supports
this boundary; gateway rules and private/shared separation enforce it mechanically.

## 2. Bounds, reference evidence and changes during execution

Use D19's recommended 16,384 UTF-8 bytes for the complete rendered initial-memory block,
including its fixed warning, delimiters, JSON escaping and identity metadata. Retain 4,096-byte
fact text, 8 sources, 32 dependencies and 16 KiB commands/events. Never truncate a stored fact.
Take a stable prefix: stop at the first whole record that cannot fit, or 32 loaded references.
Do not backfill with smaller later facts. Return a safe has-omissions flag; leave overflow
stored and searchable. Check multibyte, escaping and exact-boundary cases, not character counts.

Select at most the first 33 eligible candidates per category using indexed keyset reads;
that is enough to prove the 32-reference boundary without scanning every stored fact.
Keep only admitted records in the delivered block. Omission detail uses bounded pages, not an
unbounded list of omitted ids in the acknowledgement or event. Publish limits in scope reads.
The independent 24 KiB rebuilt-transcript cap remains. Enforce the existing 120 KiB turn-frame
and 48 KiB tool bounds on the combined delivery, including acknowledgement context; a large
new request is refused clearly rather than quietly losing its words or raising these limits.

Recall stays one authorised scope per call, at most 20 whole facts/16 KiB per page. Recommended
additional turn bounds: four content-bearing recall replies, 64 KiB total recall data and
32 unique loaded references across initial data and all recalls. Reject the next reply before
delivery if it exceeds these bounds; never discard earlier references to make room. Empty
searches still consume a call. Bound queued requests and buffers using existing admission.
These are server limits, not user-tunable options or a larger model context promise.

Selection/search cost 0 euro cents in model calls. Injected and recalled bytes still become
billable input on subsequent model calls. Preserve gateway price checks, conservative input
reservation, 2,000 output-token limit and existing integer-cent/root ceilings. Count the actual
request on each dispatch; do not equate UTF-8 bytes with tokens or promise a fixed euro cost.
No extra model call chooses pins, resolves preferences or summarises overflow.

Record complete loaded references before releasing initial or recalled text. Add one minimal
server-authored `agent.memory_context_recorded` event on the conversation stream: identity,
content generation, action prepared/loaded/invalidated/ended, reference additions, relevant
scope positions, projection generation, byte counts, omissions flag and safe reason code.
No text, ciphertext, key material, raw result or text fingerprint. Each evidence command makes
one conditional append; loading is a separate workflow step from a fact mutation. Duplicate
call evidence binds callId and generation. Fold it into existing turn summaries/feed reads.
An uncertain evidence append prevents delivery until reconciled; after evidence is proved,
conservatively treat its references as loaded even if the reply was lost. Never auto-resend.

Initial delivery marks prepared, then loaded before text/grant release. MCP recall must append
trusted additions before sending its result. The computer cannot supply a selective subset as
proof of everything seen. Bind signed recall/target proofs to the same content generation.
Use the accumulated set for every derived write; keep #95's same-scope dependency rule. Mixed
person/group/notes inputs therefore cannot produce an agent-derived fact under an incomplete
same-scope lineage. Refuse that write; use an isolated one-scope extraction instead. Personal
auto-store uses a fresh person-only extraction from the member's authorised statement and person
references, never the earlier mixed-scope model reply. A correction target proof is distinct
from dependencies on its own superseded revision. Keep loaded evidence through compaction;
losing it ends the turn rather than treating a summary as independent context.

Before every model/tool dispatch, grant renewal and generated-output release, recheck current
authority and all loaded revisions through the common validator. Subscribe to relevant access
changes and #95's affected references to stop promptly; dispatch checks remain decisive if
notifications are late or lost. Expiry also invalidates at use. Unrelated facts/messages/uploads
do not close readers or stop an unaffected turn. Reads use their ordinary one-time access check.

Correct, forget or revoke marks affected context invalid, drops its proxy grant/catalogue,
interrupts/closes its private process and rejects late output from that generation. Do this
before any next dispatch; do not wait for cleanup completion. Confirmed correction/forget
receipts survive as metadata. A tool that mutates loaded memory returns a safe receipt, then
the turn ends; it cannot continue reasoning on its own obsolete data. Lost mutation replies
remain unknown and offer original-command status. Do not automatically replay work to rebuild.
The next explicit request reconstructs authorised transcript and fresh references in a new
thread. Only report “Context refreshing” while that preparation is actually running.

Keep generated text from memory-bearing turns volatile in requester-only server/browser RAM.
Do not send it through reports.ts's current conversation-key persistence. Persist text-free
completion/output-unavailable metadata, not summaries or reasoning text. On loss/reload show
that the private reply is unavailable; do not reconstruct it from an old rollout. Independent
human messages remain durable. Clear memory-derived transcript entries on invalidation and
exclude them from privateContext reconstruction. This chooses the volatile option accepted
by #94/#95; durable source-linked generated payloads require a separate complete erasure design.

On Pod replacement, ended/unfinished private turns fail as #96 specifies. Remove all old grants,
references and buffers; new work receives a new computer/content generation. Do not repeat an
uncertain model/tool call. Replay restores references/status but creates no usable token or live
thread, provisions no keys and invokes no model/tools. Forgotten content never re-enters context,
even while cleanup is pending. Backups and already delivered external disclosures are not erased;
restore must apply latest tombstones/deletion markers before readers or turns resume.

## 3. Preferences, pins, commands and replay

Use existing `scope-<scopeId>` / `ev.scope.<scopeId>` and #94/#95 encrypted revision contracts.
Do not add preference streams, pin events or a second settings authority.

| Operation | Command/event | Result |
| --- | --- | --- |
| Add preference | remember, `memory.written`, kind preference, own person scope | New r1; default pinned=true, no expiry |
| Edit preference | correct with expectedRevision and checked full replacement; `memory.corrected` | Same identity, r+1; old revision/dependents invalidated and cleanup requested |
| Pin/unpin fact | correct with expectedRevision; server preserves text/kind/sources/dependencies and changes pinned only | Same audience; revision changes and #95 cleanup/invalidation applies |
| Remove preference/fact; Undo store | forget with receipt/current expectedRevision; `memory.forgotten` | Permanent hidden id; transitive cleanup and `memory.cleanup_recorded` evidence |

All preferences are initial candidates; unpinning a preference does not disable its wish.
Explain this in Settings. Remove it with Forget or change its kind explicitly through the
checked editor. Pin means prioritised eligibility, not guaranteed inclusion in any given turn.
Pinned facts default to no expiry; an explicit human expiry remains effective. #99 cannot
automatically expire or overwrite a pinned user fact. No automatic conflict resolution here.

Reuse #95's HTTP `/correct` contract. For pin/unpin allow a strict replacement variant
`{pinned: boolean}` with commandId/expectedRevision; expand it from the checked current value
on the server. Do not accept stale client copies or invent a metadata-only revision key.
Both forms share command identity, one conditional append, per-fact key reservation and stale
409 handling. Retry an unknown result only by reading `/changes/:commandId`. Changed operation,
target or input conflicts. A consumed erased command cannot provision keys or restore text.

Person owners manage their own preferences/facts. Any current group member may manage group
facts without approval. Notes need current assistant audience/actsFor and explicit read AND
write grants to edit, pin or forget. Admins configure setup/grants and inspect permitted safe
metadata; their role does not authorise another person's content or mutation. Infrastructure
operators remain outside this application privacy promise. Pinning never broadens access.

Agent recall requires read; remember requires write; correct/forget require both plus the
tool's own reviewed zero-cost Allow policy. Ask is a configuration refusal, Block denies.
Private automatic storage stays person-only and records real receipts. A private execution
cannot write shared facts/notes even with plausible shared source ids or a human-style body.
Human shared storage is an explicit member-authored statement, not automatic private extraction.

Deliver shared learning through a separately admitted restricted `shared_only` execution.
Bind one scope, active requester/assistant/payer and only that scope's live sources; exclude
personal preferences, private transcript/results and other scopes. It uses the same gateway,
tool policies and reference accounting. For now use existing group facts or explicit shared
member statements: current chat-source validation cannot prove whole-group visibility.
Shared output needs server-verified audience eligibility, including future authorised readers;
otherwise keep it private or require explicit reviewed release. Late child joiners never inherit
private execution text. Do not relax shared source checks to satisfy a frame example.

ProjectionRunner folds written/corrected/forgotten and cleanup evidence into current facts,
historical revision dependencies and payload-free changes. Follow #95's metadata-first replay:
establish tombstones/obsolete revisions/dependent closure before decrypting. SQL stores/indexes
TypeScript decisions only. Preferences and pins rebuild identically; no keys, cleanup reactions
or paid work execute during replay. Update schemas, registry and catalogue together for the
new context-evidence event; every public status must come from accepted events or live checks.
Distinguish accepted mutation, refreshing context, hidden/cleanup-pending, forgotten with time,
unavailable and unknown. A pin receipt is saved only after append, not after an optimistic click.

## 4. Native tools and #99 support

Extend the existing threadLoads/mcpProxy path for restricted ephemeral sessions, retaining
unload/drop-on-failure and discovery confirmation. Do not resume a memory-bearing thread
through the current tools-only fingerprint. Bind catalogues to turn/thread/content generation;
the current conversation-keyed map must not replace another active requester's catalogue.
Give each private process its own short-lived caller capability, checked against that binding.
Protect catalogue/grant control and bridge credentials against memory-free/desktop processes;
a shared proxy bearer plus a guessed thread id is insufficient. Close #200 before enabling.

Configure only built-in memory MCP at a bridge-installed random load address. Allow fixed
definition discovery before dispatch; no fact reads until thread identity, loaded evidence and
grant are confirmed. Permit only actual memory MCP item types in restricted turn notifications;
continue refusing every other tool item. Tools/list must match current published policy.
Strip supplied secret/identity/scope headers; gateway replaces x-memory-context only for
`/mcp/memory/server`. Bind operation, method/name/version, body digest, callId/requestId,
requester/assistant/computer generation, turn/thread, scope and content generation. Keep the
original ≤2-second capability expiry for backend/append checks. Ended, forged, mismatched,
replaced, revoked or stale calls fail before effects. No direct backend bypass or silent retry.

\#99 can reuse the one-scope shared-only/restricted preparation, complete input revisions,
conditional correct command and authorised metadata trail. Do not build its scheduler here.
Its dirty-scope/date/input key, active owner, assistant, payer and allowance must be recorded
before computer dispatch; existing budget admission still refuses unknown price/exhaustion.
Mixed scopes are impossible, even for person maintenance; ordinary multi-scope start preferences
must be suppressed. Preserve dependencies after merges, flag contradictions, keep pinned user
facts and discard stale output. Replay performs zero external calls. Future run/spend statuses
join the existing audit contracts, without new `memory.consolidated` emitters.

## 5. Screens and APIs, including phone layout

Keep the existing Memory panel, list/detail and #94/#95 forms. Use current authenticated
HTTP/Origin checks, `no-store`, uniform 404 for forbidden/foreign/unknown identities, 422
validation, 409 stale revisions and 503 unavailable. Human settings need no active model turn.
Add kind/pinned filters to the existing bounded facts API; bind them into cursor signatures.
Add `GET /api/conversations/:id/turns/:turnId/memory` for requester-only text-free context
status and paged omitted candidates, checked against current scope rights. Store snapshot
positions, included refs and ordering boundary, not every omitted id. List omissions only when
those positions still match; otherwise show “Context changed” and a current candidate view.
Reauthorise detail independently. Never reveal denied scopes through omission counts.

| Frames | API and state binding |
| --- | --- |
| MEM-01–06 | Existing scopes + facts/search/cursor; show only readable scopes and real notes audience. Preserve empty/loading/no-result/unavailable states; add filters without rebuilding the panel. |
| MEM-10–12 | Accepted remember/status evidence, safe scope/audience/revision/time; Undo calls #95 forget. Hydrate text only through a fresh authorised detail read, never keep text in a durable chat receipt. |
| MEM-11 | Group accepted individual commands into a receipt batch by originating turn; each item has its own status and labelled Undo. No atomic batch API, all-or-nothing promise or group approval. Review opens authorised details. |
| MEM-20/21 | Existing detail + independent source check; add canCorrect/canForget/canPin. Missing/denied sources have no preview/reference. Refresh or clear old detail on correction/forget; access change clears the panel. |
| MEM-30–32 | Reuse #94 Store form, server limits and original-command status. Preference allowed only in person scope; shared source requires the server's actual audience proof. |
| MEM-33–35 | Reuse #95 checked edit/preview/conflict screens. Corrected receipt adds actual affected-turn status, not a fabricated refresh. 409 requires Refresh and review with a new command. |
| MEM-40/41 | Reuse #95 Forget review and hidden/cleanup states. Remove old text immediately after accepted forget, explain independent chat/backups, and move focus to next row/heading. |
| MEM-50 | Personal Settings Preferences page: scopes then own facts?kind=preference; Add uses remember; Edit/Forget reuse #95. Only-you audience, no composer or shared scope selector. Use the existing settings shell if present, otherwise a minimal Preferences route with Back. |
| MEM-51 | Pin control submits the strict /correct variant, announces only on accepted receipt; stale revision opens MEM-35. No optimistic “Pinned” or changed audience. |
| MEM-52, THR-72 | Real turn-memory status supplies omission/unavailable/denied/refreshing variants separately. Omitted entries remain searchable; pin label says eligible unless actual turn evidence proves inclusion. Fresh memory-free choice preserves #96's explicit boundary. |
| MEM-60 | Reuse /api/conversations/:id/history for the requester's authorised decisions. Add /api/memory/:scopeId/history using the same audit projection/read components for visible scope memory changes; no organisation-history fallback. |

The audit projection currently excludes memory events and lacks scope/fact/revision/time fields.
Add an exact allowlist for written/corrected/forgotten/cleanup events and bounded safe metadata,
with a scope index/filter. Check scope rights before returning rows and constrain related evidence
to that same permitted scope; conversation audit stays requester-filtered. Never return keys,
ciphertext, source previews or forgotten content. Author labels need current authorised resolution;
fall back to “A member”. #99 later supplies real scheduled/run outcomes; show no invented dates.

At 1280px retain the session panel and drawers. At 390px use full-width list, detail, edit and
review overlays with Back/Cancel; Settings has its own page without a composer. Wrap scopes,
audiences and consequences, stack 44px actions and keep submit above the keyboard. Fix the
reference detail's clipped Forget action. Arrow keys move tabs/scopes; modal focus starts on
the title, Escape cancels only unsubmitted work and restores opener focus/scroll. Per-item Undo
has a distinct accessible name. Link errors with aria-describedby; announce status once, never
forgotten text. Freeze all motion under reduced motion. Do not embed another transcript renderer.

Keep drafts, receipts and fetched content in component RAM. Clear them on requester/scope/access
change; bump request and content generations so delayed list/detail/edit/history replies cannot
restore text after revoke or forget. Ordinary content changes refresh data without closing viewers.
Unknown submitted operations keep only safe references and Check status; closing an overlay cannot
cancel an accepted append. No localStorage, IndexedDB, service-worker or response cache.

## 6. Serial PR outcomes and failing-first evidence

Land from green main, server before screens, at most two stacked PRs. #94/#95 working contracts,
\#96 qualification and #200 hardening are prerequisites, not work silently hidden inside these
budgets. Each estimate counts hand-written additions AND deletions, tests/docs/release note;
each is ≤600. Unqualified native admission remains disabled throughout the preparatory PRs.

| Order / issue / lines | Independently landable outcome; tests that must fail before implementation |
| --- | --- |
| 1 / #97 / 550 | Authorised bounded initial-context preview/status for existing private turns, with dispatch still disabled. Test stable category/id prefix, JSON/multibyte caps, 32 refs, empty/overflow/denied scopes, inactive assistant, IAM/lag failure and long history outside the fence. |
| 2 / #97 / 590 | Complete reference accounting for governed recall clients: context event/fold, append-before-delivery, generation-bound proofs and dispatch validation. Test lost evidence append/reply, selective proof refusal, mixed-scope derived writes, expiry, races and replay with tool/model endpoints disabled. Native stays disabled. |
| 3 / #97 / 580 | Existing private-turn output becomes volatile whenever memory evidence is present; invalidation stops grants/reports and removes buffers. Test correct/forget/revoke between check and release, stale deltas, reconstruction/reload, two requesters, unknown mutations and no conversation-key copy. |
| 4 / #97 / 590 | Restricted per-thread built-in memory forwarding available only on qualified computers. Test pinned native discovery/all four calls, caller/catalogue isolation, same requester in two sessions, tool persistence attempts, forged/ended/replaced calls, Ask/Block and header stripping. Admission stays off elsewhere. |
| 5 / #97 / 540 | Enable initial memory on qualified restricted personal/team turns and truthful server context status. Test A/B concurrent canaries, later requester, unrelated turn activity, correction-triggered stop, Pod replacement, memory-free separation and disabled hosts. Live disk checks are a landing gate for enablement. |
| 6 / #97 / 570 | Isolated person auto-store and one-scope shared-only extraction through existing computer admission. Test mixed-reply exclusion, complete one-scope lineage, group/notes grants, member-authored source, private chat-source refusal, stale merge/forget and late-participant non-disclosure. No scheduler. |
| 7 / #98 / 390 | Server preference filters, pin-only correction variant and rights/receipts. Test owner/group/notes/admin matrix, preference outside person, concurrent pin/edit/forget, new key/old cleanup, expiry and replay parity. HTTP is usable before screens. |
| 8 / #98 / 550 | Authorised memory audit/status/omission reads with existing trail contracts. Test exact metadata allowlist, current scope denial, related-record leakage, erased content, snapshot change, bounded pages and projection replay with no effects. |
| 9 / #97 / 450 | Chat receipts, per-item Undo and real omission/refresh/restriction notices. Test partial batch outcomes, changed receipt revision, lost reply/Check status without resend, late replies, 390px fit/focus and forgotten text absent from DOM/announcements. |
| 10 / #98 / 460 | Personal Preferences Settings using existing forms, and Pin/Unpin on existing detail. Test add/edit/remove through HTTP, unpinned-preference wording, conflict/revoke, unknown submit, keyboard/phone and no browser persistence. |
| 11 / #98 / 380 | Complete panel Review/Decisions navigation and source/error states using landed APIs. Test authorised audit versus visible facts, stale access/content replies, no hidden counts, batch Review, source unavailable, empty, desktop/phone and reduced motion. |

These estimates total 5,650 changed lines; the two ticket budgets together are not credible for
the missing isolation/output/native/shared/trail guarantees. Recut any measured >600-line outcome
before implementation, preserving a usable result and its refusal tests. Do not move security
guarantees into an unlanded follow-up merely to fit. Every PR updates affected README/README.robot,
diagram/contracts/catalogue and a branch-named `changes/unreleased/` file. Existing helpers win.

During implementation, write the listed regressions first and demonstrate their failure, then
run lint/typecheck/test/check:events and affected web checks under nice -n 10. Use disposable real
NATS/PostgreSQL/OpenFGA/gateway for persistence and authority, controlled clocks for expiry and
actual pinned Codex/gVisor for isolation. Do not overlap full suites with live-view qualification.
Enablement requires fresh-install simultaneous-requester, forget/revoke/rebuild and native-tool
journeys; inspect PVC, sessions, caches, outbox, logs and dumps while canaries are live and during
attempted persistence, Stop/crash/reconnect. A tool-free #96 proof alone does not qualify MCP.

## 7. Open questions and recommended defaults

- Initial cap/order and overflow? Adopt D19's 16 KiB inclusive stable prefix, 32 references,
  no backfill, no hidden totals; publish these as spec defaults and measure real journeys.
- Does unpin disable a preference? No: every live preference is eligible. Say so; Forget removes
  it. Do not add a second enabled flag or preference-priority engine without a separate need.
- What persists from a memory-bearing reply? Default volatile generated text, durable safe
  status/references and honest unavailable-on-reload. Durable source-linked reply encryption
  needs its own erasure outcome before adoption; ordinary conversation keys are insufficient.
- May interrupted work restart automatically? No. Stop invalid context; next explicit request
  rebuilds fresh. Original-command status may reconcile uncertainty without repeating effects.
- How much recall per turn? Default four replies/64 KiB and 32 cumulative unique references;
  refuse overflow before delivery, then let the member start another explicit turn.
- Where can shared learning start? Default one-scope existing shared facts/member statements.
  Current chats cannot prove durable group visibility; keep their automatic extraction refused.
- Can admins inspect/manage personal memory? No application bypass. Setup/grants and safe audit
  only; an admin who is a group member manages that group's facts by membership.
- Who enables memory after qualification? Use the deployment's explicit image/host qualification
  evidence, never a UI toggle or role. Keep disabled if swap/core/bridge/MCP canary proof fails.
- How does #99 extend this? Reuse one-scope admission, expected revisions, loaded references and
  safe audit fields; defer nightly scheduling, cheap-model selection and maintenance screens.

Only this external design note was written. Repository files stayed read-only. No stacks, tests,
models or qualification ran; network access was limited to GitHub reads. All runtime evidence
for this proposal is NOT RUN. The existing #96 capability remains PARTIAL with admission disabled.
