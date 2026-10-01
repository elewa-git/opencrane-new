# Handoff: OpenCrane organisation administration

## Overview

Organisation settings for OpenCrane, written for a non-technical admin ("Amina at Kijani Supplies") who has to set up the organisation without an engineer. It covers:

- an overview listing what needs the admin's attention
- connecting model providers
- integrations, which are MCP servers such as Odoo and Microsoft 365
- skills and workflows built on MCP tools
- people and groups
- a shared set of states used on every page

It answers the brief in `uploads/opencrane-administration-design-brief/`. Section 01 corrects each of the 11 existing Storybook references.

## About the design files

The files in `design/` are **HTML design references**. They show the intended look and behaviour; they are not production code. Recreate them in `apps/opencrane-ui` (Angular) using its existing component, routing and styling patterns. Do not copy the inline-styled HTML or the `support.js` runtime into the app.

- `design/opencrane-organisation-admin.offline.html` is self-contained and opens in any browser. Use it to look at the design.
- `design/Organisation Admin.dc.html` is the source. All values are inline styles, so exact numbers can be read straight from the markup. It needs `support.js` next to it.

## Fidelity

**High fidelity.** Colours, type, spacing, copy and states are final. Match them using the codebase's tokens. Where a token doesn't exist, add it using the values below; don't approximate.

Every frame is labelled with what the backend can support:

- **Supported today:** build it now.
- **Partly supported:** build the UI and hide or label the parts with no API behind them.
- **Needs a backend contract:** design intent only. Don't fake the behaviour. Show the "unavailable" copy that is in the design.

## Information architecture

Organisation settings has a 220px left sidebar and a fluid main column. The sidebar items are:

1. Overview (with a count of items needing attention)
2. Models & providers
3. Integrations
4. Skills & workflows
5. People & groups
6. Change history

This replaces the separate `/admin/model-keys`, `/admin/catalogue` and `/settings/members` routes. "My tools" stays in each person's own account settings. Hide any destination the user cannot access. If they can view a page but not change it, say which role is needed.

Suggested routes: `/org/overview`, `/org/models`, `/org/integrations`, `/org/integrations/:serverId`, `/org/integrations/new`, `/org/skills`, `/org/skills/:id`, `/org/workflows/:id`, `/org/people`, `/org/people/:memberId`, `/org/history`.

## Screens (frame ids match the design canvas)

### 01 Corrections to the Storybook references (1a–1k)

Each frame shows the original screenshot above the corrected version, with numbered notes. Apply these fixes to the existing components rather than building new ones.

- **1a Members:**
  - Pluralise properly: "1 invitation pending".
  - Show roles as plain text, not code chips. Drop the "Active member" label.
  - Add Groups and Last active columns.
  - Put search in the tab row. The whole row opens member detail.
- **1b Members at 390px:**
  - Stacked rows at least 60px tall, with "Role · Groups" under the name.
  - Full-width Invite button.
- **1c Provider not connected:**
  - One state line: "Not connected".
  - No key input in the row; the key goes into the setup flow.
  - Hide the technical slug.
- **1d Key saved, not verified:**
  - State text: "Key saved — connection not verified yet".
  - Second line: "Saved today at 09:12 by Amina Wanjiku".
  - One primary action, "Verify connection", plus an overflow menu with Replace key and Remove.
- **1e Saving:**
  - The row must look busy: show a spinner and name the current step.
  - Outcome unknown (after a timeout or reload) is its own state. Its action is "Check status", never "Retry".
  - Show the server's change reference, e.g. `chg_7F3K`.
- **1f Catalogue card:**
  - The card is an MCP server (e.g. Odoo), never a use case.
  - Show publisher, version, account model, and tool count split into read and changes data.
  - The action is "Review and add".
- **1g Installed MCP server:**
  - Show four facts: Installed, Connected, Allowed for, Available to the assistant.
  - The primary action is "Connect account". Uninstall moves to the overflow menu.
- **1h Governance:**
  - One "Review request" button that expands to show who gets access, which tools and whose account.
  - Confirm button: "Approve for 41 people".
- **1i Read failure:**
  - Keep the old data visible with "Showing what we loaded at 09:40".
  - The button is "Refresh list".
- **1j Retrying:**
  - Progress replaces the error notice in the same place.
  - The disabled button keeps a readable label.
  - Announce changes with `aria-live`.
- **1k System explainer:** a "How this works" disclosure on Overview.

### 02 Navigation and Overview (2a–2c)

- The Overview is a task list, not a dashboard. Each task shows: glyph, title, one sentence (what happened and who is affected) and one action.
- Order: interrupted or unknown-outcome work first, then items needing input, then failures. Ready items follow under a "Ready" heading.
- No invented health scores.

### 03 Models & providers (3a–3d)

