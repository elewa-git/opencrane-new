# OpenCrane handoff v2 · 03 · Spending (SPD) — 37 states

For people, read [README.md](README.md) first.

These notes describe design ideas. The real app is in `apps/web`, and some file names here are not in git.

This package is one of the ten v2 handoffs. Each state has a 1280px desktop frame and a 390px phone frame. Date: 4 Oct 2026.

> **These are designed states, not implementation proof.** Nothing here shows that a live system behaves this way. Recreate the frames in `apps/opencrane-ui` (Angular) using its existing components. Don't copy the inline HTML or `support.js`.

## What's in this folder
- `html/opencrane-handoff-03-spd.offline.html` is self-contained and opens in any browser. It opens on this handoff and keeps the shared Brief tab.
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

### 03 · Spending (SPD) — 37 states
Spending page and the unknown-effect resolution drawer. Covers P3-15 (resolution first) · P4-26 (group, assistant, root and routine selection).

- `SPD-01` Summary — no usage this month — `png/SPD-01-1280.png` · `-390.png`
- `SPD-02` Summary — no groups or assistants available — `png/SPD-02-1280.png` · `-390.png`
- `SPD-03` Summary — loading — `png/SPD-03-1280.png` · `-390.png`
- `SPD-04` Summary — ready (Sales team) — `png/SPD-04-1280.png` · `-390.png`
- `SPD-05` Root and routine detail — `png/SPD-05-1280.png` · `-390.png`
- `SPD-06` Read failed — last loaded — `png/SPD-06-1280.png` · `-390.png`
- `SPD-07` Budget or audit service unavailable — `png/SPD-07-1280.png` · `-390.png`
- `SPD-08` Permissions changed — details cleared — `png/SPD-08-1280.png` · `-390.png`
- `SPD-09` Menu on 390 — `png/SPD-09-1280.png` · `-390.png`
- `SPD-20` Unknown — final usage not received — `png/SPD-20-1280.png` · `-390.png`
- `SPD-21` Check status — waiting — `png/SPD-21-1280.png` · `-390.png`
- `SPD-22` Check status — still unknown — `png/SPD-22-1280.png` · `-390.png`
- `SPD-23` Unknown reasons — `png/SPD-23-1280.png` · `-390.png`
- `SPD-24` Fresh evidence found — review — `png/SPD-24-1280.png` · `-390.png`
- `SPD-25` Release — proof of non-dispatch — `png/SPD-25-1280.png` · `-390.png`
- `SPD-26` Insufficient or conflicting evidence — `png/SPD-26-1280.png` · `-390.png`
- `SPD-27` Validation — fractional or invalid cents — `png/SPD-27-1280.png` · `-390.png`
- `SPD-28` Late larger settlement — `png/SPD-28-1280.png` · `-390.png`
- `SPD-30` Saving — `png/SPD-30-1280.png` · `-390.png`
- `SPD-31` Confirmed once — `png/SPD-31-1280.png` · `-390.png`
- `SPD-32` Lost acknowledgement — `png/SPD-32-1280.png` · `-390.png`
- `SPD-33` Already resolved by another admin — `png/SPD-33-1280.png` · `-390.png`
- `SPD-34` Revision conflict — `png/SPD-34-1280.png` · `-390.png`
- `SPD-35` Denied resolver — `png/SPD-35-1280.png` · `-390.png`
- `SPD-40` Limit edit — valid — `png/SPD-40-1280.png` · `-390.png`
- `SPD-41` Lowering review — consequences — `png/SPD-41-1280.png` · `-390.png`
- `SPD-42` Limit edit — invalid inputs — `png/SPD-42-1280.png` · `-390.png`
- `SPD-43` Zero — hard stop — `png/SPD-43-1280.png` · `-390.png`
- `SPD-44` Concurrent change — `png/SPD-44-1280.png` · `-390.png`
- `SPD-45` Applying, saved, failed-safe, unknown — `png/SPD-45-1280.png` · `-390.png`
- `SPD-46` Rights revoked mid-edit — `png/SPD-46-1280.png` · `-390.png`
- `SPD-50` Exhausted scopes — `png/SPD-50-1280.png` · `-390.png`
- `SPD-51` 1 Nov rollover — October hold stays — `png/SPD-51-1280.png` · `-390.png`
- `SPD-52` Missing price → refused — `png/SPD-52-1280.png` · `-390.png`
- `SPD-53` Personal default payer change — `png/SPD-53-1280.png` · `-390.png`
- `SPD-54` Linked chat — budget stop — `png/SPD-54-1280.png` · `-390.png`
- `SPD-04-RM` Summary — reduced motion — `png/SPD-04-RM-1280.png` · `-390.png`
