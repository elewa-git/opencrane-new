# Claude Design briefs for the Phase 3 remainder and Phase 4

The owner makes the high-fidelity designs in Claude Design, using the existing
project assets, and returns the handoff. This document supplies the screen
inventory and ready-to-paste prompts. It does not supply new designs or claim
that any journey has passed live.

## 1. Coverage and order

Scope checked on 4 October 2026 with `gh issue list --label ready-for-agent
--limit 100` and `gh issue list --state open --limit 200`. The first list contains
P3-18 (#59) and P2-7 (#32); P2-7 is outside this brief. The open P3 feature issues
are P3-4 (#45), P3-5 (#46), P3-6 (#47), P3-7 (#48), P3-8 (#49), P3-9 (#50),
P3-10 (#51), P3-12 (#53), P3-14 (#55), P3-15 (#56), P3-17 (#58), P3-18 (#59),
P3-20 (#61), P3-21 (#62) and P3-22 (#63). Closed P3 tickets are reference material,
not new work. The P3 parent #41 and egress parent #18 do not add separate screens.
All P4-1–P4-28 tickets (#83–#110) are included; #24 and #33 are delivered through
their linked P4 tickets. Follow-up faults such as #77 do not add a separate page.

Requirements come from the [Phase 3 tickets][p3], [Phase 3 decisions][p3-decisions],
[Phase 4 tickets][p4] and [Phase 4 decisions][p4-decisions]. Check open issue status
again when implementing; this is a dated design inventory.

Frame names below refer to the [chat README][chat-readme], [chat canvas][chat],
[Workspace Live][live], and [org-admin README][admin-readme] and [canvas][admin].
Chat 6a is Subagents; org-admin 6a is the shared state vocabulary. They are different
frames. Chat 4a–4b are superseded explorations; org-admin 4a–4g remain references.
The [7h texture][texture] and [motion set][motion] apply throughout.

**COVERED** means the named visual surface or narrow state set already has a
frame. It does not mean the whole ticket is implemented or qualified. **PARTIAL**
means reuse the cited frame but return the missing or corrected states. **NEW**
means no matching frame was found; neighbouring assets still set its appearance.
Qualification rows reuse the inventory rather than request another product page.

| Screen or state set | Ticket | Coverage | Existing frame and gap | Prompt |
| --- | --- | --- | --- | --- |
| Workspace shell, transcript, composer and compact layout | P3-5, P3-12; P4-4–P4-11, P4-14 | COVERED | [Workspace Live][live], chat [8b–8j][workspace]; behaviour extensions below | Reuse |
| Integration register, review, grants, publication and removal | P3-4; P4-23 | PARTIAL | Org-admin [4a–4g][admin-integrations], 6a: publication acknowledgement, unknown outcome, current grants and corrected Allow automatically / Ask / Block on reads and writes | 1 |
| Hosted package admission | P3-6 | PARTIAL | Org-admin 4b, 6a: pinned digest, signature/scan/licence evidence, rejected and scanner-unavailable states | 1 |
| Changed tools and restored service | P3-7; P4-23 | PARTIAL | Org-admin 4f: replace old-version-serving promise with quarantine; stale checks and expired approvals | 1 |
| My tools: bearer, OAuth and private instance lifecycle | P3-8, P3-9, P3-10 | NEW | Org-admin 4c supplies the account/scopes pattern; chat 13a links settings. No full personal connect/rotate/revoke/consent/wake flow | 1 |
| Explicit company and discovery-only connections | P3-8, P3-9; P4-23 | PARTIAL | Org-admin 4c–4e: personal default, company opt-in, discovery-only validation and no fallback | 1 |
| Tool progress and readable result lines | P3-5, P3-12 | COVERED | Chat [8f][tools], Workspace Live: quiet lines with details, not one card per tool | Reuse |
| Odoo approval, refusal, continuation and uncertain write | P3-5, P3-12 | PARTIAL | Chat [8g][ask], 8c/8f/8i: exact draft-note action, account, expiry, changed binding, native consent refusal and Check status | 2 |
| Persistent hard-budget stop in chat | P3-14 | NEW | Chat 8c/8d are layout references; no scope-specific ceiling/reset/late-approval state | 2 |
| Computer takeover and return | P3-17 | NEW | Workspace Live panel and chat 8i/8j are entry/layout references; no computer-wide pause, exclusive controller or lease-loss frames | 2 |
| Screenshot capture, saving, file card and authorised preview | P3-18 | PARTIAL | Chat [8e][assets], 8i and existing file previews: add capture origin/time, progress, failed save, expiry and access loss | 2 |
| Destination policy editor | P3-20 | NEW | Org-admin shell and 6a only; no person/assistant destination-and-port policy | 1 |
| Package/Git and browser egress status/refusal | P3-20, P3-21 | PARTIAL | Chat 8f plus Workspace Live panel: allowed destination, blocked redirect, ambiguous requester and disconnect | 2 |
| Unknown-effect evidence and reservation resolution | P3-15 | NEW | Org-admin 6a supplies words; no safe operator evidence/amount/conflict screen | 3 |
| Governed-work qualification | P3-22 | COVERED | No additional product screen: exercise prompts 1–3 and existing sign-in/audit frames, desktop and 390px | Reuse inventory |
| Flat group list, create and membership detail | P4-1 | PARTIAL | Org-admin [5a/5e][admin-people] show member groups, not complete group CRUD; add create/add/remove and long names | 4 |
| Ownership transfer and separate step-down | P4-2 | PARTIAL | Org-admin 5c covers last-owner conflict; missing successor review, coexistence, unknown outcome and race | 4 |
| Member list, inline invite, roles and departure | P4-3 | PARTIAL | Chat [13b][members], org-admin 1a/1b, 5a–5e: verified identity, flat groups, no-assistant option, reassignment/retirement and rejoin | 4 |
| Shared assistant create/detail and member selection | P4-7 | NEW | Org-admin 5a and chat 12a/12b are neighbours; need group owner, grants, payer, provisioning and private member-session entry | 4 |
| Direct/group drafts, transcript and participant changes | P4-4, P4-5 | PARTIAL | Chat [12a/12b][draft], Workspace Live: human-only controls, explicit participants, unsupported combinations and revoked access | 5 |
| Recent/unread/archive and permanent close | P4-6 | PARTIAL | Chat 8b, 8a: pagination, separate archive/close review, long titles and removed-access purge | 5 |
| Child summon and recoverable creation | P4-8 | PARTIAL | Chat [10a/10b][threads]: own-message selection, fixed audience/payer, queued and failed-start recovery | 5 |
| Child full-page navigation and compact anatomy | P4-9 | COVERED | Chat 10c/10e/10f: breadcrumb, collapsed origin, completion crease and docked composer | Reuse |
| Child summaries, follow-ups and restricted access | P4-9 | PARTIAL | Chat 10b/10g: evidence-based retry copy, child-only origin, late joins and purged restricted summaries | 5 |
| Reviewed interim/final publication to parent | P4-10 | PARTIAL | Chat 10d: remove automatic final post; add exact audience/content review, denied assets, conflict and unknown outcome | 5 |
| Subagents, root allowance and cascading Stop | P4-11 | PARTIAL | Chat [6a][subagents]: full-page links replace panel transcript; add shared allowance, held spend and partial/failed/cancelled outcomes | 5 |
| Private-session recovery and restricted tools | P4-14 | PARTIAL | Chat 8c: add fresh authorised context, unavailable recovery and explicit fresh memory-free turn | 5 |
| Memory list/search/store, batch receipts and Decisions tab | P4-12, P4-15, P4-16 | PARTIAL | Chat [3a–3c][knowledge], [6b][trail]: only person/assistant-notes/group scopes, no group approval, no hierarchy or cross-group store | 6 |
| Correct/forget/pin/preferences, conflicts and omission | P4-13, P4-15, P4-16 | PARTIAL | Chat 3b/6b offer Undo but no complete editor, revision conflict, cleanup failure or capped-context state | 6 |
| Nightly memory maintenance trail | P4-17 | NEW | Chat 6b supplies the trail shell; need merge/contradiction/expiry, source links, skipped and held-spend states | 6 |
| Account, preferences and persona entry | P4-18 | PARTIAL | Chat [13a][account]: remove invented device count/global sign-out and department hierarchy; add save-unknown/no-assistant/access-changed | 7 |
| Sign-in, identity-provider handoff and rejection | P4-28 regression | PARTIAL | Chat [1a/1b/1d][signin]: preserve SSO and rejection; email fallback is unavailable in the current product, so exclude active magic-link frame 1c | 7 |
| Four-step survey | P4-19 | PARTIAL | Chat [1e–1h][survey]: flat-group context, tasks grant no skills, saved progress and validation | 7 |
| Persona revision review, approve, edit and restart | P4-19 | NEW | Chat 13a and 1e–1h point towards it; no complete revision/review screen | 7 |
| Welcome, interrupted completion and no-assistant variant | P4-20 | PARTIAL | Chat [1i/5a/8a/11a][welcome]: deterministic saved exchange, truthful no-monitoring copy and independent read-only archive | 7 |
| Provider list, six-step setup and key rotation | P4-21 | PARTIAL | Org-admin [1c–1e, 3a/3b/3d][admin-models]: cost/unknown-price refusal, rotation invalidates tests, save reconciliation | 8 |
| Model grants, routing and provider retirement | P4-22 | PARTIAL | Org-admin 3a/3c/3d: actual dependencies, replace/pause and stop new calls; replace “The server decides” | 8 |
| Routines: list, schedule, detail and run history | P4-24, P4-25 | PARTIAL | Org-admin [7d/7e][admin-routines], 6a: company account, payer, daily/weekly/DST, owner-bound Ask, pause/reassign/skip/unknown; no workflow builder | 9 |
| Spending by group/assistant/root/routine | P4-26 | NEW | No matching supplied spending frame; reuse org-admin table/forms and 6a, with P3 budget/effect contracts | 3 |
| Overview, navigation and shared status patterns | P4-27 | PARTIAL | Org-admin [2a–2c][admin-overview], 1i/1j, [6a][admin-states]: Routines and spending destinations, correct actions/dependencies | 10 |
| Organisation change-history list and safe detail | P4-27 | NEW | Navigation names it; chat 6b and org-admin 6a are references, not a complete org-history screen | 10 |
| Complete company-product qualification | P4-28 | COVERED | No additional product screen: use all preceding rows, including sign-in and inherited P3 journeys | Reuse inventory |

Prompts 1–3 come first for open Phase 3 work. Prompt 3 also describes the later
P4 spending extension so the same page is designed once. Then prioritise
4 → 5 → 6 → 10 for the Phase 4 isolation/qualification path, bringing 7–9 in
before their dependent features and the final overview. Provider prompt 8 can run
alongside prompt 4 at the initial P4 frontier. This ordering does not change ticket
dependencies or the Phase 3 live-PASS gate. Prompt 1's real group audience is
completed with P4-1/P4-23; it does not introduce group management into Phase 3.

## 2. Ready-to-paste prompts and 3. Return to us

Each numbered prompt stands alone. Its **Return to us** list immediately follows
the fenced block. Return desktop (1280px) and 390px frames for every named state,
with stable names, interaction links, focus/keyboard notes and reduced-motion
variants; compact state sheets are fine when they show the full affected area.
The handoff must distinguish designed behaviour from live implementation evidence.

### 1. Integrations, My tools and destination access

```text
Extend the owner's existing OpenCrane project in Claude Design. Produce a
high-fidelity handoff, not application code. Build on Workspace Live, the 8b–8j
chat states, org-admin 4a–4g, org-admin 6a shared states, and the 7h texture and
motion set. Use org-admin 4b/4c for setup, 4d/4e for access, 4f for comparison,
4g for removal, and chat 13a for the My tools entry. Keep the existing logo,
DM Sans/DM Mono, colours, paper surface, quiet status glyphs and spacing.

Users/jobs: Amina Wanjiku, an admin at Kijani Supplies, reviews and publishes
integrations and controls access. Alex Kim connects their own account in
Settings → My tools. Cover P3-4/6/7/8/9/10/20 and the P4-23 group extension.
Keep these as related admin/register and personal-connection pages; do not mix
private credentials into the organisation register.

Design the register, source/admission detail, tools/access review, company
connection, per-tool update comparison, removal review, My tools list/detail,
bearer connect/replace/revoke, OAuth handoff/return and destination policy editor.
Sample: “Odoo Community — 2 tools”; read_draft_order and update_draft_order_note;
personal profile “Alex · Odoo”; optional company profile “Kijani orders bot”.
Show scopes before consent. Use masked empty secret fields, never sample keys.
Use safe change reference chg_7F3K, checked 4 Oct 2026 at 08:40 UTC.

Required states, with named variants:
- Empty: “No integrations yet”; “You have not connected Odoo”; no destinations
  allowed. Draft: review not finished; nothing available to an assistant yet.
- Loading: list skeleton; discovery; image checks; publishing; account saving;
  OAuth completing; private instance “Waking your connection”. Disable only the
  affected submit. A sleeping instance is normal after five idle minutes.
- Success: keep Installed, Connected, Allowed for and Available to the assistant
  separate, each with its evidence. Reviewed/published is not a grant. Ready
  requires publication acknowledgement. Connected means this named account.
- Access: Allow automatically / Ask / Block for EVERY tool, reads included.
  New tools start Block. Show requester and assistant both need current grants.
  P3 uses available people/assistant audiences; P4 adds real flat groups such as
  “Sales team · 12 people”. Explain direct versus group access and missing rights.
- Hosted admission: immutable image digest, publisher/signature, dated malware
  and vulnerability checks, reviewed licence evidence. Separate pending,
  unsigned/tampered image, unacceptable or unknown licence, Critical/High finding,
  stale scan and scanner unavailable. A passed scan still needs tool review.
- Drift: “Odoo is paused: its tools changed”; added/removed/schema-changed rows,
  expired check or failed watch, new tools blocked, review/publish in progress,
  restored with fresh evidence. Old versions do not keep serving; existing
  approvals cannot authorise the changed schema. Do not offer rollback.
- Personal bearer/OAuth: consent required, cancelled consent, wrong account,
  expired consent, failed refresh, revoked profile, connected, replacement saved,
  reconnect and removed. Clear secret input after acceptance. No personal
  profile means no silent company/other-person fallback. Private instance
  unavailable or requiring a lasting startup secret has an explicit reason.
- Company setup: explicit admin opt-in; “Odoo records Kijani orders bot;
  OpenCrane records Alex as requester.” Discovery-only validation is labelled
  “Checks the tool list only; gives nobody permission to use tools”. It is a
  separate admin-owned connection, not a member's credential fallback.
- Errors: failed safely before change (“Nothing changed — try again”); missing
  data/scopes; unavailable identity/secret service; stale edit conflict; role or
  grant revoked while open. Clear protected data on access loss. If a response
  is lost, show “Outcome unknown” and Check status for chg_7F3K, never blind retry.
- Removal review: actual affected people, assistants and dependent routines;
  missing dependency data blocks confirmation. “Remove for 12 people”; past
  history stays, upstream Odoo user is not deleted. Show removed and failed/unknown.
- Destination policy: admin chooses permitted person/assistant, exact HTTPS
  destination and port, e.g. registry.npmjs.org:443 and github.com:443. Show
  empty, loading, saved, invalid/private destination, denied role, revoked rule,
  stale edit and unknown save. No wildcard bypass or private Git credentials.

Interactions: register filters All/Needs attention/Pending review; row → detail;
review → consequence summary → scoped confirmation. My tools returns to the
interrupted chat after a confirmed connection, without resending an action.
Tab/Shift+Tab follow navigation, filters, rows, editor, review, actions. Arrow
keys operate radio/segmented choices; Enter/Space activate; Escape closes an
overlay and restores focus without submitting. Show labelled Back/Cancel.

At 390px use the rail as a menu, stacked rows and full-width primary actions;
detail/review panels overlay rather than squeeze the page. All targets ≥44px.
The linked chat keeps its composer docked above the keyboard; settings has no
composer. Keep scopes, consequences and long names readable without clipping.
Accessibility: 2px visible focus, labelled fields and errors, glyph plus words,
polite progress/results, focus trapping/restoration in modal panels, no secret
announcements. Use sufficient text contrast. Reduced motion freezes 7h loops.

Out of scope: new visual language, new integration marketplace, directory sync,
group hierarchy, generic policy language, skill/workflow authoring, real secret
values, automatic connection fallback and new backend behaviour.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- Register, admission, access, drift, removal and destination-policy state sheets.
- My tools bearer/OAuth/private-instance journeys and company/validation variants.
- Desktop/390px review and recovery frames, including revoked access and unknown saves.

### 2. Governed chat, computer control and screenshots

```text
Extend the owner's existing OpenCrane project in Claude Design with a
high-fidelity workspace handoff. Build on Workspace Live, the 8b–8j chat states,
org-admin 4a–4g for account/access wording, org-admin 6a shared states and the
7h texture and motion set. In particular preserve 8f's quiet tool lines, 8g's
orange approval edge, 8e's file cards, 8i's panel and 8j's phone anatomy. Keep
the current logo, fonts, spacing and tokens; do not redesign the workspace.

Users/jobs: requester Alex Kim works on a draft Odoo order, reviews a change,
understands a refusal, watches/takes control of the computer and captures a
screenshot. Participant Grace can view/capture only with current conversation
and computer-audience access, but cannot take control just by being a participant.
Cover P3-5/12/14/17/18/20/21. Put these flows in the existing chat, Files/Activity
panel and computer overlay, not a separate operations dashboard.

Sample: #order-so-1042. “Read draft order SO-1042 — 12 cartons of printer paper.”
Approval: update_draft_order_note; target SO-1042; exact text “Deliver after
10:00 on Tuesday”; Odoo at erp.kijani.example; account “Alex · Odoo”; consequence
“Changes the draft note immediately; does not confirm the order.” Show actual
expiry timestamp and requester. Do not copy the old €5,000 sign-in threshold.

Required states:
- Empty transcript/Files/Activity; viewer not yet opened; no screenshot yet.
  Loading tool result, connecting viewer and checking current access.
- Running, successful read, approved write confirmed by readback, completed
  after an evidenced safe retry; sanitised tool details. Do not invent retry
  counts. Unsupported native consent says it cannot grant tool permission.
- Approval requested, submitting, approved, consumed/used, denied, expired,
  cancelled, changed arguments/order/schema/profile and revoked grant. Missing
  consequential detail prevents approval. Only the bound requester can decide;
  other authorised readers see “Waiting for Alex” without approval buttons.
  “Sign in again” appears only when the server requires it. Pending cards return
  above the composer after reconnect; terminal cards collapse and stay terminal.
- Safe pre-dispatch failure may retry the same request. A lost write reply or
  lost computer gives “We could not confirm the change — Check status”. Check
  reads evidence, never resends the write. Show still unknown and confirmed
  changed/not-dispatched outcomes separately. Odoo's own denied rights remain
  denied even after OpenCrane approval; never suggest using an admin account.
- Budget stop remains visible: “Sales team monthly limit reached: €200.00.
  Resets 1 Nov 2026, 00:00 UTC. Ask an admin to review the limit.” Variants for
  global and assistant limits, still-held spend and an already-dispatched call.
  Delayed approvals cannot continue stopped work. A new limit/month permits new
  checked work, never automatically repeats the interrupted action.
- Viewer: Connecting, Viewing read-only, Disconnected, Unavailable and Access
  changed. Fit/zoom are not control permission. Clear pixels on revoked access.
- Take control: review says all assistant threads on this computer pause;
  Taking control → all pauses confirmed → You are in control → Returning control
  → Agent paused/ready for new checked work. Show pause timeout/local command
  still stopping, another controller, wrong requester, lease expiry, disconnect,
  computer replacement and failed return acknowledgement. No writer before every
  pause succeeds; failures stay paused. Reconnect never silently restores control.
  Explicit Return control closes writer access; pending effects are not replayed.
- Screenshot: capture in progress, scanning/saving, durable saved PNG thumbnail,
  expanded preview and download. Sample “SO-1042-desktop.png · captured by Alex
  · 4 Oct 2026, 10:14 UTC”; safe computer/generation metadata in details. Save
  failure is not a saved file. Show disconnected capture, unavailable computer,
  rejected/oversized image, failed preview, expired link that needs a fresh
  access check, and revoked access with no image/name leak. Repeated capture
  submission returns one result; saved authorised files reopen after reload.
- Egress tool lines: “Installed the permitted package from registry.npmjs.org”,
  “Cloned the permitted repository from github.com”, loading, safe error and
  “Blocked destination: files.example.net”. Browser variants show allowed page,
  blocked redirect/subresource, unavailable network policy, expired capability,
  ambiguous requester and disconnect. Do not imply an allow bypass; unknown
  active requester means no browsing, including during takeover lease loss.

Interactions: tool line opens details; Activity jumps to its message; approval
opens readable details before decision; capture adds to transcript and Files;
thumbnail opens authorised preview. Tab goes rail → header → transcript/cards
→ composer; Enter sends, Shift+Enter adds a line, Stop is keyboard reachable.
Menus use arrows, Enter/Space and Escape. Overlay Escape closes/restores focus;
inside a controlling desktop distinguish keys sent to the computer from shell
shortcuts, with a labelled keyboard-accessible exit/Return control outside it.
Never trap a keyboard user in the remote desktop or make closing equal success.

At 390px: rail becomes a menu, computer/file/details panels become overlays,
composer docks above the keyboard, approval actions stack full width, all hit
targets ≥44px. Keep action text/account/expiry visible without horizontal scroll.
Accessibility: readable glyph-plus-word states, contrast and 2px focus, modal
focus management/restoration, labelled image capture/preview controls and a
text caption (not invented image contents). Announce start/end/wait/failure
politely, not streamed tokens. Reduced motion freezes the 7h loops and caret.

Out of scope: continuous recording, a new file service, a terminal redesign,
unrestricted browser/network access, participant/admin takeover substitution,
automatic effect retries, full A2UI catalogue and new approval policies.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- Odoo tool/approval/refusal and budget-stop workspace states, including expired/used approvals.
- Computer viewer, every takeover transition/failure, capture-to-file and preview states.
- Package/Git/browser refusal details and desktop/390px keyboard-control annotations.

### 3. Spending and unknown-effect resolution

```text
Use the owner's existing Claude Design project to design the missing spending
page and its resolution drawer. Build on Workspace Live, the 8b–8j chat states,
org-admin 4a–4g review/table/detail patterns, org-admin 6a shared states and the
7h texture and motion set. Preserve fonts, logo, tokens and the administration
shell; use the existing chat panel for links back to authorised work.

Users/jobs: Owner/Admin Amina checks an uncertain external effect without seeing
private prompts, then settles actual usage or releases a proven unused hold.
Later she sets named group/assistant ceilings and follows root/routine spending.
P3-15 needs the resolution view first. P4-26 extends this same page with real
group, assistant, root and routine selection; do not gate P3 on those controls.

Design monthly spending summary, scope selector, limit edit/review, safe detail
and unknown-effect evidence/resolution panel. Sample October 2026: Sales team
limit €200.00, settled €84.20, reserved €6.30, available €109.50. One held call is
€1.20 of that €6.30, reference req_1042. Format EUR for people; values and input
validation are integer euro cents (20000, 8420, 630, 120). No fractional cents.
Show global, paying-group, optional assistant monthly ceiling and daily safety
cap separately. They are views of the same charge, not three bills to add up.

Required states:
- Empty: no usage this month; no uncertain effects; no groups/assistants available.
  Loading summary/evidence; read failure with last-loaded timestamp; unavailable
  audit or budget service; permissions changed, with protected details cleared.
- Ready: settled versus reserved visibly separate, period and UTC reset shown.
  Group and assistant are named; include root/descendant and routine safe ids,
  fixed payer and links only where current rights permit. A root allowance is
  capacity, not another provider charge or money automatically spent.
- Unknown: “Final usage was not received. €1.20 remains reserved.” Reasons
  include lost reply/computer, unknown tariff and conflicting evidence. Check
  status reads the original evidence; it does not repeat the external action.
  Waiting, still unknown, fresh evidence found and late settlement are distinct.
- Resolution review: evidence source/reference, observed effect, original held
  amount, proposed actual charge in cents or proof of non-dispatch, and reason.
  Example readback “SO-1042 note matches the approved change”; no credentials,
  raw arguments or private transcript. Confirm exact settlement or release.
  Missing/insufficient/conflicting evidence blocks confirmation and keeps hold.
- Saving, confirmed once, lost acknowledgement/Check status, already resolved
  by another admin, revision conflict/refresh and denied resolver. Duplicate
  clicks do not create another charge. A late larger actual charge is not erased.
- Limit edit: valid, invalid/fractional/overflow/negative, zero hard stop,
  concurrent change, applying, saved, failed-safe-to-retry and unknown. Review
  lowering a limit explains cancellation of affected work and descendants;
  dispatched usage still settles. Revoked admin rights block confirmation.
- Exhausted global/group/assistant/daily scopes; affected work and admin remedy.
  On 1 Nov at 00:00 UTC, show new monthly headroom while an October hold stays
  attached to October. Timeout/month rollover never means a refund. Missing
  price means refused work, never free work. Changing a personal default payer
  affects new roots only; admitted roots/routines do not switch payer.

Interactions: choose period/scope → inspect safe row → Check status → review
evidence → confirm resolution. Filters preserve selection on refresh; links
cannot reveal private content merely because the viewer is an admin. Editing a
ceiling has a separate consequence review. Tab/Shift+Tab follow selectors,
summary, rows and panel actions; arrows select choices; Enter/Space activates;
Escape cancels/closes and restores focus without applying a change.

At 390px the rail is a menu, tables become stacked labelled rows, panels overlay,
primary actions are full width and all targets ≥44px. Keep amount, state and
period together. Linked chat has a docked composer above the keyboard; spending
has no composer. Accessibility: no colour-only balances; labelled units and
errors; readable contrast, 2px focus, modal focus handling, polite save/status
announcements, reduced-motion/static 7h states. Do not announce private evidence.

Out of scope: invoices, payments, exchange rates, price editing, a finance
engine, a second audit ledger, timeout refunds and automated uncertain retries.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- P3 unknown-effect inspection, evidence review and conflict/held/resolved variants.
- P4 spending summary, scope/root/routine details and ceiling-change review.
- Desktop/390px zero-limit, rollover, unknown-save and revoked-admin states.

### 4. People, flat groups and shared assistants

```text
Extend the owner's OpenCrane Claude Design assets at high fidelity. Build on
Workspace Live, the 8b–8j chat states, org-admin 4a–4g access/consequence patterns,
org-admin 6a shared states, and the 7h texture and motion set. Specifically reuse
chat 13b inline invites, org-admin 1a/1b and 5a–5e member screens, and chat 12a/12b
assistant selection. Keep the established type, colours, logo and spacing.

Users/jobs: Amina manages Kijani Supplies members and flat groups; owner Marieke
appoints a successor; Alex selects a group assistant for private work. Cover
P4-1/2/3/7. Design People & groups list/detail/create, membership add/remove,
invite panel, role/departure review, owner transfer/step-down, and a group's
shared-assistant create/detail with its linked member-selection entry.

Sample: Sales team, 12 members; Nairobi office, supplied by Microsoft Entra ID;
Alex Kim, Member; Marieke Vos, Owner; Grace Achieng, active successor. Use
alex@kijani.example and grace@kijani.example. Long-name test: “Regional purchasing
and supplier relationship coordination”. Shared assistant “Sales assistant”,
owned by Sales team, paying group Sales team, one computer, explicit tool/model
grants. Group membership does not reveal private conversations or memory.

Required states:
- Empty groups/members/search; no eligible colleagues or assistants; loading
  list/detail/effective-access/ownership inventory; validation and duplicate
  submission; saved/created success. Failed reads show safe last-loaded data and
  timestamp, except after revocation when protected data must disappear.
- Local membership editable; supplied identity-provider membership locked with
  source and next step. Role and groups are separate. “What Alex can use — and
  why” lists direct/group grants, missing account and assistant rights, without
  granting private conversation or desktop access. No group nesting/departments.
- Membership removal review, applying, removed, stale conflict, denied role,
  unavailable identity service and access changed mid-edit. Group-derived live
  access stops within two seconds; stale selections never silently restore it.
- Invites: Active/Pending search and exact counts; intended verified identity,
  Member default, seven-day expiry, provision personal assistant selected by
  default and explicit no-assistant choice. Unresolved/outside-organisation
  identity is unavailable, not an email-created member or policy exception.
  With no mail delivery: “Link created. No email was sent”, Copy link, copied,
  wrong account, expired, accepted, provisioning and provisioning failure.
  Lost save acknowledgement uses Check status, not another invitation.
- Role change: Member/Admin options within caller authority; owner transitions
  use the owner flow. Read-only viewer sees the required role. Ownership
  transfer is owner-only: active successor review → appoint → both are Owners.
  Separate “Step down” review/action; never imply automatic transfer-and-removal.
  Show inactive successor, last-owner conflict with Choose another owner,
  concurrent removals, authority pending, save unknown and confirmed success.
- Departure: actual access lost, retained history/private-content limits,
  owned shared assistants/routines needing reassignment or explicit retirement,
  missing dependency data that blocks confirmation, applying/removed/unknown.
  Rejoin says old grants, credentials and ownership are not restored automatically.
- Shared assistant: draft/create, explicit owner group/grants/payer review,
  provisioning, ready, busy/queued, failed, removed and permission revoked.
  Repeat creation returns the same assistant. An additional assistant is an
  explicit additional computer, not a capacity slider. Member selection opens
  “Your private session with Sales assistant”; two members have separate context
  and personal profiles. Desktop access is separately granted. Memory is not
  advertised as available until its later qualified feature is enabled.

Interactions: group row opens membership/assistant detail; inline add/search;
member row opens role/groups/access; invite opens above the list. Confirmations
repeat the person/group and consequence. Assistant selection confirms an allowed
paying group before work starts; the payer stays fixed for that root. Keyboard:
Tab through navigation/search/rows/forms, arrows for selectors, Enter/Space to
activate, Escape to close/cancel and return focus; no destructive row-click.

At 390px the rail is a menu, member/group tables become stacked rows, detail and
review panels overlay, and all targets ≥44px. The linked chat composer docks
above the keyboard; administration has no composer. Long names wrap. Use
full-width primary actions. Accessibility: semantic lists and labels, explicit
required/read-only/source text, focus management and a 2px ring, glyph plus words,
polite progress/results, sufficient contrast and reduced-motion 7h variants.

Out of scope: CSV export, directory-sync engine, hierarchy/group deletion,
implicit private-content access, global account administration, unverified
external invitations, skill ownership and new assistant deployment controls.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- Group/member/invite and effective-access frames, including long names and IdP locks.
- Transfer/co-owner/step-down/last-owner and departure dependency reviews.
- Assistant provisioning/detail/selection with desktop/390px failure and revocation states.

### 5. Human chats, child threads, delegation and recovery

```text
Extend the owner's existing Claude Design project. Build directly on Workspace
Live, the 8b–8j chat states, org-admin 4a–4g for access/account consequences,
org-admin 6a shared states, and the 7h texture and motion set. Reuse chat 12a/12b
drafts, 10a–10g full-page child threads, and chat 6a Subagents. Keep the familiar
rail, quiet tool lines, fonts, logo and paper; child transcripts are full pages,
not embedded in the old Subagents panel.

Users/jobs: Alex and Grace message each other and the Sales group without AI;
Alex explicitly asks Sales assistant from an own group message; colleagues
follow the child, refine it and review what returns to the parent. Alex can stop
delegated work and resume their own private session after a computer replacement.
Cover P4-4/5/6/8/9/10/11/14 and the member workspace side of P4-7.

Sample parent #supplier-review, message “Compare the two delivery proposals”;
child “Compare delivery proposals”; interim “Both offers are read; checking
delivery dates”; final “Choose the Tuesday delivery; it meets our deadline”;
eligible final asset delivery-comparison.pdf. Private member work stays private.

Required states and corrections:
- Empty/recent/archived/no matches, loading and more-results loading, long title,
  read failure, reconnect/caught-up, unavailable and removed access. New session
  stays a draft until first send. To: one colleague means two-person direct;
  several people/explicit flat-group snapshot means human group; one assistant
  means agent session. Mode locks at first send. Unsupported assistant/person
  combinations are refused, not the old 12b automatic mixed-mode promise.
- Direct/group sent/delivered/reloaded, failed-safe-to-retry and unknown send
  acknowledgement with same-message status recovery. Ordinary human messages
  have no model, Stop, memory or assistant controls. The explicit group summon
  entry appears only where permitted; typing plain @agent does not dispatch.
- Participant picker: none eligible, denied/stale selection, long names, adding
  explicit people, removal and applying/saved/error. Only the creator manages
  group participants. Show audience/history boundary before confirmation; group
  membership changes never silently change a private chat's participants.
- Archive/unarchive affects only my list; unread position survives devices.
  Separate permanent Close review → closed/read-only. A child and parent can
  close independently. Revoked access clears transcript, drafts, names, files,
  counts and late results. Unknown/foreign ids show the same unavailable state.
- Selected @agent on Alex's own visible group message: authorised assistant,
  explicit child audience and fixed paying group review; queued/starting, ready,
  failed start, lost acknowledgement, retry of the same intent, denied summon.
  The source message stays; reconciliation must not create a second child.
  No eligible assistant means no autocomplete, not a broken control.
- Parent summaries: starting, working, waiting, retrying, completed, completed
  after retry, failed, cancelled, closed and restricted. Show only observed
  counts/attempts; never promise “nothing changed externally” without proof.
  Parent has no child token stream/tool logs. Restricted summary says only
  “Agent thread restricted”: no question, title, result, filenames or counts.
- Full-page child breadcrumb, collapsible origin, run completion crease and
  independent unread state. Back returns to the parent source-message position.
  A follow-up starts one serial turn as its sender, never another person's
  private execution context. Other participants cannot answer Alex's approval.
  Child-only late invitees may see existing shared child history, with a
  restricted origin and no parent link/access. Show explicit late invitation
  review, accepted/denied/unknown and loss of inherited rights on parent removal.
- Publication: completion prepares a draft only. Final AND interim require
  review of exact text, immediate-parent audience, source, publishing person
  and eligible final assets. Preview → publish → one credited parent entry.
  Show changed payload/stale review, closed/revoked parent, child-only reader,
  inaccessible asset (without filename leak), sharing required through separate
  explicit authorised file sharing, saving and unknown acknowledgement. Never
  automatically copy private memory, raw tool output or child history.
- Subagents panel: empty, running, completed, failed, cancelled, partial result,
  unavailable/restricted link. Show one root allowance €10.00, settled €2.40,
  reserved €1.10, remaining capacity €6.50, paying group Sales team. Descendants
  consume that allowance, not another charge. Stop/exhaustion cancels the tree;
  stopping, stopped, already-dispatched unknown effects and revoked rights stay
  visible. New serial follow-up gets a new admitted root, retries do not.
- Private recovery: connection lost, recovering authorised context, resumed
  fresh thread, context unavailable and memory admission disabled. No invented
  completed reply after lost context. “Local file and browser writes are not
  available while private memory is loaded. Start a fresh memory-free turn.”
  That action explains the boundary and requires a new checked turn; it never
  carries the private instructions into persistent files or replays unknown work.

Interactions/keyboard: Tab rail → header → transcript → summary/ask → composer;
Enter sends and Shift+Enter adds a line. To/mention lists use arrows, Enter to
select, Escape to dismiss. Summary opens the relevant child location; Back
restores focus/scroll. Keyboard-visible Stop reaches all descendants. Review
dialog traps focus and Escape returns it; cancel never publishes or closes work.

390px: rail as menu, Files/Activity/Subagents as overlay panels, full-page child
with collapsed origin, docked composer above keyboard and ≥44px targets. Stack
review actions and wrap long breadcrumbs. Accessibility: clear mode labels and
audience text, 2px focus, contrast, glyphs plus words, polite state announcements
without token-by-token speech, new-message indicator when reading older content,
no forced scroll/focus jump, reduced motion using the existing frozen 7h set.

Out of scope: new chat engine, automatic final publication, generic sharing
framework, cross-computer delegation, unrestricted memory-bearing disk tools,
invented retry evidence and permission granted by a group label or link.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- Direct/group/agent draft and lifecycle sheets; participant and close reviews.
- All child summary states, child-only/revoked views, summon and reviewed publication.
- Subagent budget/Stop and private recovery states, with desktop/390px navigation paths.

### 6. Knowledge, preferences, pins and nightly maintenance

```text
Extend the owner's existing OpenCrane Claude Design assets. Build on Workspace
Live, the 8b–8j chat states, org-admin 4a–4g for clear audience/access wording,
org-admin 6a shared states, and the 7h texture and motion set. Reuse chat 3a–3c
and 6b as the knowledge/trail shell, 3b's quiet receipt and 13a's Preferences
entry. Preserve the design language while correcting the old scope/approval
behaviour. Cover P4-12/13/15/16/17, with P4-14 recovery as an entry dependency.

Users/jobs: Alex remembers preferences privately; Sales members store shared
facts without approval; permitted assistant users inspect shared notes. People
search, correct, forget and pin facts, and inspect what nightly maintenance did.
Admin status alone gives no right to read their memory. Use only the scopes
“Personal · Alex”, “Group · Sales team” and “Assistant notes · Sales assistant”,
with each actual audience spelled out. No organisation, department, project
hierarchy, multi-scope copy or group approval queue.

Sample personal fact: “Use UK English and put the answer first.” Shared fact:
“Kijani's Tuesday deliveries arrive after 10:00”, sourced from an authorised
group message. Shared assistant note: “Delivery checks use the draft order
reference”, sourced only from group-visible material. Never turn Alex's personal
facts/model output into shared notes automatically. An explicit member-authored
shared statement is allowed. Scope colour is not meaning; keep glyph plus text.

Design the bounded list/search, fact detail/source, store/edit/forget/pin forms,
Preferences entry, memory receipts/batch trail, Decisions tab and a maintenance
detail within that trail. Required states:
- Empty memory, no search results, loading/searching, paged results, saved and
  batch saved (“3 facts stored in Sales team”), per-item Undo. Personal auto-store
  and member group-store are receipts, not approval decisions. Undo means Forget.
- Missing source, source no longer accessible, permission denied, fact unavailable,
  revoked scope and service unavailable. Never leak hidden fact ids, counts or
  snippets. Source links require their own access. Late responses cannot refill
  a cleared panel. Decisions shows authorised audit entries, not raw private logs.
- Store/edit: permitted scope, fact/source/kind, pin and expiry where applicable;
  validating, too much text, applying, saved, safe failure, unknown acknowledgement
  with Check status for the original change. No browser-only saved claim.
- Correction: current revision, edited text/source, preview, corrected receipt;
  another edit arrived → refresh/review instead of overwrite. Stale or revoked
  edit refuses. Never silently overwrite a concurrently forgotten fact.
- Forget review: removes the fact and dependent copies from usable memory;
  independent chat messages and backups are not erased by this action. Show
  applying, hidden/cleanup pending, forgotten, cleanup unavailable and conflict.
  Failed cleanup never makes the forgotten text visible again; history shows
  safe metadata, not the erased text. No misleading Restore/Undo-forget control.
- Preferences stay personal; pin/unpin saved and conflict states. Pinning grants
  no new rights. At the configured initial-context cap, “Some saved facts were
  not included in this turn. They are still searchable.” Show omitted pins,
  unavailable memory, revoked scope and “Context refreshing before work continues”
  after correction/forget. Do not promise ongoing work still uses old context.
  Illustrate current draft limits as annotations: 16 KiB total initial memory,
  4 KiB per fact, recall up to 20 results/16 KiB per page; these are configurable
  spec defaults, not new fixed product promises.
- Nightly trail: no maintenance yet, scheduled for 02:00 UTC, loading/running,
  “2 duplicate facts merged”, contradiction flagged without invented resolution,
  stale unpinned fact expired, pinned fact kept, source/revision/time links.
  Each run names exactly one permitted scope, owner, assistant and paying group.
  Show no changes, failed safely, owner/grant revoked, unavailable identity,
  unknown model price, budget exhausted, uncertain attempt with held spend and
  stale output discarded after a correction/forget. Sample “€0.18 settled;
  €0.12 reserved” within a €1.00 scope/night allowance. Check status never launches
  another uncertain call. No combining private and group inputs, no resurrected
  forgotten source or derived fact after a merge.

Interactions: scope → bounded search → fact → authorised source or edit;
inline receipt Undo → forget outcome; batched receipts open each fact. Edit and
forget confirmation name scope/audience; pin toggles announce saved state only
after acceptance. Tab/Shift+Tab reach tabs/search/rows/actions; arrow keys switch
tabs and choices; Enter/Space opens/activates; Escape closes overlays with focus
restored. Decisions and Memory switch within the existing panel.

At 390px the rail is a menu; narrow memory/detail panels become full-width
overlays with a Back control; chat composer stays docked above the keyboard
when chat is visible. Use ≥44px targets and full-width review actions. Source
text and long facts wrap. Accessibility: field/error associations, labelled
scope and pin state, visible 2px focus, readable contrast, glyph plus words,
polite saved/deleted/conflict announcements, focus managed after deletion and
reduced-motion/static 7h variants. Do not read forgotten text in notifications.

Out of scope: knowledge graph, vector/document-ingestion product, general scope
promotion, cross-group copying, group approval queues, disk-based SOUL.md or
memory, transcript renderer, automatic contradiction decisions and backup erasure.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- Memory/search/source, batch receipts, preferences and pin/omission frames.
- Correction, forget/cleanup, conflict and scope-revocation state sheets.
- Nightly merge/contradiction/expiry and failed/held-spend trail, desktop and 390px.

### 7. Account, survey, persona review and welcome

```text
Extend the owner's existing OpenCrane project in Claude Design. Build on
Workspace Live, the 8b–8j chat states, org-admin 4a–4g for My tools/access links,
org-admin 6a shared states and the 7h texture and motion set. Use chat 13a account,
1e–1h four-step survey, 1i/5a first welcome, 8a completion and 11a no-Agent as the
specific starting frames. Keep the existing typography, logo, paper and spacing;
preserve 1a/1b/1d SSO, handoff and rejection. Email sign-in is unavailable in
the current product: show its disabled state, not an active fallback or the 1c
magic-link-sent flow. Cover P4-18/19/20 and the existing #33 outcome.

Users/jobs: new colleague Alex sets personal preferences, reviews a version of
their assistant's persona, completes a resumable welcome and later edits their
own account/preferences. Grace's invitation has no personal assistant; she must
still finish a truthful welcome and start direct/group chats.

Design account/preferences, all four survey steps, persona review/edit/restart,
welcome interrupted/completed and no-assistant variants. Settings replaces the
rail with Back to workspace. Show verified identity and silo; SSO name/email and
supplied role/group fields are read-only with their source. Preferred display
name is editable. Personal assistant card links to persona review; My tools
opens existing personal connections. No invented device count/global sign-out.

Sample identity Alex Kim, alex@kijani.example, Kijani Supplies. Survey:
1. “What should I call you?” Alex; optional they/them or Skip.
2. “What do you do here?” Purchasing coordinator; current flat Sales team
   context read from membership, not an editable department grant.
3. Direct tone, Brief, cite sources.
4. Draft documents and compare supplier proposals; optional own task.
Selections do not join groups, enable tools or install skills. Replace that
promise in old 1h. Review/welcome also covers UK English, challenge (“Point out
weak assumptions”), initiative, habits and memory/risk boundaries. These cannot
weaken tool Ask/Block, access checks or budgets.

Required states:
- Sign-in: SSO ready, handing off, rejected with a safe retry/sign-in path;
  email fallback explicitly disabled: “Email sign-in is unavailable”. This
  does not add a new authentication method.
- Empty optional preferences and untouched survey; loading account/progress;
  step validation, safe save error, unavailable saved progress, save pending,
  saved/resumed at the right step and outcome unknown/Check status. No claims
  of saved browser-local authority. Preserve entered non-secret values on safe
  failure, but clear protected content if the session/access is revoked.
- Persona review: human-readable proposed revision, “Only your personal turns
  use this”, explicit Approve this version, edit/replace, restart consequence
  review and approved receipt. “SOUL.md” may label the reviewable persona, but
  explain it is private instructions, not a shared file on the computer. Show
  no persona yet, validation, changed revision on another device, stale approval,
  saving, save unknown, unavailable and denied access. Approval must select the
  exact reviewed revision; restart does not silently approve the replacement.
- Welcome: saved ordered exchange, e.g. “What would make this week easier?” /
  “A concise comparison of our two suppliers.” Resume after interruption at the
  unanswered question. Completing and duplicate/concurrent completion reconcile
  the same result. Finish with the person's answer, assistant confirmation and
  completion crease. Sample confirmation: “Your preferences are saved. You can
  start a new chat when you are ready.” No unconfigured background monitoring.
- Completed welcome is a distinct read-only entry with explanation in place of
  the composer and Start a new chat. It can be archived for this person without
  reopening or becoming an ordinary assistant run. Show archived and restored
  list entry using 8b, without adding a new onboarding status dashboard.
- No assistant: “No personal assistant assigned yet. You can chat with colleagues
  now.” Direct/group drafts work; agent-session entry waits for assignment.
  Later provisioning does not rewrite/reopen the recorded welcome. Show account
  card with no assistant, provisioning and unavailable links truthfully.
- Access/session expired, wrong person's settings, missing progress and
  unavailable preference service get clear recovery paths. No participants or
  model picker mounts anywhere in onboarding. Completion uses a saved scripted
  exchange; do not design a paid model or free-form chat dependency to finish it.

Interactions: Back/Continue preserve confirmed progress; Skip applies only to
optional fields; review links back to its field; restart names what will be
replaced. Tab/Shift+Tab follows fields then Back/Continue; arrow keys select
choices, Space toggles task/citation choices, Enter activates the focused action.
In the welcome composer Enter sends and Shift+Enter adds a line. Escape cancels
review overlays and restores focus; never silently discards approved revisions.

390px: workspace rail becomes a menu; settings Back remains visible, panels
overlay, survey choices stack, primary actions are full width, welcome composer
docks above the keyboard and all targets ≥44px. Accessibility: meaningful step
heading/progress, optional/required labels, source/read-only text, associated
validation, contrast, 2px focus, focus on the new step heading, polite save and
completion announcements, reduced-motion/static 7h completion crease.

Out of scope: new sign-in methods, device management, global sign-out without
a supported endpoint, billing, department hierarchy, skill installation,
onboarding-created authority, persistent persona files and monitoring promises.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- Supported SSO/unavailable-email states, account/preferences and all four survey steps.
- Saved/validation/unknown variants for account and survey.
- Persona review, exact-version approval, edit/restart and concurrent-edit states.
- Resumed, completed/read-only, archived and no-assistant welcomes at both widths.

### 8. Providers, models and safe retirement

```text
Extend the owner's existing Claude Design project. Build on Workspace Live,
the 8b–8j chat states for authorised chat links, org-admin 4a–4g review/access
patterns, org-admin 6a shared states and the 7h texture and motion set. The page
itself must closely reuse org-admin 1c–1e and 3a–3d Models & providers. Preserve
the administration shell, DM Sans/DM Mono, logo, colours and spacing. Cover
P4-21/22; this can be designed alongside the early People & groups work.

User/job: Owner/Admin Amina connects and verifies a provider, chooses permitted
models from the existing eleven-model registry, explains who can use each, and
replaces or pauses affected work before retiring a connection. Use OpenAI and
Anthropic as provider examples. Current sample model rows: gpt-6.1-sol for chat,
gpt-6-astra for deep analysis, gpt-6-luna for frequent automation and summaries.
These are examples from the repository routing, not a new catalogue or prices;
do not enable old 3a model examples merely because they appear in that frame.

Design provider/model tables, detail, six-step setup, replace key, model access
editor, routing explanation and retirement review. Six steps are Provider →
Key → Verify → Models → Access → Done. Use connection name “Kijani primary”,
saved 4 Oct 2026 at 09:12 by Amina; change chg_7F3K. Password-style key field is
blank/masked, never a real or realistic key; no browser persistence or readback.

Required states:
- Empty providers/models, loading and stale-read timestamp, draft part-complete,
  validation error, role read-only and unavailable secret/gateway/identity data.
- Saving key, accepted and cleared input, saved but unverified, provider reachable,
  model answers with dated revision-specific evidence. Each check is separate.
  Warn before a priced, reserved test and allow Skip: “Connected, not tested”.
  Unknown price/budget refusal prevents a test; skipped test is not Ready or
  proof that a conversation works. No invented free verification call.
- Connection/test error with safe reason, test failed after storage, saving reply
  lost or reload mid-save → Outcome unknown and Check status for the same change.
  Only proven unchanged failure offers retry. Keep the unaffected rows usable.
- Replace/rotate key: consequence review, pending, accepted, fresh verification
  needed (old test evidence invalid), confirmed, conflict and unknown. Never
  display the saved secret or send it to chat; details contain metadata only.
- Model rows show enabled/disabled, provider, current supported task route and
  access sources: direct person, flat group, assistant. Example “Sales team;
  assistant grant missing”. Both requester and assistant need access; connection
  and model availability are separate from a grant. No unsupported enable switch.
  Include empty audience, loading access, changed grant, revoked role, stale
  configuration, unavailable IAM and saved access. Group revocation takes effect
  within two seconds; no stale Ready claim.
- Retirement review shows actual assistant/routine dependencies, valid replacement
  or explicit pause for each, active work and retained history. Replace old
  “The server decides” copy: new calls are fenced; already-dispatched usage
  still settles; interrupted work is not automatically retried elsewhere.
  Missing dependency data or invalid replacement blocks retirement. Show review,
  applying, retired, conflicting edit, role revoked, failure and unknown outcome.
- Done names exactly what was configured/tested and where to go next. No test
  conversation PASS or fallback guarantee beyond the evidence shown.

Interactions/keyboard: row opens detail; one primary action per row; setup
Back/Next and clear step progress; cost confirmation before test; retirement
confirmation repeats connection/scope. Tab/Shift+Tab through navigation, tables,
fields and actions; arrows choose provider/model/audience; Enter/Space activate;
Escape cancels a panel and returns focus without saving or exposing a key.

390px: rail becomes menu, tables become stacked labelled rows, setup/review
panels overlay, actions full width and targets ≥44px. Linked chat uses a docked
composer above the keyboard; provider pages have none. Long models/dependencies
wrap. Accessibility: named key field without speaking its value, labelled
step/check/error state, 2px focus, contrast, glyph plus words, polite progress,
modal focus restoration and the existing reduced-motion/static 7h rules.

Out of scope: new model catalogue/prices, automatic failover, FX, key readback,
global credential management, skill registry and a new configuration ledger.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- Provider/model tables, six steps, skipped/refused test and key-rotation states.
- Model access/routing explanation and complete replacement/pause retirement review.
- Desktop/390px unknown outcome, stale verification and revoked-role variants.

### 9. Routines: list, schedule, run detail, paused and needs-approval states

```text
Extend the owner's OpenCrane Claude Design project at high fidelity. Build on
Workspace Live, the 8b–8j chat states (especially 8g bound approval), org-admin
4a–4g company connection/access patterns, org-admin 6a shared states and the
7h texture and motion set. Start from org-admin 7d/7e schedule/recent runs/phone
approval, but make this a simple Routines page, not Skills & workflows. Keep
the existing fonts, logo, token values and shell. Cover P4-24/25.

User/job: permitted owner Peter Otieno schedules one assistant using an explicit
company connection and paying group, inspects results, answers Ask, and pauses,
resumes, edits or retires work. An admin can arrange explicit reassignment when
Peter leaves; admin status is not Peter's approval or personal credentials.

Sample “Morning draft-order check”: owner Peter, Sales assistant, instructions
“Read draft order SO-1042 and summarise delivery notes”, company profile “Kijani
orders bot”, payer Sales team. Every weekday is not a new recurrence type: offer
the specified daily or weekly choice; example weekly Monday 07:00 Africa/Nairobi,
next 5 Oct 2026, 07:00 EAT / 04:00 UTC. Show Runs as Peter and “Odoo records
Kijani orders bot; OpenCrane records Peter as requester”.

Design list/create/schedule/detail, next occurrence, recent runs, run detail with
session/audit/spending links, pause/resume/edit/retire/reassign reviews and owner
approval. Required states:
- Empty list/no runs, loading next/recent run, draft/validation error, missing
  assistant/company profile/payer, personal-only connection refused. Saved/ready
  names the next local and UTC occurrence; saving/failed-safe/unknown save uses
  the original change reference and Check status. Unavailable schedule/access
  data does not claim ready. Long names/time zones wrap.
- Scheduled → starting → running → succeeded with linked result and one spend
  attribution. Two scheduler notifications still show one occurrence. Show
  failed, cancelled, partial result and Outcome unknown with held spend; Check
  status reads evidence and never repeats a possibly dispatched effect.
- Ask waits for the recorded owner. Sample change-note approval: exact new note,
  SO-1042, Odoo destination/company account, consequence and actual expiry.
  Requested/submitting/approved/used/denied/expired/cancelled; changed tool schema,
  arguments, connection revision, ownership or revoked grant invalidates it.
  Expiry stops work; do not copy 7e's branch-manager approval or automatic skip
  fallback. Other authorised viewers see Waiting for Peter, with no Approve.
- Pause/resume/edit/retire: review consequences, applying, confirmed, conflict,
  safe failure, unknown acknowledgement and access changed. Pause/retire fences
  active work. Current owner can Stop the active root and all descendants;
  already-dispatched effects/uncertain charges stay visible. Editing must not
  change an active run's owner, payer, connection or approved arguments.
- Owner removed, assistant grant revoked, company connection revoked, unknown
  price, budget exhausted or unavailable identity → visibly paused/refused.
  Reassignment names the new active owner, rechecks rights/payer and affects new
  occurrences only. Old approvals end; never switch silently to admin credentials.
- Non-overlap: “Skipped — previous run still active”; missed occurrence after
  downtime; resume shows the next future slot with no catch-up burst. Run now
  is a reviewed explicit NEW occurrence, not retry of unknown work. Safe retry
  exists only when that same intent is proven not dispatched.
- Time-zone/DST review: show exact next run. Europe/Brussels at 02:30 on
  28 Mar 2027 is skipped because that local time does not exist; at 02:30 on
  25 Oct 2026 only the first occurrence runs. Show skipped reason and next slot;
  do not offer a general cron or workflow editor.

Interactions: list row → detail → specific run; result/session/audit links keep
current access checks. Schedule edit previews next occurrence before save.
Pause/retire/reassign review names affected active/pending work. Tab/Shift+Tab
through filters/rows/fields/actions; arrows operate daily/weekly, day and time
zone choices; Enter/Space activate; Escape closes overlays and restores focus.
In a linked run chat Enter sends, Shift+Enter adds a line; approvals have explicit
labelled buttons and are never decided by a generic Enter on page load.

390px: rail as menu; stacked routine/run rows; schedule/detail/review as overlays;
linked chat composer docked above keyboard; full-width approval actions and
≥44px targets. Keep owner, company identity, payer and expiry readable. Accessible
labels for date/time/time zone, readable 2px focus, glyph plus words, contrast,
polite next-run/status changes, modal focus management and reduced-motion 7h.

Out of scope: skill library, workflow builder, arbitrary cron/step DSL, personal
credential routines, automatic fallback/reassignment, backfill bursts, automatic
uncertain retries and approving another person's pending request.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- List/create/schedule/detail/run-history and linked result frames.
- Owner Ask lifecycle, pause/resume/edit/retire/reassign and interrupted-run states.
- Desktop/390px skipped/overlap/DST, revoked connection and unknown-effect variants.

### 10. Admin overview, navigation and change history

```text
Extend the owner's existing OpenCrane Claude Design project. Build on Workspace
Live, the 8b–8j chat states for linked authorised work, org-admin 4a–4g for
integration detail/review, org-admin 6a shared states and the 7h texture and
motion set. Specifically reuse org-admin 2a–2c task-list overview, 1i/1j stale
read/refresh, and chat 6b's Decisions trail for history density. Preserve fonts,
logo, spacing, quiet states and tokens. Cover P4-27; the journeys in P3-22/P4-28
need these existing surfaces, not a new qualification dashboard.

User/job: Amina sees what needs action across members, tools, models, spending
and routines, follows the one appropriate recovery action, and explains a
change through safe history. Ownership/admin rights do not reveal private
conversation text, memory facts, arguments, secret values or approval content.

Design the admin shell, overview task list, change-history filters/list/detail
and access-denied/unknown/stale states. Navigation: Overview, People & groups,
Models & providers, Spending, Integrations, Routines, Change history. Show only
permitted destinations; a permitted read-only page names the role needed to edit.
Replace Skills & workflows rather than advertise an unimplemented destination.

Sample tasks in this order:
1. “Check the Odoo note change — outcome unknown; €1.20 remains reserved” →
   Check status (safe metadata only, no private note).
2. “Reconnect Kijani orders bot — Morning draft-order check is paused; Sales
   team's 12 members are affected” → Reconnect.
3. “Review changed Odoo tools — calls paused until review” → Review tools.
4. “Invitation delivery unavailable — 2 links created, no email sent” → View links.
Then failures and Ready items with dated evidence, e.g. “Provider verified
4 Oct 2026 at 08:40 by a model test”. Use only actual counts/dependencies;
no invented score, background monitor or notification promise.

Required states:
- Empty setup with useful permitted next action; no tasks needing attention;
  no history/no filter matches. Loading, per-row applying/checking, ready and
  confirmed change. Only the affected action is disabled while other rows work.
- Draft/needs input, safe failure with explicit unchanged evidence, Outcome
  unknown, access changed, disabled/removed. Unknown or interrupted tasks precede
  needs-input tasks, then failures, then Ready evidence. One next action per row.
- Failed refresh retains previously authorised data with “Showing what we loaded
  at 09:40” and Refresh list; refresh progress replaces the error in place. Fully
  unavailable dependency and role revocation are different: access loss clears
  protected data, including a late response. Missing evidence never becomes Ready.
- Status read for a named original change (chg_7F3K): still checking, confirmed,
  safely failed, unknown, conflict and no longer authorised. Check status does
  not resubmit the command or external action. No second change ledger.
- History filters: date range, authorised actor, action kind, outcome, safe
  reference. Bounded list/pagination and long labels. Example entries: “Marieke
  appointed Grace as owner”; “Alex published a child result”; “Sales team memory
  corrected — content restricted”; “Peter's routine paused: connection revoked”.
- Detail distinguishes decision (“Allowed/Approved/Blocked”) from observation
  (“Dispatched/Confirmed/Unknown”), with time, actor where verified, affected
  scope, change/request/root/routine reference and permitted links. Include
  member/ownership, tool/model, publication, memory metadata, delegation/root
  spending and routine changes. A denied decision is not an executed effect;
  uncertain observations and missing matches stay uncertain.
- Detail loading, unavailable correlation, restricted resource, removed actor,
  stale timestamp and revoked viewer. Non-authorised private links do not expose
  names/previews/counts. Memory history must not copy forgotten text. Admins can
  follow safe budget/effect evidence without being given the private transcript.

Interactions: task action opens the owning feature/state, preserving a way Back;
history row opens safe detail, filters refresh the list, links check current
rights. Tab/Shift+Tab: navigation → tasks/filters → rows → detail actions;
arrows select menu/filter items, Enter/Space activates, Escape closes a detail
overlay and restores focus. Refresh neither moves keyboard focus nor resets
the user's place unexpectedly.

390px: sidebar/rail becomes a menu, rows stack, details/review panels overlay,
primary actions full width and all targets ≥44px. The linked chat composer
stays docked above the keyboard; admin pages do not add one. Accessibility:
semantic headings/lists, labelled filters and times, contrast, 2px focus, glyph
plus words, polite progress/refresh announcements and focus restoration. Use
the 7h reduced-motion/static variants, not a new animation system.

Out of scope: health scores, analytics dashboard, SIEM/export/retention controls,
private-content access for admins, a new mutation/audit ledger, skill/workflow
navigation, implementation evidence badges and Phase 5 operations screens.

Return a high-fidelity handoff with named 1280px desktop and 390px frames for
every state above, stable frame names, linked interaction transitions, and
keyboard/focus/accessibility notes including reduced-motion variants. Do not
produce application code or present designed states as live implementation proof.
```

Return to us:

- Updated admin navigation and ordered overview task/Ready state sheets.
- History filters, list and safe decision-versus-observation detail frames.
- Desktop/390px stale/read-only/revoked/unknown variants and cross-page return paths.

[p3]: ../specs/phase-3/tickets.md
[p3-decisions]: ../specs/phase-3/decisions.md
[p4]: ../specs/phase-4/tickets.md
[p4-decisions]: ../specs/phase-4/decisions.md
[chat-readme]: chat/README.robot.md
[chat]: chat/design/opencrane-frontend-wireframes.offline.html
[live]: chat/design/workspace-live.offline.html
[admin-readme]: org-admin/README.robot.md
[admin]: org-admin/design/opencrane-organisation-admin.offline.html
[texture]: chat/wireframes/09-7h-paper-texture.png
[motion]: chat/README.robot.md#visual-system
[workspace]: chat/README.robot.md#workspace-live-canonical
[admin-integrations]: org-admin/README.robot.md#04-integrations-the-mcp-register-4a4g
[tools]: chat/wireframes/03-8f-tool-calls.png
[ask]: chat/wireframes/03-8g-ask-card.png
[assets]: chat/wireframes/03-8e-assets.png
[admin-people]: org-admin/README.robot.md#05-people--groups-5a5e
[members]: chat/wireframes/08-13b-members-invite.png
[draft]: chat/wireframes/04-12b-mode-derivation.png
[threads]: chat/wireframes/05-10g-state-table-routes.png
[subagents]: chat/wireframes/06-6a-subagents-tab.png
[knowledge]: chat/wireframes/06-3a-storing-request.png
[trail]: chat/wireframes/06-6b-decisions-memory.png
[account]: chat/wireframes/08-13a-account-settings.png
[signin]: chat/wireframes/01-1a-sign-in.png
[survey]: chat/wireframes/01-1h-survey-4.png
[welcome]: chat/wireframes/02-11a-welcome-no-agent.png
[admin-models]: org-admin/README.robot.md#03-models--providers-3a3d
[admin-routines]: org-admin/README.robot.md#06-skills--workflows-7a7e
[admin-overview]: org-admin/README.robot.md#02-navigation-and-overview-2a2c
[admin-states]: org-admin/README.robot.md#07-shared-state-vocabulary-6a