- **3a Providers:** a Providers table (Provider, Status, Models, actions) and a Models table (Model, Provider, Who can use it). Each Ready status shows its evidence, e.g. "Verified today at 08:40 by a test request".
- **3b Connect a provider:** an interactive six-step flow: Provider → API key → Verify → Models → Access → Done.
  - The key field is `type=password` with `autocomplete=off`. The key is never stored in the browser and is cleared once the server accepts it.
  - Verify shows three separate checks: Key stored, Provider reachable, A model answers.
  - The test prompt warns it may cost money before it runs, and can be skipped. A skipped test shows as "connected, not tested".
  - If the page reloads mid-save, the user lands in outcome unknown and is offered "Check status". That re-reads the saved change and must not create a second one.
  - The Done screen must not claim a test conversation works.
- **3c Retire:** list what depends on the connection and choose replacements before confirming. What happens to running conversations is labelled "The server decides".
- **3d Provider detail at 390px.**

### 04 Integrations: the MCP register (4a–4g)

- **4a Register:**
  - Columns: Server (with source and version under the name), Account, Tools ("9 of 14" allowed), Status, action.
  - Tabs: All, Needs attention, Pending review.
- **4b Add an MCP server:**
  - Choose the source: Catalogue, Remote server (URL) or Package (OCI image).
  - Catalogue cards show the account model and tool count. Protocol details sit behind "Advanced".
- **4c Connection:**
  - Choose whose account it acts through: each person's own (OAuth), or one company account/app.
  - Show the provider permissions (scopes) before anyone is asked for consent.
  - Don't request a scope that only a disabled tool needs.
- **4d Tools & access:**
  - Use the server's own tool list, grouped into Read and Changes data. Each tool has a segmented control: Off / Allow / Ask first (Ask first only appears on tools that change data).
  - Groups are chips, with "21 people · none has access today".
  - A one-sentence summary restates the result.
  - With a company account, a notice says Odoo will record actions under that one account and OpenCrane keeps who actually asked.
- **4e Server detail:**
  - Four fact cards.
  - Last connection check: list the tools, then one bounded read-only call.
  - "Used by" lists the skills and workflows that depend on this server.
- **4f Update comparison:**
  - Compare tool by tool. New tools start Off; changed tools are flagged.
  - The old version keeps serving until the update succeeds. No rollback is offered.
- **4g Removal review:**
  - Name the people affected and the skills and workflows that will break.
  - Removing here does not delete the account in the external system (e.g. the Odoo user).
  - Confirm button: "Remove for 21 people".

### 05 People & groups (5a–5e)

- **5a Member detail:**
  - Role and groups are separate cards.
  - Groups managed by the identity provider show a lock and name the provider.
  - "What Alex can use — and why" lists each item of access with its source (e.g. "via Sales team").
- **5b Remove access:** state what they lose, what they own (each needs a transfer owner), what is kept and what happens if they return.
- **5c Last-owner conflict:** comes from a backend rule. Say it in words and give one way forward.
- **5d Invite:**
  - When email delivery is unavailable, say so and create links instead.
  - Invitation states: link created, wrong account used, expired.
- **5e Member detail at 390px.**

### 06 Skills & workflows (7a–7e)

These frames still use the 7a–7e ids from the canvas.

- **7a Skills library:**
  - Columns: Skill (version, owner), Uses (MCP servers), Shared with, Status, action.
  - Status counts who can actually run it, e.g. "5 of 12 can run it". Work this out from each person's tool grants and account connections.
- **7b Skill detail:**
  - Fields: what it does, instructions, inputs it asks for, tools it uses, last test run.
  - A skill never grants access; it runs with the permissions of the person using it. Show this in the UI.
- **7c Share:**
  - Pick groups. Show who can run it and why the others can't, with a link to the MCP access that would fix it.
  - Choose who can edit, and whether new versions need admin review.
- **7d Workflow:**
  - Shows trigger/schedule, "Runs as", and steps (a skill, an approval with timeout and fallback, an MCP tool action).
  - Recent runs use the shared states.
  - If the "runs as" person loses access, the workflow pauses. It never switches account silently.
- **7e Approve a workflow step at 390px:** full-width buttons, at least 44px tall.

### 07 Shared state vocabulary (6a)

This frame still uses the 6a id from the canvas.

Use these states on every page:

| State | Glyph | Example copy | Action |
| --- | --- | --- | --- |
| Not configured | empty circle | Nothing set up yet | Start setup |
| Draft | orange dot | Steps 1–2 of 4 saved | Continue |
| Applying / checking | spinner | Reaching OpenAI… | none (no double submit) |
| Needs input | orange dot | Connect your Odoo account | Connect account |
| Ready | green check | Verified today at 08:40 | Use · Test · Manage |
| Failed, safe to retry | red × | Couldn't reach OpenAI. Nothing changed. | Try the same change again |
| Outcome unknown | ? in a circle | We couldn't confirm the change | Check status |
| Access changed | lock | You no longer have permission | Ask an admin |
| Disabled / removed | dash | Removed 12 Sep · history kept | Set up again |

