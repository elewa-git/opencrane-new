<!-- markdownlint-disable MD018 MD036 -->
# Personal bearer profiles and OAuth connections

Design for [#49](https://github.com/elewa-git/opencrane-new/issues/49) and [#50](https://github.com/elewa-git/opencrane-new/issues/50), 10 October 2026.
Base: `work/p3-8-design`, equal to local `origin/main` at `d53e8e35aa94`.
Proposal only. Implementation, tests, desktop/mobile journeys and fresh-install qualification: NOT RUN.
Only this note was written. No product changes, stacks, tests, model calls or spending; network reads were GitHub-only.

## Readiness and sources

Read both issues, comments and Design sections; #45–#48, #51, #53, #105, #63 and #100; the accepted `<home>/.fleet/reviews/p3-6-design.md`; and open PR #329.
Read AGENTS.md, the engineering standard, all six ADRs, Phase 3 tickets/spec/decisions, D08 and D14–D17 with their OC1 rows, the root plan and event catalogue.
Read the named model/event/projection, server, computer, auth/authz, dev-stack, Odoo and web paths. Read the INT handoff README/HTML and requested PNG sets, WRK-10/11, OVR-20 and the PLAN rows for both issues.
Reuse narrowly from OC1 `libs/backend/server/gateways/mcp/main/src/connections/`, source commit `10abd0ef6`; preserve its licence and record the source in the owning README.robot.md.
Adapt `kubernetes-mcp-connection-secret-store.ts` and its HMAC keyring; do not port the Prisma-backed credential reader, its bearer-only assumption or its database authority model.

#46 remains OPEN despite merged #221, #225, #250, #258, #265, #270, #283, #287, #297, #308 and #311. It supplies real governed calls, approval waiting and recovery, not completed fresh-install qualification for personal credentials.
#45 has merged #204/#222, but reviewed publication acknowledgement and grant gaps remain dependencies. Installing, connecting or discovering grants nobody access.
#47/#48's accepted design supplies the planned final checked dispatch and stable policy revision. PR #329 is OPEN: its snapshots/revision contract must land before depending on it; it is not present on this base.
Current `mcpPolicy` and `chat/turn-tools.ts` admit only `accountMode: none`. Current approvals say “No account”; connection events and `credential.released` are contracts without the required commands.
`provider-secrets.ts` supplies private, immutable file writes, but not D14's exact UID/version custody. Do not treat it as a completed MCP store or copy its trust of an existing filename.

Keep #51's startup-only personal instances separate; do not mount a permanent token. #53 consumes this per-call path for Odoo; #105's group tool access/company attribution, #63's fresh journeys and #100's settings shell must reuse its identities/statuses rather than invent parallel records.
Implement dev custody and journeys first. Helm, production custody and KMS qualification belong to Phase 5. Backend slices may land closed while dependencies remain; #49/#50 cannot close on source readiness alone.

## 1. Identities, events, commands and checks

### Profile identity and explicit selection

Distinguish installed MCP `connectionId` from credential `profileId`. Use opaque immutable ids, not labels, emails, tool arguments or a provider username, as keys.
A profile binds `siloId`, `serverId`, installed `connectionId`, `profileId`, `ownerKind` (personal/company/validation), owner and purpose. Personal owner is the current member; company owner is the silo with a named admin custodian; validation is admin-owned and discovery-only.
Never let a rename, reconnect or admin action change these bindings. Changing server/owner/purpose means a new profile. Pin OAuth account identity to verified issuer plus subject; display name is separate, bounded data.
Each successful replacement has a strictly increasing generation. A generation binds secret name/reference, exact UID, resourceVersion, endpoint digest, verifier key id and verified material digest. No token or token-derived public digest belongs in events.
Keep the HMAC verifier inside custody metadata. Events carry references and exact identity/version, safe account metadata, scopes, expiry, operation/change reference and actor only.

Selection is an explicit authenticated user action, recorded by `connection.selected` on a small `connection-selection-<user>-<server>` stream. Its value is a profile id or an explicit clear; selection grants no rights.
The turn start reads selection and profile state before its short access check, then binds profile id and selection revision into the authenticated turn context. Bind the current credential generation separately into each tool offer, approval and dispatch permit; a call cannot provide a different profile through headers or arguments.
Normal same-account OAuth refresh can issue a fresh tool context after current checks, without restarting the turn. It invalidates old-generation approvals/permits; a call waiting before dispatch can continue under its new permit, but an already-sent call is never resent.
Do not auto-select on connect, pick the first profile or infer identity from a label. Offer an explicit “Use this account” action after success; it is a separate append from connecting.
A missing, cleared, disabled or stale selection selects nothing. Personal/team assistants use the requester's selected personal profile; neither assistant owner nor company account is a fallback.
Company mode additionally requires a recorded admin opt-in, reviewed server account mode, current tool rights and explicit user selection of that company profile. Disclosure names both requester and upstream bot account.

### Append-only commands

Use the existing `connection-<user>-<server>-<profile>` subject shape for personal profiles; reserve a typed company owner key for silo-owned profiles. Enforce uniqueness within the silo without adding a second authoritative SQL record.
All commands fold exact streams first, apply typed TypeScript checks, then do one conditional append to one stream. Staging, provider calls and deletion run in adapters/reactions outside that append-only command.
An HTTP orchestration may run several separately named commands; it must never pretend that these form one transaction across streams, custody and an OAuth provider.
Use expected sequence, deterministic operation event ids and a client change reference. Store idempotency in event history beyond the broker's deduplication window. Reject reuse of a reference for different bindings/material.

| Command/event | Required checks and result |
| --- | --- |
| Connect bearer → `connection.created` | Current member; eligible reviewed server/account mode; personal ownership or admin company opt-in; bounded secret; staged exact generation; expected absent/current state. No access grant. |
| Rotate bearer → `connection.refreshed` | Same bindings, current owner/admin, expected generation and revision; stage a new immutable generation first. Add `reason: bearer_rotation`; replace reference atomically in the event fold. |
| Revoke → `connection.revoked` | Current owner or silo admin; expected profile version; record actor/reason and invalidate all generations immediately. Stage only a deletion intent, never delete material before this append. |
| Admin disable → `connection.disabled` | Current admin; exact member/server or company profile; record reason and blocker. Personal disable uses a small `connection-control-<user>-<server>` stream, covering new/reconnected profiles too; company disable uses its profile stream. A later explicit admin enable is separate authority. |
| Select/clear → `connection.selected` | Current requester, matching silo/server and permitted owner kind; current opt-in for company; no arbitrary owner supplied by the browser. Recheck on turn start/call. |
| Consent start → `connection.oauth_started` | Current owner/admin and reviewed OAuth configuration; bind state, exact redirect/issuer, scope revision, attempt expiry and private custody reference. Does not activate a generation. |
| Exchange claim → `connection.oauth_exchange_claimed` | Conditional claim of the one unconsumed attempt, matching current profile/policy generation; purpose consent or refresh. Only its live worker may exchange once. |
| Refresh start → `connection.refresh_started` | Current usable OAuth generation, needed expiry refresh and no active attempt; bind expected generation, scopes and change reference. Competitors join that attempt. |
| OAuth success → `connection.created` / `connection.refreshed` | Verified account/scopes/expiry and staged new exact custody; original attempt still current, not revoked/disabled, matching generation and configuration. |
| Attempt failure → `connection.operation_failed` | Matching active attempt; safe typed cause and whether local outcome is known. `invalid_grant` or identity change makes the current profile Needs input; late old failures cannot overwrite a newer generation. |
| Close abandoned append → `connection.operation_closed` | Conditional close of an uncommitted operation so its delayed append can no longer succeed. State whether provider outcome remains unknown; this is not proof of provider revocation. |
| Release → `credential.released` | Normal call: exact live decision, requester, selected profile/generation, computer/thread, tool and request. Discovery/identity check: exact authorised worker operation and purpose-bound profile/stage. Confirm append before forwarding; no material or release reaction on replay. |

Extend existing strict event payloads compatibly and update `libs/events` and catalogue tables together, in both directions. Preserve old events in replay; incomplete legacy profiles remain unavailable until reconnected, rather than guessing a generation or owner.
Extend `credential.released` beyond today's request/permit/connection/profile/lease/generation: include userId, computerId, conversationId, turnId, serverId, toolName, issuedAt, expiresAt and purpose. Link approval and decision ids through existing correlation fields.
Use a strict purpose union: normal calls require computerId/turnId/toolName; discovery requires admin userId, workerId and exact `server/discover` or `tools/list`; identity checking requires owner userId, workerId and the configured identity operation. Worker variants explicitly omit computerId/turnId. Never fabricate a computer. Audit successful release and safe denials through existing audit contracts.
Change the catalogue's “secret written inside the command” wording to describe boundary staging before the conditional append. Record cleanup as a reaction, not a SQL business rule.

### Exact custody and orphan cleanup

Adapt OC1's immutable Opaque Secret adapter: deterministic generation name; silo/user/profile/server/purpose labels; endpoint binding; HMAC verification; create-or-recover; exact UID/resourceVersion read and delete preconditions.
On creation conflict, verify every binding and the supplied material privately with the HMAC. A same-name Secret with different content, recreated UID, changed version or wrong namespace must fail, not be adopted.
Stage the new generation before the activation append. A custody journal records only operation id, reference, expected stream sequence, append deadline and exact staged identity. It is repair information, not connection truth.
A confirmed activation makes that generation current. Lost staging/append replies trigger exact recovery by operation id; never generate a second token object just because HTTP timed out.
Reuse the reasoning in `memory/commands.ts`: unknown is not failure, and cleanup must be serialised with staging/append recovery. Do not copy its domain-specific model or make a SQL journal authoritative.
For an orphan candidate, read its exact profile stream, resolve the original operation, and exclude any current reference or operation whose append can still succeed. Recheck while holding the cleanup/staging coordination lock.
If publication is uncertain, retain the Secret. After a proven deadline, conditionally close the operation at its expected sequence, or prove that a conflicting append already made that sequence impossible. A timeout or 404 alone is insufficient.
Delete only the exact non-current UID/resourceVersion. On a deletion conflict, reread and stop; never delete by name alone. A failed store/read/reconciliation retains material and denies use rather than deleting optimistically.
A revoke/rotation reaction deletes superseded generations only after activation/invalidation is confirmed and no live injection is holding them. Unknown provider exchanges retain private recovery data until safely closed; every pending generation is accounted for.
The journal may be rebuilt from events plus custody enumeration; an enumeration is a bounded maintenance task, never a wildcard read inside a user's access check. Restoring old Secrets cannot restore revoked authority.

### OAuth consent, identity and refresh

Use authorisation code with PKCE S256. Keep the verifier, received code, access token, refresh token and any confidential client secret solely in custody; events contain only attempt references. State is an opaque random handle whose digest is checked server-side.
Bind the attempt to signed-in member/session, silo, profile, installed server, exact operator-configured redirect URI, issuer, provider configuration digest, scope/policy revision and expiry. Recommended attempt lifetime: ten minutes; browser state alone is not authority.
The callback checks the original signed-in user/silo and every binding before claiming the attempt. Forged state, duplicate parameters, replay, wrong user/provider/silo, stale consent, malformed code and issuer mismatch cannot activate a profile.
Use issuer identification in the response where supported, and verify token/identity evidence against the pinned issuer, audience/client, nonce and subject. Fail if a provider cannot establish the configured account identity; never trust an unsigned returned name.
On first connect, show the verified account and require explicit confirmation before activation/selection. On reconnect, require the original issuer/subject; a different account gets INT-71 and no replacement. A deliberate new account gets a new profile.
Store the exchanged but unconfirmed token set privately under the same attempt; reload retrieves safe status/account metadata, not tokens, and does not exchange the code again.
Validate discovery, authorisation, token, identity and revocation destinations with the existing address policy: approved HTTPS origins, bounded responses, every DNS result checked, socket destination pinned, no redirect chasing or URL credentials.
A token request uses the fixed endpoint and form body; grant parameters are not arbitrary URL query input. Apply guarded discovery to `/.well-known` too. The browser sees only the approved authorisation URL and opaque state/challenge, never a verifier.
Incoming callbacks use the exact tailscale serve origin; they are not remote SSRF targets. Never use funnel or loosen the public-address guard for arbitrary private hosts. An intentional local fixture needs a fixed operator address binding.

Compute the union of scopes required by currently enabled, reviewed tools from typed configuration. Blocked tools add no scope. `openid` and refresh-related scopes such as `offline_access` are protocol needs disclosed separately, only when required.
Do not derive permissions from provider error text, tool descriptions or arbitrary advertised scopes. Store actual granted scopes; each call checks its own required subset. Missing write scope denies that tool while valid read scope can remain usable (INT-91).
A policy expansion requires explicit reconsent; scope reduction never broadens rights. A changed issuer/configuration/account binding invalidates the attempt and pauses use; no bearer/company substitution.

Refresh on demand shortly before expiry with a bounded clock margin; do not build a scheduler or refresh every inactive profile. One conditional refresh-start event chooses the attempt for the current generation; all callers join it and wait or receive a safe temporary status.
Claim the external exchange once. Record its claim before sending; retain a privately staged result for recovery after a lost activation reply. The models service leader/SQL coordination prevents competing workers but is not business authority.
A worker restart must not resend a code or rotating refresh token after an uncertain send. Recover a staged response if available; otherwise mark Needs input with provider outcome unknown and require fresh consent. A claim alone is not proof that the provider received it.
After receiving a valid response, stage access/refresh material as a new immutable generation before the single `connection.refreshed` append. Preserve an old refresh token only if the provider contract explicitly permits omission; rotating providers must supply its replacement.
Competing activation appends converge on the accepted attempt/generation. Losing staged results become cleanup candidates. Revoke, admin disable or a newer consent defeats an old refresh append; a late `invalid_grant` cannot disable the newer connection.
Confirmed `invalid_grant` immediately records Needs input and stops releases. Temporary endpoint/store failure is Unavailable, not falsely “revoked”; expired access material never releases while refresh is unresolved.
If an access call returns an authentication failure, report it and pause/reconnect as appropriate; do not automatically resend an external write after refreshing. Local lease expiry cannot revoke a provider's long-lived bearer.

### Discovery-only validation profile

An admin explicitly creates a validation profile bound to this silo/server/quarantine revision, with only scopes needed for discovery. It is a distinct purpose even when owned by the same admin as a company profile.
Only the authenticated quarantine worker may request its lease for bounded `server/discover`/paginated `tools/list`. Refuse `tools/call`, batches, resources, sessions and normal gateway routes; every page consumes a separately bound request lease.
Use the same state/PKCE/custody/release audit rules, naming the admin and discovery request. It grants no person/assistant tool use, creates no company opt-in and cannot enter the selection list.
Publication still needs reviewed evidence and exact configuration acknowledgement under #45/#47/#48. INT-23's discovery-only check must not be presented as a successful personal call or permission grant.

## 2. Runtime location, isolation and release ordering

Default dev store: Kubernetes Secrets in a dedicated silo custody namespace, using the narrow OC1 adapter. Bind least-privilege service-account reads/deletes to custody; gateway/computers cannot read Secrets or list this namespace.
Kubernetes base64 is not encryption. Record whether the dev control plane has encryption at rest and protected backups; if absent, mark at-rest qualification PARTIAL, not PASS. File-store substitution requires equivalent immutable identity/version and deletion preconditions, not just the existing provider adapter.
Keep verifier keys and private OAuth attempts in custody too; key rotation retains keys needed to validate active/pending generations. Use installed Kubernetes access machinery first, not an unreviewed new dependency.

The broker lives in the server/models boundary. Add the narrow outbound injector to #47/#48's final checked dispatch; do not put tokens in ext_authz responses or agentgateway configuration.
Agentgateway forwards an authenticated opaque permit to that trusted injector. Only the injector reads material for the immediate upstream request; this implements the gateway injection boundary without giving the gateway process custody or long-lived bearer material.
The lease is an in-memory capability, maximum 30 seconds from issue, bound to request/permit, silo, user, profile/generation, computer/thread (or authorised worker), server/tool or permitted operation, arguments digest and purpose. It is never stored in Postgres, events or a PVC; audit stores its id and expiry only.
Neither browser nor computer receives the lease or upstream credential. Refresh material reaches only the custody-backed OAuth worker and pinned provider token endpoint, never gateway, computer or MCP. The injected access bearer exists only in the injector's immediate request buffers and the receiving MCP request; disable header/body traces and redact transport exceptions.
A stateless MCP must not persist the header in sessions/logs/cache and must authorise using the injected credential. Do not claim that JavaScript buffers guarantee secure erasure; drop references promptly and prevent copies, dumps and tracing.

Release and dispatch proceed in this order:

The steps below govern normal tool calls. Discovery and identity-check requests instead require a current owner/admin-authorised operation, exact purpose-bound custody and guarded endpoint, zero cost, confirmed decision/release audit and the same one-send/live-invalidation rule. They never acquire normal tool rights or a member selection.

1. Validate current computer credential/generation, authenticated turn/requester, exact route/method/tool and lossless arguments. Read needed conversation history before starting the two-second access check.
2. Check current requester ∩ assistant rights, member/team/payer/grant authority, reviewed publication/policy revision, tool mode and scope, explicit selected profile/generation, company opt-in if applicable, and budget hard stops.
3. Require `costCents === 0` for this scope. Secure any applicable reservation through its existing single-append command before consuming approval, then preserve the recorded allowance/hard stop; do not invent a paid-tool tariff or a dummy charge. Money is always integer euro cents.
4. For Confirm, consume a single-use approval bound to requester, turn, tool/arguments, policy revision and exact profile/generation/account owner. Auto skips approval only when its current mode allows it.
5. Confirm `decision.recorded` and current permission, then confirm `credential.released` with all required identities before reading exact custody and preparing the one-request lease. Audit failure means no material read. Audit or secret-store failure denies forwarding.
6. At final send, recheck the small watched authority positions plus exact profile/selection/policy revision; synchronise generation invalidation with this dispatch. Burn the permit/lease once, overwrite credential headers and forward exactly one request.
7. Record gateway dispatch/effect evidence independently. A release proves a credential was authorised, not that an external effect succeeded. Unknown dispatch remains unknown; do not replay a lease or resend the tool call.

Overwrite/drop every caller credential source: Authorization, cookies, proxy authorisation, alternate API-key headers and duplicate header variants. Construct an allowlisted outbound header set with one trusted bearer and protocol/request metadata; reject credentials embedded in URLs/arguments for this adapter.
Identity-shaped ordinary tool arguments remain untrusted data; they cannot choose a profile, change owner or bypass upstream rights. Preserve approved argument bytes under the lossless JSON contract rather than silently rewriting an approved action.
The injector accepts only the authenticated gateway/worker capability, not an exposed public route or unsigned profile header. Bind endpoint/instance generation as well as credential generation; prevent direct computer-to-MCP access with existing network policy.
A duplicate release event, permit or request cannot cause a second release/forward. After injector restart, expire all volatile leases and default closed; history of a release never reconstructs material or forwarding authority.

For Alice and Bob on one assistant/computer, turn contexts remain separate and carry their authenticated requester identities. Alice's request releases only her selected generation; Bob's only his. Concurrent calls, forged profile ids and owner-like arguments cannot cross that boundary.
Revoke, rotate, member removal or admin disable invalidates cached release authority immediately. Watch exact small streams; any watcher gap, stale check or outage closes dispatch. Use a maximum two-second live authority age, independent of the 30-second lease expiry.
Synchronise final injection with invalidation so a prepared old lease cannot be forwarded after the change is observed, and no new old-generation release occurs later than two seconds after its event. Already-sent external work is not undone; disclose that limit.
Only small member/assistant/team/payer/grant streams decide general access. Exact profile/selection/admin-control/policy revisions are additional dispatch preconditions. Read their state before the short check; compare latest positions during it, never scan full histories then.
Reads check access once without a write fence; no wildcard event reads and no whole conversation stream in a read fence. Tool activity or credential refresh must not close a viewer or refuse a chat reader.
Leave `authority.test.ts` and `authority-volume.test.ts` unchanged. Add focused connection/dispatch tests elsewhere; do not widen generic authority watches to solve credentials.

## 3. Status, projections, replay and recovery

Project a connection list/detail from events: id/owner/purpose, safe verified account, account model, current generation reference, actual scopes/expiry, admin blocker and current change reference. Custody values never enter projections.
Use `libs/projections` for connection and selection folds, and extend allowlisted `audit.ts` metadata. SQL stores projections/indexes only; no trigger, view or stored procedure decides status or permission.
Separate persisted lifecycle from temporary operation status and catalogue availability. Connected does not mean authorised for every tool, Ready/published, or reachable now.

| Display | Meaning and allowed next action |
| --- | --- |
| Not connected | No active profile; show scopes and Connect. No selection or fallback implied. |
| Saving / Completing / Refreshing | Original change is pending; show its reference. No duplicate submission. Old usable generation may continue only where policy permits and no invalidation/expiry occurred. |
| Connected as … | Activation confirmed and named identity verified. Show scope limitations separately; never infer provider confirmation from custody success. |
| Needs input | Expiry without usable refresh, invalid grant, changed identity or uncertain rotating exchange; reconnect explicitly. Unsupported tools remain unavailable. |
| Disabled by admin | Blocker recorded; no calls or member bypass via reconnect. Name the admin safely where permitted. |
| Revoked | Owner revoked this profile; history remains, no secret readback. A new explicit connection is possible if otherwise permitted. |
| Not available | Server unpublished/held, missing tool rights or account model unsupported. Retain safe own history, with no route access. |
| Secret service unavailable | Release denied; last confirmed metadata is labelled as such. Do not claim nothing changed if an append/exchange reply may have been lost. |
| Outcome unknown | Only Check status for the original reference; distinguish unknown local activation from unknown provider exchange. |

Expose authenticated `GET /api/my/tools/changes/:changeRef` and equivalent admin status routes. Return pending/unknown, confirmed applied with event time/revision, or confirmed not applied with proof; 404/projection lag is not proof of failure.
Use session + exact Origin + existing CSRF pattern for mutations, with current membership/ownership/admin checks. Bound list/detail reads to permitted profiles; an admin sees metadata and Disable, never personal credentials.
Reload during OAuth completion reads the original change reference from its safe route/status response. The callback redirects promptly to a clean My tools URL, with no code/error query retained in app routes; suppress callback query logging/referrer leakage.
The OAuth code may transit the registered callback URL as required by the protocol; never put it in browser persistence, analytics, application logs or rendered errors. No tokens/verifiers in browser storage, route state or chat.
Clear secret inputs after submission acceptance and on unknown submission, close, navigation and role loss. Do not retain a token to make Retry convenient; confirmed non-application asks for a fresh entry. Keep change references, not secret drafts.
Check status never resubmits. A proven not-applied append may retry with the same operation and privately recovered stage; a consumed/uncertain OAuth code or refresh token requires recovery or fresh consent, not another exchange.
Returning to chat restores only a draft (INT-75), rechecks conversation access and focuses the composer. Nothing is sent until the requester explicitly submits; no delayed tool call resumes simply because a connection became usable.
On replay, rebuild statuses, selection and audit only. Never contact OAuth, release material, forward a call or refresh/revoke at the provider. A separately live reconciler can resume only proven-safe pending work after current checks.
Keep local revoke effective even if an optional guarded provider revocation fails. Delete local material asynchronously; show provider revocation separately if offered, rather than promising that OpenCrane deleted an Odoo token.
Treat tool descriptions, account names, OAuth errors and Odoo responses as bounded escaped data, never instructions. Emit typed safe errors without raw upstream bodies or secrets; never insert provider text into assistant control instructions.

## 4. Screens, APIs and owner handoff

Build in `apps/web`, not the handoff's old application path. Fill the existing `/account/tools` My tools placeholder and settings shell from #100; keep `/integrations` admin navigation and existing chat/overview routes.
Reuse PaperSurface, DogEar, SharedState, HingeDrawer and ModalSheet; use actual evidence/versions, not the frames' example product facts. All API paths below are proposed contracts, not endpoints available on main.

| Frames: both 1280 and 390 | Screen behaviour and API contract |
| --- | --- |
| INT-20 | Account model and scopes in admin setup; GET reviewed server config; mutation records company opt-in/account mode with existing MCP policy command, not a grant. |
| INT-21 | Explicit company checkbox, named upstream account and masked token; POST `/api/integrations/:serverId/connections/company`. No secret readback. |
| INT-22 | Company saving; accepted change reference; lost reply switches to INT-95. Clear submitted input. |
| INT-23 | Discovery-only result; POST `/api/integrations/:serverId/validation/check`; explicit validation purpose, no normal call or user grant. |
| INT-60 | My tools empty/eligible but unconnected; GET `/api/my/tools`; choose Connect for the server's reviewed auth method. |
| INT-61 | Own connection list; GET same; stacked mobile rows with account/status/scopes/expiry and safe actions. |
| INT-62 | Personal bearer entry and disclosed scopes; POST `/api/my/tools/:serverId/profiles`, expected revision + changeRef. |
| INT-63 | Personal saving; status lookup by original reference; no second POST. |
| INT-64 | Confirmed bearer identity and empty token input; safe GET detail. Require read-only provider identity evidence before “confirmed as”. |
| INT-65 | Confirmed replacement; POST `/api/my/tools/:serverId/profiles/:profileId/rotate`; older generation cannot release. |
| INT-66 | Revoke review; POST corresponding `/revoke`; explain local disable, no fallback, pending approval cancellation and provider-token limit. |
| INT-67 | OAuth consent scopes before leaving; POST corresponding `/oauth/start`; return approved authorisation URL + changeRef. |
| INT-68 | Handoff; open the approved provider in the same tab, with safe return context. No token/code in app state. |
| INT-69 | Completing; fixed GET `/api/my/tools/oauth/callback` orchestrates claim/verification, then clean status route; reload checks original attempt. |
| INT-70 | Confirmed consent cancelled; safe failure event, no account activated; fresh start only after terminal proof. |
| INT-71 | Wrong verified upstream account on reconnect; show returned safe name, keep original binding, no activation. |
| INT-72 | Expired/refresh refused; GET own detail; explicit Reconnect through `/oauth/start`, no silent fallback. |
| INT-73 | Admin-disabled personal profile; member detail/status, no reconnect bypass. Admin action needs missing frame A below. |
| INT-74 | Chat missing usable selection/profile; safe governed refusal with My tools link. Never send credential request to the model. |
| INT-75 | Return after confirmed connection; server rechecks chat access; restore draft, focus composer, no automatic resend. |
| INT-76 | Owner-revoked/removed connection history; Connect again only where allowed. Distinguish from admin-disabled INT-73. |
| INT-90 | Definitive command failure; safe typed reason and fresh entry/retry only when original outcome is known. |
| INT-91 | Actual scopes missing for one enabled tool; show permitted reads separately; reconsent through OAuth start. |
| INT-92 | Store unavailable; GET confirmed metadata/status. Correct “Nothing changed”/Try again copy when outcome is unknown: use INT-95 instead. |
| INT-93 | Stale revision; reload/review current metadata, never overwrite a newer generation silently. |
| INT-94 | Role loss; purge protected DOM, close sheets, clear tokens and ignore late responses. |
| INT-95 | Lost reply/unknown; show original changeRef and Check status only. Adapt to My tools as well as admin setup. |
| INT-96 | Checking/still unknown/applied/not applied; status read only. Show one current result, not all illustrative alternatives together. |
| WRK-10/11 | Requester approval review in chat; existing approval GET/POST plus safe bound account owner/model/profile/generation. Missing account-disclosure variant C. |
| OVR-20 | Existing action history GET with joined decision, approval, credential release and dispatch ids; metadata only, source and outcome remain distinct. |

At 390px use 18px/16px page padding, stacked labelled rows, wrapped scopes/account names and no horizontal scrolling. Keep 44px controls and full-width primary actions; do not reproduce the PNGs' clipped demonstration dividers.
Mobile drawers/sheets fill the available width with Back, focus trap, Escape and focus return. Use a keyboard-safe chat composer and scrollable review body; a sticky action must not conceal scopes or consequences.
Reuse DM Sans for UI and DM Mono for ids; paper #fbfcfc, canvas #eceff0, ink #16191a, teal #0db5cc/focus #0a8497, orange #f47920, green #2a7d4f, red #c1392b and amber #8a5d1f.
Keep the handoff's 12px dog-ear, main-paper crease, 12px card/8px button radii and 2px focus ring. Honour reduced motion with static progress; polite announcements once, never announce a token. Labels remain readable at zoom.

### Missing frames: ready-to-paste Claude Design prompts

These are every additional screen/state required by this proposal without an exact supplied frame. Existing saving/error/recovery frames are reused rather than asking for another generic error page.
Each prompt requests 1280px and 390px frames plus keyboard/focus, reduced-motion and state notes. UI PRs using these gaps wait for the owner's accepted handoff; backend PRs proceed. Do not invoke Claude Design during this task.

Proposed API mapping for the missing frames:

| Prompt | API contract |
| --- | --- |
| A | Admin GET `/api/integrations/:serverId/member-connections` and `/:userId`; POST `/:userId/disable`, with expected control revision and changeRef. Metadata only. |
| B | Admin GET `/api/integrations/:serverId/connections/company`; POST corresponding `/rotate`, `/disable` or `/oauth/start`; existing admin change-status read. |
| C | Existing chat approval GET/POST; add safe bound account fields to review, with server-side generation recheck on approve. No account-selection mutation here. |
| D | Admin GET/POST `/api/integrations/:serverId/validation/profile`; POST corresponding `/oauth/start`, `/confirm`, `/revoke` and `/check`; same fixed callback bound to validation purpose. |
| E | POST `/api/my/tools/:serverId/selection`, profile id or explicit clear, expected selection revision and changeRef; GET list/detail includes the current selection. |
| F | GET `/api/my/tools/:serverId/profiles/:profileId`; POST corresponding `/rotate` and `/revoke`; original change-status read. |
| G | POST corresponding personal/company/validation `/oauth/confirm`, with original changeRef, verified account binding and expected profile revision; no tokens in body. |
| H | GET reviewed current/requested scopes; POST the existing `/oauth/start` with reviewed policy revision. Reuse confirmation/status APIs, not a separate consent ledger. |

Bearer identity checking is a bounded, fixed read-only provider operation against staged material. Record its authorisation before sending, with an explicit `identity_check` audit purpose and worker identity, and refuse normal tool dispatch until verified activation. OAuth exchange/identity reads are similarly bounded to the configured provider; none can invoke arbitrary MCP tools.

**A. Admin members' connections and Disable**
> Design an admin-only Integrations → Members' connections list, detail and Disable confirmation. Purpose: inspect safe ownership/status and stop a member's upstream releases without viewing their token or becoming that user. Users: silo admins; members see only the existing INT-73 result. Include empty/loading, connected, refreshing, needs input, disabled, stale revision, lost reply/check status and role loss. Data: member, server, profile label, verified account, scopes, expiry, last change, admin blocker; no secret values. Interactions: bounded member/server filters, open detail, Disable with reason, cancel and check original change; explain existing external work may finish and no other account replaces this one. At 390px stack rows with field labels, show long names/scopes wrapped and use a full-width review sheet with 44px actions. Reuse INT-61/66/73, INT-90–96 and the Integrations shell; reuse DM Sans/DM Mono, paper/dog-ear, teal focus and red danger tokens above. Do not add impersonation, secret reveal or bulk disable.

**B. Company connection management, rotation, disable and reconnect**
> Design an admin company-connection detail page with bearer replacement, OAuth reconnect and Disable review. Purpose: maintain the explicitly opted-in company account; users are admins, while members can only explicitly select an eligible company account elsewhere. States: no opt-in, connected, rotating/completing, confirmed replacement, expired, disabled, changed upstream identity, store unavailable, stale revision and outcome unknown. Data: requester attribution explanation, named upstream bot, custodian, scopes, expiry, generation/change reference and enabled-tool impact; never return a token. Interactions: opt in explicitly, rotate with a new masked input, review disabled users/tools, confirm disable, check status and reconnect the same OAuth identity. Explain no personal-to-company fallback and no promise of provider token deletion. At 390px use stacked detail cards and full-width sheets, wrapped scopes, 44px actions and keyboard-safe secret entry; clear entry on acceptance/unknown/close. Reuse INT-20–23/62/65/66/67–72/90–96 and all paper, type, focus and status tokens above. Do not let ordinary members rotate it.

**C. Approval naming the upstream account**
> Extend WRK-10/11 approval cards to disclose whose upstream account will perform the action. Users: the authenticated requester reviewing a governed tool call; purpose: make personal versus company attribution explicit before approval. States: personal account, explicitly selected company bot, pending, expired, profile rotated/revoked/admin-disabled, policy changed and outcome unknown after dispatch. Data: requester, verified upstream account and owner, personal/company label, tool/target/approved data, consequence, expiry and safe profile/change ids; no credential. Interactions: approve once or deny; account/profile changes cancel this approval and require a new review; never offer switching account inside the approval. At 390px wrap names and ids, place account attribution before the action buttons, use a scrollable body and 44px controls above the keyboard. Reuse WRK-10/11 orange review edge, INT-20/73/95/96 and OVR-20 evidence language; reuse the listed type/paper/focus/status tokens. Distinguish authorised release from completed external effect.

**D. Admin OAuth validation profile**
> Design Integrations quarantine → Validation account, separate from company and personal accounts. Users: admins; purpose: allow protected discovery without granting any user tool permission. States: not connected, scopes review, provider handoff, completing, verified identity review, discovery running, discovery result, expired/invalid grant, wrong account, revoked, store unavailable and unknown/check status. Data: server/quarantine revision, admin owner, verified account, discovery-only purpose, exact discovery scopes/expiry and change reference. Interactions: explicitly consent, confirm identity, run bounded tool-list discovery, reconnect or revoke; there is no tools/call test, member selection or publish/grant shortcut. At 390px use stacked cards, wrapped scopes, a full-width consent/confirmation sheet and 44px controls; no horizontal tables or secret readback. Reuse INT-23/67–73/90–96 and the Integrations shell, with the listed paper/type/focus/status tokens. Keep “Discovery only; gives nobody access” visible in every usable state.

**E. Explicit account selection**
> Design My tools → Choose account for this integration, used before a chat turn. Users: a signed-in member with current tool rights; purpose: record an explicit personal profile or an explicitly enabled company profile, never choose by inference. States: no selection, own connected profile, company option with opt-in disclosure, selected, saving, missing scopes, disabled/unavailable selection, stale revision and unknown/check status. Data: profile id/label, verified upstream account, personal/company owner, scopes and usability; never list another member's private profiles or a validation profile. Interactions: choose, confirm Use this account, clear selection, or Connect; connecting alone does not select, and no selection blocks calls without fallback. At 390px use vertically stacked radio cards with wrapped account names, 44px targets and a full-width confirm action; return to chat as an unsent draft. Reuse INT-20/60–64/73–75/90–96 and My tools shell, with the listed paper/type/focus/status tokens. Explain company bot attribution before confirmation.

**F. Personal bearer details and replacement entry**
> Design My tools → Personal connection detail and Replace bearer token entry; INT-65 already supplies the success result, but no exact detail/rotation-entry frame exists. Users: the profile owner; purpose: inspect scopes/identity and replace a token without secret readback. States: connected, replacement entry, saving, replaced, missing verified identity, disabled, stale revision, service unavailable and outcome unknown. Data: server, safe account identity, scopes, current status, expiry where known and change reference. Interactions: Replace, paste a new masked token, confirm, cancel, revoke via INT-66, check status; clear input on acceptance, unknown or navigation. At 390px stack labelled facts and use full-width entry/actions with 44px controls and visible help; never display the old token. Reuse INT-61/62/63/65/66/90–96 and My tools shell, with the listed paper/type/focus/status tokens. Say the old generation stops working in OpenCrane, not that the provider token was deleted.

**G. First OAuth account confirmation**
> Design the missing first-connect verified account confirmation between INT-69 and Connected. Users: the member, or an admin for company/validation purposes; purpose: explicitly accept a provider-verified identity without treating an editable profile label as proof. States: verified account awaiting confirmation, accepted/saving, cancelled, expired attempt, wrong issuer/account, stale scope policy and unknown/check status. Data: safe provider name, verified account, purpose/owner, requested and granted scopes, missing tool scopes, expiry and change reference; no tokens/code/verifier. Interactions: Confirm this account, cancel, or restart with another account as a new profile; reconnect requires the already pinned identity. At 390px show account and scope cards before full-width 44px actions, wrap names/scopes and preserve focus on reload. Reuse INT-64/67/69–72/91/95/96 and the listed paper/type/focus/status tokens. Activation and explicit selection are distinct; never automatically send a waiting chat request.

**H. Changed scopes and explicit reconsent**
> Design a My tools scope-change review when an admin enables a tool requiring additional OAuth scope. Users: the profile owner; purpose: show what permission is added before reconsent. States: current reads still usable, added write scope needed, consent pending, provider declined part of the scope set, policy changed again, confirmed update and unknown/check status. Data: current versus requested scopes, affected enabled tools, verified account and expiry/change reference; blocked tools contribute no scope. Interactions: continue to approved provider, keep current permitted tools, cancel, reconnect and check status; no automatic permission expansion. At 390px stack current/additional permission cards with readable tool labels and wrapped scopes, followed by full-width 44px actions. Reuse INT-20/67–72/91/95/96 and My tools shell, with the listed paper/type/focus/status tokens. Treat provider descriptions as data and distinguish partial scope from invalid grant.

## 5. Ordered, independently landable PRs

Use one development branch/PR at a time from the then-current main, not a stack. Every estimate includes non-generated code, tests, catalogue/docs, both package READMEs where responsibilities change and one branch-named `changes/unreleased/` note.
Target 350–550 changed lines, hard review target about 600 per PR; split further before opening if needed. These replace the old two-ticket aggregate estimates, which are too small for custody, recovery and all missing states.
Keep intermediate runtime behaviour closed: registration of a new event/API must not open credentialed routes. Each PR must deliver the concrete bounded behaviour named below, not speculative configuration or scaffolding.
Server contracts precede their screens. Backend work does not wait for missing frames; no gap UI is implemented until the owner accepts its handoff.

| Order / issue / estimate | Deliverable and failing-first evidence before implementation |
| --- | --- |
| 1 / #49 / 450 | Exact custody adapter and private stage recovery. Red: mismatched binding/material, recreated UID, changed version and unsafe delete refused; lost create response recovers one generation. Preserve OC1 notice. |
| 2 / #49 / 550 | Bearer create/rotate commands, typed payloads and connection fold. Red: stage failure prevents append; stale rotation fails; replay carries refs only; legacy incomplete profile stays closed. |
| 3 / #49 / 550 | Revoke/admin disable plus orphan reconciler. Red: unknown append retained, current ref never deleted, late append blocked before cleanup, exact delete conflict retained, reconnect cannot bypass admin blocker. |
| 4 / #49 / 450 | Company opt-in integration and explicit selection commands/fold. Red: absent selection chooses nothing, no implicit company fallback, forged owner/profile denied and opt-in does not grant tools. |
| 5 / #49 / 550 | One-request broker/injector and release audit, attached to accepted final-dispatch contract. Red: audit/store failure sends no bytes; foreign/expired/reused lease refused; malicious credential headers overwritten. Routes stay closed until step 6. |
| 6 / #49 / 550 | Turn/tool/approval binding and live personal/company dispatch. Red: Alice/Bob concurrent turns isolate, argument identity cannot select, rotation/revoke/disable defeats prepared release within two seconds, old approvals fail. Depends on #46 and #45/#47/#48 dispatch/publication contracts, including #329 stable revision. |
| 7 / #49 / 400 | Own/admin metadata and change-status APIs with projection/audit joins. Red: owner/admin boundaries, lost reply status recovery, 404 not terminal failure and replay never releases. No secret readback. |
| 8 / #50 / 550 | PKCE start/callback claim and guarded provider destinations. Red: forged/replayed/wrong user/silo/provider/redirect/issuer state and stale scope revision fail before activation; redirect/DNS/SSRF attempts refused. |
| 9 / #50 / 550 | Verified first identity confirmation, generation activation and reconnect. Red: reload exchanges once, lost result/append recovers original attempt, unconfirmed/wrong subject never activates, secrets stay private. |
| 10 / #50 / 550 | Single-flight refresh/recovery and per-tool actual-scope checks. Red: competing refreshes converge; invalid grant becomes Needs input; old failure cannot defeat new generation; uncertain exchange is not resent; valid reads survive missing write scope. |
| 11 / #50 / 450 | Discovery-only validation commands/leases. Red: tools/call/normal route/selection denied, each page audited, no user grant, stale quarantine revision stops discovery. |
| 12 / #49+#50 / 350 | Dev disposable provider/resource fixture and separate-org app setup instructions. Red: fixture rejects wrong audience/scope/account and expires access tokens; setup refuses a wrong resource owner. No model calls, paid service or modification of the web SSO app. |
| 13 / #49+#50 / 500 | Bounded backend journey runners extending current MCP/approval journey style. Red: real consent → governed call → expiry → rotating refresh → revoke, Alice/Bob isolation, store/audit failure and lost-reply recovery. Record fresh evidence; browser qualification remains explicit. |
| 14 / #49 / 500 | Framed My tools bearer/list/revoke screens. Red component/browser tests: 390px stacked rows, empty accepted secret input, accurate local-revoke consequence and blocked admin profile. Uses #100 shell; detail/selection entry waits for E/F. |
| 15 / #49 / 350 | Framed recovery/role-loss states and chat draft return. Red: unknown offers only Check status, late role-loss response ignored, no automatic resend and keyboard-safe draft focus. Reuse INT-90–96/74–76. |
| 16 / #50 / 550 | Framed consent/handoff/completion/cancel/wrong-account/expiry/scopes UI. Red: reload resumes same reference, scope disclosure precedes navigation, actual missing scopes shown and no browser persistence. Confirmation/reconsent waits for G/H. |
| 17 / #49 / 450 | Framed company setup plus owner-handed-off company manage/rotate/disable. Red: opt-in required, token cleared, truthful upstream attribution, 390px reviews and lost response recovery. Wait for B. |
| 18 / #49 / 450 | Owner-handed-off explicit selection and personal detail/rotation entry. Red: Connect does not auto-select, clear blocks calls, another person's/validation profile absent, mobile keyboard usable. Wait for E/F. |
| 19 / #49 / 400 | Owner-handed-off admin member list/detail/disable. Red: no secret/impersonation controls, bounded metadata access and member reconnect bypass refused. Wait for A. |
| 20 / #49 / 350 | Owner-handed-off bound account approval card and OVR-20 release detail. Red: both identities named, stale generation cancels approval, audit shows release without claiming external success and no secret display. Wait for C. |
| 21 / #50 / 450 | Owner-handed-off first identity/reconsent UI. Red: unconfirmed identity inactive, same-account reconnect enforced, partial-scope choice truthful and no resend. Wait for G/H. |
| 22 / #50 / 400 | Owner-handed-off admin OAuth validation screens. Red: discovery-only disclosure, no grant/call action and original status recovery. Wait for D. |

Future implementation follows failing-first tests per row; this design task runs none. Check lint/typecheck/test/check:events as required before landing and on main; run vitest/lint/typecheck/build under `nice -n 10`, never during a live-view qualification batch.
Use at most two independent review passes, with a different model as the standard requires, during implementation only. PR descriptions cover Why / Functional outcome / Architecture / Evidence / Not in this PR; no AI attribution.
Record source-ready versus fresh-live results explicitly. A fixture-only pass is not OAuth-provider evidence or production custody evidence. Fresh dev journeys must pass at desktop and 390px before marking capabilities done.

## 6. Open questions and recommended defaults

| Question | Recommended default / boundary |
| --- | --- |
| Which disposable OAuth provider? | A separate application in the existing Zitadel **OpenCrane 2 Dev** organisation, with code + PKCE and refresh enabled, separate exact tool callback and a small zero-cost resource fixture that validates its tokens/scopes. Do not reuse the web SSO app. |
| Which users and account identity? | Two disposable ordinary integration accounts; keep the privately configured owner test user separate. Pin verified issuer/subject; explicitly confirm first identity. Odoo bearer ACL evidence and Zitadel OAuth evidence are separate; do not claim Odoo has native OAuth from this fixture. |
| Which callback and provider reachability? | Registered `https://ocn-dev.tail00285e.ts.net/api/my/tools/oauth/callback` via tailscale serve, subject to the actual dev origin check; no funnel. If the provider cannot return through the user's tailnet browser, stop and fix that route rather than expose a public callback. |
| What Zitadel changes are allowed later? | Only the OpenCrane 2 Dev org, with resource-owner checks, separate tool app and synthetic users. No changes to other organisations or the owner's account. This design performs no changes. |
| Which dev custody backend and at-rest evidence? | Narrow OC1 Kubernetes Secret adapter; report any missing control-plane encryption/backups qualification as PARTIAL. A file adapter is an alternative only if exact identity/version custody is specified and qualified. Production encryption/KMS is Phase 5. |
| How is bearer account identity verified? | A fixed, bounded read-only adapter identity endpoint, explicitly configured for the fixture/provider. Until available, show Saved, identity not verified and keep release closed; do not use a user-entered label as confirmation or execute a tool to guess identity. |
| Can one person have several profiles? | Permit opaque distinct profiles but require explicit selection per server; initially show one selected profile in the turn. No guessed default, owner-email lookup or identity supplied by the model. |
| What happens to admin-disabled profiles? | Keep a distinct admin blocker; owner reconnect cannot remove it. No re-enable UI in these issues unless the owner supplies it; a later admin enable must be an explicit event and require new consent/material where needed. |
| How much OAuth capability is built? | One configured provider contract and typed scope map, not a provider marketplace. Prefer public PKCE client where supported; confidential secrets stay in custody. Request offline access only for the refresh journey. |
| What if a rotating exchange reply is irrecoverable? | Conservative Needs input with unknown provider outcome; fresh consent, no retry of the same code/token. Separately show whether local profile activation was confirmed; do not invent exactly-once provider semantics. |
| Does partial scope disable the whole connection? | Deny only tools missing their required scope; retain valid reads. Invalid grant, identity/configuration change or expiry without refresh blocks the profile. New enabled scopes require reconsent. |
| Who owns a company account when its custodian leaves? | Silo owns it, with audited admin custodian transfer; do not reassign a personal profile/token. Disable until a current admin explicitly accepts custody if no custodian remains. No automatic routine identities are introduced here. |
| What costs money outside the box? | Cloud KMS, paid vault/OAuth tiers, hosted test infrastructure and any metered provider/resource calls are **outside the box** and out of this design's allowance. Default: existing dev box, existing org/available zero-cost capacity and synthetic fixture; do not buy capacity. |
| Which dependencies/licences? | Node standard library and installed packages first; narrowly reuse OC1 under its existing OSI licence. Check any newly introduced runtime component and bundled notices before adding it; no source-available runtime services. No SDK is assumed necessary. |

No tools in this scope charge money: record zero integer cents and respect current allowances/hard stops. Do not call paid upstream APIs or models for qualification. Do not introduce a generic OAuth service, secret platform, SQL business engine or startup-only deployment in these issues.

## 7. Left for later

The orchestrator decision of 29 October 2026 changes section 2, step 5 from
decision → custody → release audit to decision → release audit → custody → one
guarded forward. The private broker saves the audit before reading any secret.
A custody failure can therefore leave a confirmed release audit without a material
read or send. That receipt confirms authorisation only; recovery cannot resend.
Preparation errors wait behind one permission decision, and an established typed
permission refusal survives later failures.

Gateway destination and header checks, production callers and fresh-install
provider qualification remain later work. Public tool routes stay closed.
The private callback tests do not qualify a guarded upstream forward.
