# OpenCrane handoff v2 · 01 · Integrations & My tools (INT) — 75 states

For people, read [README.md](README.md) first.

These notes describe design ideas. The real app is in `apps/web`, and some file names here are not in git.

This package is one of the ten v2 handoffs. Each state has a 1280px desktop frame and a 390px phone frame. Date: 4 Oct 2026.

> **These are designed states, not implementation proof.** Nothing here shows that a live system behaves this way. Recreate the frames in `apps/opencrane-ui` (Angular) using its existing components. Don't copy the inline HTML or `support.js`.

## What's in this folder
- `html/opencrane-handoff-01-int.offline.html` is self-contained and opens in any browser. It opens on this handoff and keeps the shared Brief tab.
- `html/source/` holds the source design component, `support.js` and the local DM Sans/DM Mono fonts.
- `png/<ID>-1280.png` and `png/<ID>-390.png` contain one desktop frame and one phone frame for every state id.
- `frame-index.md` lists every id and name, in the same order as the HTML.

## Stable frame names
- The pattern is `KEY-NN`, for example `INT-07`. A `-RM` suffix marks a reduced-motion variant. In the HTML, frames are labelled `INT-07 @1280` and `INT-07 @390`, and the anchor `#INT-07` deep-links to the state.
- KEY is one of: INT Integrations & My tools · WRK Workspace effects · SPD Spending · PPL People & groups · THR Threads & delegation · MEM Memory · ONB Onboarding & account · MOD Models & providers · RTN Routines · OVR Overview & change history.
- Each state's notes column lists its transitions as `→ ID label`. These links are the interaction map.

## Built on (unchanged)
- Workspace Live: the 236px rail, 56px header, transcript (max 780px), docked composer and 300px Files/Activity panel.
- Chat 8b–8j: 8f quiet tool lines, 8g orange approval edge, 8e file cards, 8i panel and 8j phone anatomy.
- Org-admin: 4a–4g for registers, reviews, comparison and removal, and the 6a shared state vocabulary.
- 7h: rice-paper texture and the 14-motion set.
- DM Sans for the UI and DM Mono for ids, references and tool names. Teal `#0db5cc`, orange `#f47920`, green `#2a7d4f`, red `#c1392b`, ink `#16191a`.
- The organisation shell's navigation is now: Overview, People & groups, Models & providers, Spending, Integrations, Routines, Change history. Skills & workflows has been removed.
- Personal settings replace the rail with “‹ Back to workspace” and have Account, Preferences, Assistant and My tools.

## Paper and origami system
- **Rice paper:** a 42% texture on main surfaces only (`.oc-rice`). Panels, cards and sheets stay plain paper.
- **Dog-ear:** a 12px folded corner on fact cards, money cards, quotes, file and child-summary cards, selected option cards, unknown-outcome notices and modal sheets.
- **Crease:** a two-line embossed fold (1px `#cdd4d5` over 1px white) for dividers and the completion crease, drawn in over 600ms.
- **Hinge:** drawers fold in from the right edge and carry a 16px crease shadow. The mobile menu folds in from the left. Modals lift as a sheet with a folded corner.
- **Folding…:** a paper-square loader while an assistant works. **Flutter** marks a rail row or status with work in flight. **Grain** is the skeleton loop.

## State vocabulary (6a, extended)
Every state is shown as a glyph plus words, never colour alone:
- Not configured: empty ring
- Draft or needs input: orange dot
- Applying or checking: ring spinner
- Ready or confirmed: green check, always with dated evidence
- Failed, nothing changed: red ×. Only this state offers “Try again”.
- Outcome unknown: ? ring. Check status reads evidence for the original change reference and never resends.
- Access changed: lock. Protected data is cleared, including late responses.
- Paused: amber bars
- Blocked or refused: struck circle
- Removed: dash, history kept
- Waiting, scheduled or expired: clock, always with a real timestamp

## Keyboard and focus (global)
- Tab and Shift+Tab move through the rail or navigation, then the header, then the main content (filters, rows, cards), then the panel or overlay actions, then the composer.
- The arrow keys move within radio groups, segmented controls, tabs and menus. Enter or Space activates.
- Escape closes an overlay without submitting, and returns focus to the control that opened it.
- Modal panels trap focus and start on their title. Every review has a labelled Back or Cancel.
- The focus ring is 2px solid `#0a8497` with a 2px offset. It is never removed.
- In the composer, Enter sends and Shift+Enter adds a line. Stop is keyboard reachable.
- An approval is never decided by a generic Enter. Its buttons are explicit and labelled.
- Inside a remote desktop under control, keys go to the computer. Return control stays outside the desktop and reachable with Ctrl+Alt+Esc.

