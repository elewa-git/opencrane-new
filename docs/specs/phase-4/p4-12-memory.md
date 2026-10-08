# Scoped memory: design for #94

8 October 2026. Design only. Inspected `work/p4-12-design`, SHA `7f3e9b90261dce1136e0d73836ae991cac6b6cef`, equal to local `origin/main`. Read GitHub issues [#94](https://github.com/elewa-git/opencrane-new/issues/94), [#95](https://github.com/elewa-git/opencrane-new/issues/95), [#97](https://github.com/elewa-git/opencrane-new/issues/97) and parent #82. Read the MEM frame definitions and handoff README under `/home/jente/dev/design-handoffs/v2/06-mem/`; inspected representative desktop and phone PNGs. All twelve requested frame ids are mapped below.

The governing defaults are `plan.md` Memory, D14–D19 in `docs/specs/phase-4/decisions.md`, `docs/design/handoff-v2/PLAN.md` Memory, `AGENTS.md`, and ADRs 0001–0006. Current source, rather than historical spike claims, determines what needs building. This note proposes contracts; none are implemented or qualified by this task.

## 1. Scopes and permission

Use exactly three kinds: `person`, `assistant_notes`, `group`. No organisation, department, nested group, promotion or cross-group copying. Derive an opaque `scopeId` from SHA-256 of JSON `[silo, scopeKind, ownerId]`; retain those three fields and verify the derivation at every entry. A label never grants access.

| Scope | Human recall/list/search/detail | Human remember | Agent remember/recall |
| --- | --- | --- | --- |
| Person | Active silo member whose id equals ownerId | Same owner; preferences only here | Same requester, using their authorised assistant and that assistant's explicit operation grant |
| Group | Active silo member, current recorded group member, OpenFGA `team#member` allowed | Same membership; no approval | Same requester membership, assistant owned by this group, and explicit assistant operation grant |
| Assistant notes | Current permitted assistant audience, `actsFor`, and explicit requester read grant | Same audience and explicit requester write grant | Same audience, matching assistant, and explicit requester ∩ assistant operation grants |

For a personal assistant, its notes audience is its active owner alone. For a team assistant, it is current owner-group members allowed to act for it and use its notes. A direct resource grant cannot admit an outsider. Notes are shared with that whole permitted audience, never private per member. Pinning, being an administrator, owning the silo, viewing a desktop or joining a child conversation supplies no memory right. Reject inactive assistants.

Reuse OpenFGA `resource#use` with two distinct resource types: `memory_read` and `memory_write`, resource id = scopeId. Do not change the FGA model merely to rename these existing checks. Person ownership and group membership give human read/write rights as above; assistant-note human rights and all agent rights additionally require the relevant explicit grant. `recall` requires read; `remember` requires write; #95 correct/forget require write and current fact read. Read never supplies write.

Provision assistant operation grants through recorded `grant.given` commands, not arbitrary tuple writes or the first remember. Extend explicit assistant selection where needed; current `assistantGrantSchema` allows only model/MCP. For notes, explicitly grant the personal owner or owner-group too. A setup reaction may finish an already recorded selection, one grant command per stream, idempotently; it must respect previous revocations. Existing assistants need an explicit upgrade selection before tools are enabled. Missing grants deny. Human group storage remains available without granting a model access.

Resolve browser identity using the existing verified session/member binding. A cookie authenticates identity; its roles, scope hints and labels are never permission evidence. Resolve agent identity from verified computer/turn claims and server-recorded live thread bindings. Never trust model text or scope headers. Use `memberAuthorisation.check`, `team`, `actsFor`, `use` and `applied` with higher consistency, plus current member/team/assistant/grant event state. A pending grant or unapplied revocation refuses access; IAM failure is unavailable.

Before a write, read command/fact/source history with its own bounded deadline, then start the two-second `authorityFence`. Watch exact member, assistant, relevant team and operation/MCP grant streams; payer only where admission uses it. Never include the conversation or memory-content stream in that access check. Confirm immediately before the one conditional append. Content races use the scope stream's expected sequence and fact revision, separately from access. Reads check access once, without a fence. Source links get a separate read check. Turn lifecycle checks use `decisionActivity` summaries and relevant later changes, not a whole-chat replay inside this limit. Existing gateway admission also has a two-second total deadline: cold summaries may refuse, never skip authority checks. Unrelated messages, uploads or turns must not refuse memory readers or close panels.

Shared writes accept either server-verified group-visible sources or a human member's explicit shared statement. Bind sources to the real audience, including future authorised group readers; matching today's participant count is insufficient. Reject private sessions, another group and inaccessible sources as shared sources. If group-visible message support is absent, offer explicit human-authored storage. An agent may write shared scopes only from a server-recorded `shared_only` execution whose inputs exclude personal memory and private messages/results. A private thread cannot claim this class or claim human authorship. For #94, reject its shared writes even when it supplies a plausible shared source id. Assistant notes follow the same rule. Keep preference kind personal in every path.

## 2. Events, encryption, projection and search

Keep the existing catalogue names and `scope-<scopeId>` subjects, wired as `ev.scope.<scopeId>`. Serialise every fact change within its scope; no new fact stream or global memory stream. Both event envelope and scope identity carry silo. Keep commands' `commandId`, principal, time and correlation; derive change/fact ids from silo + principal kind/id + scope + commandId, not a globally reusable client id. Bind agent principal to the verified requester; correlation adds conversation/turn and decision request. Thread and assistant references come from verified context.

Define enriched version 1 payloads below; preserve explicit parsing of the existing unversioned catalogue shapes for replay, without guessing their audience. Unknown legacy scope ownership remains quarantined until an authorised offline mapping. Update schemas, examples, registry, catalogue and documentation together.

| Event | Fields besides envelope |
| --- | --- |
| `memory.written` (#94) | schemaVersion: 1; scopeId, scopeKind, ownerId; memoryId; revision: 1; kind: fact/preference; pinned; expiresAt: UTC timestamp/null; sources; dependsOn; ciphertext; keyId |
| `memory.corrected` (#95) | Same full current value; expectedRevision; revision = previous + 1; supersedes = own previous fact/revision; checked dependencies; reason = human/merge/contradiction/expiry |
| `memory.forgotten` (#95) | schemaVersion, scope identity, memoryId, expectedRevision, next revision; no text, ciphertext or replacement payload |

`source` entries are typed message references `{conversationId, messageId}` or member-authored references `{memberId, commandId}`; server resolves labels and visibility, never saves a model's source preview. `dependsOn` contains memory `{scopeId, memoryId, revision}` references in the same scope. #94 agent-derived facts must supply server-verifiable lineage, checked against the thread's recalled references; missing lineage refuses storage. Do not allow untracked recalled copies. #99 may add multiple dependencies without changing this identity scheme.

Use these server defaults, returned to forms: text 1–4,096 UTF-8 bytes, no NUL; 8 source references; 32 dependency references; ids/commandId at most 200 ASCII letters/digits/underscore/hyphen; positive safe-integer revisions. Whole command and whole event each at most 16,384 UTF-8 bytes, including metadata/encryption expansion; return a size error rather than truncating. Ciphertext at most 5,500 base64 characters for 4,096 text bytes plus 12-byte nonce and 16-byte GCM tag. Expiry must be null or a valid future UTC timestamp; pinned facts default to no expiry. Preference kind is refused outside person scope.

Encrypt text with Node AES-256-GCM, a fresh nonce and a separately destroyable secret-store key per fact revision. Authenticate silo, scope identity, memoryId and revision as additional data. Events contain ciphertext and `key:<opaque-id>` only. Never reuse conversationKeys or one scope-wide key: forgetting one fact must neither erase its neighbours nor leave old revisions readable.

Prepare key custody/encryption before append; this creates no business fact. Reconcile unused keys after a definitive failed append. Keep keys while append outcome is uncertain, until the original command is reconciled. Secret custody must support idempotent provision/read/delete and persistent deletion markers; its implementation is a prerequisite, not a claim that the current file-based conversation helper already provides it. No key material goes to the computer.

One command attempt makes one conditional append only. Check saved command identity and decrypted input/metadata before reusing a live result; a changed input is a conflict. Concurrent identical commands converge on the original memoryId/revision; conflicting append returns refresh/reconcile, without a hidden second append. Event history remains decisive after SQL rebuild or loss of NATS deduplication. After key deletion, the old command is permanently consumed: return safe forgotten/unavailable status, never provision its key or resend its content. A lost append reply is outcome unknown, never “nothing changed”.

Add one `memory` projection using `ProjectionRunner`: `memory_facts` (current metadata, ciphertext/key reference, deletable plaintext search text and tsvector), `memory_dependencies` (edges), and payload-free `memory_changes` (command/fact/revision/outcome/position). Keep all effects, processed id and checkpoint in one transaction. Index silo/scope/fact and scope-local ordering, plus GIN search. Retain only current search text; no plaintext revision/history table. Resolve keys through read-only custody before the SQL transaction; projection application never provisions or deletes keys. Missing destroyed keys produce unavailable content; transient key-store errors stop the projection rather than marking a live fact deleted. Replay never provisions keys, sends a model request or runs maintenance/cleanup effects.

Use PostgreSQL full-text `simple` configuration and `ts_rank_cd`, with parameters. TypeScript validates a query of at most 256 UTF-8 bytes and 8 terms, builds literal Unicode letter/number terms and bounded prefixes, and selects eligible scopes, live revisions and expiry. SQL does retrieval/indexing, never decides grants, lineage, correction, tombstones or scheduling. Compute tsvectors explicitly in the projection; no trigger, generated business expression, view or stored procedure. Rank pins first, then exact-term matches, prefix matches/rank, then stable memoryId. “deliver” should find “deliveries”; arbitrary middle-of-word matching and semantic similarity are outside this contract. Qualify realistic multilingual queries.

Recall searches one selected authorised scope per call, at most 20 facts and 16 KiB total serialised result including cursor/metadata. Return whole facts, using fewer rows when text is large; never cut UTF-8. Detail is also capped at 16 KiB. Return nextCursor and returnedCount; omit total counts initially. Bind opaque signed cursors to requester, scope, query, ordering, scope position and projection generation; reauthorise each page. Changed scope contents reset paging. No counts, ids, ranks or snippets from excluded scopes. Source previews are absent from list results; authorised detail resolves them separately.

Require projection catch-up to the captured relevant scope position before any read, including status, or return unavailable. In #95 this prevents a lagging index from returning a tombstoned fact; never serve stale text as a fallback. A proven append can return a payload-free saved receipt while list catch-up waits. No embeddings: model cost per fact is 0 euro cents. Reuse PostgreSQL, NATS, OpenFGA, pg-boss, Node crypto, Zod and jose; no new runtime dependency. Their recorded licences are OSI-approved. Any later vector/model proposal needs measured search failure, a named model and integer-cent budget, and owner approval before paid calls. It is outside #94.

## 3. Governed MCP and browser APIs

Host memory in the server, outside the computer. Expose stateless MCP 2026-07-28 `server/discover`, `tools/list`, `tools/call`; no sessions, resources, prompts, batches or legacy initialise fallback. Bind header method/name/version to the parsed JSON-RPC body; reuse lossless parsing and bounded `_meta.threadId/callId`.

| Tool | Input | Output |
| --- | --- | --- |
| `remember` | commandId, scopeId, text, kind, pinned, expiresAt, source references, dependsOn | changeId, memoryId, revision, scope/audience, savedAt, outcome; no permanent raw text receipt |
| `recall` | scopeId, query (empty means list), cursor?, limit? <= 20, memoryId? for detail | current facts with id/revision/text/kind/pin/expiry and authorised source status; nextCursor, returnedCount |
| `correct` (#95) | commandId, scopeId, memoryId, expectedRevision, replacement and sources | checked new revision or conflict/refusal |
| `forget` (#95) | commandId, scopeId, memoryId, expectedRevision | hidden/cleanup-pending/forgotten/unavailable, no forgotten text |

Do not advertise correct/forget until their implementation lands. Discovery and list expose reviewed definitions only, no facts or requester-private metadata. Record the built-in memory server, connection and reviewed zero-cost Allow tools using existing MCP catalogue events. Record requester and assistant `mcp_server` grants explicitly. Group remember has no approval card; policy Block still denies. A memory policy set to Ask is refused as a configuration mismatch, never silently converted to Allow or routed through a group approval queue.

Current facts: `apps/computer/src/proxy.ts` accepts only `/v1/responses`; no `mcp-proxy` exists on local origin/main or GitHub main inspected today. `libs/models/src/mcp.ts` validates calls and current published zero-cost policy; `decision.ts` checks tokens/thread/live activity; `gateway.ts` strips all credentials and forwards only its MCP allowlist plus decision-issued request id. It forwards no memory scope context today. `turn-tools.ts` offers tools only to personal memory-free turns. Restricted/private Codex configuration disables tools.

Extend that existing path: Codex → authenticated thread forwarding proxy → `/mcp/<memoryServer>/<connection>` on agentgateway → ext_authz → server memory MCP. The proxy takes credentials from its trusted grant map, not client headers. Only bridge-installed, live per-thread bindings can select tokens and routes. Strip all supplied identity, scope and secret headers. ext_authz returns an `x-memory-context` signed capability only on the built-in memory route; add it to that route's replacement allowlist, never external MCP/model routes.

Capability claims: issuer/audience, silo, requester, assistant, computer/generation, conversation, turn, thread, operation, scope ids, content-access class, context generation, callId/requestId, canonical body digest, issued/expiry times and grant positions. Expire within two seconds. Bind to exactly this method/name/body and route. MCP validates signature/binding, then rechecks current scope and operation rights; for writes, use the original capability deadline for the final access check. A signature is insufficient after revocation. Gateway-only network access plus signature verification refuses direct backend calls; short-lived turn secrets never reach the backend or logs. Duplicate remember transport replays still use command idempotency. No new general permit store or mutation ledger.

A thread can select only its requester's person scope, its bound assistant's notes, and that assistant's owner-group scope. Neither another membership nor a caller-supplied id expands it. Shared-only execution excludes person scope. Ended/forged/mismatched turns and stale content context refuse. #94 proves gateway calls using issued test contexts, without injecting facts or offering memory tools to persistent native Codex. #97 wires native calls after #95 and qualified #96; #200's documented local bridge credential gap must also be closed before this.

Expose browser APIs through existing authenticated HTTP/Origin/CSRF conventions: `GET /api/memory/scopes?assistantId=...&groupId=...` returns authorised choices, audiences, operation rights and limits; `GET /api/memory/:scopeId/facts?q=&cursor=`; `GET /api/memory/:scopeId/facts/:memoryId`; `POST /api/memory/:scopeId/facts` uses remember's contract; `GET /api/memory/:scopeId/changes/:commandId` checks this principal's original command without resending. Return 422 invalid input, 409 conflict, 503 unavailable and a uniform 404 for unknown/foreign/forbidden fact ids. Unknown command status stays unknown. Source resolution uses existing conversation/message access; opening a link rechecks access. Browser operations call the same memory rules internally, never manufacture ext_authz headers or require a live model turn for human storage.

Stored text is untrusted data. Delimit recall results with fact id/revision/scope; never interpolate text into tool definitions, system policy or access claims. #97 may include preferences as bounded user data within server-authored instructions, never executable policy. Facts cannot change identity, grant tools or request secrets. Escape HTML; no automatic fetching of URLs or source names supplied in text. Remembering “ignore the rules” is allowed as data and must confer no authority. Reject private-to-shared writes mechanically, not with a prompt instruction.

## 4. Privacy and downstream deletion

Owner/Admin can manage setup/grants and see permitted payload-free decision metadata. That role alone cannot list/search/read another person's facts or private notes, inspect source previews, export content or load another requester's context. A group member administrator sees group facts by membership, not by office. The silo infrastructure operator can technically read server/search storage and custodied keys; application permissions are not encryption against the host owner. Do not promise that stronger boundary.

`#95` appends a tombstone first, immediately denying usable recall/context, then
idempotently destroys every revision key and removes plaintext/tsvector rows.
It also invalidates dependent facts and deletes their keys/text transitively;
replay checks tombstones/dependency liveness before publishing rebuilt content.
Missing keys remain missing. Cleanup resumes after restart, even with key/index
failure. Stale correction/dream inputs cannot recreate a forgotten id/dependency.
Use the existing handler runtime for cleanup, no effects inside the projection.
The catalogue currently says “delete key, then tombstone”; correct that wording
with the new contract. Its per-scope key wording also needs per-revision clarification.

Store turn/receipt/audit evidence as fact/revision references, not permanent recall bodies or copied preferences under a conversation key. Generated memory-dependent private text stays volatile or uses deletable source-linked keys in #97. Never put facts in computer rollouts, report journals, SOUL.md, logs, prompt caches or dumps. Browser data remains in RAM; no localStorage, IndexedDB or offline/service-worker content cache. Use `Cache-Control: no-store`; clear protected state and discard late responses when scope/requester changes or access is revoked. Only access changes invalidate viewers; ordinary memory activity refreshes data.

Independent human chat messages and existing backups are not erased by forget. Search text is a deletable derivative, but database backups/WAL may retain it; retention and restore must reapply tombstones/deleted-key state before serving. Keep payload-free history only. #94 never enables memory in native turns; #97's 16 KiB initial context, reference-based reconstruction, revision invalidation, requester isolation and live no-disk proof remain explicit downstream gates.

## 5. Frame-to-API map and phone layout

| Frame | API/state binding |
| --- | --- |
| MEM-01 | scopes + facts with empty query: authorised empty group list |
| MEM-02 | pending bounded facts query; one polite “Searching …” status |
| MEM-03 | facts query/cursor; pins, source status, returned count and next page |
| MEM-04 | successful facts query with zero permitted matches; no hidden counts |
| MEM-05 | scopes + own-person facts; preference kind and “Only you” audience |
| MEM-06 | scopes + assistant-notes facts; actual permitted audience and shared-source rule |
| MEM-10 | remember POST/status receipt from accepted event; chat rendering later in #97 |
| MEM-20 | fact detail GET + independently authorised source links |
| MEM-21 | detail/source unavailable, missing, refused or revoked; no denied preview |
| MEM-30 | scopes/limits + selected authorised source + remember POST |
| MEM-31 | UTF-8 byte validation in form and identical server 422 validation |
| MEM-32 | remember pending/saved/definite failure/unknown; status GET for original command |

The issue's Design body lists ten states; its comment and PLAN also assign MEM-10/20 to #94. Cover all twelve above. MEM-10 Undo requires #95: use `canUndo: false` until forget exists, then its typed command. Hide unavailable Edit/Unpin/Forget actions in MEM-20. Do not promise “included in initial context” from a pin before #97; say “Pinned for initial context; loading is not enabled yet”. Disable Preference outside person scope, despite MEM-30's example group toggle. Do not reproduce static example counts, revisions, dates or successful outcomes.

Reuse MemoryList, MemoryFactDetail, MemoryFactForm and MemoryReceipt contracts in PLAN and the existing Angular shell. Desktop uses the session panel; detail/store open drawers. At 390px use full-width overlays with Back/Cancel and restore focus and scroll. Wrap three scope choices, long facts, source labels and audiences; missing authorised choices are unavailable, never fabricated. Stack actions with 44px targets; keep submit reachable above the keyboard. The reference phone assets clip some action edges: follow the handoff's no-horizontal-scroll rule. Arrow keys navigate scope/tabs, Enter opens, Escape cancels/restores row focus. Associate errors with aria-describedby, announce outcomes politely once, and make all motion static under reduced motion. No browser-only saved state.

## 6. Ordered, independently landable PRs and failing-first proof

Land serially; each starts from green main and supplies a complete outcome, tests, affected README/README.robot diagram/contracts, catalogue updates and its own branch-named release note. Estimates include hand-written tests/docs, not generated artefacts; keep each below about 600 added/deleted lines. No stack deeper than two.

| Order / target lines | Whole outcome and first failing tests |
| --- | --- |
| 1 / 550 | Replayable current memory with revision keys and operator rebuild, no public exposure. Prove Unicode/event limits; per-revision decrypt/AAD isolation; missing versus unavailable keys; current-state/index equality after rebuild; crash rollback and no external effects. |
| 2 / 590 | Authorised human scopes and store/list/detail/status HTTP API. Prove owner/group/notes matrix, read-only grants, admin/foreign-silo refusal, unapplied revoke, shared-source/private-output refusal, concurrent identical/changed commands, unavailable/lost append and same-reference reconciliation; long-chat activity cannot refuse reads. |
| 3 / 590 | Governed network memory discovery and remember/recall, without native memory admission. Prove real gateway header replacement, body/thread binding, direct/expired/ended/forged calls, stale grant denial, shared-only restriction, bounded exact/prefix ranking/paging and zero denied upstream effects. |
| 4 / 420 | Usable read-only Memory panel/detail at desktop and 390px. First test source-denial preview removal, scope change/revoke with late replies, empty/loading/no-result/down states, cursor reset, keyboard/focus and no persistent browser cache. |
| 5 / 400 | Human store form and real saved/status receipts at desktop and 390px. First test multibyte byte errors, shared Preference refusal, trusted read-only source, Cancel/no mutation, safe failure versus lost reply, Check status/no resend, no approval and hidden unavailable Undo/edit actions. |

PR 1 is an operator replay/storage feature, not unused future scaffolding. PR 2 is usable through HTTP before screens; PR 3 is usable by governed MCP clients while Codex memory remains gated; PRs 4/5 each deliver working browser outcomes. If a diff exceeds its estimate, recut a whole usable outcome before implementation. These estimates total about 2,550 lines. #94's 1,200–1,500-line ticket budget is not credible for the currently missing crypto, scope and MCP path plus UI/tests; recommend revising it to these complete outcomes, not weakening security or excluding tests/docs from the count. This is the requested design split, not permission to consolidate or to build a dependent chain before serial landing.

Run required source/web checks under nice -n 10 during implementation only; respect the live-view batch exclusion. Real NATS/PostgreSQL/OpenFGA/gateway tests must establish persistence and refusal; mocks alone do not. Source-ready PRs may land with native/live work explicit. Capability completion needs a fresh-install remember/recall/browser journey; #97 separately qualifies pinned Codex/gVisor, concurrent requesters and disk inspection. No tests, stack, model or qualification were run here: runtime/source gates and live capability are NOT RUN.

## 7. Open questions and recommended defaults

- Who selects existing assistants' memory grants? Use explicit owner/admin setup selection plus recorded per-operation grants; never grant from first recall.
- Which secret-store adapter supports permanent per-revision destruction? Reuse existing secret custody if it meets this contract; otherwise deliver the minimal adapter in PR 1. Block storage exposure until restart/deletion proofs pass.
- Can every current group message serve as a shared source? Default no: require durable whole-group visibility, otherwise explicit human-authored facts. Do not infer all-member visibility from an explicit participant list.
- Can private model output write a shared fact with a source id? Default refuse. Later #97 shared-only execution may do it; human storage remains available now.
- Should pins expire, and should search show totals? Default no pin expiry and no total counts. Keep 4 KiB facts, 20 results/16 KiB recall; publish server limits.
- How should orphan legacy scope ids be handled? Preserve encrypted metadata for replay, refuse access and require explicit offline mapping; never default to group.
- Are the PR budget and overlapping frames acceptable? Recommend five serial outcomes above; keep truthful #94 receipts and defer functioning Undo/correction to #95, native chat memory to #97, complete preferences/trail to #98/#99.
