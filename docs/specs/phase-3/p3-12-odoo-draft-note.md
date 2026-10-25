# Read and approve an Odoo draft-note change

Design for [#53](https://github.com/elewa-git/opencrane-new/issues/53), 10 October 2026. Read-only checkout:
`<worktree>`, branch `work/p3-12-design`. HEAD, local `origin/main` and GitHub main all checked at
`dd3880237b87f98bab1793a5e1ceec1addfdfbbc`. This note is a proposal. Implementation, tests and live qualification: **NOT RUN**. Only this
file was written. No repository edits, deployments, fixture starts, tests, model calls or spending. Network access was limited to GitHub
reads.

## Sources and current readiness

Read #53 and comments; #47, #49, #50, #52, #46, #48, #51, #63 and #105 with their comments; PRs #329,
\#65, #287, #308 and #311; AGENTS.md, the engineering standard, plan.md, all six ADRs, the event
catalogue and the requested source paths. Read Phase 3 tickets and decisions D18, D19 and D21, the accepted joint designs
`<home>/.fleet/reviews/p3-6-design.md` and `p3-8-design.md`, and the local INT/WRK handoff README/HTML, relevant phone PNGs and PLAN.md
P3-12 row.

- #47/#48's joint design and defaults are accepted. #329 is OPEN, not main:
stable `policyRevision`, dated snapshots and freshness checks are proposed there. Final checked dispatch, hosted admission and configuration
acknowledgement still wait.
- #49/#50 were described as not started in the request. GitHub now records their joint
design accepted at 19:56 UTC, with #49 custody PR 1 building. Their usable per-call bearer/OAuth paths are still absent from checked main.
Do not treat acceptance as delivery.
- #52 is CLOSED; #65 merged. Its direct JSON-2 fixture receipt is existing evidence,
not an MCP/chat receipt. README.robot.md and checks.py supersede #65's inaccurate claim that neither user can see the restricted record: the
assigned writer can.
- #46 remains OPEN. #287 supplies same-turn holds; #308 participant review; #311
dispatch evidence and explicit safe retry. Later #46 work still owns its remaining generic screens/qualification and stripping Codex private
metadata before external calls.

Verified on main, rather than inferred from issue text:

| Contract | Current fact and implication |
| --- | --- |
| Approval profile | `libs/models/src/approvals.ts` hard-codes `profile: 'none'` and “No account”. Personal/company binding needs #49. |
| Call availability | `mcp.ts` and server `chat/turn-tools.ts` require account mode `none`; turn offers are personal, memory-free only. Shared/requester credential delivery is a dependency, not already usable. |
| Price | `mcp.ts` returns `unknown_cost` unless a non-blocked tool explicitly has `costCents: 0`. Both Odoo tools stay zero. |
| Dispatch | `tool.dispatch_recorded` already has `not_dispatched`, `responded`, `outcome_unknown`. `responded` proves an HTTP reply, not an Odoo change. |
| Fixture keys | Odoo-generated 12-hour RPC keys, mode 600 below `~/.config/opencrane/odoo/`; directory 700. No key files were read for this task. |
| Fixture reachability | Operator loopback relay `127.0.0.1:18069`; named internal Docker network `opencrane-odoo-mcp-upstream`, Odoo `172.30.52.2:8069`. No k3d attachment or Pod route exists. |

ADR 0003's October amendments establish the pinned Codex 0.159.2 stateless flag and per-conversation unload/resume; its historical handshake
blocker is superseded. Use the current event-history command idempotency rule, not ADR 0001's old SQL-ledger suggestion. Queues and SQL
checkpoints are execution bookkeeping, never authority.

## 1. Exact feature and code ownership

One requester reads one draft sales order, proposes one replacement note, reviews the 8g Ask card, and approves or denies. Approval can
admit one attempted write; only dated Odoo readback can confirm the resulting note and upstream author. It does not confirm/send an order,
invoice, create records or offer arbitrary searches.

Create a small AGPL-3.0-or-later Node 22/TypeScript ESM workspace at `apps/odoo-mcp/`: `src/server.ts` for MCP HTTP/discovery,
`src/tools.ts` for the two schemas/handlers, and `src/odoo.ts` for fixed JSON-2 calls. Add its Dockerfile, reviewed runtime licence
inventory and README.md/README.robot.md there. These are proposed real repository locations, not existing files. Use installed Zod/HTTP
helpers and Node APIs; do not add an Odoo SDK or generic MCP framework by default. Keep model/approval rules in `libs/models`, receipt
commands in `apps/server/src/integrations/odoo-receipts.ts`, and chat routes in `apps/server/src/chat/tool-status.ts`. Do not run an MCP
inside those server modules.

| Tool | Strict arguments and bounded result |
| --- | --- |
| `read_draft_order` | `orderId`: positive safe integer. Read exact `sale.order` id, fixed fields: id, name, state, note, write_uid, write_date and at most 20 order lines with fixed description/quantity fields. Refuse non-draft, missing, inaccessible or oversized records; no truncated “complete” snapshot. Return a dated snapshot/version and digest. |
| `update_draft_order_note` | Scalar `orderId`, `note`, `expectedVersion`: required, no unknown fields. Version refers to the saved, verified read snapshot; note is bounded plain text. Replace only that order's note if its exact approved version still matches and it remains a draft. Return a typed reply; confirmation requires readback. |

Suggested bounds: note 2 KiB UTF-8; 16 KiB tool arguments; 64 KiB result; 15 s whole Odoo operation. Fail explicitly on bounds/invalid
UTF-8, never approve a shortened note. Quantities are descriptive bounded strings; add no monetary fields. Hash exact source note bytes
separately from escaped display text. Treat Odoo's HTML note as data; escape it for display. Convert new plain text to one deterministic
escaped Odoo paragraph representation before review, bind that exact representation, and compare the stored representation on readback. Do
not silently trim or normalise an approved note. If Odoo transforms it unexpectedly, report mismatch, not success.

Validate the complete before/new-note review against `libs/protocol/src/approvals.ts` and its 8,000-character field limits before Ask.
Oversized source/review data makes this write unavailable; never trim it or enlarge every approval's limits for Odoo. The dispatcher
supplies the saved snapshot in bounded, authenticated internal precondition context alongside the unchanged MCP arguments. The stateless
adapter verifies that context and its expectedVersion digest, then supplies only those fixed comparison fields to the Odoo method. It reads
no event store and retains no cross-request snapshot cache. Caller-supplied precondition context is stripped.

Enforce MCP `2026-07-28` on both headers and `_meta`; POST JSON-RPC only, explicit `server/discover`, `tools/list`, `tools/call` allowlist.
Full DiscoverResult includes `resultType`, `supportedVersions`, `capabilities`, top-level `serverInfo`, `ttlMs`, `cacheScope`. Also supply
matching `_meta.io.modelcontextprotocol/serverInfo` for the current inventory reader; qualify the real installer and Codex path together
rather than copying their differing fixtures. List both exact input/output definitions, review descriptors and annotations, with complete
pagination semantics. Discovery needs no Odoo credential and cannot call Odoo. Advertise a fixed catalogue per start with atomic
expected-revision checking under #47/#48's dispatch contract. Reject initialise/session/GET/resources/batches and mismatched names/versions.

Use Odoo JSON-2 POST with injected `Authorization: Bearer …` and fixed `X-Odoo-Database`. Paths, database, fields and methods come from
reviewed operator configuration/code, never arguments. No ORM executor, arbitrary model/method/URL, context overrides, `sudo`, administrator
fallback or impersonation. Reject identity arguments as unknown fields; they never choose credentials. Do not expose a third identity tool.
\#49's authenticated identity-check worker uses a separate fixed read-only operation: `res.users/context_get`, then self `res.users/read` if
needed. Pin verified uid plus upstream/database identity, not an editable profile label.

### Required atomic version check

The fixture currently uses separate native `read` and `write` requests. A final read followed by `sale.order/write` is **not atomic**:
another writer can change the note or confirm the order between them. Serialising our MCP cannot lock Odoo's other clients. Native write has
no expected-version argument in the checked fixture. Keep write unavailable until an atomic comparison is qualified; reads may proceed.

Recommended default: a tiny external Odoo add-on at `infra/odoo/addons/opencrane_draft_note/`, with one fixed JSON-2 method on sale.order
that compares an expected snapshot and writes the note in the same transaction. It locks the exact row, invalidates stale ORM reads, applies
Odoo ACL/record rules as the bearer user, compares id/state/note/write_date (and approved line facts), then uses native ORM write, without
sudo. Qualify concurrent order/line edits, including Odoo transaction-conflict behaviour; do not retry a failed transaction. This is an
upstream atomic storage operation, not an OpenCrane policy engine. All grants, modes, approvals, digest rules, budgets and status rules
remain typed TypeScript. Any SQL here is parameterised row locking only, no SQL business rules, triggers or stored procedures. Keep the
add-on outside the silo; record its licence and amended fixture inventory. Deploy the same guarded upstream contract elsewhere before
enabling writes there. If this external addition is rejected, the default is read-only, not a claim that two HTTP calls prevent concurrent
edits.

### Admission and licence evidence

Build a separate adapter image; never use/import the fixture image or build files. The fixture Docutils exception covers external
`infra/odoo` only and transfers no exception to the adapter. All silo application dependencies/binaries must be OSI; Debian main only for
the OS, with individually reviewed bundled free notices. Ship AGPL source/notices and corresponding-source access with the adapter. Install
the immutable digest through #47, with trusted publisher signature, complete licence inventory/SBOM, dated vulnerability and malware
evidence, platform, scan coverage, policy/version/hash references and expiry. Reject missing/unknown licences, unsigned/tampered content,
Critical/High findings and incomplete/stale scans. Dev reuses existing ClamAV; production hosted admission waits for our Phase 5 shared
scanner service. Do not duplicate scanner infrastructure or claim production PASS.

## 2. Runtime, upstream route and per-call identity

One stateless adapter per installed server in `<silo>-mcp`, outside gateway and computer. Reuse #47's gVisor, non-root, read-only root, no
capabilities/host mounts, no service-account token, bounded scratch/resources and exact workload UID/generation admission. Default-deny
NetworkPolicy: inbound only the checked gateway transport; outbound only the operator-bound Odoo address/port, with controlled DNS if
required. No NATS, SQL, custody credentials, registry access or Internet-wide 443 in the MCP.

Dev route proposal, not present or tested now:

```text
Codex → private proxy → agentgateway/ext_authz → checked dispatcher/injector
  → <silo>-mcp Odoo Pod → fixed TCP relay on k3d-ocn
  → opencrane-odoo-mcp-upstream → 172.30.52.2:8069
```

Use a dedicated digest-pinned, OSI socat relay attached to exactly those two Docker networks. Bind its listener only to its private k3d
address, with no published host port; hard-code the single Odoo target. Add operator-owned routing/cleanup at
`infra/dev-stack/odoo-upstream.ts`, using the existing dev relay patterns. Extend the D19 upstream binding to name this relay's exact owned
identity/address and the approved MCP workload UID/generation; a Docker network name alone proves no identity. Permit Pod egress to that
relay /32 and port only. Enforce named-workload access with cluster NetworkPolicy before node SNAT, plus operator network/firewall controls.
Do not attach the k3d node itself to Odoo's bridge, publish Odoo broadly, use host networking in the MCP, or assume Pod localhost reaches
the host's operator port. If the CNI cannot enforce this path, leave the route unavailable. Live tests must prove an unrelated Pod/computer
cannot reach relay/Odoo and MCP cannot reach other ports, databases, metadata or Internet. Persist only safe operator binding metadata.
Fixture lifecycle remains operator-owned in infra/odoo; dev-stack code must not depend on its images/build files or silently reset its data.
Helm comes later.

\#49 owns custody, explicit selection, profile generation and one-request leases.
Secure operator setup imports writer/reader key files into that custody path without argv/log output; events contain secret ids and safe
verified identity only. Reset rotates fixture keys; 12-hour expiry requires fresh setup, never admin substitution. Only the trusted injector
reads material after current checks and a confirmed `credential.released` append. Bind lease to silo/request/permit/requester/profile,
generation/computer/thread/tool/backend; expiry at most 30 s, shorter than remaining admission evidence. Overwrite client credential
headers. Release failure sends nothing. The MCP holds the injected bearer only for the bounded request, never a user registry, cache,
environment startup secret, disk, log or result. Disable HTTP proxy inheritance, redirects and transport retries. Strip private Codex
`_meta` under #46's accepted boundary contract without changing the exact approved argument bytes/digest.

Personal and team assistants use whoever requested that turn. Concurrent writer and reader requests share the stateless adapter but not
credential state. A company profile requires recorded admin opt-in AND explicit member selection AND current requester/assistant grants.
Odoo sees the bot uid; OpenCrane records the requester and bot separately in review/result/audit. #105 owns full company/group admin UX;
\#49 owns the connection primitives. #51 startup-secret instances are unnecessary
for Odoo and must not be introduced as a shortcut.

## 3. Events, commands, status and replay

Reuse install/discovery/review/publication events from #47/#48, grants, #49 connection events and `credential.released`. Do not invent an
Odoo permission database. Read history, encrypted review/snapshot and slower policy/Odoo preparation before starting the two-second access
check, with their own bounded deadlines. Watch only relevant small member/assistant/team/payer/grant streams; check profile/selection,
policy and instance generations separately at final dispatch. No wildcard reads, whole-conversation watches or history reads inside that
access window. Read endpoints check access once, not an activity fence. Tool activity does not close a reader/viewer. Keep
`libs/models/test/authority.test.ts` and `authority-volume.test.ts` unchanged, including their assertions/deadlines. Add targeted
integration coverage elsewhere.

Each named command folds exact events and does one conditional append to one stream. External HTTP and credential work runs outside
commands. Use commandId/principal, expected sequence and exact payload comparison beyond NATS's duplicate window. No append failure or
uncertain acknowledgement can authorise forwarding.

| Stage / command | Existing or proposed fact, checks and meaning |
| --- | --- |
| Read | Existing `decision.recorded`, `credential.released`, `agent.tool_call_started/finished`, `tool.dispatch_recorded`; proposed `tool.result_recorded` saves validated read snapshot or typed refusal. Allow read still checks current requester ∩ assistant grants and Odoo ACL. |
| Propose / Ask | Existing `tool.approval_requested` on `approval-<id>` binds the verified saved read snapshot to exact arguments/review, requester/conversation/logical turn/assistant, schema/tool/stable policy revision, image/instance, upstream and selected profile/generation. Model-supplied expectedVersion must match the saved snapshot, not create evidence. |
| Approve / Deny | Existing approval GET/POST; only requester. `approval.decided` records approved/rejected; approved means “not used yet”. Missing review fields may be denied but never approved. Same-turn hold expires after 15 minutes or earlier turn closure/profile/evidence limit. |
| Write admission | Check current rights, open work/budget state, unchanged binding and fresh catalogue; consume `approval.used`, confirm decision/release/dispatch claims in separate commands, then forward once. The upstream atomic method checks the approved version. Burnt approvals stay terminal after a crash. |
| Write reply | Existing `tool.dispatch_recorded` keeps transport meaning; proposed `tool.result_recorded` records validated applied reply, upstream ACL refusal, version conflict or uncertainty. Neither approval use nor HTTP 200 is confirmation. |
| Readback request | Proposed `tool.readback_requested` on the original `decision-<requestId>`; requester or initial authorised post-write reaction, exact original operation, checkRef and expected sequence. Queue one bounded read; no write route/body. |
| Readback result | Proposed `tool.readback_recorded` on that same stream: checkRef, evidence time/digest, matching/mismatching/unavailable status, safe cause and encrypted Odoo facts. Confirm only under the evidence rules below. Missing result stays unknown. |
| Check status | GET saved operation status never contacts/writes Odoo. Explicit POST Check status appends a readback request if needed; its reaction calls only `read_draft_order` with a fresh release. Repeat/reload of the same checkRef joins that read, never dispatches a write. |

The three proposed event names are additions, not main contracts. Implement each in `libs/events/src/data.ts`, registry/event definitions
and every matching table in `docs/architecture/events.md` together. `tool.result_recorded` and readback facts carry request/logical
request/call/approval/conversation/turn/server/profile refs, account kind and verified uid, source revision and timestamp; private
order/note facts use bounded ciphertext/keyId plus digest. Hash binding checks happen before storage and on decrypt. No bearer, token hash,
raw upstream error or HTML in audit. Only the trusted dispatcher/receipt worker may report them; a computer's summary or arbitrary adapter
response cannot substitute for validated transport evidence.

Extend `libs/projections/src/conversations.ts` with encrypted result/readback entries and `audit.ts` with an explicit safe allowlist for
these tool events (its current prefix list does not include all tool facts). Join by original request/approval id. Keep
`mcp-catalogue.ts`/`tool-policy.ts` responsible for server availability under the shared fold. SQL only stores/indexes projection facts.
Rebuild statuses, receipts, approvals and audit with reactions off: zero calls, releases, writes or refreshed timestamps. A replacement
dispatcher starts closed and reads claims; never resend a write claimed before its crash, even if there is no recorded reply. Keep the used
approval terminal; derive external confirmation separately from result/readback facts. Updating the displayed outcome never makes it usable
again.

Readback after the turn closes needs #49's lease purpose extended with a narrow `readback` worker form: requester/original
request/checkRef/read tool/account binding, no invented live computer or turn credential. Authorise it as a fresh requester read, using a
currently usable profile verified as the same upstream identity. Rotation may allow a fresh read of that same account; revoke/admin disable
blocks release. No company/other-user fallback. A held/drifted server cannot reconcile through old code; wait for a currently reviewed read
path. Approval expiry does not block a new authorised evidence read, and the read grants no new write permission.

### Evidence and refusal rules

Compare readback's order/upstream id, draft state, exact note representation/digest, `write_uid` and `write_date` with the approved snapshot
and dispatch interval. Uid must match the verified personal user or explicitly selected company bot; write_date must advance from the
approved version. Reject missing/malformed facts and implausible timestamps; keep raw Odoo precision, do not use gateway log time as causal
proof. In the isolated fixture, one admitted attempt plus matching dated readback confirms the observed change. In general these fields
cannot identify a unique request: another write by the same account, timestamp resolution or a later overwrite can make attribution
inconclusive. Show “note matches; attribution not confirmed”/Unknown rather than exactly-once. Do not add an upstream receipt ledger solely
to make that claim. Never fabricate an Odoo record of an OpenCrane request id.

| Condition | Required result |
| --- | --- |
| Deny, expiry, Stop/closed turn | Denied/Expired/Cancelled; no release or write, no automatic restart. |
| Changed arguments/note/order/version | Old approval cannot authorise another payload; atomic upstream conflict writes nothing. Fresh read and new explicit request/review required. |
| Revoked/replaced/disabled profile or grant | Invalidate old approvals/permits; no release after current check. Already sent work may finish; keep unknown evidence if readback is now refused. |
| Schema/description/image/instance drift | Hold under #48, cancel old approval, no old-revision write after restore. Freshness-only unchanged checks do not cancel via stream-position churn. |
| Odoo ACL/record-rule refusal | Typed refusal, even after OpenCrane approval; no administrator/other-account suggestion or retry. Reader's refused write leaves note and write_uid unchanged. |
| Lost write reply/Pod/worker | Outcome unknown; claim/used approval prevents resend. Only explicit readback; absent/mismatching note does not prove nothing was sent. |
| Proven non-dispatch | Only trusted dispatch evidence proves it; missing receipt, HTTP error, unchanged note or “Odoo has no record” cannot. Existing explicit safe-retry command may authorise one identical attempt after fresh checks; never automatic. |
| Hard stop | D21 stops remaining writes, including under old reservations; record already-dispatched evidence. A separate authorised zero-cost readback may collect evidence, never resume stopped work. |

Odoo notes, names, line descriptions, errors and tool descriptions are bounded data, never instructions or a reason to change grants, choose
an account or call another method. Render escaped text; never execute HTML/Markdown or fetch embedded links. Keep returned text in
tool-result data, never system instructions. Security remains enforced even if text asks an assistant to ignore approval or reveal
credentials.

## 4. Dependencies and what can land early

Adapter discovery/bounded reads, atomic upstream support, closed write handler, receipt schemas/projections and saved-status APIs can land
independently before
\#47/#49/#50 finish. They must expose no bypass route or static fixture credential.
Dev relay preparation can land without callable MCP deployment, with the operator binding explicit; actual workload admission waits for #47.
Do not fake pipeline events or seed reviewed/publication facts to call an unfinished hosted installer.

Credentialed chat reads/writes and live readback wait for #47/#48 admission, publication/config acknowledgement, stable revision/final
dispatcher, #49 verified bearer custody/selection/release and bound approvals, and #46's supported turn/privacy contracts. Shared Odoo proof
also waits for real requester-bound team turn delivery; do not remove the current personal-only gate locally to manufacture that proof.
\#52's fixture exists, but the relay and atomic guard still need qualification.

OAuth #50 is **not technically required for the fixture's Odoo RPC bearer key**.
\#49 is the actual credential dependency. #53's issue/spec/PLAN still list #50:
recommend a reviewed dependency correction there, retaining #50 for OAuth and
\#63's whole Phase 3 qualification. This note changes no tracker edge. Until the
edge is changed, report that administrative gate explicitly; do not silently close
\#53 early. No invented Odoo OAuth scopes/consent/refresh path. Describe Odoo model
rights as ACL capabilities, not OAuth scope names from the illustrative frames.

## 5. Screens, APIs and missing handoff

Use `apps/web`, existing chat components, the settings shell and v2 tokens; not the handoff's historical apps/opencrane-ui name or copied
inline HTML. API labels below: E = exists on main; P = proposed here; C = connection contract owned by #49.

| Frames, 1280 and 390 | APIs and ownership |
| --- | --- |
| WRK-02–04 | E conversation HTTP/socket activity; P validated result/receipt fields and GET `/api/conversations/:conversationId/tools/:requestId`. Running, bounded Odoo result, sanitised details with account/requester and dated evidence. #46 owns generic pieces; #53 supplies Odoo content. |
| WRK-05 | Existing linked attempt/dispatch fields plus #46 safe-retry UI. Show only saved attempts; no estimated retry count. Read succeeds after explicitly authorised proven-safe retry. |
| WRK-10–11 | E GET/POST `/api/conversations/:conversationId/approvals`; #49 adds verified account/generation, #53 approved before/new note/version and Odoo consequence. Missing company account variant A below. |
| WRK-12–14 | Same approval API: other participant sees review, requester alone decides; missing details blocks Approve but allows Deny; submitting waits for same reference. #46 owns screens. |
| WRK-15 | P result/status GET plus saved readback fact; show dated matching note and actual write_uid, not just “approved”. #53 owns readback content. |
| WRK-16–22 | E approval lifecycle/status and #49 connection facts: consumed, denied, expired, cancelled, changed binding, sign-in/reconnect. #46 owns shell states. Reconnect restores a draft/new review where needed, never resurrects a consumed write. |
| WRK-30–31 | #46 owns safe non-dispatch/unknown pieces. #53 supplies Odoo facts. Correct WRK-31 to “may have reached Odoo” unless dispatch is positively known; Check status uses original request. |
| WRK-32–35 | P GET original tool status; POST `/api/conversations/:conversationId/tools/:requestId/readbacks` with checkRef, expectedSequence and CSRF. Checking/still unknown, confirmed matching readback, trusted non-dispatch, Odoo-rights refusal. #53 adds these. |
| INT-60–61 | C GET `/api/my/tools`: eligible unconnected/list, own verified account/status/expiry and explicit selection. #49 owns reusable screens; Odoo content here. |
| INT-62–64 | C POST `/api/my/tools/:serverId/profiles`, then GET `/api/my/tools/changes/:changeRef` and own detail: masked bearer entry, saving, verified connected with input cleared. Connected alone is not Selected. |
| INT-65–66 | C POST own profile `/rotate` or `/revoke` with expected revision/changeRef; same status read. Local release stops, upstream token deletion is not promised. |
| INT-73–75 | C own status plus E chat access: disabled/revoked cause displayed accurately, missing profile/selection refuses without fallback, confirmed return offers unsent draft. Distinguish owner revoke from admin blocker (#49 also uses INT-76). |

GET tool status returns saved approval/dispatch/result/readback as separate facts, with checkedAt, original ids, canCheck/canRetry and
reasons. GET never writes or refreshes Odoo. POST readback is requester-only; GET private result requires current conversation
participation/join scope. Origin/session/CSRF protect mutations. Admin audit alone cannot decrypt a private note. Clear protected DOM and
ignore late responses on access loss. A 404/projection delay is not confirmed non-application.

Correct WRK-34's “Odoo has no record of req_1042” to the trusted gateway/dispatcher non-dispatch evidence and date. Correct WRK-33's
changed-once implication to matching readback/author evidence with its limits. Existing frames can take these copy fixes; the richer
conflict/account/evidence states below need handoff before their UI PRs. PLAN.md row P3-12 currently says hosted adapter/profile/readback
need building through P3-6/P3-9/P3-11. Later update it to P3-6/P3-7/P3-8/P3-11 plus atomic upstream/relay, explicitly mark P3-9 as the
tracker question, link receipt APIs and missing frames. Keep #46 ownership WRK-01–07, 10–14, 16–22, 30–31; #53 adds 15, 32–35 and Odoo
content.

Mobile first: 390px with wrapped names/ids, stacked labelled facts, no horizontal scroll, 44px targets and full-width primary actions.
Full-screen details with Back, scrollable body, focus trap/Escape/return focus; actions cannot conceal the note or consequence. Composer
stays above keyboard. Generic Enter never approves. Status is glyph plus words, polite once; replay is quiet. Reduced motion uses static
loaders. Reuse DM Sans/DM Mono, paper #fbfcfc/canvas #eceff0, ink #16191a/muted #4f575a, teal
\#0db5cc/focus #0a8497, orange #f47920, green #2a7d4f/red #c1392b, 12px dog-ear/card radius, 8px buttons,
crease and 2px focus ring.

### Ready-to-paste Claude Design prompts for missing screens

These are missing exact frames, not a request to run Claude now. Produce desktop 1280px and phone 390px frames, keyboard/focus and
reduced-motion notes for each. Prompts A/D/E/F reuse #49's existing missing-frame requests; coordinate one handoff. Unrelated
OAuth/admin-member validation screens remain
\#49/#50 scope, not new #53 UI.

#### A. Approval with explicit personal/company account attribution

> Design the missing WRK-10/11 account-bound Odoo approval variant. Purpose: let the requester knowingly approve this note change as their own account or an explicitly selected company bot; other participants can read but cannot decide. States: pending personal/company, submitting, missing review, expired, profile changed/disabled, unknown after dispatch. Data: requester, verified upstream uid/name, Personal or Company label, profile generation, order, current and exact new note, checked version/time, consequence and expiry; never tokens. Approve/Deny are explicit; changing account cancels and requires fresh review, with no account picker inside approval. At 390px stack account then before/new-note facts, scroll the review and keep full-width 44px actions reachable above the keyboard. Reuse WRK-10–14/20, INT-20/73, 8g orange edge, DM Sans/DM Mono, paper/dog-ear, teal #0db5cc and #0a8497 focus, orange #f47920, green #2a7d4f/red #c1392b. API: existing approvals GET/POST with bound safe account fields.

#### B. Company attribution on tool result and readback detail

> Design the missing company-account Odoo result/detail state. Purpose: explain who requested work and who Odoo recorded; users are authorised chat participants, with evidence checks reserved to the requester. States: successful read, pending write, confirmed matching note by bot, refused, missing author evidence and unknown. Data: requester name, explicitly selected company account and uid, order/note summary, write_uid/write_date, checkedAt and original request; no token or full raw output. Open details/Back, jump from Activity and Check status when permitted; never suggest switching to an admin. At 390px stack “Requested by” and “Odoo account” above evidence, wrap ids and use a full-screen drawer with 44px Back and primary action. Reuse WRK-03/04/15/31–35, INT-20/21, 8f tool lines, DM Sans/DM Mono, paper #fbfcfc, dog-ear/crease, teal #0db5cc/#0a8497 focus, green #2a7d4f/red #c1392b. API: tool status GET and readbacks POST; show author and requester as separate facts.

#### C. Readback checking, conflict and unavailable evidence

> Design missing Odoo readback detail variants. Purpose: resolve uncertainty conservatively; users are the original requester and authorised participants. States: checking, note/author/version match, note matches but author unconfirmed, later different note, no read rights, revoked profile, server paused and unavailable Odoo; unknown offers no write retry. Data: approved/current note, original version, observed write_uid/write_date, account, checkedAt, original request and safe cause. Check again requests only a read of that reference; reconnect/review leaves the write terminal, Back closes detail. At 390px stack Approved and Observed cards, wrap text, provide a scrollable full-screen sheet and full-width 44px Check status; no horizontal comparison table. Reuse WRK-04/15/31–35/20, INT-73/92/95, DM Sans/DM Mono, paper/dog-ear, teal #0db5cc/#0a8497 focus, amber #8a5d1f, green #2a7d4f/red #c1392b and static reduced-motion status glyphs. API: saved tool GET and requester readbacks POST; matching content alone cannot prove exactly-once.

#### D. Explicit account choice after bearer connection

> Design My tools Choose account for Odoo. Purpose: record a deliberate selection; users are members with current tool access. States: none selected, verified personal choices, explicitly enabled company choice, saving, selected, disabled/stale and unknown. Data: own profile id/name, verified uid/account, owner kind, expiry/status; never other people's personal profiles, validation profiles or tokens. Choose/Use this account/clear selection/Connect are separate actions; Connect never automatically selects or resends chat. At 390px use stacked radio cards, wrapped account names, full-width 44px confirmation and an unsent draft on return. Reuse INT-20/60–64/73–75/95–96, settings shell, DM Sans/DM Mono, paper/dog-ear, teal #0db5cc/#0a8497 focus and glyph-plus-word status colours. API: #49 GET own profiles and POST `/api/my/tools/:serverId/selection` with expected revision/changeRef; company choice states Odoo sees the bot.

#### E. Personal bearer detail, replacement entry and expiry

> Design My tools Odoo bearer detail and replacement entry. Purpose: manage this verified personal key; user is its owner. States: current, approaching/actual key expiry, replacement entry/saving/confirmed, admin-disabled, wrong verified account and unknown. Data: account/uid, profile, expiry, selected status, last checked time and change reference; secret is never read back. Replace enters a new masked empty field and verifies the same account, Revoke reviews local consequences, Check status recovers the original change; clear entry on accepted/unknown/close and never resume a pending write. At 390px stack labelled facts, use a keyboard-safe full-screen form with 44px actions and wrapped ids. Reuse INT-62–66/73/90–96, DM Sans/DM Mono, paper #fbfcfc/dog-ear, teal #0db5cc/#0a8497 focus, orange #f47920/red #c1392b. API: #49 own profile GET, rotate/revoke POST and change GET; explain the fixture's real 12-hour expiry without presenting OAuth refresh.

#### F. Company bearer management and explicit opt-in

> Design admin Odoo company-connection detail, rotation and Disable review. Purpose: maintain the deliberately enabled bot connection; users are current silo admins, while members only select an eligible account elsewhere. States: no opt-in, connected, key expired, replacing/confirmed, disabled, changed identity, stale revision and unknown. Data: verified bot uid/name, custodian, expiry, selected-use impact, last change and safe reference; no token readback or personal impersonation. Opt in explicitly, enter new masked bearer, confirm Disable, cancel or Check status; explain local revocation and no company fallback. At 390px stack cards and use a full-screen keyboard-safe review, wrapped impact text and full-width 44px actions. Reuse INT-20–22/62/65–66/90–96, admin shell, DM Sans/DM Mono, paper/dog-ear, teal #0db5cc/#0a8497 focus and red #c1392b danger. API: #49 company detail/rotate/disable and original change GET; #105 later adds full group administration.

#### G. Upstream atomic-write capability unavailable

> Design the missing Odoo integration detail and chat refusal variant when bounded reads work but safe conditional note writes are unavailable. Purpose: avoid presenting an unchecked write as ready; users are admins inspecting readiness and requesters encountering refusal. States: atomic capability missing, checking, qualified, changed upstream contract and unavailable evidence. Data: upstream identity, fixed guard version/digest, checkedAt, affected write tool and readable reason; no internal SQL or secrets. Admin Refresh status reads saved capability evidence and cannot publish/grant by itself; requester may read or return to chat, with no bypass or admin-account action. At 390px stack Read available/Write unavailable facts, wrap reasons and use 44px full-width actions in the normal shell. Reuse INT-37/40/42/91 and WRK-20/35, DM Sans/DM Mono, paper/dog-ear, teal #0db5cc/#0a8497 focus, amber #8a5d1f and struck-circle/word status. API: reviewed integration/tool readiness and tool status GET; never trigger a test write from the screen.

Backend PRs proceed without these frames. UI PRs that introduce A–G wait for the owner's accepted handoff. Framed generic
connection/approval work remains with
\#49/#46; avoid duplicating their components or missing-frame implementation.

## 6. Ordered PRs and failing-first evidence

Land serially from then-current main; each row is independently usable or safely closed, not a stack of speculative interfaces. Target at
most about 600 total non-generated added/deleted lines per PR, including tests, both package READMEs, catalogue/API docs, diagram changes
and branch-named changes/unreleased note. Narrow further if measured diff exceeds that target; do not compress code/docs. Server behaviour
lands before screens; the final row adds qualification only.

| Order / target lines | Whole outcome, gate and tests written before implementation |
| --- | --- |
| 1 / 580 | Standalone adapter discovery and bounded read, no credentialed product route. Red: real HTTP full discovery/version/meta/header checks; identity/arbitrary method rejected; oversized/non-draft/read ACL refusal; exact lossless snapshot and text escaping. Can land before blockers. |
| 2 / 550 | External Odoo atomic version operation and reproducible fixture capability evidence. Red against real ordinary users: concurrent note/confirmation/line edit rejects stale update; reader denied; rollback preserves note/uid; no sudo/retry. Can land early; unavailable capability keeps write closed. |
| 3 / 500 | Adapter fixed guarded write and typed response; still no bypass route. Red: expected snapshot/digest mismatch, changed note/state, malformed result/redirect and lost reply; at most one send, no automatic HTTP/transaction retry. Can land early. |
| 4 / 550 | Validated encrypted tool result facts, feed and safe audit projection. Red: forged correlation/source, wrong silo/account, note leakage, hash failure; real event/PostgreSQL rebuild reproduces results with zero effects. Can land early. |
| 5 / 580 | Original-operation status/readback request/result commands and API, execution unavailable until broker exists. Red: requester/join scope/CSRF, same checkRef idempotency and changed payload conflict, unknown append recovery, GET makes no external call; conservative matching/author/version rules. Can land early. |
| 6 / 450 | Operator-owned dev fixed relay/binding lifecycle. Red network qualification: no original Pod route; only named admitted MCP can reach fixed target, other Pod/computer/ports refused; cleanup cannot remove foreign identity. Preparation can land early; deploy/call qualification waits for #47. |
| 7 / 580 | Real personal Odoo admission/review/Ask/dispatch integration, consuming #47/#48/#49/#46 contracts. Red: none-profile forbidden, unverified/expired keys, revoked grant/profile, stale schema/instance, altered arguments and budget stop; approval/release/audit failures send nothing, one approval admits one attempt. Wait for prerequisites and atomic guard. |
| 8 / 550 | Governed readback worker and narrow #49 readback lease purpose, including closed-turn recovery. Red: lost write reply → read only; restart never resends; same-account rotation/read rights checked; other identity/revoke/drift blocks evidence; mismatch stays unknown, trusted non-dispatch remains separate. Wait for broker/final dispatcher. |
| 9 / 500 | Odoo requester/account attribution qualification for concurrent team turns and explicit company selection. Red: writer/reader overlapping one assistant never swap; reader restricted read/write denied despite grants/approval; no fallback; bot uid differs from requester and appears in result/audit. Wait for shared-turn and company primitives; do not rebuild group admin. |
| 10 / 550 | Framed WRK-15/32–35 and bounded Odoo read/details content using server facts. Red browser/component cases: approved alone not success, unknown has Check status only, authoritative safe retry only, late protected result ignored; desktop/390px keyboard/overflow/reduced motion. Wait for server facts and #46 reusable UI. |
| 11 / 450 | Account/readback-detail variants A–C and capability-refusal variant G. Red: bot/requester distinction visible before approval and after result; conflicting/inaccessible evidence stays unknown; 390px review does not hide notes/actions. Wait for accepted handoff; split by complete screen responsibility if over budget. |
| 12 / 550 | Fresh live Odoo journey/receipt using actual hosted install and product flows, extending infra/dev-stack journey style without replacing server with test wiring. Red first: failure when any scan/route/profile/readback/second-user proof is absent. Run fresh install twice, including desktop/390px; final receipt below. Wait for earlier rows and reusable #49 connection/selection screens D–F. |

Rows D–F's generic connection UI PRs are already owned by #49; their framed INT screens and missing-frame PRs land after their servers and
accepted handoff. They are prerequisites to row 12, not extra #53 profile implementations. #50 does not block source/backend rows for
bearer; retain the tracker caveat from section 4.

Future implementation runs relevant real integration checks and mandatory lint, typecheck, test, check:events plus separate web checks
before landing/on main. Run Vitest, lint, typecheck and builds under `nice -n 10`; never a full root suite or fleet batch during live-view
qualification. At most two independent review passes under the engineering standard; unresolved blockers go to the owner. PR descriptions:
Why / Functional outcome / Architecture / Evidence / Not in this PR. One emoji/plain commit sentence; no co-author or AI attribution.

The final receipt records date/SHA, adapter digest, signature/scans/SBOM, upstream pin/guard and relay identity, fresh stack id, safe
fixture ids, commands, original approval/request/release/readback refs, expected/observed outcomes and artefact links. Use real
Codex/proxy/gateway with local scripted Responses if needed: this can prove live Odoo effects without a paid model. Do not reuse
approval-journey.ts's directly seeded policy/turn or mcp-journey.ts's replacement server as hosted-flow evidence. Verify writer allowed
read, deny with zero writes, approve one exact changed note, actual write_uid/readback, reader allowed shared read and denied restricted
read/write, concurrent team identities, explicit bot attribution with a separate ordinary bot, all listed invalidations, lost
reply/readback, drift hold and replay/service/Pod restart. Show no second write using fixture observations and before/after facts, not mocks
alone. Reset fixture through operator instructions separately; never deploy its images in a silo. Mark every condition PASS/FAIL/PARTIAL/NOT
RUN. Missing team/company/handed-off screen evidence keeps capability PARTIAL; no mock-only PASS or production/Helm claim. Feed this bounded
receipt into #63, which owns the broader Phase 3 fresh journey.

## 7. Open questions and recommended defaults

| Question | Recommended default |
| --- | --- |
| Can the external upstream supply an atomic version check? | Require the narrow Odoo add-on/storage contract above; qualify concurrency under ordinary users. If unavailable/unaccepted, leave write blocked and report PARTIAL. Do not call separate read/write race-safe. |
| Which approved facts invalidate the version? | Exact order id/state/note/write_date and the bounded read's displayed line facts. Refuse changed order facts; lock/revalidate relevant lines too or refuse write capability. Never infer version only from displayed text. |
| Which identity/expiry for fixture keys? | Verify uid through the fixed read-only #49 identity operation; import via secure operator setup, explicit selection. Use fixtures.json's safe expiry metadata; elapsed 12 hours means replacement/reset, no OAuth refresh. |
| How should #50's blocker be corrected? | Owner/orchestrator updates #53/spec/PLAN to #49 for bearer delivery; #50 stays required by OAuth/#63. Until corrected, disclose the remaining tracker gate. |
| What proves an ambiguous write? | Conservative readback comparison with author/time/version and original approved digest. Inconclusive/conflicting evidence stays unknown; no retry or exactly-once claim. No new generic receipt/idempotency platform. |
| Is safe retry enabled for Odoo? | Only explicit #46 retry after trusted proof of non-dispatch, identical binding and fresh checks. Denial/expiry/conflict/revoke/drift/unknown never offers it; a new request needs a new review. |
| Is a company bot required for completion? | Qualify explicit bot selection/attribution using a separate ordinary synthetic Odoo account once #49 primitives and handoff exist. Do not relabel the writer/admin; #105 full group/company administration may wait. |
| What is production readiness? | Dev stack first; no Helm deliverable. Production hosted admission waits for Phase 5 shared scanner, custody and network qualification. Docutils exception remains fixture-only. |
| How much new dependency/network machinery? | Installed Node/schema/HTTP packages plus a fixed existing OSI relay pattern; reviewed pins/inventory. No Rust fork, generic ORM, scanner per silo or broad private-address exception. Tailnet browser access only; never Tailscale Funnel. |
| Any Zitadel changes? | None for Odoo bearer protocol. If later journey identities need provisioning, only the “OpenCrane 2 Dev” org and disposable users; never change another org or the web SSO app for this adapter. |
| What costs money outside the box? | **Outside the box:** paid model/provider calls, hosted registry/storage/scanner compute, cloud KMS/vault, paid OAuth tiers and external Odoo hosting. None is authorised/needed here. Use existing box/cluster/dev store and zero-cost synthetic calls. |

Every Odoo tool/identity/readback call is explicitly zero integer euro cents. Keep hard stops and current paying-group/assistant
attribution; zero price is no permission to bypass closed work or resume stopped writes. No spending outside a recorded allowance. This task
spent nothing. #63's separate shared 500-cent live-provider envelope requires proven remaining balance/provider limit before any later paid
qualification; otherwise that condition is NOT RUN. Design readiness is not source readiness or capability PASS.