## Accessibility
- Text contrast is at least 4.5:1. Muted text is no lighter than `#4f575a` on paper.
- Fields have labels. Errors are linked with `aria-describedby`. Read-only fields state where their value comes from.
- Progress and results are announced through `aria-live="polite"` or `role="status"`, once at the start and once with the result. Streamed tokens, secret values, private evidence and forgotten text are never announced.
- Images use a text caption. The design never invents a description of what an image contains.

## 390px rules
- The rail or sidebar becomes a menu opened from a 44px button.
- Tables become stacked rows with labels.
- Detail, review, editor, computer and file panels open as full-screen overlays with a Back button.
- Primary actions are full width, and every target is at least 44px.
- In chat, the composer docks above the keyboard (shown in frames with a keyboard). Admin and settings pages have no composer.
- Long names, scopes, consequences and breadcrumbs wrap. Nothing scrolls horizontally.

## Reduced motion
- Entrances appear instantly.
- The loops freeze: the spinner becomes a static ring, Flutter a still triangle at 60%, Folding a still folded square, Grain a flat bar, and the caret stays solid.
- Creases render fully drawn. Settle has no overshoot.
- Each handoff has a `-RM` frame. The HTML's “Reduced motion” tweak applies this to every frame.

## Rules that recur
- Reviewed, published, connected and allowed are separate facts, each with its own evidence. None of them is a grant on its own.
- The requester and the assistant both need current grants. No group label, link, admin role or fallback account grants permission.
- Lost replies lead to Check status for the same reference (for example `chg_7F3K`, `req_1042`). The design never retries blindly or invents retry counts.
- Money is shown in EUR for people and validated as integer euro cents. Settled and reserved are always separate. Rolling over to a new month never refunds anything.
- Secret fields are always masked and empty. Nothing is read back.

## Frame index

### 01 · Integrations & My tools (INT) — 75 states
Integrations register, hosted admission, tool access and My tools. Covers P3-4 · P3-6 · P3-7 · P3-8 · P3-9 · P3-10 · P3-20 · P4-23 group extension.

