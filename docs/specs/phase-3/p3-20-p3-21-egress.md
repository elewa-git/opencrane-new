# Governed package, Git and browser access

<!-- markdownlint-disable MD018 MD034 -->

Design: [#61](https://github.com/elewa-git/opencrane-new/issues/61),
[#62](https://github.com/elewa-git/opencrane-new/issues/62), D25, delivering #18. 10 October 2026.
Checkout, origin/main and GitHub main: `d53e8e35aa949a9044685259eeda38540628d0c6`.
Only this note was written. No repository changes, tests, deployments, model calls or
network calls other than GitHub reads. Implementation and live qualification: **NOT RUN**.

Read requested issues/comments, specs, ADRs, code, robot READMEs and both frame sizes; estimates are limits.

## Contract and existing facts

Keep ordinary commands socket-denied as UID 1001. Delegate only fixed operations
through supervisor-created IPC to a different user. Each caller gets separate permission;
Codex's UID 1000, caller token, model/MCP proxy and grants are never lent to a tool.
Reuse the decision/audit paths. Package output, repositories and pages are data, never instructions.

- #13/PR #17's real gVisor isolation receipts must stay passing; general egress is unproved.
- #61/#18's 6 October audit says the broker is unbuilt. Main proxies serve Codex only;
  desktop.ts starts Xvnc, not a product browser controller.
- #58 is unbuilt. Consume its durable pause proof, requester/generation and expiring lease,
  not S0.5's volatile identity. #62 waits for #61 and that lease to land.
- #60 is closed: extend existing `egress.observed` and audit.ts, not duplicate events.
  Correct events.md's obsolete “P3-18; fixture contract” producer label during implementation.
- #55 owns final dispatch: old reservations cannot bypass stop; cancellation starts within
  two seconds and isolated exit is proved within ten seconds.
- #46/#49 own MCP credentials/calls; egress cannot select a profile or release a secret.

## Destination policy, capability and gateway

An Owner/Admin saves one exact ASCII DNS hostname, integer port and subject: silo,
person or assistant. Lower-case and validate the hostname, including IDNA conversion;
reject wildcards, suffix matching, URL credentials/path/query/fragment, malformed labels,
ambiguous numeric hosts, IP literals and private/internal/metadata destinations.
Default HTTPS port 443; another HTTPS port needs an explicit rule. No HTTP downgrade.
Effective access requires the silo rule AND the requester's rule AND the assistant's
rule for the identical host/port. No union, owner fallback or implicit registry/CDN rule.
Retain revoked rules and their actor/time. Saving one subject never saves the other two.
Show which of the three rules is missing without exposing another person's policy.

Bind capabilities to silo, requester, assistant, computer/Pod id, generation, conversation,
thread/turn, operation id/kind/digest, host/port, policy positions and expiry. Human browsing
also binds takeover/lease id, control epoch and originating requester event. Retain original
thread/turn when present; idle takeover uses its request reference, never a fake active turn.
Add `computer-egress` audience/type, strict ES256 expiry at most 60 seconds, bounded by
turn/grant/lease expiry. Tighten its verifier explicitly: the current non-turn branch allows
ten minutes. Keep existing audiences. Separate command/automation/desktop capabilities;
reject substitution. New destinations/renewals need fresh checks; never extend a dead turn.
Keep bearers only in trusted memory/inherited pipes, never argv/env/PVC/browser/stdout.
Events retain ids/digests/bindings. One capability cannot authorise another operation.

**Native CONNECT exists in agentgateway v1.5.0 (Apache-2.0).** The local binary pin is
`daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`; the dev relay image
is `sha256:bf2f339ef326d32def2aaeb44b1b4549801293c19b89e764a4228667d97d9896`.
GitHub's v1.5.0 tag resolves to `fe6732474a96a0363dfb9822859af4e9bab360fa`.
The [egress example](https://github.com/agentgateway/agentgateway/blob/fe6732474a96a0363dfb9822859af4e9bab360fa/examples/traffic-egress-proxy/README.md),
[CONNECT implementation](https://github.com/agentgateway/agentgateway/blob/fe6732474a96a0363dfb9822859af4e9bab360fa/crates/agentgateway/src/proxy/httpproxy.rs)
and [tests](https://github.com/agentgateway/agentgateway/blob/fe6732474a96a0363dfb9822859af4e9bab360fa/crates/agentgateway/tests/tests/connect.rs)
show native routing and byte tunnels. This is source confirmation, not a binary test.
Use frontend `connect: {mode: route}`, route-specific JWT/extAuthz, never wildcard tunnels.
Model/MCP routes reject egress audience; strip proxy bearers, identity headers and internal
metadata before destination forwarding. No replacement proxy dependency.

Native raw byte copying alone supplies neither public-address pinning nor active
revocation. Add a small TypeScript socket guard beside the gateway (our AGPL-3.0-or-later
code, Node MIT), reusing `isPublicAddress` from server integrations. For each authorised
HTTP/CONNECT request, the decision registers a short-lived, single-use private relay
address with the guard. The gateway's dynamic backend selects only that server-issued
address from extAuthz metadata; it never resolves the caller's host directly.
The guard associates the relay with the exact permit and opens only its validated IP.
Private relay/control listeners are gateway-local, inaccessible to computer Pods.
Creating a relay is a reaction after admission, not a second business write in a command.
Prove metadata-to-backend ordering on the pinned binary before enabling this route;
registration failure or an unknown relay yields no outbound connection.

Resolve all A/AAAA answers per visible HTTP request or CONNECT with a bounded deadline.
Reject empty, mixed public/private, link-local, loopback, multicast, reserved, mapped/
transition IPv6, cluster, CGNAT/tailnet and metadata answers; follow CNAMEs without trusting
suffixes. Pin a checked IP through connect; retain hostname for client TLS verification/SNI.
Fallbacks use only the checked set; reconnects re-resolve. Save-time validation is insufficient.
Scope pools to operation, destination and current policy positions.

Each redirect destination needs its own rule/capability. npm/Git use HTTPS proxies,
fixed settings and HTTPS-only redirect handling. A new host causes a new CONNECT.
Same-host paths remain within the host rule: this is no path allowlist. Refuse downgrade,
IP redirects, CONNECT authority/Host disagreement, nested/extended CONNECT, CONNECT-UDP,
SOCKS and raw non-TLS protocols. Require TLS SNI to match the approved authority before
relaying application data; refuse absent/hidden SNI rather than guessing.
Do not intercept TLS, install an interception CA or claim inner HTTP visibility.

Record outer CONNECT admission/open/close, host/port or safe digest, selected public IP,
bytes, permit, requester/turn, timestamps and close reason. “Tunnel opened” is not
“package installed” or “page loaded”. Encrypted inner paths, bodies, headers and WebSocket
messages are invisible to the gateway. Browser telemetry can describe a blocked redirect
or subresource separately, without pretending it is a decrypted gateway observation.
TLS host rules cannot prevent an approved remote site acting as a server-side relay;
only reviewed destinations belong in this policy. Do not promise content filtering.

## Supervisor, worker and browsers

Extend entrypoint.ts's trusted executor connector to recognise only fixed npm-install,
HTTPS-git-clone and later browser operations. Bind `process/start` metadata.thread_id and
tool_call_id to the bridge's registered live command and digest, then to server facts.
The [pinned executor protocol](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/exec-server-protocol/src/protocol.rs)
explicitly calls metadata telemetry, not authorisation. Missing/unmatched metadata fails
egress. Never infer a turn from cwd, model-written environment, the latest token or stdout.
Accept only documented standalone command forms, not arbitrary shell strings/pipelines.
Non-network commands retain their existing native executor path and seccomp filter.

For a fixed operation the supervisor starts a UID 1001 socket-denied connector and a
UID 1004 network worker over inherited pipes. Return output/exit through the executor
protocol; no command gains a socket descriptor. The worker runs fixed image-owned npm/Git
binaries with validated arguments, empty supplementary groups, no capabilities and
no_new_privs. Its trusted local proxy stamps only its operation capability. It reaches
gateway TCP 3000 only; no DNS/UDP/Unix-socket or process-inspection escape. Reject caller
proxy settings and origin-form requests to local management endpoints.

Use a private operation root: immutable runtime, its workspace, temp and cache. UID alone
cannot hide today's world-readable `/workspace`. Default supervisor-prepared chroot with
checked non-link parents, copied runtime, no /proc, host /tmp, devices or private homes.
Add CAP_SYS_CHROOT only to the launcher; drop before worker, no SYS_ADMIN/NET_ADMIN or
privileged Pod. Main lacks this capability: revise admission/template explicitly.
Failed gVisor/runtime/memory proof holds enablement; cwd/file modes are insufficient.

Start with 300-second operation wall time, 30-second idle network time, 64 KiB output
retained and 2,000-token chat excerpt, 128 MiB downloaded/unpacked workspace limit,
two operations per computer and eight tunnels per operation. Bound archive expansion,
file count (10,000), backpressure and every IPC frame (64 KiB). Kill descendants and
close relays on timeout, quota, EOF or revocation; use same-UID termination, not CAP_KILL.
Copy selected input privately; verify output paths/digests and record a scanned manifest
before idempotent publication through the existing file pipeline. Complete only after its
receipts. No shared mount; refuse changed destinations or links during publication.

Force npm `--ignore-scripts`, no audit/fund calls, fixed registry and no user/global
.npmrc or inherited environment. Permit version/integrity-pinned packages only; validate
lockfile destinations, transitive licences and archive paths before publication.
Lifecycle scripts never run as the worker. An explicit later local build remains UID
1001/socket-denied; no automatic postinstall, native download or script privilege escape.
For Git force HTTPS only, `core.hooksPath` to an empty protected directory, no global/user
config, helpers, external protocols, submodules, LFS filters, recursive fetch or credentials.
Clone without checkout, validate/scan, then publish and perform any checkout under UID
1001 with filters/hooks disabled. Private Git authentication is out of scope.

Reintroducing runtime npm requires its Artistic-2.0 licence and bundled notices; Git is
GPL-2.0 with reviewed bundled dependencies. Both are OSI-approved. Review exact versions
and image inventory before adding them; arbitrary fetched packages need the same licence
gate. Reuse the existing ClamAV path in dev (GPL-2.0); production uses our own shared
scanner service in Phase 5. No new hosted scanner, mirror or paid licence service.

Playwright commands delegate bounded navigation/actions/data over inherited IPC. Keep the
controller UID 1001/socket-denied; trusted automation/Chromium uses a private UID 1004 root,
fresh profile and automation capability. No model-written JavaScript runs as the worker;
arbitrary Playwright scripts retain socket denial. Reuse installed playwright-core
(Apache-2.0) and reviewed Chromium BSD/OSI bundle, with sandboxing enabled.

Desktop Chromium stays UID 1002, with its own capability held by a separate trusted broker,
never Codex's proxy. Launch a managed controller; Xvnc alone is insufficient. One owner:
checked explicit active requester/turn or #58's connected lease. Several threads mean off
until selection; never pick the latest person or silently replace another active owner.
Conditionally append selection to computer stream, serialised with takeover/turn admission.
Takeover intent closes grants and proves quiet before human browsing. Return/disconnect/
expiry/revoke closes it before ended/new work. Viewing grants neither browsing nor control.
The assistant-scoped shared profile is sensitive shared state, not requester MCP accounts.

Intercept navigation/redirect/subresource requests before continuation, including same-host
requests on reused TLS. Block service workers, extensions, prefetch/background sync,
cross-origin HTTP/2 coalescing and unmanaged launches. Record bounded ids, initiator class
and destination digest from the trusted controller, never page identity/full URLs/cookies.
Deny WebSocket, WebTransport, QUIC/HTTP3, WebRTC/STUN and UDP by default; disable browser
downloads/uploads. Block IP/local/file-network, metadata, provider/secret/control endpoints,
including `/mcp`, `/credentials`, `/bridge` and signers. Unproved request classes stay blocked.
The guard independently checks visible HTTP/CONNECT and closes at expiry; controller reports
do not prove gateway TLS contents. Initially allow reviewed free public browsing only;
refuse mutation methods/forms, paid accounts and paid-site login flows.

Main README.robot.md records an unauthenticated local `/credentials` handler. Worker and
browser enablement require its existing hardening work (#200) to land or equivalent fixed
route refusal: desktop/worker calls must not replace bridge identity or forge acknowledgements.
Keep restricted UID 1003 turns tool-free; this slice grants them no new egress.
Preserve S0.1b, private turns, read-only view, screenshots and Kasm isolation.

## Events, commands, status, replay and failure

Read histories/request facts first, with their own ten-second deadline. Then check exact
small member, assistant, relevant team/payer and three destination grant streams within two
seconds. Partition policy by silo, subject and destination digest, not one silo-wide stream.
No wildcard history, whole conversation or computer stream in an access fence.
Use bounded activity summaries/tails separately for turn/lease/closure changes. Cold facts
that cannot meet the deadline return unavailable. Reads check access once; new activity
never refuses a reader or closes a viewer. Leave authority.test.ts and
authority-volume.test.ts unchanged. Reuse authority helpers without broadening watch lists.

| Stream / event | Command, projection and reaction |
| --- | --- |
| `egress-grant-<silo>-<subject>-<destinationDigest>`; new `egress.destination_allowed`, `egress.destination_revoked` | Owner/Admin save/revoke with commandId and expectedSequence; project rules/receipt index; refresh coarse rules and close matching relays. Check only the three exact destination grant streams, using bounded current facts and tails. |
| `egress-operation-<id>`; new `egress.operation_requested`, `egress.operation_finished` | Record verified binding/digest/limits before launch; finish stores completed/refused/stopped/unknown, safe reason, scan and publication receipts. Reactions reconcile exact operation; startup never executes old requests. |
| `computer-<assistant>`; new `egress.browser_bound`, `egress.browser_unbound` | Checked desktop owner selection/end; project separately from lifecycle readiness, consume #58 control state; close old grants. Never let new events replace computer.ready or end viewers. |
| `decision-<request>`; existing `decision.recorded`, route=egress | One conditional append per HTTP/CONNECT admission/refusal; allow includes permit and verified requester/turn. No permit leaves before durable audit and final dispatch checks. |
| `egress-<request>`; existing `egress.observed` | Extend optional fields for operation, bindings, automation channel, request/tunnel-open/tunnel-close/controller-request stage, counts/times and close reason; old fixtures still parse. Stable stage-specific ids deduplicate ordered open/close appends. Open is unknown; close success means transport completion only. |
| `gateway-<request>`; existing `gateway.observation_recorded` | Safe outage/JWT evidence ingestion; unverified callers have no asserted requester/turn. |

Commands append conditionally to ONE stream; reactions issue separate idempotent receipts.
Update registry/catalogue/handlers/projections together; TypeScript owns rules, SQL stores data.
Reuse access-changes.ts's same-command/content/actor/expected-sequence checks, not wildcard
assistant discovery. Retain receipts beyond dedup TTL; know the change id before sending.
Changed content under that id is 409; equal current values do not prove this change saved.
Lost replies stay unknown until exact event readback; missing rows/404 do not prove absence.
Only authoritative absence plus a terminal attempt/expired deadline permits explicit
same-command retry. Check status never posts. Never repeat possibly started operations;
reconcile original output/receipts or require explicit new work.

Project rule revision, safe actor/time, operation progress, decision/observation separately,
scan/publication state, current browser binding and close reason. Reuse chat transport and
ToolActivityLine with typed egress records, not assistant prose or raw command output.
Extend audit metadata narrowly: current audit.ts discards destination/computer/stage fields.
Use decision anchors, operation correlation and permit joins; give policy changes explicit
anchors so request correlation does not hide them. Reconcile unmatched observations into
one security.alert_raised; missing expected open/close/completion stays unknown.
Safe organisation history excludes repository paths, URL paths, arguments and private
conversation titles; richer own-operation detail requires current conversation access.
Scrub headers, queries, output and secret canaries before any event/log/UI ingestion.

Replay rebuilds projections without tunnels, tokens, workers, secrets or charges. Restart
starts off; reconcile incomplete receipts, never reopen historical bindings. Outage evidence
uses bounded redacted JSONL, stable ids, fsync and cursor advancement after append; it is
physical evidence, not policy truth. Guard snapshots need applied positions and a watchdog.

| Trigger | Required outcome |
| --- | --- |
| Rule/member/assistant/grant revoke, ended turn, generation change, takeover release/expiry | Immediately deny new admissions; close matching open relays within two seconds and stop worker/browser. Record exact reason; retain already-sent observations. |
| Gateway/decision/audit/event store/IAM/budget unavailable | No new egress. Watchdog closes active relays within two seconds when current proof is lost; preserve unknown outcome and safe evidence. Audit projection lag alone is not authoritative audit failure. |
| Hard stop at global/group/assistant ceiling | Reuse #55's serialised final check immediately before target connect/transmission, even under an old permit. Cancel affected relays; collect already-dispatched observations without auto-retry. |
| Capability expiry or operation bound exceeded | Close active sockets, no silent renewal after expiry; report stopped, partial or unknown according to receipts. |
| Lost completion/scan/publication reply or crash | Check exact operation; never report “nothing installed” without proof, never relaunch on replay. |

Default these operations have `allowanceCents: 0`, use free fixtures and have no purchased
service. A host allowlist is not a financial permission: arbitrary paid upstream actions
cannot be bounded through opaque TLS. Refuse paid destinations/operations in these slices;
future priced egress requires a recorded integer-cent allowance/reservation before dispatch.
Do not reserve a fictitious model charge using BudgetActor.reserve (it requires a priced model).
Budget hard stop still applies to zero-cost egress; recovery admits only explicit new work.

Dev first: preserve computer NetworkPolicy's gateway-only TCP 3000 and no DNS exception.
stack.ts places the relay in `<silo>-gateway` with an exact cross-namespace selector;
restrict proxy ingress to labelled computer Pods in that silo namespace. No NodePort,
public ingress, Kasm exposure or open proxy. Existing application routes remain explicit.
Only the gateway guard has scoped resolver/public destination access. Operator UI uses
tailnet HTTPS through tailscale serve, never funnel. Helm/HA follows later, not in this work.

## Screens, APIs and missing handoffs

All paths below are proposed additions unless marked existing. DestinationPolicyEditor,
HingeDrawer, SharedState, ToolActivityLine, LiveView and audit live in apps/web; the exported
apps/opencrane-ui path is obsolete. PLAN.md's P3-20/P3-21 rows correctly say these egress
contracts need building. Do not make tool-policy's current value-comparison recovery a
policy receipt. Existing C/H/V transports are reused, not evidence of egress readiness.

GET `/api/org/egress/destinations`: authorised rows, per-rule revision, canEdit and CSRF;
POST: allow/revoke, subject, host/port, commandId, expectedSequence. GET its
`/changes/:commandId`: exact authoritative receipt with current access.
GET `/api/conversations/:id/egress/:operationId`: own readable progress/receipts;
GET/POST `/api/conversations/:id/browser`: read/select checked owner. Internal capability/
renewal routes require computer binding; session writes require Origin/CSRF. Return 400
invalid, 401 unauthenticated, 403 refused, 409 stale/conflict, 202 pending, 503 unavailable;
unknown is explicit. Existing org/conversation history supplies scoped audit.

| Frame pair (1280/390) | API/status and mobile behaviour |
| --- | --- |
| INT-80 | Destination GET empty; Add opens editor; stacked empty fact card. |
| INT-81 | GET loading; Add disabled, labelled skeleton rows. |
| INT-82 | POST allow editor; Host first, integer port, one subject; full-screen Cancel/Save. |
| INT-83 | Exact saved receipt/time/reference; refresh labelled rule rows, not assumed effective permission. |
| INT-84 | 400 wildcard/private/invalid field errors linked by aria-describedby; no second example field in the real form. |
| INT-85 | GET canEdit=false; authorised read-only rows, name Owner/Admin remedy, no save affordance. |
| INT-86 | Revoked event/result, actor/time; no confirmation frame here. |
| INT-87 | 409 stale; Review their change reads current revision; never overwrite. |
| INT-88 | Lost save; GET original change, unknown row and full-width Check status. |
| INT-90 | Proven pre-append failure; explicit same-change retry only with evidence, destination-specific copy. |
| INT-91 | Missing silo/person/assistant destination rule or required data; link authorised policy view, no credential reconnect for egress. |
| INT-92 | Identity/policy/audit unavailable; safe unavailable state, not the exported secret-service claim. |
| INT-93 | Access/policy edit conflict; read current rules, retain/discard draft explicitly. |
| INT-94 | Page access revoked; clear protected rows and ignore late replies; role downgrade with retained read uses INT-85. |
| INT-95 | Unknown policy/operation outcome; same reference readback, no resend. |
| INT-96 | Checking/still unknown/confirmed saved/confirmed absent; only proved absence enables explicit retry. |
| WRK-95 | Chat egress records: running, installed/cloned with publication proof, refused, failed or unknown; wrapped tool lines above docked composer. |
| WRK-96 | Browser records: allowed, blocked redirect/subresource, unavailable, expired, ambiguous requester, disconnected; no navigation retry bypass. |
| WRK-52 | Existing POST view + view WebSocket; viewing/fit/zoom grants neither browsing nor keys. Full-screen computer on phone. |
| WRK-53 | View disconnect; reconnect checks view access, never restores browser permission. |
| WRK-54 | Computer unavailable; no pixels or browser token, no invented load result. |
| WRK-55 | View access loss clears pixels/late frames; egress-only loss may retain authorised viewing. |
| WRK-62 | #58 connected lease + browser binding; Return closes browsing through #58 before new agent work; external 44px Return/Ctrl+Alt+Esc. |
| WRK-69 | Lost takeover connection ends browser binding; reconnect is checked read-only view only. |
| OVR-20 | Existing history lists decisions/observations and safe references; stacked rows. Category/date/outcome filters are P4-27 work, not falsely supported by current API. |
| OVR-21 | History loading/empty/no matches; no fake receipts. |
| OVR-22 | Decision and observed tunnel/operation result kept separate; full-screen Back/detail on phone. |
| OVR-23 | Refused/not dispatched versus allowed/unknown; no automatic retry or invented monetary charge. |
| OVR-24 | Restricted resource, removed actor, missing correlation/receipt, stale evidence or revoked audit access; clear late protected data. |

At 390px use a 44px menu, labelled stacked rows, full-screen Back/Cancel and full-width
primary actions. Wrap hosts/references; keep focus visible, errors linked, composer above
keyboard and Return outside remote input. Announce once. Reduced motion freezes loops/
draws creases immediately. Correct export clipping; frames grant no permissions.

These are all additional screen families required here without an exact supplied frame.
Each prompt is ready to paste. UI PRs for gaps wait for the owner's handoff; back-end PRs proceed.

1. Destination revoke review, submitting and closure not yet confirmed:
   > Design destination revocation for an Owner/Admin. Show exact host/port, silo/person/assistant scope, actor, current revision and change reference. Include review, submitting, revoked, tunnel closure pending/unknown, stale policy and lost reply. Explain that new requests stop and active connections close; never promise undo of sent work. Confirm explicitly; Cancel saves nothing; Check status reads the same change. At 390px use a full-screen sheet, wrapped facts and full-width 44px actions. Reuse INT-82/86/87/88/96 and ModalSheet, DM Sans/Mono, teal #0db5cc, orange #f47920, ink #16191a, paper #fbfcfc, 12px dog-ear and focus #0a8497. Supply 1280, 390 and static reduced-motion frames.
2. The page inside desktop Chromium when blocked or browsing is off:
   > Design an OpenCrane-owned browser page for the requester and authorised desktop viewers. Include blocked navigation/redirect, unavailable policy, permission expired, unknown or ambiguous requester, disconnected control and budget stop. Use safe host/port, reason, checked time and reference; exclude URL queries, tokens and private identities. Explain the remedy without an Allow anyway button. Check status only reads; new browsing needs current permission. At 390px fit the page within the scaled computer view, wrap facts and keep 44px actions readable. Reuse WRK-52/62/69/96 and SharedState, DM Sans/Mono, teal #0db5cc, orange #f47920, ink #16191a, paper #fbfcfc, focus #0a8497 and 12px dog-ear; provide 1280/390/reduced-motion frames distinct from a chat tool line.
3. Desktop browsing owner selection and refusal:
   > Design explicit browsing ownership for current requesters sharing one computer. Show off, one eligible turn, several eligible turns, selecting, active owner, another owner, stale selection and unavailable context. Data: only readable conversation/turn labels, requester, generation, expiry, binding reference and canSelect; use Other work for restricted context. Select and confirm one turn, never pick the latest person; takeover uses its existing lease. At 390px use a full-screen review with stacked options and full-width 44px Confirm/Cancel; retain external Return control. Reuse WRK-60/62/69/96 and INT-87/88, DM Sans/Mono, paper, teal #0db5cc, orange #f47920, ink #16191a, 12px dog-ear and focus #0a8497. Supply 1280/390/static reduced-motion frames.
4. Egress operation detail and honest recovery:
   > Design package/Git/browser details for a requester or authorised participant. Show admitted, running, scanning, publishing, completed, refused, stopped, partial and outcome unknown. Data: safe operation name, host/port, limit reason, request/change references, evidence times, scan/publication receipts and safeToRetry. Explain disabled npm scripts/Git hooks and unsupported command forms. Distinguish tunnel opened from installed/cloned/page loaded; show no raw output, credentials or private repository paths. Check status reads, never repeats unknown work. At 390px use a full-screen Back drawer, stacked facts and 44px actions above the keyboard. Reuse WRK-04/31/32/95/96 and INT-19/95/96, DM Sans/Mono, paper, teal #0db5cc, orange #f47920, ink #16191a, dog-ear and focus #0a8497; supply desktop/390/reduced-motion frames.
5. Blocked subresources and WebSockets with an otherwise allowed page:
   > Design a safe browser notice and matching activity detail for the requester and authorised viewers when the page loaded but a redirect, image, script or WebSocket was refused. Include one/many blocked requests and permission lost while a page remains visible. Data: safe destination, initiator class, count, reason and evidence reference, never full URLs or content. Keep the allowed page usable only under current browsing permission; offer details/status, no bypass or automatic reload. At 390px use a compact wrapped notice outside the desktop picture plus full-screen Back detail and 44px targets. Reuse WRK-52/62/96 and WRK-04, DM Sans/Mono, paper, teal #0db5cc, orange #f47920, ink #16191a, focus #0a8497 and dog-ear; supply 1280/390/static reduced motion.
6. Destination policy permission summary and unavailable read:
   > Design policy facts for an Owner/Admin and a member viewing only their authorised rules. Show the separate silo, requester and assistant requirements, missing rule, saved but not yet acknowledged configuration, unavailable read, stale retained evidence and edit role lost while read remains. Data: safe host/port, permitted scope labels, current/applied revisions and checked time; never disclose other members' rules. Add/Edit saves one rule only; refresh reads, no permission bypass. At 390px use labelled stacked rows and full-screen editor, full-width 44px actions. Reuse INT-80/81/83/85/91/92/94, DM Sans/Mono, paper, teal #0db5cc, orange #f47920, ink #16191a, dog-ear and focus #0a8497; provide 1280/390/static reduced-motion frames.
7. Egress-specific audit detail:
   > Design egress history detail for a requester and an Owner/Admin with safe metadata access. Show policy save/revoke, admission/refusal, tunnel open/close, browser request report, operation publication, missing receipt and unmatched observation. Data: permitted actor, computer/generation, channel, host/port or digest, request/permit/operation/lease references, bytes, timestamps and close reason. Separate decision from transport and task completion; state TLS content is not recorded. Hide private paths, arguments, page content and tokens. Check status reads only. At 390px use OVR-20 stacked rows and OVR-22/23/24 full-screen Back/detail, 44px controls, DM Sans/Mono, paper, teal #0db5cc, orange #f47920, ink #16191a, dog-ear and focus #0a8497; supply desktop/390/static reduced-motion frames.

## Ordered PRs and failing-first evidence

Seven independently landable PRs from main, sequentially merged without stacks.
Server before screens; all #61 before #62, which also waits for #58.
Targets: #61 **1,480 lines** (1,100–1,500); #62 **1,080** (800–1,200), including all
hand-written additions/deletions. Re-estimate excess; never compress code or omit proof.

| Order / issue / lines | Whole landable outcome and failing-first tests |
| --- | --- |
| 1 / #61 / 330 | Policy commands, receipts/projection, egress binding/decision contracts and audit extensions; networking stays off. Fail exact scope intersection, stale CAS, wrong reused change id, lost reply past dedup TTL, cross-silo reads, removed member, malformed host/port, authoritative replay and long history before small checks. |
| 2 / #61 / 480 | Native gateway route and guarded pinned sockets with revocation/outage receipts; no command worker enablement. First fail pinned binary CONNECT/extAuthz/relay ordering, mixed/rebound DNS, every forbidden destination/protocol, secret stripping, same permit reuse, expiry/close and #55 final-dispatch race. Use recording upstream and real event store/gateway. |
| 3 / #61 / 410 | Confined supervisor worker, fixed npm/Git IPC and scanned publication; enable only after hardening/dispatch prerequisites and live isolation pass. First fail forged/missing executor binding, sibling-command IPC theft, arbitrary shell delegation, workspace escape, scripts/hooks/filters, licence/scan failure, quotas and killed-worker uncertainty. Prove real gVisor npm install and public HTTPS git clone, scan/publication receipts and unchanged S0.1b negatives. |
| 4 / #61 / 260 | Destination editor/status and WRK-95 using landed APIs, minimal scoped audit detail. Wait for prompts 1/4/6/7 handoff. First fail unknown-save resend, stale overwrite, 390px field/focus/role loss, partial publication labelled success and inaccessible detail/late response leakage; capture actual desktop/phone states. |
| 5 / #62 / 410 | Browser binding events and automation request checks consume landed #58 lease; desktop browser remains off until its launcher proof. First fail two live requesters, foreign turn/lease/epoch/generation, takeover intent versus queued automation, ended-turn request, replay reopening and revocation/outage/budget races. |
| 6 / #62 / 410 | Managed desktop/automation launch, interception, separate capabilities and closure proof. First fail subresource/redirect/socket/QUIC/metadata/MCP-secret escapes, service-worker/background reuse, same-host request after stop, late controller connection and release/reconnect restoration. Prove real gVisor Playwright command and desktop Chromium allowed-site journeys beside S0.1b/live-view controls. |
| 7 / #62 / 260 | WRK-96/view integration and browser gap pages/details from prompts 2/3/5 plus reused 4/7; wait for handoff. First fail ambiguous-owner affordance, blocked-page bypass, reconnect restoring browsing/control, TLS visibility claims, mobile Return/focus and restricted audit data. Add minimal journey evidence to existing runner. |

Every live negative gets a receipt: date, SHA/image digest, fresh environment, command,
expected/observed result, decision/observation ids, safe artefact and upstream absence.
Cover missing/forged/expired/foreign capability and wrong silo/person/assistant/computer/
generation/Pod/thread/turn/channel/destination; missing each rule; ended/revoked turn;
private/internal/metadata/mixed/rebound IPv4/IPv6, illegal port/redirect/tunnel/SNI;
socket/DNS/UDP/provider/local proxy/token theft; IAM/audit/decision/gateway/budget outage;
hard stop under queued/old permission; worker limits/scripts/hooks, unsafe packages and
scan/licence/publication failure; browser subresources/WebSockets, ambiguous ownership,
takeover release/expiry/disconnect/crash and replay. Assert zero upstream requests for
pre-dispatch refusals; sent work retains partial/unknown evidence and is never replayed.
Use real disposable NATS/PostgreSQL/OpenFGA/gateway, pinned gVisor and recording endpoints.
Use a fixture-controlled DNS/public-address setup without a production private-host exception;
keep transport pin tests separate from private fixture networking. No paid providers needed.
Journeys add **jente@elewa.ke as a separate owner user**, two distinct requesters and a
read-only participant. Owner status alone never grants requester browsing/control.
#63 repeats twice fresh, with every negative, rebuild, restart/Pod replacement and
1280/390/reduced-motion/accessibility evidence. Source substitutes stay NOT RUN live.
Each PR updates affected README/README.robot/diagram and branch-named release note.
Future lint/typecheck/test/check:events run under nice -n 10, outside live-view batches; two reviews max.

## Open questions and recommended defaults

- Executor binding: default fixed standalone forms with verified metadata and protocol
  replies. Prove on pinned Codex; missing binding refuses, never selects another live token.
- Gateway hooks: default prove relay selection/revocation in PR 2 before enabling. If
  impossible, our Node HTTP/CONNECT broker (AGPL-3.0-or-later, Node MIT) is the alternative;
  revise D25/estimate explicitly. No speculative proxy dependency or gateway upgrade.
- Confinement: default minimal CAP_SYS_CHROOT and inventoried runtime, no privileged Pod.
  Prove gVisor escape negatives, copy size and 512 MiB memory before enabling.
- Limits: default 300 seconds and 60-second capabilities; renew only before expiry under
  current checks, never keep a tunnel beyond actual expiry. Increase only with evidence.
- Ownership: default explicit single owner, off if ambiguous, lease after quiet proof.
  Idle lease uses its request reference; unproved browser request classes stay blocked.
- Packages: default pinned OSI packages, scripts off, existing dev ClamAV; refuse unknown
  licences/stale scans. Native builds stay socket-denied; production scanner is Phase 5.
- Fixtures: default unchanged public HTTPS policy, controlled DNS negatives and zero-cost
  public browsing site. Private fixture routes are test-only, impossible in customer policy.
- Scope: default seven PRs, 1,480 + 1,080 lines; revise budgets if reuse cannot fit.
  #200/#55/#58 are enablement dependencies. Open live/UI gates prevent a done claim.
- **MONEY OUTSIDE THE BOX:** default none. Hosted mirrors/scanning, paid sites/providers,
  cloud storage/compute and external design generation need recorded integer-cent allowance.
  #63's 500-cent provider envelope authorises none here. Dev PASS is not Helm/HA/production.