Rules:

- Meaning never relies on colour alone: always a glyph plus words.
- "Try again" is only offered when the failure changed nothing.
- Outcome unknown always reconciles with the server first.

## Interactions and behaviour

- **Buttons:**
  - Primary: background `#0db5cc`, text `#16191a`, shadow `0 1px 0 #0a8497`, hover `#22c3d8`.
  - Secondary: white with a `#c9d1d2` border, hover `#f3f6f6`.
  - Danger: white with a `#e6b8b1` border and `#c1392b` text. Solid danger is `#c1392b` with white text.
  - Pressed: `translateY(1px)`.
  - Focus: `2px solid #0a8497` outline with a 2px offset.
  - Minimum height 36px, or 44px on mobile.
- **Rows:** hover background `#fafbfb`. A row with a chevron opens its detail page.
- **Destructive actions:** always a review screen with the consequences. The confirm button repeats the scope.
- **Concurrency:** progress is shown only on the affected row; other rows stay usable. Disable submit while a change is applying.
- **Spinner:** 11px ring, `2px solid #cdeef3` with a `#0db5cc` top, rotating every 0.9s, linear. With `prefers-reduced-motion`, show a static ring.
- **Live regions:** use `aria-live="polite"` for progress and results, and `role="status"` for refresh notices.
- **Responsive:** at 390px tables become stacked rows, the sidebar becomes a top bar with a menu icon, and primary actions are full width.

## State (per flow)

- **Provider setup:**
  - `step` (0–5), `provider`, `connectionName`, `key` (in memory only)
  - `phase`: idle → saving → reach → offer → test → done. A skipped test ends in `skipped`. From saving, the path can go saving → unknown → reconcile → reach.
  - `selectedModels[]`, `defaultModel`, `audience`
- **Server responses needed:**
  - Every mutation returns a change reference.
  - A status endpoint looks up a change by that reference (for outcome unknown).
  - Each provider and server carries separate verified-at and saved-at timestamps.
  - MCP tool lists include a read/write classification.
  - A per-person "can run" check for skills.

## Design tokens

### Colours

- Text: `#16191a`
- Secondary text: `#4f575a`
- Muted text: `#6f7779`
- Placeholder text: `#8a9294`
- Faint text: `#a7aeaf`
- Lines: `#e1e6e7` (table rows), `#d9dfe0` (card borders), `#c9d1d2` (inputs)
- Backgrounds: page `#eceff0`, app `#f6f8f8`, sidebar `#eef1f2`, table header `#f1f4f4`, card `#fff`
- Teal: primary `#0db5cc`, dark `#0a8497`, tint `#e4f6f9`, border `#cdeef3`
- Green (ready): `#2a7d4f`
- Amber text: `#8a5d1f`
- Orange (needs input): `#f47920`
- Red (failed): `#c1392b`
- Warning notice: background `#fff8ef`, border `#f1d8b8`
- Info notice: background `#f2fbfc`, border `#cdeef3`

**Type:** DM Sans for the UI, DM Mono only for tool names, change references and identifiers.

- Page title: 22px / 600 / −0.3px
- Section title: 24px / 600
- Card title: 16px / 600
- Row title: 13.5–14px / 600
- Body: 13px
- Secondary: 12–12.5px
- Column header: 10.5px / 600 / uppercase / 0.08em tracking

**Spacing:** 4, 6, 8, 10, 12, 14, 16, 18, 22, 26, 32px. Main padding is 28px vertical and 32px horizontal. Row padding is 14px vertical and 18px horizontal.

**Radius:** 7–8px (buttons, inputs, chips), 9px (logo tiles), 10px (notices, option cards), 12px (cards, app frame), 50% (avatars).

**Shadows:** primary button `0 1px 0 #0a8497`; the active sidebar item has a 2px teal bar on its left edge plus `0 1px 2px rgba(0,0,0,.04)`.

## Assets

- The OpenCrane logo is an inline SVG of five polygons (see the top of the source file). Use the codebase's existing logo asset if it has one.
- Server logo tiles (OD, M3, SL and so on) are placeholders. Swap in real vendor marks where licensing allows.
- No other images. The "Before" screenshots come from `uploads/opencrane-administration-design-brief/screenshots/` and are for reference only.

## Files

- `design/opencrane-organisation-admin.offline.html`: self-contained design, opens in a browser.
- `design/Organisation Admin.dc.html` and `design/support.js`: source with exact inline values.
- Target codebase: `apps/opencrane-ui` (Angular). Related backend apps: `apps/mcp-executor`, `apps/feat-skill-registry`, `apps/skill-authoring`.
