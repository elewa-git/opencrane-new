# Take control only after every agent thread is paused

Design for [#58](https://github.com/elewa-git/opencrane-new/issues/58), Phase 3, D22. Read-only review on 10 October 2026. Checkout, origin/main and GitHub main all identified `d53e8e35aa949a9044685259eeda38540628d0c6`.
This note is the only output file. No product changes, tests, deployments, model calls or non-GitHub network
calls were made. Implementation and live qualification: **NOT RUN**. Estimates below are planning limits.

## Contract and existing behaviour

Only the current requester may control. First record computer-wide intent, stop every thread and prove local
execution quiet. Then record the lease and admit one writer. Close and prove writer access gone before
allowing explicitly requested, newly checked work. Disconnect, expiry, revocation or a crash leaves work
paused. Never replay a write.

Sources: docs/specs/phase-3/{tickets,decisions,spec}.md (P3-17/D22), docs/architecture/events.md,
AGENTS.md, plan.md, ADR 0006 and spikes/s0-5-live-view/README.robot.md. GitHub reads are linked below.

- [#57](https://github.com/elewa-git/opencrane-new/issues/57) is closed. Merged
  [#73](https://github.com/elewa-git/opencrane-new/pull/73) supplied the authenticated
  viewer; [#128](https://github.com/elewa-git/opencrane-new/pull/128),
  [#147](https://github.com/elewa-git/opencrane-new/pull/147), [#153](https://github.com/elewa-git/opencrane-new/pull/153),
  [#180](https://github.com/elewa-git/opencrane-new/pull/180) and
  [#211](https://github.com/elewa-git/opencrane-new/pull/211) refined unavailable checks,
  monotonic delivery leases, pause/replay and prompt denial. Their receipts include
  PARTIAL/NOT RUN conditions; closure of an issue is not new takeover evidence.
- [#59](https://github.com/elewa-git/opencrane-new/issues/59) is closed; merged
  [#112](https://github.com/elewa-git/opencrane-new/pull/112) and [#199](https://github.com/elewa-git/opencrane-new/pull/199) own screenshots. Keep their
  authorised capture/file path; takeover adds no image store or continuous capture.
- [#295](https://github.com/elewa-git/opencrane-new/pull/295) is merged. Participation
  periods and saved removals govern reads before OpenFGA catches up. Open draft
  [#318](https://github.com/elewa-git/opencrane-new/pull/318) also refuses removed then
  reinvited members at first/repeated turn admission and before queued bytes leave.
  Its fixes are proposed, not on this baseline; integrate after it lands, or retain
  equivalent active-membership refusal before enabling takeover.
- [#46](https://github.com/elewa-git/opencrane-new/issues/46) keeps approval holds bound
  to their original turn. [#55](https://github.com/elewa-git/opencrane-new/issues/55)
  owns the shared check immediately before dispatch. Its accepted defaults and
  [#56](https://github.com/elewa-git/opencrane-new/issues/56) preserve observed usage,
  held reservations and uncertainty. Reuse that check; do not build another stop engine.
- [#60](https://github.com/elewa-git/opencrane-new/issues/60) is closed and audit accepts
  `takeover.`. It currently discards the computer, lease, affected turns and timestamps;
  it also makes correlated non-decision events non-anchors. Prefix acceptance is not
  a complete takeover row. [#62](https://github.com/elewa-git/opencrane-new/issues/62)
  must consume this lease for desktop browsing; [#63](https://github.com/elewa-git/opencrane-new/issues/63)
  owns two fresh-install Phase 3 journeys, including all refusal sets.
- S0.5 proved one interrupted turn and requester input, with volatile identity/state.
  Multi-thread quietness/tools/crash recovery were NOT RUN. Its clipboard-enabled writer is narrowed below.

## Requester, commands and admission

The server derives identity from the signed session and member mapping. In an agent session, the latest
accepted human `message.posted` identifies the requester through `authorId`; bind its event id as
`requesterEventId`. Match any active `computer.turn_started.requesterId` to that event, as turns.ts and
bridge-conversation.ts already do. A finished request may identify the requester while idle; no human request
means no takeover requester. A newer request requires a new review. Never use assistant text, the latest token
on the computer, assistant ownership or an administrator role as a substitute. No delegation is introduced by
this ticket.

Require active event-backed silo membership, current participation/join, an open agent session, current
assistant/generation/Pod identity, OpenFGA read and post/actsFor rights, and the shared-desktop audience grant
with applied receipts. Unavailable authority grants nothing. Recheck requester identity and authority before
start, renewal and writer admission, including after a slow Pod connection. Removal followed by invitation
does not restore membership. A participant or owner without requester status is refused.

Read conversation history and request facts first, with their own ten-second deadline. Then open the
at-most-two-second `authorityFence` on exact small member, assistant, participation, relevant team/payer and
grant subjects. Check later requester/closure changes through the existing activity summary and bounded tail,
outside the authority watch list. No whole conversation replay inside this limit, wildcard reads, or new
computer/conversation subjects in a read-access fence. Leave authority.test.ts and authority-volume.test.ts
unchanged. Cold decision facts which cannot meet the gateway deadline return unavailable; a retry obtains
fresh facts, never a longer permission.

Put all takeover events on `computer-<assistantId>`, beside turn admission. A request command performs one
conditional append at the checked sequence. A racing new turn either committed before intent and joins the
pause set, or loses its append and is refused on reread. Two controllers, including two tabs belonging to one
member, cannot hold intent together. Capture all open turns from the authoritative computer summary; include
preparing bridge work, approval waits, restricted turns and queued old requests. The supervisor's actual
inventory must agree; a missing or extra running item prevents control. Do not discover threads by scanning
every conversation inside an access check.

Use one typed computer-control summary in libs/auth, exposed to server admission and decision activity.
Preserve it across generation replacement until checked recovery. Replace the current “anything except
computer.turn_ is lifecycle” selectors in computer-summary.ts, view-access.ts and bridge-conversation.ts with
the existing explicit lifecycle set. Takeover records must neither replace `computer.ready` nor close viewers.

Check the control state at message-to-turn delivery, first and repeated start/pass admission, local grant
installation/renewal, model/MCP/memory decisions and the final dispatch check. Approval decisions also inspect
this state: refuse approve/retry while paused; allow explicit denial/cancellation because it cannot dispatch.
Remove approvals.ts's blanket computer authority watch in favour of this separate typed activity check. Stop
and completion/effect receipts remain accepted while paused. New chat drafts stay editable but assistant sends
are refused; file capture/reads and authorised uploads keep their existing permissions, while delivery into a
running tool remains held.

The final dispatch check must serialise the intent append and the start of upstream transmission for each
computer in its existing single-owner process. A decision response or old reservation is not dispatch
permission. If intent wins, queued sends and delayed approval wakes are refused; if transmission began first,
record an already-dispatched effect and keep observing it. A check followed by an unguarded later send is
insufficient. Use #55's shared dispatch path for this ordering; do not enable writers while any currently
runnable caller bypasses it. #62 later adds lease-bound browser dispatch; its absent, denied browser path does
not create a circular blocker for #58. Process ownership loss denies sends until event catch-up. This is a
dev-stack single-owner contract, not a claim of Helm/HA.

## Pause proof, roles and isolation

The server owns event-backed decisions, authority, status and the authenticated proxy. The bridge owns Codex
interruption, report delivery and removal of per-thread grants and approval holds. The root supervisor owns
executor admission and proof of process exit. Desktop UID 1002 owns Kasm and the human browser; it grants no
model authority.

On committed intent, a reaction installs a deny-all-work gate at the bridge and supervisor before inspecting
work. Cancel preparing loads and late start acknowledgements; drop all local turn grants/catalogues and
approval holds before waiting for interruption. Send `turn/interrupt` to every known Codex turn. Wait for
terminal interrupted/completed notifications, confirm no preparing/running turn remains and confirm unloaded
threads. An interrupt RPC reply, `computer.turn_closed`, EOF or a lost socket alone proves nothing about the
executor's children. Late reports still retain the real outcome.

The supervisor stops accepting exec.sock/host.sock/private.sock launches. Close existing executor/host
connections, request termination, then verify every UID 1001 executor, code-mode host and descendant is gone,
including detached/reparented processes. Inventory process identities with PID and start time; do not trust a
shell's exit or process group alone. Use bounded same-UID termination helpers under existing SETUID/SETGID
permissions; CAP_KILL is absent and must stay absent. Recheck until no producer or child exists. Restricted
UID 1003 processes must also exit. Reuse #55's isolated-exit proof when landed. No new dependency or
privileged image capability is proposed. Keep image applications OSI-approved and OS packages in Debian main.
Retain Kasm GPL-2.0-or-later; exclude stock UI/artwork and non-free/contrib packages.

Terminate local Playwright/automation processes and close their browser/CDP connections. For the UID 1002
browser, prove no agent automation connection or queued input remains; do not kill Xvnc or an unrelated viewer
to establish this. Main desktop.ts only starts Xvnc; browser automation receipts must describe actual
processes, not assume a product browser controller exists. If disconnected automation can continue,
close/recreate that browser before granting control, or fail paused and require fresh-Pod recovery. Browser
network effects already sent are still external effects, not evidence that tools are quiet.

Obtain the final local receipt through a root-only supervisor control socket reached by the server's existing
namespace-scoped Pod exec transport. The receipt binds generation, Pod UID, takeover id, deny-gate epoch,
affected turn ids and empty execution/automation inventory. It is not supplied by the model or accepted from
an arbitrary bridge message. UID 1000 runs bridge/Codex/proxy, UID 1001 tools, UID 1002 desktop and UID 1003
restricted Codex; none gains access to this root socket. Keep tool-user.c's cleared environment,
socket-denying seccomp and no_new_privs. Avoid using the unauthenticated local POST /credentials route as
proof or control authority: README.robot.md records that gap. Writer enablement requires that local credential
replacement cannot forge bridge/control acknowledgements; harden the existing entry point before claiming this
isolation.

Persist the quiet receipt as `takeover.paused`, recheck current authority, then append `takeover.started`.
Only after that append may the supervisor open a requester transport. Keep the deny gate closed throughout
human control. Use a 30-second overall pause deadline, matching WRK-65; start cancellation within two seconds
and use the shared ten-second isolated-exit limit within it. Timeout/failure yields no writer and keeps the
gate closed. A late quiet reply cannot revive a failed attempt.

The browser never receives Kasm credentials. desktop.ts already creates `viewer` with
read permission and `requester` with read/write permission. Extend the private transport
to select requester only with a current lease and a single supervisor-owned writer slot.
Keep existing read-only transports independent. Admit RFB 3.8/None/shared handshake,
SetPixelFormat (type 0, 20 bytes, existing true-colour validation), SetEncodings (type 2,
at most 256 entries, force raw), FramebufferUpdateRequest (type 3, 10 bytes), KeyEvent
(type 4, 8 bytes) and standard PointerEvent (type 5, 6 bytes, bounded coordinates).
Do not negotiate Kasm's extended pointer or keyboard encoding. Refuse type 6 clipboard,
extended/binary clipboard, file transfer and every unknown extension before forwarding
any bytes, including fragmented/coalesced packets. Filter server clipboard too. Keep
4 KiB WebSocket messages, 8 KiB partial input and 4 MiB output/buffer bounds.

Bind lease and writer slot to silo, assistant, computer, generation, Pod UID, requester, conversation,
requester event, takeover id, writer session and proxy instance. One writer only, with a single-use
cookie/Origin-bound ticket redeemed within 15 seconds. Lease expiry is at most start + 120 seconds and no
later than login expiry. Explicit renewal rechecks the same requester/current rights and conditionally appends
a new expiry of at most now + 120 seconds. It cannot restore an expired/disconnected slot or change its owner.
Independent short access checks stop input within two seconds of revocation. Convert persisted wall expiry to
a conservative monotonic deadline; clock changes never extend it. The Pod relay has its own deadline/watchdog,
checked before each input send. The current desktop helper's fixed 120-second exit cannot support longer
renewed control: renew the existing supervised relay deadline only after the saved renewal is confirmed.

For #62, publish the exact lease/requester/conversation/generation as the sole human browsing context. Use a
separate desktop capability, never a turn token, caller secret or MCP profile. Revoke it before return/end;
refuse ambiguous agent browsing ownership. All browser traffic remains deny-by-default until #62 qualifies
that path. Desktop content, captions and pages are data and never instructions or permission evidence. Use
Tailscale serve on the tailnet, never funnel. Kasm has no public endpoint or Service.

## Events, state, replay and recovery

Reuse and extend `takeover.started`/`takeover.ended`; neither has an emitter on main. New emissions require
generation, conversation, requester, requesterEventId, takeoverId, leaseId and reason; keep
requestedBy/endedBy for compatibility. Started adds writerSessionId, proxyInstanceId, expiresAt,
quietReceiptId and affected turns. Ended adds startedAt, endedAt, requestedBy, closureReceiptId and whether
new checked work may be admitted. Read old registered shapes as unverified historical records: never derive a
writer from them. New commands use the full strict shape. Extend code and catalogue together.

| Event and emitter | Durable status and next action |
| --- | --- |
| `takeover.refused`, server command on `view-<attemptId>` | audit-only refusal; never changes an existing controller |
| `takeover.requested`, requester command | requested; deny new work; reaction installs local gates |
| `takeover.pausing`, server reaction after gate receipt | pausing; interrupt all work and obtain quiet proof |
| `takeover.paused`, server receipt command | paused; save quiet/closure proof, no writer by itself |
| `takeover.started`, server start command | writer connecting; saved lease permits one fresh connection |
| `takeover.writer_connected`, proxy receipt command | in control; physical connection confirmed, then enable input |
| `takeover.renewed`, requester command | same controller; confirmed new expiry, no new connection |
| `takeover.return_requested`, requester/system command | returning; stop input and close every writer transport |
| `takeover.ended`, server closure command | ended with reason; computer stays paused, checked new work may be allowed |
| `takeover.failed`, server reaction | failed attempt; paused, no writer, recovery required |
| `takeover.recovery_requested`, requester command | recovery intent; no writer, replace Pod and obtain fresh proof |

Refusal data exposes no protected computer/turn facts to the refused caller.
These extra types distinguish intent, physical proof, renewal and loss; started/ended alone cannot describe
them honestly. Each command appends once to the computer stream; reactions execute effects and submit separate
receipt commands. Use stable command ids derived from the trigger and transition, and verify identical retry
payloads even after NATS deduplication expires. Wrong reused ids, stale leases/epochs and conflicting renewals
return conflict. Append outages return unavailable, never an audited success.

Proposed HTTP: GET `/api/conversations/:id/takeover` returns status, control position,
server time, expiry, eligible actions, own affected turns and safe reason. POST the same path
accepts request with commandId, reviewed requesterEventId and generation. POST
`/:takeoverId/renew`, `/return` and `/recover` use command ids and checked lease/position.
All writes use session, Origin and CSRF checks. POST `/writer` redeems saved start into a
single-use ticket; `/ws/conversations/:id/control` carries RFB.
Use 202 for recorded work in progress, 400 malformed, 401 unauthenticated, 403 forbidden,
409 state/controller conflict and 503 unavailable. Lost replies lead to GET for the same
reference. GET never interrupts, opens a writer, renews a lease or repeats an effect.

Project control separately from lifecycle readiness, with computer-level phase, epoch, lease/expiry, affected
ids, quiet/closure receipts, end reason and recovery eligibility. Add a control position/status to existing
chat reads and realtime ready messages so every conversation on the computer updates even without a new
conversation event. Do not broadcast private titles, requester names or other conversations' turn details;
show “Other work on this computer” unless the viewer has current access to that data. SQL only stores/selects
projection data. Typed TypeScript decides transitions/access.

Replay rebuilds control and audit without opening tunnels, renewing capabilities, executing a turn or sending
approvals. A reconciler compares current intent with actual generation/Pod and starts with local work and
input disabled. Historical started records cannot recover writer sessions. Old pending/prepared messages
covered by the intent's event position and bridge inventory are permanently held/stopped, including those
never admitted as turns; bridge-conversation retry must not choose them after return. Record their terminal
reports/closures through the existing separate commands. A fresh explicit message gets a fresh turn/token; the
first checked computer.turn_started may clear a safe paused state by conditional append with the matching
control epoch.

| Failure interval | Required recovery |
| --- | --- |
| Before/after requested append or its lost reply | Read exact command; deny if unknown; no writer; committed intent is reconciled |
| Intent → gate receipt → pausing append | Starts remain blocked by events; reinstall gates; append failure leaves local gate closed |
| Pausing → interruptions → quiet/paused append | Repeat stop/proof only; keep effects observed/uncertain; never infer quiet from missing reports |
| Paused → started append | Failed/ambiguous append grants no transport; read it back; restart abandons old lease |
| Started → delayed upstream open → connected append | Recheck slot/epoch/authority/expiry; destroy late transports; failed receipt append closes them |
| Connected → first input or renewal append | Input needs both saved state and live proof; failed renewal never extends the old deadline |
| Return request append → transport shutdown | Disable input immediately on local fault; reconcile saved return; failed append cannot resume agents |
| Shutdown → closure proof → ended append | Close pending opens too; failed/unknown append keeps paused; GET resolves original command |
| Ended → fresh turn append → grant delivery | Recheck all authority/budget/control; lost pass never revives an affected old turn |

Destroy the browser writer, private Pod relay and upstream Kasm requester connection; prove no delayed open,
buffered input or pressed-key state can arrive later. Obtain a Pod-side closure/input-drain receipt before
ended or fresh execution. A proxy's socket close alone is insufficient. If Kasm cannot establish that receipt,
remain paused and use fresh-Pod recovery; do not invent a successful acknowledgement from logs. Unexpected
disconnect (including closing the viewer/tab), lease expiry, grant/requester revocation, proxy/bridge/Pod
crash, shutdown, protocol fault and generation change close control and durably end with that exact reason
when storage returns. Local watchdogs close first if append fails. Keep a failed end unconfirmed until its
receipt is stored. Proxy restart ends, rather than reuses, old leases; a fresh request is required.

Explicit return permits new checked work but starts no old turn automatically. Abnormal end requires checked
recovery. /recover is refused while another live lease exists; it appends takeover.recovery_requested, proves
old transport/Pod absence, then uses normal lifecycle reactions to create a fresh Pod, rotate credentials and
obtain ready/quiet receipts. Accept the owner's 10–14 second cold resume. Make its generation new: main
currently inherits the claim generation on normal resume, so update resume/credential verification and the
computers projection together for this recovery path, preserving old-event reads. No checkpoint/warm
attachment assumption. Save takeover.paused with recoveryFor and canStartNewWork only after the new ready and
quiet receipts. Keep paused until proof and an explicit fresh request. Budget exhaustion and member removal
remain independent reasons to refuse it.

Audit one anchor at requested, joining subsequent records by takeoverId as correlation.request. Special-case
this anchor in audit.ts; otherwise its request correlation hides it from lists. Record verified actor,
computer/generation, origin conversation, affected turn identities, requested/pause/start/writer-connected/end
times, expiry/renewals, receipts and end reason. Safe org history retains ids/counts and reasons; private
conversation names/text, arguments, screens, credentials and lease bearer values stay out. Requester history
lists only turns they may currently read. Denied intent and uncertain physical outcome are separate facts; do
not label takeover approval as an observed external write or settled spending.

## Screens and missing handoffs

Inspected the 1280/390 PNG pairs for WRK-56, WRK-60–71, WRK-62-RM and OVR-20–24, and both handoff READMEs.
PLAN.md's P3-17 row correctly says the control APIs need building. Use apps/web, not the obsolete
apps/opencrane-ui path in the exported README. Reuse LiveView, ModalSheet, HingeDrawer, SharedState, composer
and existing noVNC (MPL-2.0). WRK-50–55 retain P3-16 view admission, fit/zoom, access pause, denial and pixel
clearing. Never convert an open viewer into a writer by flipping only noVNC.viewOnly.

| Frames (each at 1280 and 390) | API/state mapping |
| --- | --- |
| WRK-56 | GET eligible=false for a participant; viewer/capture remain authorised |
| WRK-60 | GET review facts; confirm POST request; Cancel before append has no effect |
| WRK-61 | requested/pausing; authorised per-turn progress, no writer |
| WRK-62 | connected receipt + live writer proof; Return POST /return |
| WRK-63 | returning; input disabled while closure is proved |
| WRK-64 | ended/released, paused; Start new checked work focuses the retained draft |
| WRK-65 | failed/pause_timeout; no writer, Check status/recover before a fresh request |
| WRK-66 | 409 controller conflict; disclose “your other session” only when true |
| WRK-67 | 403 requester mismatch; preserve independently authorised viewing |
| WRK-68 | ended/expired, real expiry; no browser capability or resumed work |
| WRK-69 | ended/disconnected; Reconnect uses existing read-only view admission only |
| WRK-70 | ended/generation_changed; old canvas gone, new viewer needs fresh access |
| WRK-71 | unknown return acknowledgement; GET same reference, stay paused |
| WRK-62-RM | same proof as WRK-62, static orange border/rings, instant entrances |
| OVR-20 | existing conversation/org history APIs; takeover anchor with safe filters |
| OVR-21 | same reads: loading/empty/no matches; no synthetic success |
| OVR-22 | takeover decision, physical receipts and end facts in existing detail pattern |
| OVR-23 | refused takeover vs uncertain effect; link existing evidence, never resend |
| OVR-24 | restricted affected work, removed actor, missing receipt or revoked audit access |

At 390px use a full-screen computer/review overlay, labelled Back/Cancel, wrapped facts, stacked progress and
full-width primary actions. Keep all targets at least 44px and Return control outside remote input, reachable
by Ctrl+Alt+Esc. Closing control returns focus safely and ends its lease. Preserve draft/composer above the
keyboard. Announce phase changes once, not countdown ticks. Reduced motion changes no security behaviour.

The following are all additional screen families required by this design with no exact frame. Each quoted
prompt is ready to paste; request 1280, 390 and 390 reduced-motion frames. UI PRs for these gaps wait for the
owner's handoff; back-end PRs can proceed.

1. Lease remaining and renewal, including refusal/unknown reply:
   > Design control time and renewal for the current requester. Show lease time left, real expiry, renewing, renewed, refused and acknowledgement unknown from leaseId, serverTime, expiresAt and safe reason. Renew explicitly; Check status reads the same command; Return stays available. At 390px stack time and full-width 44px actions above the desktop, with no horizontal scroll. Reuse WRK-62/68/71, DM Sans/Mono, teal #0db5cc, orange #f47920, ink #16191a, paper, dog-ear and focus #0a8497. Add static reduced motion; never announce each second.
2. Another conversation paused by someone else's takeover, including composer:
   > Design a computer-wide pause notice for a participant/requester in another conversation. Show requested, pausing, another person in control, returning, ended and recovery required using control phase, permitted actor label, computer label, reason and canStartNewWork. Never reveal an inaccessible conversation title or turn. Keep the draft editable, disable assistant Send and Approve with the reason, retain authorised read-only viewer/screenshot and explicit Deny. At 390px put an amber-bars notice above the docked composer, wrap names, use 44px actions and no keyboard overlap. Reuse WRK-12/44/56/64, Workspace Live/8j, DM Sans/Mono, orange/teal/ink, paper and focus tokens; freeze motion.
3. Writer connecting after quiet proof, including late cancellation:
   > Design the current requester's connection wait after all threads are quiet. Show connecting, taking longer, cancelling and connection failed from phase, quietAt, expiry and reason. Say control is not ready; admit no keys. Offer Return/Cancel and Check status of this reference, never a second writer. At 390px stack the progress below the computer header with full-width 44px controls outside the picture. Reuse WRK-61/63/65/71 and WRK-62's desktop, DM Sans/Mono, teal/orange/ink, paper and focus tokens; static reduced-motion rings.
4. Lost request/recovery reply and unavailable control status:
   > Design honest status checking for a requester whose takeover or recovery reply was lost. Show checking, saved and pausing, confirmed absent, still unknown and service unavailable from commandId, confirmed phase, evidence time and safe reason. Check status never repeats intent or keys; only confirmed absence enables an explicit same-command retry. At 390px use a full-screen sheet, wrapped reference, 44px Back and full-width actions. Reuse WRK-71, OVR-21/24, SharedState's question ring/dog-ear, DM Sans/Mono, teal/ink and focus tokens; freeze loops.
5. Control revoked while viewing is still allowed:
   > Design loss of control for a former requester and a retained read-only participant. Show requester changed, control grant revoked and full view access revoked separately using canView, canControl, reason and end time. End keys immediately; retain pixels only with current view access, otherwise clear them and late frames. Offer checked read-only viewing, never renewal of the old lease. At 390px wrap the notice under the computer header with 44px actions. Reuse WRK-55/56/67/68, lock glyph, DM Sans/Mono, orange/teal/ink, paper and focus tokens; static reduced motion.
6. Quiet proof unavailable/browser still active and cancellation before control:
   > Design pause failure for a requester, including automation still stopping, unavailable supervisor proof and cancellation before any writer. Show own permitted thread rows, safe hidden-work label, elapsed time, proof state and reason. Never say quiet or nothing changed without evidence. Check status observes; recovery is explicit. At 390px stack rows and full-width 44px actions. Reuse WRK-61/65/71, amber bars/question ring, DM Sans/Mono, orange/teal/ink, paper/dog-ear and focus tokens; freeze progress motion.
7. Fresh-Pod recovery review, progress and ready-but-paused:
   > Design safe computer recovery for the current authorised requester after abnormal control loss. Show review, replacing computer, 10–14 second cold startup, proof unavailable and ready with agent paused from old/new generation, reason and canStartNewWork. Explain that unsaved desktop state may be lost; preserve the draft and never resend approvals/writes. Recovery is refused during another live lease. At 390px use a full-screen review/progress sheet and a notice above the keyboard-docked composer, 44px Back and full-width actions. Reuse WRK-60/64/70/71, DM Sans/Mono, teal/orange/ink, paper and focus tokens; static reduced motion.
8. Takeover-specific audit detail and restricted affected-turn list:
   > Design takeover history for a requester and an owner/admin viewing safe metadata. Show requested, quiet proof, control started/connected, renewals, end reason, unknown closure and restricted turns using actor, computer/generation, allowed turn ids/counts, timestamps, lease reference and receipt state. Keep decisions and observations distinct; omit private titles, text, arguments and tokens. Check status only reads. At 390px reuse OVR-20's stacked rows and OVR-22/23/24's full-screen Back/detail layout, 44px actions, DM Sans/Mono, paper/dog-ear, teal/orange/ink and focus tokens; freeze motion.

## Ordered delivery and failing-first evidence

Five sequential PRs from landed main, no stacks or consolidation PR. Budget 1,430 changed hand-written lines
including tests, schemas, migration/docs and release notes; none over 600. Reuse existing fixtures/helpers
rather than rebuilding their transports. These are estimates, not permission to compress code or omit proof;
reconcile measured size before building. Required lint/typecheck/test/check:events and relevant web checks run
under nice -n 10, outside a live-view qualification batch. At most two independent review passes.

| PR / lines | Independently landable outcome and failing-first proof |
| --- | --- |
| 1 / 300 | Typed control events/summary, intent/status, admission and audit fields. Writer absent. First fail two-conversation/new-turn CAS, two-controller intent, old-token/late-approval refusal, removed/reinvited member and projection replay; assert unchanged viewer delivery and no lifecycle corruption. |
| 2 / 420 | Root supervisor/bridge quiet and closure receipts, local gates and hold cancellation; still no writer API. First fail a real running exec-server child, detached descendant, code-mode host and automation after interrupt; include late preparation/grant, unavailable proof, supervisor forgery and crash at every pause transition. |
| 3 / 360 | Requester writer, lease/renewal/return, abnormal end and fresh-generation recovery; enable only with shared final-dispatch guard and local hardening qualified. First fail raw input from viewer, clipboard/file refusal, two writer sockets, delayed writer after return/expiry, revocation, watchdog/proxy/Pod crash, append outage at each transition, close-before-new-turn and never-resend assertions. |
| 4 / 200 | Existing WRK takeover frames using landed APIs and shared components. First fail no-control-before-connected, persistent keyboard Return, status-only lost return reply, read-only reconnect, 390px focus/draft retention and reduced motion. Keep WRK-50–55 and screenshots working. |
| 5 / 150 | Owner-supplied gap variants and takeover audit detail, reusing PR 4 states; minimal journey extension. Wait for handoff. First fail renewal expiry/unknown acknowledgement, other-conversation composer, restricted audit turns and late access-loss response; capture desktop/390/reduced-motion comparisons through actual APIs. |

PR 1–3 evidence uses real NATS/PostgreSQL/OpenFGA/gateway/socket fixtures and recording upstreams;
process/desktop claims additionally require the real pinned gVisor image. Parameterise crash injection at
every arrow in the recovery table, before and after each append/receipt/open/close; assert no overlapping
agent/human input at Xvnc, no second writer and exact upstream counts. Replay projections while upstream
counters stay fixed. Journeys add **the privately configured owner test user as a separate owner user**, beside requester A, requester B
and a read-only participant; an owner cannot control without requester rights. Do not merge identities or use
an owner session as the requester fixture. Run two active conversations on one computer, with a local tool and
pending approval, through takeover, renewal, explicit return, disconnect and recovery. #63 repeats this twice
fresh and records SHA/image digests, commands and PASS/FAIL/PARTIAL/NOT RUN; UI fixtures alone are not a
capability PASS. Each PR includes its branch-named changes/unreleased note and updates affected package
README/README.robot contracts and diagrams when needed.

## Open questions and recommended defaults

- Current requester while idle: use the latest accepted human request event, bound to
  review; no request means refuse. Confirm this default before exposing the idle action.
- plan.md permits delegated control, while D22/#58 require requester-only. Follow the
  explicit task: no delegation; align plan.md in the implementation's documentation.
- Pause/closure proof on pinned gVisor/Kasm: no new capability/dependency; use same-UID
  termination and root receipts. If complete process/input-drain proof fails, offer
  explicit fresh-Pod recovery and keep control disabled until it passes. Unsaved forms
  are not promised to survive. Do not lower proof to meet the line estimate.
- Shared dispatch guard/local credential hardening are unfinished on this baseline.
  Back-end contracts/proof PRs proceed; writer enablement waits for their actual guards,
  not issue labels. Coordinate #55/#46/#62 and #318 rather than copying their engines.
- Who may recover after requester removal: another current requester with current
  assistant/desktop rights may recover ended control from their own conversation;
  owner/admin status alone grants no control. No forced eviction of an active lease.
- Renewal: explicit button, each extension at most two minutes, no silent renewal or
  reconnect restoration. Lease cap is per extension; login expiry remains an upper bound.
- PR size: target 1,430 total; if clear implementation exceeds it, return a measured
  scope/budget revision before building excess. Never hide extra tests or prerequisite
  changes from the count. Helm/HA, new browser tooling and general audit restyling stay
  in their existing tickets. Dev stack first, mobile by default, minimal SQL.
- **MONEY OUTSIDE THE BOX:** default none. Use local recording model/tool providers and
  the existing synthetic Odoo. Paid-provider qualification, cloud compute/storage or
  external SaaS design calls require separate owner authorisation; #63's shared
  500-cent provider envelope is not authorisation for this design or its proposed PRs.
