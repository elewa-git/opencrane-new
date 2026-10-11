# Startup-only MCPs in isolated personal instances

Design for [#51](https://github.com/elewa-git/opencrane-new/issues/51), 10 October 2026.
Base: `work/p3-10-design`, equal to local `origin/main` at `dd3880237b87`.
Proposal only. Product changes, tests and fresh-install journeys: NOT RUN.
Only this note was written. No stack, tests, model calls or spending; network reads were GitHub-only.

## Readiness and boundaries

Read #51/comments/Design, #47/#49/#48/#50/#61/#18/#53/#63/#15, PR #329 and both accepted
fleet designs; requested specs/plan, catalogue, AGENTS.md and ADRs 0003/0006. Inspected
named code/tests, INT/WRK PNGs at both widths, READMEs and PLAN's P3-10 row.

\#47 owns hosted admission/isolation/dispatch; #49 owns profiles/custody/selection/release;
\#48 owns per-start capture, freshness, drift holds and stable reviewed revisions.
PR #329 is OPEN: dated catalogues/stable `policyRevision` do not supply final dispatch,
watch or acknowledged configuration. Wait for those completed contracts too.
\#50 adds OAuth access material and refresh. #53's Odoo adapter remains stateless with
per-call injection; do not force this fallback onto Odoo or add a second Odoo adapter.

Main admits only `accountMode: none`; registration/install-worker provide remote discovery.
My tools `/account/tools` is a placeholder. SandboxClient uses `pods/proxy` for grants,
but creates PVCs/has exec rights: reuse delivery/reconciliation, not computer claims/RBAC.
Use ADR 0003's later discovery/unload rules; omit ADR 0006's retained computer disk.

## 1. Startup credentials, identities and admission

“Startup-only” describes a reviewed process that obtains its upstream account material
before serving calls rather than accepting a different user's credential on each call.
It still speaks stateless MCP 2026-07-28: no initialise/session/GET stream or legacy fallback.
Require renewable short-lived material/reviewed launcher; refuse permanent env keys.

Record a digest-bound hosted credential contract during registration/admission:
`credentialMode: per_call | startup_short_lived`, supported material kind, bounded expiry,
memory delivery method, renewal/restart behaviour, fixed upstream binding and evidence ref.
An unsupported dependency gets `mcp.server_rejected` with `lasting_startup_secret_required`
or `startup_contract_unverified`; INT-26 explains the refusal before Connect or publication.
Do not trust the image's assertion: read configuration/source/dependencies and exercise it
with synthetic expiring material in quarantine, expiry/renewal, restart and persistence
negatives. No normal tools/call is available during discovery; a separate qualification
harness checks the startup contract. Unknown behaviour refuses admission.
Recheck at review/publication and digest/launcher/dependency/config changes. Legacy records
without evidence stay unavailable. Refuse lasting-secret requirements before the first call.

The immutable instance key is `(siloId, userId, profileId, serverId, startupAccessGeneration)`.
`startupAccessGeneration` counts versions of the profile’s startup access material.
It contains no secret value and is separate from the process’s `runGeneration`.
Also bind the installed `connectionId`, image/install generation and upstream digest.
Use #49 opaque ids, never labels/email/arguments/URLs. Keep increasing `runGeneration`
and actual workload/Pod UIDs: idle wake/Pod loss does not invent credential rotation.
Allow one callable process per silo/user/profile/server. Bind both generations and Pod UID;
reused names/ClusterIPs cannot restore permits. Safe labels can be hashes of these ids.

Only the current member owning an eligible, explicitly selected personal profile may
request a wake from My tools, or cause one through a currently authorised tool request.
The server derives user/silo from the session or signed turn, never from the request body.
Team assistants use the requester's profile. A participant, assistant owner, admin viewing
metadata or another member cannot wake/use that personal instance on the owner's behalf.
Admins may refuse, disable or stop it. An authenticated lifecycle worker executes the
committed wake under current checks; the event alone grants nothing. Validation discovery
uses #50's separate admin-owned, discovery-only profile and isolated quarantine identity;
it never becomes a personal selection or permits a normal call. Company startup instances
are outside this ticket; company selection must not fall back into a personal route.

Support two material forms; a timer cannot make a lasting bearer short-lived:

- A D16 startup-purpose capability supplied by the P3-8 broker, renewable within a
  maximum 30-second validity. Extend its strict purpose union for instance start/renewal.
  Bind it to this user/profile/upstream, startup access/run generation, Pod UID and release id.
  The receiving upstream must enforce expiry and these bindings. The ordinary D15
  single-request tool lease remains single-use; never cache it for five minutes or release
  the lasting raw bearer it normally wraps. A bearer-only upstream without delegation
  cannot support this form and is refused. The synthetic upstream can support it at zero cost.
- A P3-9 access token with verified audience/scopes/issuer/identity and actual expiry.
  Only access material leaves custody; refresh tokens, OAuth codes/client secrets and
  lasting bearer keys never enter an MCP. Recommend at most ten minutes of remaining
  access-token life for this fallback; refuse providers without acceptable bounded expiry.
  The delivery capability still expires within 30 seconds and is consumed once.

Renewal does not turn startup into unrestricted per-call injection. A reviewed memory
credential provider can replace/renew material through private IPC while retaining the
account identity; each renewal is newly checked and audited. A process that reads one
immutable token only at launch needs controlled replacement before its token expires.
Stop calls, retire the old process and start/capture anew. Refuse lifetimes too short for
replacement plus a bounded call; do not lengthen leases or restart every few seconds.
Use an in-memory renewable handle for the 30-second fixture; no sleeping refresh scheduler.

Issue after receiver/Pod UID checks, never before scheduling/pull. Deliver a bounded body
through authenticated Kubernetes Pod proxy, never URL/env/kubectl arguments.
Adapt the existing stdin delivery but discard raw stderr/body errors and suppress request
body audit/traces on this subresource. The receiver consumes a one-use delivery capability
bound to the run and passes material to the process over an inherited private pipe/IPC.
Require peer UID checks and atomically acknowledge safe release id/expiry, never its value.
No Secret mount, ConfigMap, env, argv, Pod annotation/spec, disk file or log holds material.
Exclude delivery bodies from control-plane audit logs too; qualify that cluster setting.
The separate P3-8 custody store may persist source secrets as designed;
“nothing persisted” here concerns released material and the MCP instance, not that store.

Renew while recent authorised demand/in-flight work keeps the instance within its five-minute
idle window; renewal itself never resets that timer. Do not renew a sleeping instance.
Start renewal with enough time for its measured operation, a five-second clock margin and
replacement where needed. Require current membership, profile/control/selection, admitted
image and publication before every release; confirm `credential.released` before delivery.
On expiry/renewal failure, close calls/stop; show Unavailable or Needs input by recorded cause.
Enforce trusted-time expiry locally and upstream despite watcher failure. JavaScript buffers
cannot guarantee erasure; drop references, disable dumps/traces and bound receiver memory.

## 2. Runtime, routing, idle stop and time limits

Run in `<silo>-mcp`, separate from gateway and computers, under #47's admitted exact digest.
Use #47's workload adapter/ops runtime, replicas zero/one and no callable overlap.
No warm pool, HPA, workflow platform or computer volume; derive names from checked key/run.
Match UIDs, owner references, expected resourceVersion and checked spec before mutations.

Reuse #47's gVisor, non-root, read-only root, no privilege escalation, dropped capabilities,
RuntimeDefault seccomp, no host namespaces/hostPath/devices, no service-account token,
no arbitrary init/ephemeral containers and no PVC. Use only bounded memory-backed scratch;
keep credentials in private process memory/IPC, not scratch files. Defaults remain
100m CPU/256 MiB request, 1 CPU/512 MiB limit, 64 MiB scratch and 256 PIDs where enforced.
Unsupported hardening fails deployment. Admission protects exact images, receiver/launcher,
container count, volumes, ports, identity and limits; policy/trust writers are separate
from the lifecycle service account. Reuse computer-admission's CEL structure, not its
literal template, computer capabilities or PVC exception. SQL decides no business rule.

Give the MCP lifecycle identity only its namespace's necessary workload reads/mutations
and `pods/proxy` delivery; no `pods/exec`, secret listing, RBAC/policy writes or other silo.
The MCP's identity has no Kubernetes, event-store or custody access. Dynamic names mean
RBAC alone cannot restrict create by label; admission checks the worker and reviewed spec.

Keep this route: `Codex → private mcp-proxy → agentgateway/ext_authz → checked hosted dispatch → exact MCP`.
The browser/computer supplies server/installed connection references only. Derive profile,
user, generations and backend from checked turn/selection/event facts. An internal one-use
permit binds method/tool/arguments digest, requester/assistant/turn, reviewed policy,
image, profile, material expiry, instance UID and both generations. Final dispatch validates
it immediately before sending; the instance entry wrapper also validates the bound identity.
Caller-selected Pod/Service/URL/profile headers and alternate credentials are refused/stripped.
No direct computer/browser-to-MCP Service, Ingress, public port or tailscale funnel exists.

Default-deny NetworkPolicy; permit callable ingress from #47's trusted gateway/dispatch
transport with namespace AND Pod selectors. Host processes cannot match Pod selectors:
extend the existing credential-free relay explicitly to reach checked transport. Keep the
Pod proxy receiver as a separate authenticated control path, not a second tools/call route.
Allow egress only to the reviewed upstream's exact address/port plus narrowly controlled
DNS if required; forbid other instances/users/silos, metadata, API server and Internet 443.
Use #47's fixed operator binding for the local synthetic upstream. Hostname-only policies
are insufficient: check all DNS answers, pin addresses and update allowed IPs safely.
No model gateway, package/Git or browser route is needed by this MCP. #61/#18 supplies
computer command egress separately; it must not broaden the personal MCP's upstream rule.

Default per-silo quota: four concurrent MCP Pods total in this namespace, counting shared,
personal, quarantine and terminating Pods; aggregate limits 4 CPU/2 GiB, requests 400m/1 GiB.
Image scan jobs stay in #47's scan location. This caps personal growth alongside shared use.
Kubernetes ResourceQuota enforces races; a projection supplies safe capacity status only.
When full, refuse a new wake with `instance_capacity_unavailable`; do not evict another
person, queue without a deadline or buy capacity. Confirm Pod absence before freeing a slot.

Wake only on explicit demand. Reading My tools, loading chat, renewal and health checks
never wake or keep alive. Capture discover/tools/list on EVERY process start under #48;
an unchanged digest preserves reviewed policy, a changed catalogue holds calls for review.
Keep stale image/check evidence unavailable rather than rescanning inside a user's call.
Idle means no pending/in-flight call and five minutes since authorised demand completed
(explicit wake completes at Ready). A waking attempt counts only until its deadline.
Use admitted demand/completion facts, never unrelated chat or unauthorised probes.
On 300 seconds idle, append stop intent against the current instance stream position,
close admission, scale to zero and record observed Pod absence. Recheck activity before
append so a concurrent call and stop cannot both win. Bound hung calls by the call deadline;
finish with observed/unknown outcome, then stop normally. Never replay their tool request.

Target warm Ready admission under one second and cold wake-to-callable p95 at most 15 seconds
on the existing box with a pre-pulled admitted image; hard wake deadline 20 seconds.
This includes receiver delivery and per-start discovery. #48's 30-second discovery limit
is a ceiling, further bounded here by remaining wake time. Image pull/scanner outage may
miss the target and must show Unavailable, not extend a wait without limit.
The owner's accepted 10–14 second computer cold resume fits the 15-second target only
if MCP material delivery/capture also fit; it is context, not measured MCP evidence.

D10's upstream deadline remains 30 seconds from the actual call send, not from wake start.
Wake (20 s) plus call (30 s) is at most 50 s, below proxy socket inactivity (120 s)
and Codex `tool_timeout_sec: 1200` (20 minutes). Bound calls further by material expiry
minus clock margin; renew before admission if too little life remains. Enforce a 50-second
overall deadline; socket inactivity alone is insufficient. ext_authz cannot wait for wake:
it authorises a one-use preparation capability only, consumed immediately by checked
transport to record the wake. That capability cannot send a tool call. After preparation,
the transport requests a fresh internal decision for approval/permit/release/dispatch.
Keep both authorisation checks within two seconds. Do not consume approval
or issue a send permit before a slow wake, or carry a stale authority check across it.
`thread-loads.ts` uses `startup_timeout_sec: 10` and a separate 10-second unload limit:
10–14 seconds does NOT fit if wake is placed in Codex discovery. Serve its approved
catalogue locally as today; actual upstream capture precedes callable readiness and the
final check rejects a changed list. Confirmed affected-thread unload/reload applies on
drift; fail that turn if unload is unconfirmed, without restarting other conversations.

## 3. Commands, events, status and failure recovery

Keep the profile stream and selection/control streams defined by #49. Lifecycle uses
`mcp-instance-<opaque-instanceId>` for this key, with key fields checked against the silo.
Extend #47's proposed lifecycle events rather than introduce a parallel computer lifecycle.
These are proposed contracts. Update registry/schemas and docs/architecture/events.md together.
Commands read/check exact facts then append once to one stream; reactions own external work.

| Command / event | Checks, projection and reaction |
| --- | --- |
| Admit/review startup contract | Extend #47 admission/review receipt with the credential contract digest and evidence; existing `mcp.server_rejected` records unsupported requirements. No wake or release. |
| Wake → `mcp.instance_start_requested` | Owner/current authorised requester, selected usable profile, supported contract, admitted image; assign runGeneration, reason/request/change ref and 20 s deadline. Duplicate demand joins that attempt. Reaction creates the owned closed receiver. |
| Observe → `mcp.instance_observed` | Exact key/run/UID/spec and original attempt; record starting, callable, failed, stopping or absent plus safe reason/time. Callable requires release acknowledgement, fresh matching catalogue and acknowledged config. Late observation cannot restore an old run. |
| Start/renew release → `credential.released` | Extend #49's purpose union with instance_start/instance_renewal, user/profile/server/connection, worker operation, UID/run, material id, generation and issuedAt/expiresAt. Link originating computer/turn/tool/request when demand came from chat; explicit My tools wake uses worker identity, never a fabricated computer. Audit first, then deliver once. |
| Finish release → new `mcp.instance_material_observed` | Record release id/run/UID, accepted or failed/unknown and expiry only; never bytes or a token-derived public hash. A successful matching acknowledgement allows readiness/renewal. Unknown keeps the route closed. |
| Admit call / finish call → new `mcp.instance_call_admitted` / `mcp.instance_call_closed` | One conditional append per command on this instance stream; bind request/permit/run and deadline. Serialise admission with stop. Existing `decision.recorded`/`tool.dispatch_recorded` remain decision/outcome authority; closure records their safe references and responded/not_dispatched/unknown, never sends anything. |
| Stop → new `mcp.instance_stop_requested` | Idle current revision, owner/admin stop, expiry, revoke/rotate, drift or loss; record reason and run. Deny first; reaction scales to zero/deletes exact owned objects; observation records actual absence. |
| Rotate/revoke/disable | Reuse #49 connection events/control; invalidate the old profile generation immediately, cancel its approvals and append stop intent per affected instance through separate commands. No multi-stream transaction. |

Separate connection state from runtime: Connected + Sleeping is normal; Waking names the
actual attempt/time; Available needs all matching live evidence; Stopping denies new calls.
Unavailable distinguishes capacity, startup, custody/audit, check and transport causes.
Needs input means expiry without usable refresh or invalid grant. Admin-disabled and owner-
revoked stay distinct. Outcome unknown describes the ORIGINAL operation, not latest status.
Project status/audit in TypeScript; replay rebuilds rows/indexes without restoring authority.
Check expiry at read/admission despite stopped timers. No SQL business rules.

Read conversation/request history before its own short access check; watch only the small
member, assistant, team, payer and grant streams for general access. Exact profile/control,
selection, policy and instance revisions are additional dispatch preconditions, prepared
before the two-second window and compared by position within it. Never wildcard-read a
user check or watch a whole personal conversation; no conversation stream in a read fence.
Reads check access once. Turn/file/tool activity must not close a reader/viewer. Leave
`authority.test.ts` and `authority-volume.test.ts` unchanged; add focused MCP cases elsewhere.

Rotation/revoke ordering: stage new material in custody if needed, then confirm #49's event;
invalidate old release/dispatch within two seconds, even if instance cleanup is delayed.
Block the instance's entry route, cancel old permits/approvals and stop the old process.
Before ANY new-generation material release, require confirmed old Pod absence, or a
verified upstream revocation plus effective ingress/egress isolation of that exact old run.
Default to Pod absence: a routing change alone cannot stop a process using retained
upstream material. If absence/containment cannot be proved, leave new generation unavailable.
This also applies to ordinary OAuth refresh when it advances startupAccessGeneration.
An expiry/old-generation/foreign-user/foreign-silo call reaches no MCP tool; no fallback.
Already sent external work may finish or be uncertain; stopping a Pod cannot undo it.

Lost create/scale/delete replies are reconciled by original operation, exact owner/UID/spec
and resourceVersion before retrying a Kubernetes change. A name/label/404 alone is no proof
of ownership or terminal failure. Lost material-delivery reply reads safe receiver status
for that release id; never sends the same material again. If status is irrecoverable, keep
closed, retire that run and request fresh audited material after confirmed absence.
Do not copy SandboxClient's token cache as durable delivery proof. Avoid raw kubectl errors.
On worker/dispatcher replacement, start closed, reread current intent and invalidations,
reconcile UIDs and require fresh bounded release/ack; fence the previous dispatcher under
\#47's single active dispatch ownership. A local mutex alone cannot fence another worker.

Pure replay rebuilds lifecycle/status/audit only: no wake, secret release, renewal or tool
send. Live reconciliation may finish currently authorised pending infrastructure intent;
historical Ready/release facts cannot reconstruct a permit. Persist a send claim through
\#48's one-use dispatch contract BEFORE network bytes; after a crash an unresolved claim
is unknown even if it might have crashed before send. Complete/expire admitted call facts
from durable evidence/deadlines, not another attempt. D08 forwards once with no automatic
redispatch. Restarts, HTTP retries, reconnect, late Approve and status GET never repeat a write.
Every material start/renew/replacement has a separate confirmed audit before delivery;
audit/custody failure denies. Audit records authorised release separately from observed effect.
Retain original command/change refs and payload binding beyond NATS deduplication windows;
confirmed not-applied needs terminal refusal/closed deadline, not projection lag or timeout.

## 4. Screens, APIs and missing frames

Build in apps/web using PLAN's PrivateInstanceStatus/MyToolsScreen/ConnectionProfileForm,
shared paper/states, existing settings shell and ToolActivityLine. Show Waking/Unavailable
in My tools AND active chat; participants see authorised call status, not private accounts.
Browsing status never wakes. No new lifecycle dashboard.

Proposed reads: `GET /api/my/tools` adds safe runtime status to #49's own profile rows;
`GET /api/my/tools/:serverId/profiles/:profileId/instance` returns status, run/change ref,
checked/expiry/idle times and typed reason, with no Pod address or material. `POST` its
`/wake` takes changeRef/expectedSequence only, and `/stop` is explicit owner stop.
Both use session, exact Origin/CSRF and current ownership; no browser-selected user/generation.
`GET /api/my/tools/changes/:changeRef` checks the original attempt; it never wakes or saves.
Admin unsupported-contract status uses #47's `/api/org/integrations/:serverId/admission`.
Existing #49 rotate/revoke/selection and #50 OAuth start/status routes remain their owners.
Chat uses authorised HTTP/realtime tool records joined by original request id, adding typed
preparing_instance/waking/unavailable and dispatch certainty; lifecycle polling is not a
second effect-status API. Generation/access changes abort obsolete reads and reject late replies.

| Frames, each 1280 and 390 | Binding and truthful behaviour |
| --- | --- |
| INT-24 | Instance GET/original wake status in My tools; retain its “normal sleep” message and real requested time. Supplied frame is admin installation: personal shell variant needs prompt A. No simulated progress or enabled Continue before callable evidence. |
| INT-25 | Confirmed wake failure: instance/status GET; Try again requests a NEW wake only after terminal failure. Replace “No connection was saved” with the actual lifecycle outcome; a connected profile remains connected. A lost Kubernetes reply goes to INT-95 instead. |
| INT-26 | Admission refusal before install/review completes; lock + Back only, supported short-lived requirement explained. No permanent-secret field, override or invitation to collect it later. Name the actual fixture/integration, not example Odoo. |
| INT-60/61 | #49 list/connect + runtime state; own selected account and sleeping status are separate facts. Stacked mobile rows; unavailable integrations grant no use. Sleeping is not Removed. |
| INT-72 | Needs input/expiry or failed refresh from #50; Reconnect uses its existing flow. A temporary worker/custody outage is Unavailable, not falsely expired consent. Show one relevant variant. |
| INT-73 | #49 admin blocker; no wake/reconnect bypass. Say Disabled by admin when that is the recorded action; show permitted safe contact/time. |
| INT-74 | Chat refusal for no usable selection/profile; My tools link, no owner/company fallback. Existing tool refusal data, no secret request to the model. |
| INT-75 | Return after confirmed connection/selection restores an unsent draft and composer focus; it never replays a waiting write or wakes automatically. |
| INT-76 | Owner-revoked/removed connection history; reconnect only where permitted. Idle scale-to-zero does not enter this state. |
| INT-92 | Custody/identity unavailable; label last confirmed metadata, deny new release. “Nothing changed” requires evidence; unknown submission switches to INT-95. |
| INT-94 | Role/grant loss clears protected content, closes sheets and ignores late responses; unrelated chat activity changes no access. |
| INT-95/96 | Original change GET only: checking, still unknown, confirmed applied or proven not applied. Render one result, not every illustrative alternative. Applied wake means recorded intent unless callable evidence is also present. |
| WRK-02 | Reuse quiet tool line and Stop for active work; exact Waking variant is missing (prompt C). Use typed server status, never a timer that pretends a call was sent. |

At 390px use the 44px menu, 18px/16px padding, stacked labelled facts, full-width actions
and full-screen details with Back. Wrap names/scopes/refs; no horizontal page scroll.
Keep the composer above the keyboard and actions clear of it; settings have no composer.
Keep 44px targets, focus trap/return, Escape/Back, 4.5:1 text contrast and glyph plus words.
Announce “Waking your connection” once and its result once; freeze progress under reduced
motion. Do not reproduce the PNGs' demonstration clipping or example dates. DM Sans/DM Mono,
paper #fbfcfc/canvas #eceff0/ink #16191a, teal #0db5cc/focus #0a8497, orange #f47920,
green #2a7d4f/red #c1392b/amber #8a5d1f; 12px dog-ear/card, 8px button, 2px focus ring.
Tool descriptions, upstream responses and safe account names are escaped bounded data,
never instructions, executable Markdown/HTML or URLs to fetch automatically.

### Every additional screen without an exact frame: pasteable Claude Design prompts

Four gaps follow; other errors/reconnect/unknown reuse the frames above and WRK-30–35.
\#49's eight selection/account/admin/approval gaps stay in its accepted prompt batch.
Request 1280/390, reduced-motion, keyboard/focus and transitions for each. Gap UI PRs wait
for the owner's handoff; backend PRs proceed. No Claude Design call is made here.

#### A. My tools private-instance list/detail and lifecycle states

> Design My tools private-instance rows and a detail sheet for the signed-in profile owner. Purpose: distinguish a connected account from a sleeping or waking private process. States: loading, Connected + Sleeping, Waking, Available with dated evidence, Stopping, Unavailable, renewing, Needs input, Disabled by admin, access lost and original wake outcome unknown. Data: integration, safe selected account, scopes, runtime status, actual checked/requested/expiry/idle-stop times and change reference; no credential, Pod address or other person's account. Interactions: open detail, explicit Wake, explicit Stop, existing Reconnect/Revoke, Back and Check original status; reading never wakes and reconnect never resends chat. At 390px stack labelled account/runtime facts, wrap names/refs, use a full-width detail sheet with Back and 44px full-width actions, no composer. Reuse INT-60/61, INT-24/25, INT-72/73/76/92/94–96, PersonalSettingsShell, SharedState and ModalSheet. Reuse DM Sans/DM Mono, listed paper/dog-ear, teal focus and status tokens. Show sleeping as normal, not removal or failure.

#### B. Capacity unavailable in My tools and chat

> Design a capacity refusal notice for members requesting a private-instance wake, in My tools detail and its chat tool line. Purpose: explain that the silo's concurrent-instance limit is full without disclosing who uses the slots. States: confirmed capacity refusal before tool dispatch, read/checking, capacity available for an explicit new request, and access lost; show unknown original operation with existing Check status styling when appropriate. Data: integration, own request time/reference and safe capacity reason; no other users, Pod list, price or fabricated countdown. Interactions: Check status reads only, Back, return to an unsent chat draft, explicit new wake only after the original is terminal; no automatic retry, eviction or purchase. At 390px use a stacked notice with 44px full-width actions; in chat keep it above the keyboard-safe composer. Reuse INT-25/61/94–96 and WRK-02/30, SharedState, paper/dog-ear, DM Sans/DM Mono and teal/red/clock tokens. Make both 1280/390 frames and reduced-motion notes.

#### C. Waking private connection in a chat tool line

> Design the WRK-02 variant “Waking your connection” for a requester waiting for a governed tool call on their private instance. Purpose: show preparation before any tool request reaches the integration. States: wake starting with actual request time, callable then running, wake stopped/cancelled, unavailable before dispatch, catalogue changed requiring review, and access revoked. Data: safe integration/tool label, request reference and typed lifecycle phase; account details are visible only where authorised, never to every participant. Interactions: open sanitised detail, keyboard-reachable Stop, link to My tools when input is needed; no timer-generated success or automatic repeat after reconnect. At 390px wrap the quiet tool line and details, retain the docked composer above the keyboard and 44px controls; announce waking once and result once. Reuse WRK-02 quiet line/Stop, INT-24/25/74/75, SharedState and chat shell; reuse all listed typography, paper/crease, teal focus and glyph/status tokens. Provide 1280/390 and static reduced-motion progress.

#### D. Instance renewal/replacement failure with dispatch certainty in chat details

> Design sanitised tool details for a private instance whose material expired or whose process was replaced. Users: the requester and currently authorised conversation participants; purpose: explain what happened to this original call without repeating a write. States: preparing but definitively not sent, renewal failed/Needs input, stopping old generation, replacement unavailable, sent with outcome unknown, Check status still unknown, and observed response. Data: safe tool/integration, original request reference, actual event/check times, typed failure and dispatch evidence; no credentials, provider error bodies, Pod URL or private account fields. Interactions: My tools/Reconnect where permitted, Check status for the original request, Back; only proven non-dispatch permits an explicit new request, and connection success returns an unsent draft. At 390px use a full-screen detail sheet with labelled stacked evidence, wrapped refs, 44px actions and a keyboard-safe return to composer. Reuse WRK-02/04/30–35 and INT-72/74/75/92/95/96, SharedState, ModalSheet and all listed paper/type/focus/status tokens. Distinguish unknown effect from failed wake and never say “nothing changed” without evidence; provide 1280/390 and reduced-motion notes.

## 5. Ordered PRs and failing-first evidence

Use serial branches/PRs from main, no stack; each ≤600 non-generated changed lines,
including tests, events/docs, affected README/robot diagrams and branch release note.
This supersedes #51's 800–1,200-line aggregate estimate. Read package robot contracts first.
Write failing tests per row; unfinished paths stay refused. Server precedes screens.

| Order / maximum lines | Independently landable outcome and dependency | Failing-first proof |
| --- | --- | --- |
| 1 / 480 | Startup credential contract and early review/install refusal. Can land before #47/#49 finish, against existing rejection/discovery contracts; no hosted startup enabled. | Lasting/env-only/raw-bearer and unknown contracts refused before Connect/publication; legacy stays closed; compatible synthetic contract is not yet callable. |
| 2 / 550 | Instance identity/lifecycle commands, projection and own original-operation reads. Can land before #47/#49 finish using accepted payload contracts; missing profile/admission refuses wake. | Foreign silo/user/profile/server, renamed profile, stale revision/run and duplicate changed payload refused; replay/status cannot wake or release; 404 is not terminal failure. |
| 3 / 590 | Dev namespace workload admission/RBAC/NetworkPolicy/quota and exact UID scale/delete adapter. Wait for #47's admitted workloads/hardening; may land before #49 finishes with no material delivery/calls. | Real k3d rejects secret/env/PVC/exec/privileged/foreign mutations, denies arbitrary egress/direct computer ingress and fifth concurrent Pod; lost apply/delete reply adopts only exact owned run. |
| 4 / 580 | Memory receiver/startup-purpose broker delivery, renewal and audit acknowledgement. Wait for #47 and #49 custody/release audit; per-call leases unchanged, normal calls still closed. | Audit/store failure delivers nothing; expiry/foreign/reused delivery denied; lost delivery response reconciles or retires; no material in spec/env/disk/log. Renewable fixture keeps upstream expiry enforced. |
| 5 / 590 | On-demand wake, per-start catalogue and five-minute idle scale-to-zero. Wait for #47/#49 contracts and #48 capture/freshness (#329 alone insufficient). | Concurrent wakes create one run; read/health/renewal does not keep alive; wake deadline and stop/admit race; every restart captures tools; changed catalogue stays closed; 10-second Codex discovery stays local. |
| 6 / 590 | Governed personal dispatch and revoke/rotate/disable replacement barrier. Wait for #47/#49 plus #48 final permit and acknowledged publication; OAuth variant also waits for #50. | Alice/Bob concurrent calls use separate instances; forged backend/old run/material expiry fail; revoke wins against prepared release, no new material before old absence; approval consumed only after Ready; sent write never resent after crash. |
| 7 / 550 | Recovery and real backend fresh-dev journey using zero-cost startup fixture. Wait for rows 3–6 and #47/#49 usable product flows; OAuth renewal proof waits for #50. | Crash/lost Kubernetes/release/dispatch reply at each boundary, rebuild projections, Pod replacement, idle wake with fresh release, exact upstream write count remains one, actual egress/isolation/persistence negatives. |
| 8 / 480 | Framed startup refusal and shared recovery/reconnect states in apps/web. Wait for server rows, #49/#50 owning screens as applicable; existing frames suffice. | INT-26 offers Back only; unknown GET never POSTs; expiry versus outage/disabled accurate; 390px keyboard/focus and late access-loss replies; return draft never sends. |
| 9 / 560 | My tools runtime status/detail/capacity using A/B. Wait for server rows, #49 My tools and owner's A/B handoff; backend does not wait. | Reading never wakes, sleeping stays connected, explicit wake/stop/capacity status, original-ref recovery, secret-free mobile details and obsolete-response rejection. |
| 10 / 550 | Chat waking/unavailable/replacement details using B/C/D. Wait for server rows and owner's B/C/D handoff. | Typed pre-send/unknown distinction, Stop, no redispatch, participant privacy, local startup timeout, keyboard-safe 390px composer and static reduced motion. |

Real cluster proof belongs in proposed `apps/ops/test/mcp-personal-k3d.test.ts`, using
the existing lifecycle-k3d slot ownership check, real gVisor/k3s, NATS/Postgres/OpenFGA,
actual agentgateway/checked relay and signed/scanned AGPL-3.0-or-later fixture. Name cases:
“isolates two users and refuses foreign and old-generation routes”; “allows only the
reviewed upstream and denies metadata, other instances and direct computer ingress”;
“keeps released material out of specs, environment, volumes and logs across restart”;
“reconciles lost Kubernetes replies and restarts without repeating an upstream write”.
Inspect specs/layers, /proc environment/cmdline, mounts/scratch and logs with synthetic
canaries. Prove allowed upstream works and refused destinations receive nothing; include
a controlled missing-policy negative. Inspection uses the test operator, never product
exec rights. Prove the upstream rejects expired/revoked capabilities.

Existing `lifecycle-k3d.test.ts` cases “admits the checked computer template and rejects a
forged Pod identity source” and “qualifies the event-driven lifecycle on k3d gVisor” are
computer regressions, not personal MCP proof. Reuse idle/wake/kubernetes/credentials tests'
race, old-Pod, ambiguous-patch and gateway-refusal patterns; mock kubectl is insufficient.
Future runner: `nice -n 10 env MCP_PERSONAL_K3D=1 DEV_STACK_ID=1 PG_TEST_URL=… npx vitest run apps/ops/test/mcp-personal-k3d.test.ts` after claiming its secondary slot.
Run required lint/typecheck/test/check:events and web checks before landing/on main under
nice; never overlap root/fleet batches with live-view qualification. #63 owns twice-fresh
desktop/390px journeys. Receipts: date/SHA/digests/freshness, expected/observed results,
safe artefacts and PASS/FAIL/PARTIAL/NOT RUN. Fresh journey required to close #51; NOT RUN here.

## 6. Open questions with recommended defaults

| Question | Recommended default and cost boundary |
| --- | --- |
| What exactly can P3-8 supply at startup? | A separately typed D16 startup-purpose renewable upstream capability, not a reusable D15 per-call lease/raw lasting bearer. Qualify one zero-cost synthetic upstream accepting it. Reject unsupported bearer-only dependencies; do not relax D15. |
| How short must OAuth access material be? | Verified actual expiry, at most ten minutes remaining, no refresh token in the instance. Renew in custody; generation advance stops the old process before replacement release. Provider lacking bounded renewable material remains unsupported. |
| Which renewal mechanism? | Reviewed memory IPC/credential-provider for the 30-second fixture. Immutable launch-only tokens need a measured replacement window within their expiry; incompatible combinations are refused at admission. No env/config-file workaround. |
| Which quota and wake target? | Four total concurrent MCP Pods, existing-box resource limits above; cold p95 ≤15 s/hard 20 s, actual send ≤30 s. Measure all phases including capture. **COST OUTSIDE BOX:** extra nodes/RAM/cloud cluster capacity needs separate approval; do not buy speed or silently raise quotas. |
| Can old/new processes overlap on rotation? | Default no: require old Pod absence before any new-generation release. If deletion is uncertain, stay unavailable. Any alternative upstream-revocation/isolation proof needs qualification; route removal alone is insufficient. |
| Who runs timed/background work? | Current requester demand only for personal instances. No owner impersonation, routine/company reuse or background keepalive; those need separately owned contracts. |
| Where is hosted dispatch reachable in dev? | Reuse #47 checked transport and the in-cluster relay, explicitly qualified across namespaces. Tailnet access through serve only; never funnel or widen computer NetworkPolicy. No new paid proxy/service. |
| Does production ship now? | Dev stack first. Helm/HA/production custody and encryption are #15/Phase 5. Dev image scanning uses existing ClamAV; production needs our own shared scanner service, with admission unavailable until qualified. **COST OUTSIDE BOX:** production scanner compute/storage, cloud KMS or paid vault are separate decisions, none authorised here. |
| Fixture licensing/provider work? | Own narrow AGPL-3.0-or-later TypeScript fixture using installed OSI dependencies, pinned admitted image and reviewed notices; no new runtime dependency. OAuth proof reuses #50's separate app/throwaway accounts only in Zitadel “OpenCrane 2 Dev”; no changes in this design task. |
| Any tool/provider spend? | Explicit `costCents === 0` only until budget work lands; still honour recorded allowance and hard stops. Money uses integer euro cents. No paid-provider call here. **COST OUTSIDE BOX:** registries/egress/managed services or paid qualification need separate recorded allowance and remaining balance; the 500-cent live-test envelope is not automatically available. |
| How to unblock UI gaps? | Send A–D to the owner as one handoff batch during delivery; this read-only task contacts nobody. Gap UI PRs wait for accepted frames; server PRs proceed within dependencies. Existing #49 prompts stay with their owner. |