- `INT-01` Register — No integrations yet — `png/INT-01-1280.png` · `-390.png`
- `INT-02` Register — loading list — `png/INT-02-1280.png` · `-390.png`
- `INT-03` Register — All — `png/INT-03-1280.png` · `-390.png`
- `INT-04` Register — Needs attention — `png/INT-04-1280.png` · `-390.png`
- `INT-05` Register — Pending review — `png/INT-05-1280.png` · `-390.png`
- `INT-06` Detail — Draft, review not finished — `png/INT-06-1280.png` · `-390.png`
- `INT-07` Register — read failed, showing last loaded — `png/INT-07-1280.png` · `-390.png`
- `INT-08` Register — menu open on 390 — `png/INT-08-1280.png` · `-390.png`
- `INT-11` Admission — discovery and image checks — `png/INT-11-1280.png` · `-390.png`
- `INT-12` Admission — passed — `png/INT-12-1280.png` · `-390.png`
- `INT-13` Admission — pending scanner result — `png/INT-13-1280.png` · `-390.png`
- `INT-14` Admission — unsigned or tampered image — `png/INT-14-1280.png` · `-390.png`
- `INT-15` Admission — licence unknown — `png/INT-15-1280.png` · `-390.png`
- `INT-16` Admission — licence not acceptable — `png/INT-16-1280.png` · `-390.png`
- `INT-17` Admission — Critical/High finding — `png/INT-17-1280.png` · `-390.png`
- `INT-18` Admission — scan is stale — `png/INT-18-1280.png` · `-390.png`
- `INT-19` Admission — scanner unavailable — `png/INT-19-1280.png` · `-390.png`
- `INT-19-RM` Admission — checks running (reduced motion) — `png/INT-19-RM-1280.png` · `-390.png`
- `INT-33` Access — missing rights explained — `png/INT-33-1280.png` · `-390.png`
- `INT-35` Publish — scoped confirmation — `png/INT-35-1280.png` · `-390.png`
- `INT-37` Detail — published, four separate facts — `png/INT-37-1280.png` · `-390.png`
- `INT-40` Drift — Odoo is paused — `png/INT-40-1280.png` · `-390.png`
- `INT-41` Drift — per-tool comparison — `png/INT-41-1280.png` · `-390.png`
- `INT-42` Drift — expired check or failed watch — `png/INT-42-1280.png` · `-390.png`
- `INT-43` Drift — review and publish in progress — `png/INT-43-1280.png` · `-390.png`
- `INT-44` Drift — restored with fresh evidence — `png/INT-44-1280.png` · `-390.png`
- `INT-50` Removal — review — `png/INT-50-1280.png` · `-390.png`
- `INT-51` Removal — dependency data missing — `png/INT-51-1280.png` · `-390.png`
- `INT-52` Removal — result with an unknown part — `png/INT-52-1280.png` · `-390.png`
- `INT-60` My tools — You have not connected Odoo — `png/INT-60-1280.png` · `-390.png`
- `INT-61` My tools — list — `png/INT-61-1280.png` · `-390.png`
- `INT-62` Bearer — connect — `png/INT-62-1280.png` · `-390.png`
- `INT-63` Bearer — account saving — `png/INT-63-1280.png` · `-390.png`
- `INT-64` Bearer — connected, input cleared — `png/INT-64-1280.png` · `-390.png`
- `INT-65` Bearer — replacement saved — `png/INT-65-1280.png` · `-390.png`
- `INT-66` Bearer — revoke review — `png/INT-66-1280.png` · `-390.png`
- `INT-67` OAuth — consent required — `png/INT-67-1280.png` · `-390.png`
- `INT-68` OAuth — handoff — `png/INT-68-1280.png` · `-390.png`
- `INT-69` OAuth — completing — `png/INT-69-1280.png` · `-390.png`
- `INT-70` OAuth — consent cancelled — `png/INT-70-1280.png` · `-390.png`
- `INT-71` OAuth — wrong account — `png/INT-71-1280.png` · `-390.png`
- `INT-72` OAuth — expired consent or failed refresh — `png/INT-72-1280.png` · `-390.png`
- `INT-73` Revoked profile — `png/INT-73-1280.png` · `-390.png`
- `INT-74` Chat — no personal profile, no fallback — `png/INT-74-1280.png` · `-390.png`
- `INT-75` Chat — returned after confirmed connection — `png/INT-75-1280.png` · `-390.png`
- `INT-76` Removed — set up again — `png/INT-76-1280.png` · `-390.png`
- `INT-80` Destinations — none allowed — `png/INT-80-1280.png` · `-390.png`
- `INT-81` Destinations — loading — `png/INT-81-1280.png` · `-390.png`
- `INT-82` Destinations — editor — `png/INT-82-1280.png` · `-390.png`
- `INT-83` Destinations — saved — `png/INT-83-1280.png` · `-390.png`
- `INT-84` Destinations — invalid or private host — `png/INT-84-1280.png` · `-390.png`
- `INT-85` Destinations — role can’t edit — `png/INT-85-1280.png` · `-390.png`
- `INT-86` Destinations — revoked rule — `png/INT-86-1280.png` · `-390.png`
- `INT-87` Destinations — stale edit — `png/INT-87-1280.png` · `-390.png`
- `INT-88` Destinations — save outcome unknown — `png/INT-88-1280.png` · `-390.png`
- `INT-90` Failed safely before change — `png/INT-90-1280.png` · `-390.png`
- `INT-91` Missing data or scopes — `png/INT-91-1280.png` · `-390.png`
- `INT-92` Identity or secret service unavailable — `png/INT-92-1280.png` · `-390.png`
- `INT-93` Stale edit conflict on access — `png/INT-93-1280.png` · `-390.png`
- `INT-94` Role or grant revoked while open — `png/INT-94-1280.png` · `-390.png`
- `INT-95` Outcome unknown — `png/INT-95-1280.png` · `-390.png`
- `INT-96` Check status — results — `png/INT-96-1280.png` · `-390.png`
- `INT-10` Add — choose source — `png/INT-10-1280.png` · `-390.png`
- `INT-20` Connection — account model and scopes — `png/INT-20-1280.png` · `-390.png`
- `INT-21` Company setup — explicit opt-in — `png/INT-21-1280.png` · `-390.png`
- `INT-22` Company setup — account saving — `png/INT-22-1280.png` · `-390.png`
- `INT-23` Company setup — discovery-only check — `png/INT-23-1280.png` · `-390.png`
- `INT-24` Private instance — waking — `png/INT-24-1280.png` · `-390.png`
- `INT-25` Private instance — unavailable — `png/INT-25-1280.png` · `-390.png`
- `INT-26` Private instance — needs startup secret — `png/INT-26-1280.png` · `-390.png`
- `INT-30` Tools & access — new tools start Block — `png/INT-30-1280.png` · `-390.png`
- `INT-31` Tools & access — editing (P3) — `png/INT-31-1280.png` · `-390.png`
- `INT-32` Access — P4 group extension — `png/INT-32-1280.png` · `-390.png`
- `INT-34` Review — consequence summary — `png/INT-34-1280.png` · `-390.png`
- `INT-36` Publishing — `png/INT-36-1280.png` · `-390.png`
