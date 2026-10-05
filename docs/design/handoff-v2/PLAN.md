# Claude Design v2 UI integration plan

4 October 2026. Seams are confirmed. This plan covers all 380 named states in the
[ten handoffs](README.robot.md), including their 1280px, 390px and reduced-motion views.
It specifies Angular work in `apps/web`; the handoffs' `apps/opencrane-ui` name is
obsolete. Designs are references, not evidence that a capability works.

The [Phase 3 tickets](../../specs/phase-3/tickets.md),
[Phase 4 spec](../../specs/phase-4/spec.md),
[tickets](../../specs/phase-4/tickets.md) and
[decisions](../../specs/phase-4/decisions.md) own behaviour. Follow the
[engineering standard](../../process/standards.md) and
[owner's style](../../../AGENTS.md#style): small named functions and components,
clear inputs, installed dependencies first, no generic screen builder, workflow
engine, policy language or second mutation ledger. Commands remain HTTP;
conversation updates use the existing position-based WebSocket service.

## Baseline and API status

Inspected import commit `d46efcad2516fc788a6041682749f41452368ef4` on
`work/design-handoff-v2`, server route registrations and their handlers, and the
current Angular shell, workspace, approvals, models, tool policy, audit,
MCP installer, live view, file preview and fold loader. There is no separate
`org-admin` Angular directory: that shell and integration register live in
`app.ts`, `app.html` and `app.css`.

**Exists** below means a callable source contract in this checkout, not a live
qualification claim. **In review** means PR #114, inspected at
`655cd5dfca44d7eeb757a272fb0ff5be3583b4c8`; it is open and not merged.
**Branch available** means the P4-1 backend at
`05db5bb3d5d0d90d754b3c6ae6d266d07512d6b6` on `work/p4-1-groups`; no open PR was
listed for that branch at inspection. **Needs building** means the required
browser contract is absent here, even where events, internal helpers or another
unfinished branch exist. Recheck branch status when starting implementation.

| API key | Current browser contract and status |
| --- | --- |
| A: identity | **Exists:** `GET /auth/me`, `/auth/login`, `/auth/callback`; `POST /auth/logout` ends the current session. `POST /members/join` accepts a verified invitation. No general people directory, invitation administration, account edit, onboarding or global sign-out API. |
| C: chat | **Exists:** `GET /api/chat`; `GET/POST /api/conversations`; `GET/POST /api/conversations/:conversationId/messages`; position-based WebSocket replay. Creation currently requires an assistant and refuses direct/group modes. Stop uses the existing chat command path. Server-backed archive/unread, human participants, child creation/publication, root trees and memory recovery need extending. |
| Q: approvals | **Exists:** `GET/POST /api/conversations/:conversationId/approvals`. GET supplies cards and CSRF; POST sends only `approvalId` and `decision` with Origin and `X-CSRF-Token`. Requester-only, with 428 for required sign-in step-up. Approval is separate from proof that the external effect happened. |
| I: integrations | **Exists:** `GET/POST /api/org/integrations` (remote registration); `GET /api/org/integrations/discovery?locator=…`; `GET /api/org/integrations/:serverId/discovery`; `GET/POST /api/org/integrations/:serverId/tools` (reviewed per-tool modes). No complete publish/grant/removal, hosted admission, drift, credential profile or destination-policy browser contract in this checkout. |
| B: budgets/models | **Exists:** `GET /api/org/models` returns registry, task routing, price table and budget summary; POST forwards an integer-cent budget command with `commandId`, `expectedSequence`, scope and applicable ceiling/default-payer fields to the existing actor. This is not a provider-key lifecycle API. Root/routine joins and personal default-payer editing need work. |
| H: history | **Exists:** `GET /api/org/history` and `GET /api/conversations/:conversationId/history`. Filters are `before`, `requestId`, `turnId`, `decision`; rows distinguish decision and outcome, with safe records and optional cents. No general overview task endpoint or arbitrary change-id lookup. |
| V: computer/files | **Exists:** `POST /api/conversations/:conversationId/view`, then `/ws/conversations/:conversationId/view` with the returned ticket; read-only proxy. `POST /api/conversations/:conversationId/screenshots` takes no body, Origin, `x-opencrane-view: 1` and `idempotency-key`. `GET/POST /api/conversations/:conversationId/files`; `GET /api/conversations/:conversationId/files/view?path=…&preview=true`. `GET /api/org/computers` is an admin inventory, not takeover authority. |
| E: effects | **In review:** [PR #114](https://github.com/elewa-git/opencrane-new/pull/114), `GET /api/org/effects`, `GET /api/org/effects/:permitId`, `POST /api/org/effects/:permitId/resolve`. Read the [branch HTTP contract](https://github.com/elewa-git/opencrane-new/blob/work/p3-15-reconcile/docs/process/p3-15-reconcile.md). Owner/Admin only; monetary reconciliation, not an Odoo retry/readback endpoint. |
| G: groups | **Branch available:** `GET/POST /api/groups`, `GET/POST /api/groups/:groupId`, `GET /api/groups/:groupId/changes/:commandId`. Read [docs/api/groups.md on its branch](https://github.com/elewa-git/opencrane-new/blob/work/p4-1-groups/docs/api/groups.md) and `apps/server/src/members/group-routes.ts` there. All reads and writes require Owner/Admin; no general member search. |

Future API descriptions in the ticket tables name the owning capability, not
invented URLs. The owning feature must supply a typed browser contract, status
read and refusal semantics before its controls become operational. Internal
MCP/gateway interfaces must not be exposed as browser shortcuts.

## UI foundation

### Shells and existing screen moves

Keep standalone Angular components and the existing signal-based state. Extract
responsibilities from `App` rather than reproducing its pathname conditions in
every screen. Preserve existing links and refresh/deep-link behaviour. Use a
small explicit page selection table; no new navigation framework is needed just
to move these screens. Retain full-page, immutable-id child links when P4-9 lands.

| Component | Inputs and outputs | Responsibility |
| --- | --- | --- |
| `OrganisationShell` (`oc-organisation-shell`) | Inputs `activePage`, `organisationName`, `viewer`, `navigationAccess`, optional `attentionCount`; projected page content | 220px desktop sidebar, brand, organisation, ordered navigation, viewer and Back to workspace. Current page uses `aria-current="page"`. `navigationAccess` contains server-supported visibility/read-only information, never inferred grants. |
| `PersonalSettingsShell` (`oc-personal-settings-shell`) | Inputs `activePage`, `viewer`, `workspaceHref`; projected page content | 232px desktop sidebar replacing the workspace rail, visible Back to workspace, Account, Preferences, Assistant, My tools. No composer or admin navigation inside it. |
| `NavigationMenu` (`oc-navigation-menu`) | Inputs `open`, `label`, `items`, `activeHref`, `returnFocusTo`; output `closed` | One left-hinged mobile navigation overlay for workspace, organisation and settings. Items are labelled destinations with optional evidenced count/read-only text. Native links remain links. |
| Existing `Workspace` | Keep its `ChatSession` ownership; add mode/selection inputs only with the owning feature | 236px rail, 56px header, transcript maximum 780px, docked composer, optional 300px Files/Activity panel. Keep approvals above the composer and Activity links to transcript entries. |

Organisation navigation, in order, is **Overview, People & groups, Models &
providers, Spending, Integrations, Routines, Change history**. Remove Skills &
workflows entirely. Suggested page addresses extend the existing `/org` family:
`/org/overview`, `/org/people`, `/org/models`, `/org/spending`,
`/org/integrations`, `/org/routines`, `/org/history`. These are UI addresses,
not proposed API routes. `/org` can resolve to Overview once its page is available.
Until then it must resolve to an implemented page, not sample task data.

| Current screen | Destination and retained behaviour |
| --- | --- |
| Integration register inside `App` | Extract `IntegrationRegister` under Organisation → Integrations; retain All / Needs attention / Pending review and last-loaded timestamp. |
| `McpInstall`, `ToolPolicyScreen` | Integrations add/review/detail; preserve existing `/org/integrations/new` and `/:serverId/tools` links. Extend the same installer and mode editor. |
| `ModelsScreen` | Move budget summary/editor to Spending; keep registry/routing under Models & providers. Keep API B unchanged during the move; do not duplicate the budget editor. |
| `AuditScreen` | Organisation → Change history; conversation `/history/:conversationId` remains a workspace-scoped Action history view, not an admin route. |
| `Workspace`, `ApprovalCards`, `LiveView`, `FilePreview` | Stay in workspace; adopt common paper, state and overlay primitives. Screenshots remain normal conversation files. |
| Current `/account` link and Settings rail entry | Route account to Personal settings → Account instead of falling through to sign-in. Preferences, Assistant/persona and My tools are added by their feature tickets. Keep a separate authorised organisation-settings link. |
| `SignIn` | Stays outside both shells; existing SSO routes remain. Survey/welcome use the ONB bare/workspace anatomy with no ordinary model/participant controls. |
| Existing `/org/states` view | Reuse as the foundation's state specimen and comparison surface; no new component gallery application. |

At 390px, use the handoff's 56px top bar and a minimum 44×44px menu button.
Organisation/workspace place the menu button on the left. Settings keeps Back
to workspace visible on the left and its menu button on the right (ONB-50).
The open navigation occupies the available phone viewport, with labelled close
at the top (OVR-08); it is not a narrow desktop sidebar squeezed over the page.
Close after navigation or Escape and restore focus to its trigger. Use
`aria-expanded` and `aria-controls`, an inert background and a focus trap while
open. Arrow keys move between menu destinations; Tab can reach Back/Close.

Keep existing content-driven breakpoints (the workspace panel already becomes an
overlay below 1100px); qualify 390px and intermediate widths rather than copying
the frame's fixed canvas heights. Tables become labelled stacked rows using
semantic table/list markup, not a generic data-grid package. Detail, review,
editor, computer and file panels fill the phone viewport with an explicit Back
button. Primary actions span the width; every phone target is at least 44px.
Wrap long names, references, breadcrumbs and consequences without page-level
horizontal scrolling. The chat composer stays above the actual keyboard and
safe-area inset; never render the design's illustrative keyboard. Admin and
personal settings have no composer.

### Paper, origami and tokens

Extend `src/styles.css` and `src/chat-motion.css`, reusing their fonts, colour
variables and keyframes. Extract the existing rice texture once as a local asset
if needed; do not copy `support.js`, inline design templates or base64 blobs into
each component. Preserve existing logo/icon assets. No dependency is needed.

| Token family | Build values and use |
| --- | --- |
| Type | Existing DM Sans 400/500/600/700 for UI and DM Mono for identifiers/tool names; 15px root, 13–15px body, 12–13px supporting text, 24px page heading at weight 600. Retain installed font packages. |
| Paper | `--oc-surface-canvas: #eceff0`, paper `#fbfcfc`, raised/card/sheet `#fff`, rail `#eef1f2`, subtle `#f1f4f5`; borders `#d9dfe0`, rows `#e1e6e7`, inputs `#c9d1d2`. |
| Ink | Strong `#16191a`, body `#2b3133`, muted `#4f575a`. Replace lighter inherited admin text where it fails the v2 rule; minimum text contrast 4.5:1. |
| Signals | Teal `#0db5cc`, focus `#0a8497`, orange `#f47920`, success `#2a7d4f`, error `#c1392b`, amber text `#8a5d1f`; notice fills teal `#f2fbfc`, amber `#fff8ef`. Orange/teal decoration is not low-contrast body text. |
| Geometry | Org/settings/workspace rails 220/232/236px; header 56px; transcript 780px maximum; workspace panel 300px. Page padding 28px 32px desktop and 18px 16px phone; spacing steps 4/8/12/16/24/32px; card radius 12px, button/input radius 8px. |
| Folds | `--oc-dogear-size: 12px`; crease 1px `#cdd4d5` over 1px white; drawer crease shadow 16px. Texture opacity `.42`, tile 280px, brightness 1.06 and contrast 1.08 from source. |
| Motion | Existing fold easing `cubic-bezier(.32,.72,0,1)`; completion crease 600ms; drawer hinge 420ms from current motion; Flutter 1.6s; Grain 1.4s. Retain #72 Folding timing and geometry. |
| Focus | `2px solid #0a8497`, offset 2px on every interactive element; never clip/remove it to achieve the folded edge. |

The handoff notes specify a 12px dog-ear throughout; some source render helpers
use larger corners on sheets. Use the shared 12px token as the documented rule,
not separate per-screen variants. This is a visual normalisation, not behaviour.

| Reusable Angular piece | Inputs and outputs | Implementation boundary |
| --- | --- | --- |
| `PaperSurface` directive (`[ocPaperSurface]`) | Input `ocPaperSurface: 'main' \| 'plain'` | Texture only on main surfaces, decorative pseudo-element with no pointer events; cards/panels/sheets plain. Reuse on existing semantic elements. |
| `DogEar` directive (`[ocDogEar]`) | Boolean input `ocDogEar`, default true | Decorative 12px top-right folded corner on facts, money, quotes, files, child summaries, selected options, unknown notices and modal sheets. No semantic or state logic. |
| `Crease` (`oc-crease`) | Inputs `complete`, optional `label` | Divider/completion line; animate once on a new completion, not every render/reconnect. Decorative unless it is the sole completion label. |
| `HingeDrawer` (`oc-hinge-drawer`) | Inputs `open`, `title`, optional `description`, `returnFocusTo`; output `closed`; projected body/footer | Right-edge drawer with 16px crease shadow on desktop; full-screen phone detail/review. Owns overlay focus and dismissal, not submission or HTTP calls. |
| `ModalSheet` (`oc-modal-sheet`) | Inputs `open`, `title`, optional `description`, `returnFocusTo`; output `closed`; projected body/footer | Lifting plain paper sheet with dog-ear. Use existing native `dialog` for modal focus/background behaviour; full-screen phone sheet with Back. |
| Existing `FoldLoader` (`oc-fold-loader`) | Retain no required inputs and decorative `aria-hidden` | Reuse #72 without rewriting the folding geometry. Caller supplies “Folding…” or “Writing…” and the one progress announcement. |
| `FlutterLoader` (`oc-flutter-loader`) | No required inputs; decorative | Small 10×9px teal triangle in a rail row or status with active work; reuse `oc-flutter`. Caller supplies words. |
| `GrainLoader` (`oc-grain-loader`) | Inputs `width`, `height` | One skeleton bar, `aria-hidden`; parent owns `aria-busy` and loading words. Repeated bars stay in their owning template. |

Implement overlay mechanics once and use them in both drawer and sheet; favour
small shared focus functions over a new overlay service/framework. Escape and
Back close without submitting. Capture the opener before showing; start modal
focus on the labelled title (`tabindex="-1"`), trap it, and restore the opener on
close or a surviving page heading after that opener is removed. Closing a
pending form does not cancel an accepted server command or lose its reference.

Reduced motion uses `prefers-reduced-motion`, applying to all states, not just
`-RM` examples. Entrances are immediate; spinner is a static ring, Flutter a
still triangle at 60% opacity, Folding retains its existing static folded pose,
Grain is a flat bar and caret stays solid. Creases are fully drawn; no overshoot,
shake or smooth scrolling. The v2 notes call Folding a paper square, while #72
ships a hinged triangular form: retain the explicitly accepted existing loader.

### One state vocabulary and accessible feedback

Extend existing `SharedState` (`oc-shared-state`), not a second status badge.
Keep inputs `kind`, `message`, `detail`, `actionLabel`, `safeToRetry`, `showAction`
and output `action`; add `evidenceAt`, `timestamp`, `changeReference` and
`announce` (false by default for repeated rows). Map existing `draft` and
`needs_input` to one visual family, and legacy `disabled` to removed where the
server actually means removed. Add paused, blocked and waiting presentation
values without renaming persisted business events. Each owner maps its domain
state explicitly; an HTTP success alone never means Ready.

| Visual family | Glyph and words | Required evidence/action |
| --- | --- | --- |
| Not configured | Empty ring + Not configured | Say what is missing and who can configure it. |
| Draft / needs input | Orange dot + Draft or Needs input | Name missing fields/consent; distinguish saved draft from unsent input. |
| Applying / checking | Ring spinner + Applying or Checking | Disable duplicate submission; keep original command reference. |
| Ready / confirmed | Green check + Ready or Confirmed | Dated evidence for the particular fact; an append acknowledgement is insufficient for asynchronous completion. |
| Failed, nothing changed | Red × + Failed — nothing changed | Only server-established safe failure gets “Try again”; do not infer safety from network/HTTP failure. |
| Outcome unknown | Question-mark ring + Outcome unknown | “Check status” reads the original operation. Never resubmit an external effect. |
| Access changed | Lock + Access changed | Clear protected data and drafts, terminate subscriptions, ignore late replies and revoke object URLs/pixels. |
| Paused | Amber bars + Paused | Explain current cause and authorised resume path; never automatic replay of effects. |
| Blocked / refused | Struck circle + Blocked or Refused | Name safe reason/remedy without suggesting a permission bypass. |
| Removed | Dash + Removed | Retained history is explicit; re-setup is a new reviewed action. |
| Waiting / scheduled / expired | Clock + the precise word | Real timestamp with timezone; no invented expiry, retry count or countdown. |

Use one polite status region per operation/container and announce once at start
and once at result. Do not let a nested `SharedState` and its parent both
announce. Set `aria-busy` on loading regions; preserve headings and focus during
refresh. Do not make the streamed transcript, evidence body, secret input or
forgotten text a live region. Sanitised progress words can be announced even
when sensitive details cannot. Glyphs are decorative; visible words carry meaning.

Use labelled native fields and buttons, `aria-describedby` for errors, and a
read-only field's source in text. On submit failure focus the error summary or
first invalid field. Tabs/radios/segmented choices have arrow-key navigation;
Enter/Space activate the focused control. Tab order follows navigation, header,
main content, panel/overlay actions, then composer. Composer Enter sends and
Shift+Enter inserts a line. Approval buttons must be explicitly selected;
a generic Enter on an approval panel must never approve. Keep Stop reachable.
Remote desktop keys are forwarded only under confirmed control; Return control
and Ctrl+Alt+Esc remain outside the desktop. Captions describe a saved screenshot's
metadata, not invented image contents.

### Foundation PR split

Estimates include hand-written templates/styles, relevant tests and docs; each
whole outcome targets fewer than about 1,500 added/deleted lines. Merge serially,
with at most two PRs in a stack. These are reusable presentation outcomes,
not claims to finish their consuming product tickets.

| PR | Whole outcome and first consumer | Estimated changed lines |
| --- | --- | ---: |
| F1 | Tokens, paper directives, crease, eleven-state `SharedState`, Flutter/Grain and existing Folding integration; upgrade `/org/states` and current loading/status call sites. | 800–1,200 |
| F2 | Accessible `HingeDrawer`, `ModalSheet`, mobile `NavigationMenu`; replace existing file/live-view overlay framing and workspace menu mechanics. | 850–1,300 |
| F3 | Organisation shell v2, extract current integration register, move budget UI to Spending and preserve models/tool/audit routes. Unavailable feature destinations carry truthful availability rather than sample pages. | 1,000–1,450 |
| F4 | Personal settings shell and working workspace/account entry/Back navigation; show only existing identity data and explicit unavailable entries until P4-18/profile APIs land. | 500–850 |
| F5 | Workspace presentation reuse: small `ToolActivityLine`, `ConversationFileCard` and `BudgetStopNotice`; shared states/paper/loaders, phone panel/composer and existing approval framing. Keep domain mutations in current owners. | 850–1,350 |

F1 precedes F2; F3 and F4 consume F1/F2; F5 completes the shared workspace
presentation. Implement only components used by these outcomes. Other components
below arrive in their first feature PR, not an upfront library. If a measured diff
exceeds the estimate, narrow to another complete visible outcome before building;
never compress code or defer its failure/access states to a clean-up PR.

## Ticket-to-state and API map

Ranges below are inclusive **only over ids present in that handoff's README**;
there is no INT-09, for example. `-RM` is listed explicitly, not implied by a
numeric range. Repeated ids are deliberate shared states/dependencies. Every row
uses the foundation's `SharedState`, paper/tokens, keyboard and responsive rules;
its Components column names additional domain pieces. API keys refer to the
exact routes/status above. Gaps are binding limitations, not invitations to invent
behaviour. A frame containing several outcomes must exercise each one.

### 01-int — Integrations and My tools

Reference: [handoff and full state names](01-int/README.robot.md).
`IntegrationRegister` takes `rows`, `loadState`, `loadedAt`, `selectedFilter` and
emits `filterChanged`, `refreshed`, `opened`. `IntegrationFacts` takes four
independent evidence records. Extend `McpInstall` with `serverId` and its existing
source/review state. `ToolPolicyScreen` keeps `serverId`; extract `ToolModeChoice`
with `mode`, `disabled`, `toolName` and `modeChanged` only when reused.
`ConnectionProfileForm` takes `connection`, `accountModel`, `requiredScopes`,
`status`; emits typed connect/replace/revoke intent. Secrets remain transient,
masked and never read back. `AccessGrantEditor` takes `resource`, authorised
`candidates`, `grants`, `revision`, `canEdit`; emits reviewed grant changes.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P3-4 [#45](https://github.com/elewa-git/opencrane-new/issues/45) | INT-01–08, INT-10, INT-20, INT-30–31, INT-33–37, INT-50–52, INT-76, INT-90–96 | IntegrationRegister, McpInstall, ToolPolicyScreen, IntegrationFacts, AccessGrantEditor, HingeDrawer, ModalSheet | I **exists** for list/remote discovery/modes. Publication acknowledgement, person/assistant grants, removal dependency review and same-change reconciliation **need building** in P3-4. Restyle register; compose source → connection → tools/access → review; show four facts separately, stale read, scoped confirmation and removal. No working publisher implied by discovery. |
| P3-6 [#47](https://github.com/elewa-git/opencrane-new/issues/47) | INT-10–19, INT-19-RM, INT-34–37, INT-50–52, INT-90–92, INT-94–96 | McpInstall, AdmissionEvidence, IntegrationFacts, ModalSheet | I remote flow **exists**; hosted digest/signature/licence/scanner/deployment status **needs building**. Add package source choice and separate dated admission checks with all rejection/wait states. Scanner success must not label publication Ready. |
| P3-7 [#48](https://github.com/elewa-git/opencrane-new/issues/48) | INT-40–44, INT-90–96 | ToolRevisionComparison, IntegrationFacts, ToolPolicyScreen, HingeDrawer | I inventory/modes **exist**; watch freshness, quarantined revisions, old/new definitions and re-publication status **need building**. Render tool-by-tool changes, paused cause and fresh restored evidence; new tools stay Block. |
| P3-8 [#49](https://github.com/elewa-git/opencrane-new/issues/49) | INT-20–22, INT-60–66, INT-73–76, INT-90–96 | MyToolsScreen, ConnectionProfileForm, IntegrationFacts, ModalSheet | Personal bearer profile and explicit company connection CRUD/status **need building**; A supplies identity only. Build My tools list, masked connect/replace, revoke review, explicit company opt-in and return-to-chat state. Clear accepted secret input; no silent fallback. |
| P3-9 [#50](https://github.com/elewa-git/opencrane-new/issues/50) | INT-20, INT-23, INT-60–61, INT-67–75, INT-90–96 | MyToolsScreen, ConnectionProfileForm, ConsentStatus | OAuth start/callback/status/refresh recovery and discovery-only validation-profile API **need building** on P3-8. Display scopes before redirect, recover the original connection on return, distinguish cancelled/wrong-account/expired/revoked. Product SSO A is not tool OAuth. |
| P3-10 [#51](https://github.com/elewa-git/opencrane-new/issues/51) | INT-24–26, INT-60–61, INT-72–76, INT-92, INT-94–96 | PrivateInstanceStatus, MyToolsScreen, ConnectionProfileForm | Per-profile hosted instance lifecycle/status **needs building** after P3-6/P3-8. Show waking, unavailable and reconnect. INT-26 cannot invite entry of a lasting startup secret; the spec rejects that dependency. |
| P3-20 [#61](https://github.com/elewa-git/opencrane-new/issues/61) | INT-80–88, INT-90–96; WRK-95 | DestinationPolicyEditor, ToolActivityLine, HingeDrawer | Destination list/edit/revoke/status and governed package/Git reports **need building**; C/H are existing transport/audit seams. Render labelled host/port/scope rows, validation, read-only, stale/unknown and refusal lines; no allow bypass. |
| P4-23 [#105](https://github.com/elewa-git/opencrane-new/issues/105) | INT-01–08, INT-20–23, INT-30–37, INT-40–44, INT-50–52, INT-90–96 | IntegrationRegister, IntegrationFacts, AccessGrantEditor, ToolPolicyScreen, ConnectionProfileForm | G **branch available**, I modes/list **exist**; complete P3 installation/profile/publication APIs and group grant/dependency views **need building**. Replace fixture audience with real groups; INT-32 is the group extension. Show actual affected people/routines and upstream company attribution. |

`AdmissionEvidence` takes `checks`; `ToolRevisionComparison` takes
`previousInventory`, `currentInventory`, `checkedAt`; `ConsentStatus` and
`PrivateInstanceStatus` take their typed status/evidence. `DestinationPolicyEditor`
takes `rules`, `revision`, `canEdit`, `status` and emits save/revoke intent. They
contain no credential release, deployment or permission logic.

### 02-wrk — Workspace effects

Reference: [handoff](02-wrk/README.robot.md). Extend existing `ApprovalCards`
(`conversationId`), `LiveView` (`conversationId`, `saved`) and `FilePreview`
(`conversationId`, `path`, `closed`). `ToolActivityLine` takes a sanitised tool
record and emits `detailsOpened`; `ConversationFileCard` takes authorised file
metadata and emits `opened`/`downloaded`; `BudgetStopNotice` takes the server's
scope/reason/limit/reset/held values. Do not infer outcomes from assistant prose.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P3-5 [#46](https://github.com/elewa-git/opencrane-new/issues/46) | WRK-01–07, WRK-10–22, WRK-30–35 | Workspace, ToolActivityLine, ApprovalCards, HingeDrawer | C/Q/H **exist**; live governed MCP continuation, native-consent refusal and participant-scoped effect readback **need completing**. Restyle quiet tool lines, details, pending/terminal approvals and reconnect restoration. Unknown writes check recorded status, not a fresh message retry. |
| P3-12 [#53](https://github.com/elewa-git/opencrane-new/issues/53) | WRK-02–05, WRK-10–22, WRK-30–35 | Same tool and approval pieces | C/Q **exist**; hosted Odoo adapter/profile/readback **needs building** through P3-6/P3-9/P3-11. Bind actual read, approved note write, requester attribution, refusal and unknown result to these existing pieces; no special Odoo chat engine. |
| P3-14 [#55](https://github.com/elewa-git/opencrane-new/issues/55) | WRK-40–45 | BudgetStopNotice, ApprovalCards, Workspace | B/C/Q **exist** for budgets, messages and approvals; persistent scope-specific hard-stop/cancellation/reset reports **need building**. Show global/group/assistant stop and dispatched held spend; disable delayed approvals only from authoritative lifecycle. New month allows newly checked work, not replay. |
| P3-17 [#58](https://github.com/elewa-git/opencrane-new/issues/58) | WRK-50–56, WRK-60–71, WRK-62-RM | LiveView, ComputerControlReview, HingeDrawer | V read-only viewing **exists**; takeover intent/pause confirmation/writer lease/release/status **needs building** in the landed API. Restyle view states and add explicit control review, persistent Return control, lease/disconnect/generation recovery. WRK-50–56 preserve P3-16 behaviour as a dependency. |
| P3-18 [#59](https://github.com/elewa-git/opencrane-new/issues/59) | WRK-80–91 | LiveView, ConversationFileCard, FilePreview, ModalSheet | V capture/files **exist**. Restyle capture, saved thumbnail in transcript and Files, caption, preview/download and access clearing. Retain original capture key across unconfirmed responses. Separate scan progress, expiry reason and restart-safe pending lookup have gaps below. |
| P3-21 [#62](https://github.com/elewa-git/opencrane-new/issues/62) | WRK-96; WRK-52–55, WRK-62, WRK-69 | ToolActivityLine, LiveView, BudgetStopNotice | C/V **exist** for display; P3-20 browser egress policy reports and takeover-bound caller context **need building**. Render allowed page, blocked redirect/subresource, unavailable policy, expired/ambiguous requester and disconnection; do not make navigation retry an authority bypass. |

`ComputerControlReview` takes the server's current control state, requester,
affected threads and lease evidence; emits explicit take/return intent. No writer
controls mount before the backend confirms every agent thread has paused.

### 03-spd — Spending

Reference: [handoff](03-spd/README.robot.md). `SpendingSummary` takes `budget`,
`selection`, `loadedAt`; `MoneyCard` takes `label`, `settledCents`, `reservedCents`,
optional `ceilingCents`, `period`; `BudgetLimitForm` takes current scope/limits,
`expectedSequence` and `canEdit`. `EffectResolutionDrawer` takes `permitId`;
`EffectEvidenceList` takes safe `observations`, `resolution` and `conflict`.
Their parent owns HTTP and emits/reloads typed results; money stays integer cents.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P3-15 [#56](https://github.com/elewa-git/opencrane-new/issues/56) | SPD-01, SPD-03, SPD-06–09, SPD-20–28, SPD-30–35 | SpendingSummary, MoneyCard, EffectResolutionDrawer, EffectEvidenceList, HingeDrawer | E **in review**, B **exists**. First build unknown-effects list and resolution drawer; show held/settled separately, original permit, recorded observations, structured evidence entry, safe integer validation, pending reaction, conflicts, role loss and Check status. Broader SPD summary attribution waits for P4-26. |
| P4-26 [#108](https://github.com/elewa-git/opencrane-new/issues/108) | SPD-01–09, SPD-04-RM, SPD-20–28, SPD-30–35, SPD-40–46, SPD-50–54 | SpendingSummary, MoneyCard, BudgetLimitForm, EffectResolutionDrawer, BudgetStopNotice | B **exists**, E **in review**, G **branch available**. Named assistant/payer choices, root/routine joins, personal default and hard-stop consequences **need building** with P4-11/P4-24. Finish scope selection, lowering review, zero, rollover and linked chat; reuse the P3-15 drawer. |

Bind E exactly: list `{ effects }`; detail supplies `sequence`, `state`,
`reservedAt`, `reservedCents`, nullable `settledCents`, model/price table,
observations/resolution and `csrf`. Resolve with `commandId`,
`expectedSequence`, `outcome: settled|released`, `settledCents`, and 1–10
structured evidence entries. A provider receipt has `reference`, SHA-256 `digest`
and `amountCents`; release needs `dispatch_record` with `notDispatched: true`
and zero settlement. POST includes Origin and detail's `X-CSRF-Token`.
A 202 means recorded, not settled: reread the original permit through
`resolution_pending` to the recorded result. A 409 `held` or `conflict` retains
uncertainty and refresh/review; 400 exposes validation, 401/403 clear protected
data, 503 remains unavailable/unknown. Never offer release because time elapsed.

### 04-ppl — People and groups

Reference: [handoff](04-ppl/README.robot.md). `GroupsList` takes authorised `rows`,
`loadState`, `loadedAt`; `GroupDetail` takes `group`, `changeStatus`, `canManage`.
`MemberPicker` takes authorised `candidates`, `selectedIds`, `loading` and emits
query/selection; it does not query a guessed directory. `MemberAccessSummary`
takes safe grants and sources. `OwnershipReview`, `InvitationForm` and
`DepartureReview` take the current member plus server-provided options,
revision/consequences and permissions, and emit explicit reviewed commands.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P4-1 [#83](https://github.com/elewa-git/opencrane-new/issues/83) | PPL-01–08, PPL-10–16, PPL-20–22 | GroupsList, GroupDetail, MemberPicker, MemberAccessSummary, ModalSheet | G **branch available**. Build list/create/detail/local-vs-supplied membership, add/remove review and same-command status. Members list/search, full person access and conflict actor/time are gaps; PPL-01 and PPL-20–22 overlap P4-3. No hierarchy, rename or delete. |
| P4-2 [#84](https://github.com/elewa-git/opencrane-new/issues/84), also #24 outcome | PPL-30–35 | OwnershipReview, MemberAccessSummary, ModalSheet | Ownership transfer/step-down/status **needs building** on the single ownership stream. Show successor review, coexistence of owners, success, last-owner conflict and role refusal. Non-owner role changes in PPL-30/31 belong to P4-3. |
| P4-3 [#85](https://github.com/elewa-git/opencrane-new/issues/85) | PPL-01, PPL-04–05, PPL-16, PPL-20–22, PPL-30–31, PPL-35, PPL-40–46, PPL-50–53 | MemberPicker, MemberAccessSummary, InvitationForm, DepartureReview, OwnershipReview | A join **exists**, G **branch available**; directory/invite list/create/status, roles, departure dependencies/rejoin **need building**. Build member details and copyable bound invite link, no “email sent”; require known consequences before departure and route owner changes through P4-2. |
| P4-7 [#89](https://github.com/elewa-git/opencrane-new/issues/89) | PPL-60–64; THR-07–08, THR-21–23 | SharedAssistantCard, AssistantPicker, GroupDetail, Workspace | G **branch available**, C has personal assignment/payer seams; shared assistant create/status and member-private thread selection **need building**. Build group assistant draft/review/provisioning/busy/failure, member selection and fixed payer confirmation. Membership alone never grants shared desktop access. |

`SharedAssistantCard` takes `assistant`, `provisioningState`, `canManage`;
`AssistantPicker` takes authorised assistants, eligible payers and selected ids.

G create sends `{ commandId, groupId, name }`; membership sends
`{ action: add|remove, commandId, memberId }` to the group route. Keep these ids
through lost acknowledgements. Read `/changes/:commandId`; remain Applying until
both `projection.content` and `projection.iam` are current, then reload the group.
404 does not establish that an in-flight command cannot append. Never replace
an unknown command with a new id. A 409 requires reload/review; G does not accept
an `expectedSequence` field. `membershipSource: identity_provider` is read-only.
`access.grants` explains group-derived `use`/`acts_for` only, with explicit false
conversation/private-memory access; it is not an authority cache.

### 05-thr — Threads and delegation

Reference: [handoff](05-thr/README.robot.md). Reuse `Workspace`, `ChatComposer`,
`ApprovalCards` and the current transcript. `ConversationList` takes authorised
rows/cursor/loading and emits selected/load-more/archive intent.
`RecipientPicker` takes candidates, selections and allowed mode combinations.
`ChildSummaryCard` takes a server-sanitised summary and child link;
`ChildOrigin` takes authorised origin/breadcrumb and parent return position.
`PublishReview` takes reviewed text, audience, eligible assets and revision.
`SubagentsPanel` takes authorised outcomes and root cents; `RecoveryNotice`
takes the server's recovery/restriction state. These add no second transcript.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P4-4 [#86](https://github.com/elewa-git/opencrane-new/issues/86) | THR-05, THR-08, THR-10–12, THR-16 | RecipientPicker, Workspace, ChatComposer | C **exists but rejects direct mode**; mode-correct create/send plus colleague selection **needs building**. Build two-person To line and human transcript; mount no model, memory, assistant or Stop controls. Sending text must cause no AI work. |
| P4-5 [#87](https://github.com/elewa-git/opencrane-new/issues/87) | THR-06, THR-08, THR-10–13, THR-16 | RecipientPicker, MemberPicker, Workspace | C/G seams **exist/branch available**; group-mode commands and explicit participant changes **need building**. Show group selection as a participant snapshot, immutable mode, denied/unsupported selection and plain @agent without dispatch. |
| P4-6 [#88](https://github.com/elewa-git/opencrane-new/issues/88) | THR-01–04, THR-14–16 | ConversationList, Workspace, ModalSheet | C **exists** for basic list/history/close command; durable recent pagination/read/archive and participant boundaries **need building**. Replace local archive placeholder; implement recent/archived/empty/loading/long-title/read-only states and safe reconnect. |
| P4-8 [#90](https://github.com/elewa-git/opencrane-new/issues/90) | THR-12, THR-20–23, THR-30 | AssistantPicker, ChildSummaryCard, RecipientPicker, ModalSheet | Child intent/create/activation/status **needs building** on C and P4-7. Explicitly review assistant, own source message, frozen audience and payer; lost acknowledgement finds the same child. Plain mention remains text. |
| P4-9 [#91](https://github.com/elewa-git/opencrane-new/issues/91) | THR-30–32, THR-40–45, THR-40-RM | ChildSummaryCard, ChildOrigin, Workspace, ApprovalCards, MemberPicker, Crease | C/Q **exist**; finite summary, authorised origin/late-invite and requester-correct follow-up contracts **need building**. Full-page child with Back restoring source position; collapsed phone origin, serial follow-ups and restricted summary with no counts/text/assets. |
| P4-10 [#92](https://github.com/elewa-git/opencrane-new/issues/92) | THR-50–53 | PublishReview, ChildSummaryCard, ConversationFileCard, ModalSheet | Parent publication/reconciliation/audience-eligible assets **need building**. Review exact final/interim text and audience, append one credited parent entry, and handle denied/stale/unknown. Completion prepares a draft, never automatic publication. |
| P4-11 [#93](https://github.com/elewa-git/opencrane-new/issues/93) | THR-60–62 | SubagentsPanel, MoneyCard, BudgetStopNotice, Workspace | C/B **exist**; verified root/descendant outcomes, root allowance and stop cascade **need building**. Show one root's settled/reserved and child outcomes with authorised links; no separate run-tree ledger or fabricated retry counts. |
| P4-14 [#96](https://github.com/elewa-git/opencrane-new/issues/96) | THR-70–72 | RecoveryNotice, Workspace, ToolActivityLine | C reconnect **exists**; fresh private-thread recovery/restricted-write admission **needs building** and real no-disk qualification. Explain recovering, fresh resume, unavailable context and starting a memory-free turn. THR-72 is shared with P4-15; MEM is a downstream dependency, not a separate P4-14 state set. |

### 06-mem — Memory

Reference: [handoff](06-mem/README.robot.md). `MemoryList` takes authorised `scope`,
`facts`, `query`, `cursor`, `loadState`. `MemoryFactDetail` takes a current fact
and authorised source links. `MemoryReceipt` takes fact ids/revisions, scope,
outcome and `canUndo`; emits per-item Undo. `MemoryFactForm` takes allowed scope,
current fact/revision, limits and operation. `PreferencesForm` takes current
personal preferences/revision and server bounds; `MemoryContextNotice` takes
omission/restriction evidence. `MaintenanceTrail` takes safe job outcomes and
source references. No component stores remembered text in browser persistence.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P4-12 [#94](https://github.com/elewa-git/opencrane-new/issues/94) | MEM-01–06, MEM-10, MEM-20–21, MEM-30–32 | MemoryList, MemoryFactDetail, MemoryFactForm, MemoryReceipt | Memory MCP remember/recall and authorised browser list/search/store **need building**. Build person/group/assistant-notes scope, search paging and source-aware store receipt without approval. Browser does not fabricate trusted MCP scope headers. |
| P4-13 [#95](https://github.com/elewa-git/opencrane-new/issues/95) | MEM-12, MEM-20–21, MEM-33–35, MEM-40–41 | MemoryFactDetail, MemoryFactForm, MemoryReceipt, ModalSheet | Conditional correct/forget/cleanup status **needs building** on P4-12. Build correction preview, stale revision, forget review, tombstone/cleanup outcomes; explain independent chat/backups are outside this deletion. Undo store means forget. |
| P4-15 [#97](https://github.com/elewa-git/opencrane-new/issues/97) | MEM-10–12, MEM-50–52; THR-72 | MemoryReceipt, MemoryContextNotice, PreferencesForm, RecoveryNotice | Memory CRUD depends on P4-12/13; turn-context admission, receipt/omission/invalidation reports **need building** after qualified P4-14. Show stored scope, Undo, omitted but recallable facts and memory-loaded write restriction. No UI switch may bypass no-disk admission. |
| P4-16 [#98](https://github.com/elewa-git/opencrane-new/issues/98) | MEM-01–06, MEM-10–12, MEM-20–21, MEM-30–35, MEM-40–41, MEM-50–52, MEM-60 | MemoryList, MemoryFactDetail, MemoryReceipt, MemoryFactForm, PreferencesForm, AuditScreen | Memory browser reads/edits/preferences/pins **need building/delivering** with earlier memory tickets; H Decisions **exists**. Finish knowledge panel, batch receipts/per-item Undo, preferences entry/pins and authorised Decisions. No department/org scope, promotion or approval queue. |
| P4-17 [#99](https://github.com/elewa-git/opencrane-new/issues/99) | MEM-61–63, MEM-62-RM | MaintenanceTrail, MemoryFactDetail, MoneyCard | Scope-specific nightly outcome/detail/source/budget reads **need building**; H/B provide safe audit/accounting seams. Show actual scheduled time, merges/contradictions/expiry and failed/held work; no client scheduler or automatic retry of uncertain model work. |

### 07-onb — Onboarding and account

Reference: [handoff](07-onb/README.robot.md). `AccountScreen` takes safe identity,
editable display name, assistant status and revision; `OnboardingSurvey` takes
confirmed step, saved answers, revision and field errors; `PersonaReview` takes
persona revision/content/status; `WelcomeConversation` takes ordered welcome
entries, workflow state and assistant availability. Reuse composer presentation
where applicable without mounting ordinary session authority controls.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P4-18 [#100](https://github.com/elewa-git/opencrane-new/issues/100) | ONB-41, ONB-50–52 | PersonalSettingsShell, AccountScreen, PreferencesForm, SharedAssistantCard | A identity and C personal assignment **exist**; preferred-name/settings/source-rich role/group data **needs building**; preferences depend on P4-16 and My tools on P3-8/9. Render SSO source/read-only fields, honest assistant state and working links. |
| P4-19 [#101](https://github.com/elewa-git/opencrane-new/issues/101), #33 slice | ONB-01–03, ONB-10–17, ONB-20–24 | SignIn, OnboardingSurvey, PersonaReview, ModalSheet | A SSO **exists**; saved survey/progress, persona edit/restart/approve/status **needs building**. Four steps retain name/pronouns, role/groups, tone/length/citations and tasks; focus each new heading and restore confirmed step after reload. Choices grant nothing; SOUL.md is a reviewable persona, not a disk file. |
| P4-20 [#102](https://github.com/elewa-git/opencrane-new/issues/102), #33 slice | ONB-30–33, ONB-32-RM, ONB-40–41 | WelcomeConversation, ChatComposer, Crease, ConversationList | Deterministic welcome answer/completion/status and distinct archiveable list entry **need building** on P4-19/P4-6. Render interrupted/resumed, one final confirmation/crease, read-only completed entry and no-assistant welcome. No model/participant pickers or invented assistant. |

### 08-mod — Models and providers

Reference: [handoff](08-mod/README.robot.md). `ProviderList` takes safe provider/model
rows and load state; `ProviderSetup` takes confirmed step, configuration
revision, safe connection metadata and verification evidence. `ProviderKeyForm`
takes provider id and status, never a saved key. `ProviderRetirementReview` takes
actual dependencies, eligible replacements and pause choices. Reuse
`AccessGrantEditor` and extract `ModelRoutingTable` from the existing registry
view with `models` and `taskRouting` inputs.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P4-21 [#103](https://github.com/elewa-git/opencrane-new/issues/103) | MOD-01–06, MOD-02-RM, MOD-10–21, MOD-25–26 | ProviderList, ProviderSetup, ProviderKeyForm, IntegrationFacts, AccessGrantEditor | B registry/routing **exists**; provider configuration/key save/replace/status, reachability and budgeted verification **need building**. Build Provider → Key → Verify → Models → Access → Done. Show saved/reachable/model-answer separately, priced-test warning and connected-not-tested skip. Access step depends on P4-22 grant contract. |
| P4-22 [#104](https://github.com/elewa-git/opencrane-new/issues/104) | MOD-01–06, MOD-02-RM, MOD-19–21, MOD-30–31, MOD-40–42 | ModelRoutingTable, AccessGrantEditor, ProviderRetirementReview, ModalSheet | B **exists**, G **branch available**; model grant/read explanations and provider retirement/dependency/status **need building** after P4-21. Finish real group access, replacement-or-pause review and retirement conflicts. No model/price/failover engine. |

### 09-rtn — Routines

Reference: [handoff](09-rtn/README.robot.md). `RoutineList` takes rows/load state;
`RoutineForm` takes saved routine/revision, permitted assistant/company-profile/
payer options and server schedule preview. `RoutineRunDetail` takes authorised
occurrence/root/outcome links. `RoutineChangeReview` takes operation and server
consequences; all emit explicit intent. `ScheduleSummary` takes local rule,
IANA zone and server next UTC occurrence; never predicts successful execution.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P4-24 [#106](https://github.com/elewa-git/opencrane-new/issues/106) | RTN-01–06, RTN-10–14, RTN-11-RM, RTN-40, RTN-53 | RoutineList, RoutineForm, ScheduleSummary, RoutineRunDetail, MoneyCard | Routine create/list/detail/occurrence/status **needs building** on C, company profiles and root admission. Build daily/weekly form, Runs as/company attribution, next/recent run and actual session/audit/spending links. Validate missing pieces without inventing defaults for authority. |
| P4-25 [#107](https://github.com/elewa-git/opencrane-new/issues/107) | RTN-11–13, RTN-11-RM, RTN-20–24, RTN-30–36, RTN-40, RTN-50–53 | RoutineChangeReview, RoutineRunDetail, ScheduleSummary, ApprovalCards, BudgetStopNotice | Q **exists**; routine edit/pause/resume/retire/reassign/run-now/root-stop/status **needs building** on P4-24. Render original-owner Ask, invalidation, skipped/missed and unknown outcomes. Resume next future slot; Run now is a new reviewed occurrence, not retry of uncertain effects. |

### 10-ovr — Overview, history and qualification

Reference: [handoff](10-ovr/README.robot.md). `OverviewTaskList` takes authorised tasks,
load state and last-loaded time; `OverviewTaskRow` takes one task with safe scope,
state, evidence and one action link. `AuditDetail` takes a safe history row and
permitted owning-feature links. Reuse `AuditScreen` for filters/pagination and
`EffectResolutionDrawer` for monetary uncertainty, rather than a generic resolver.

| Ticket / issue | State ids | Components | API binding and UI-only work left |
| --- | --- | --- | --- |
| P4-27 [#109](https://github.com/elewa-git/opencrane-new/issues/109) | OVR-01–08, OVR-10, OVR-20–24, OVR-20-RM | OrganisationShell, OverviewTaskList, OverviewTaskRow, AuditScreen, AuditDetail, HingeDrawer | H **exists**, E **in review**; actionable cross-feature task read and new safe history fields/filters **need building** with owning features. Order unknown/interrupted, needs-input, failed and dated Ready; one action per row. Preserve loaded data on safe refresh failure, clear on revocation. No health score or new change ledger. |
| P3-22 [#63](https://github.com/elewa-git/opencrane-new/issues/63) | OVR-05–07, OVR-10, OVR-20–24, OVR-20-RM; all INT/WRK states mapped to Phase 3 above and SPD-01, SPD-03, SPD-06–09, SPD-20–28, SPD-30–35 | Delivered Phase 3 screens and AuditScreen | Qualification, **not a new API**. Exercise I/C/Q/B/H/V/E plus delivered profile/egress/installer APIs twice fresh. UI-only remainder is desktop/phone/reduced-motion evidence, keyboard/access-loss journeys and corrections in owning feature PRs. P4-only overview aggregation does not gate Phase 3. |
| P4-28 [#110](https://github.com/elewa-git/opencrane-new/issues/110) | OVR-01–08, OVR-10, OVR-20–24, OVR-20-RM; every Phase 4 state mapped above, with Phase 3 regressions | All delivered screens | Qualification, **not a new API**. Cover every named state/outcome and the combined company journey twice fresh using actual feature APIs. Produce comparisons and refusal/replay evidence; do not turn this into a consolidation UI PR. |

## Contract gaps exposed by the designs

These are specific implementation dependencies or unsupported design details.
Keep the usable supported flow moving; omit unsupported detail or explain its
unavailability. Do not display example people, counts, dates, reasons or receipts
as production data. Visual review must distinguish an adapted truthful frame
from an unimplemented exact design state.

| Design requirement | What the spec/API actually provides; action |
| --- | --- |
| SPD-20–28 work titles, requester, assistant, group, Odoo readback and automatic “fresh evidence found” | E deliberately omits private conversation/requester data and has no Odoo readback/evidence-fetch operation. Build monetary resolution using permit/reservation/model/recorded observations and operator-supplied structured receipt references. P3-12 owns Odoo readback; P4-26 owns safe root/routine attribution. Do not imply either already exists. |
| SPD-24/25 required free-text Reason | E strictly accepts structured evidence, no free-text reason. Use labelled reference/digest/type/amount or non-dispatch proof fields in the review. Do not submit private evidence prose or invent an accepted field. Any later reason field needs an explicit contract change. |
| SPD-31/33 named resolver/time; SPD-32 `chg_7F3K`; SPD-35 read-only non-admin resolver | E's resolution response omits operator/time/command id and all E reads require Owner/Admin. Identify current outcome by original permit and sequence, without attributing it to a named admin or asserting it was this client's command. Keep denied viewers out of protected detail. A universal change-reference URL does not exist. |
| PPL-01/11/20–22 complete people/search/effective access | G returns group members and group-derived grants, not every active silo member or full direct/model/tool access. Do not infer a directory by unioning groups. Add a bounded authorised member selection read in the owning backend before shipping the add picker; P4-3 supplies full person access. Create/list/detail/remove can bind now. |
| PPL-15 named concurrent editor/time and viewer who can read but cannot manage | G returns generic 409/403 and is Owner/Admin-only; no client expected revision or conflict actor/time. Use generic refresh/review and access-changed wording. Broader read roles or stale-view revision guarantees need an API contract; do not claim them from `position`. |
| PPL-07/14 confirmed group/membership | G append is not projection completion. Wait for both content and IAM receipts; no invented confirmation timestamp when none is supplied. Display Applying until confirmed reads agree; a dated completion needs actual event/check evidence exposed by the backend. |
| WRK-81/82 separately captured/scanning/saving | Screenshot POST is one pending operation, no progress feed. Use “Capturing and saving…” until its receipt. Stage-specific progress needs a server report; timers cannot simulate these transitions. |
| WRK-85/89/91 failed save, expired link and repeated capture after reload | V returns a durable file result for a repeated successful key and uses freshly authorised file-view routes; there is no browser signed-link-expiry reason or dedicated pending capture-status GET. Refresh authorised files to reconcile known results, retain the key, and show generic unavailable/unknown where ambiguous. Do not label a failed transport as proven unsaved or POST again under “Check status”. New capture and an explicit same-key retry are separate actions under the existing contract. |
| WRK-05/30–35 safe retry/readback details, WRK-40–45 scope/reset explanation | Current tool reports and approval outcomes do not prove non-dispatch or an Odoo write. P3-5/12/14 must expose safe typed evidence; generic tool failure must lose its current “Retry in a new message” affordance when an effect may have happened. E is admin monetary evidence, not a participant effect endpoint. |
| INT-26 startup secret; INT-10 catalogue choice | P3-10 refuses dependencies requiring a lasting startup secret. Explain unsupported configuration, not an unrestricted secret form. Remote and pinned hosted sources are specified; a marketplace/catalogue service is not. Keep catalogue unavailable unless a bounded reviewed source is actually provided. |
| MOD evidence, retirement dependencies and INT affected-user/routine counts | Registry/tool-mode APIs do not supply full provider lifecycle or dependency inventories. P4-21/22 and P3-4/P4-23 must supply actual revisions, safe dependencies and status reads. Missing dependency data blocks destructive completion. |
| THR publication assets | Current file routes authorise reads but expose no general audience-sharing command. P4-10 can publish only assets already authorised for every intended recipient. A new share flow needs its own supported contract; a link cannot grant access. |
| MEM maintenance schedule/caps and RTN next occurrence | Specs define scoped nightly maintenance and daily/weekly DST rules, but no browser endpoints exist. Backend reads must supply timestamps, bounds and revisions; UI does not hard-code a fake scheduled job or calculate spend/authority. MEM budgets/caps in decisions are implementation defaults, not extra UI policy. |
| ONB account sources, preferences, persona, no-assistant progression | A/C expose only part of the account view; SSO source/role/group labels, preferred name and workflow progress need typed reads/commands. Do not make survey groups grant membership, treat SOUL.md as a file, or invent a global sign-out/device count. |
| OVR task ordering, date/actor/type filters, human names and timestamps | H currently filters request/turn/decision with position pagination; safe records do not include the design's full actor/time metadata. P4-27 needs safe fields and owning-feature task reads. Implement supported filters first; no client scan of private event histories or invented times. |
| “Ready” dated evidence across every handoff | API read time can truthfully say “Checked at”, but is not a verification/completion event time. Where the contract has no dated success evidence, retain specific recorded/applying/loaded wording and request the field in the owning API. Never paste the design's 4 October timestamps. |

All asynchronous reads must be scoped to the current page/resource and access
generation. Abort obsolete requests and reject late results after navigation or
revocation; clearing the visible template alone is insufficient. Retain
last-loaded data on a plain read failure only while current access remains valid.
Secrets and protected payloads never go in durable browser state. Persist only
safe original command references where the owning contract permits reload
reconciliation; no new generic mutation store.

## Build order and delivery gates

1. **Foundation F1–F5.** Establish shared visual/accessibility behaviour and move
   existing screens. This is source work, not a Phase 3/4 live PASS.
2. **First five screen outcomes**, in the order below. Available branch backends
   are brought through their merge/review gates before relying on them. P4-1
   source integration can be prepared early as requested; Phase 4 live work still
   requires the Phase 3 fresh-journey PASS in the spec.
3. **Phase 3 critical path:** P3-4 → P3-5 → P3-8 → P3-9 → P3-12 → P3-22.
   After P3-4, P3-6 hosted admission and P3-7 drift can proceed. P3-10 joins after
   P3-6/P3-8. P3-11 Odoo fixture also gates P3-12. Preserve P3-13 budgets before
   P3-14 hard-stop and P3-15 resolution. P3-14 also needs P3-5.
4. **Independent Phase 3 work:** keep P3-18 screenshot restyle and P3-15 resolution
   near the front. P3-17 follows existing P3-16 view; P3-20 destination/package
   egress precedes P3-21, which also needs P3-17. Existing P3-19 audit must cover
   new event families as they land. P3-22 waits for P3-7/10/12/14/15/18/19/21 and
   their transitive dependencies, not merely a finished set of frames.
5. **Phase 4 critical path:** P4-1 → P4-7 → P4-14 → P4-15 → P4-16 → P4-17 →
   P4-27 → P4-28. Run P4-12 → P4-13 alongside P4-14 after P4-1/P4-7; both P4-13
   and qualified P4-14 gate P4-15. Never enable memory while its no-disk proof
   fails. P4-17 also waits for P4-11 root accounting.
6. **Collaboration branch:** P4-4 can start at the Phase 4 frontier; P4-1/P4-4 →
   P4-5 → P4-6. P4-5/P4-7 → P4-8; P4-6/P4-8 → P4-9 → P4-10. P4-7/P4-9 →
   P4-11, which feeds memory maintenance and routines.
7. **Administration/onboarding/routines branches:** P4-2 at the frontier;
   P4-1/P4-2 → P4-3. P4-16 → P4-18; P4-3/P4-18 → P4-19; P4-19/P4-6 → P4-20.
   P4-21 at the frontier; P4-1/P4-21 → P4-22. P4-1 plus complete Phase 3
   integration/profile APIs → P4-23. P4-7/P4-11/P4-23 → P4-24 → P4-25;
   P4-11/P4-24 → P4-26. P4-27 waits for P4-3/10/17/22/25/26; P4-28 waits for
   every P4 feature. Each owning feature extends history and dependency reads
   when it lands; no final integration backlog.

| First screen | Why now | Exact starting frame scope |
| --- | --- | --- |
| 1. P3-15 uncertain-spend resolution | PR #114 already supplies the narrow read/resolve contract. | SPD-20–28, SPD-30–35, with list loading/access shells; adapt unsupported evidence details as above. |
| 2. P4-1 groups list, create and detail | G is implemented on its branch, with readback and projection receipts. | PPL-02–08, PPL-10–16; member picker waits for authorised directory data, full member detail follows P4-3. |
| 3. P3-18 screenshot capture and saved preview | Capture, durable file metadata and authorised reopening already exist here. | WRK-80–91 using combined pending status where the server has no stages. |
| 4. P3-4 integration register and publication review | List/discovery/modes exist; starts the remaining Phase 3 critical path. | INT-01–08, INT-10, INT-20, INT-30–31, INT-33–37, INT-50–52, INT-76, INT-90–96; publication/grants remain backend-gated. |
| 5. P3-5 governed tool and approval transcript | Reuses C/Q and the foundation, immediately follows P3-4. | WRK-01–07, WRK-10–22, WRK-30–35; real MCP continuation/readback evidence gates success states. |

Each feature PR includes the UI, necessary typed API completion and its relevant
failure/refusal outcomes, within about 1,500 non-generated changed lines. Existing
backend-only branches need their missing UI and qualification tracked explicitly;
this plan does not retrospectively call those full tickets done. Use PR sections
Why / Functional outcome / Architecture / Evidence / Not in this PR. Keep fixes
inside their feature PR and at most two independent review passes under the
engineering standard.

Before landing implementation: required `lint`, `typecheck`, `test`,
`check:events`, plus separate Angular build/tests. Compare each delivered state
at 1280px and 390px with the external frames; verify the matching `-RM` frame
and reduced-motion behaviour on every other state. Include keyboard/focus return,
44px targets, long content, duplicate-submit prevention, lost acknowledgement,
reconnect and access revocation with late HTTP/WebSocket responses. Meaningful
behaviour tests belong at the current HTTP/Angular seams; do not test decorative
implementation details for ceremony.

Record PASS/FAIL/PARTIAL/NOT RUN per capability, source SHA, environment/freshness
and safe artefacts. P3-22 and P4-28 each require twice-fresh journeys; screenshots
and source checks alone are not capability completion. This documentation task
changes no product code and runs no live feature journey.

## Reference inspection and plan validation

All ten handoff READMEs were read; their shared rules are identical. Exact layout
and state detail were checked in the design sources, including the shell grid,
mobile menus, effect review, member search, account fields and screenshot flow.
Rendered frames inspected where structure was ambiguous: OVR-08 at 390px,
ONB-50 at 390px and SPD-24 at 1280px, under
`/home/jente/dev/design-handoffs/v2/NN-key/png/`. These are design references only.

Validation: `npx markdownlint-cli2 docs/design/handoff-v2/PLAN.md` — PASS.
Frame-index comparison — PASS: all 380 named states covered across the 43 ticket
rows, including every `-RM` id. Independent read-only documentation review, pass 1
— PASS, no blocking findings. Product runtime checks, implementation review and
live qualification are NOT RUN by this planning change. The 43 ticket comments
link this plan on `work/design-handoff-v2`; legacy #24 and #33 remain linked
outcomes rather than additional tickets.
