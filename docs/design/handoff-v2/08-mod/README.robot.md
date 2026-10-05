# OpenCrane handoff v2 · 08 · Models & providers (MOD) — 26 states

For people, read [README.md](README.md) first.

These notes describe design ideas. The real app is in `apps/web`, and some file names here are not in git.

This package is one of the ten v2 handoffs. Each state has a 1280px desktop frame and a 390px phone frame. Date: 4 Oct 2026.

> **These are designed states, not implementation proof.** Nothing here shows that a live system behaves this way. The live website is in `apps/web`; these designed states do not prove that it supports them. Don't copy the inline HTML or `support.js`.

## What's in this folder
- `html/opencrane-handoff-08-mod.offline.html` is self-contained and opens in any browser. It opens on this handoff and keeps the shared Brief tab.
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

### 08 · Models & providers (MOD) — 26 states
Model providers: setup, verification, access and retirement. Covers P4-21 · P4-22.

- `MOD-01` Empty providers and models — `png/MOD-01-1280.png` · `-390.png`
- `MOD-02` Ready tables — `png/MOD-02-1280.png` · `-390.png`
- `MOD-03` Loading and stale read — `png/MOD-03-1280.png` · `-390.png`
- `MOD-04` Read-only role and unavailable data — `png/MOD-04-1280.png` · `-390.png`
- `MOD-05` Provider detail — `png/MOD-05-1280.png` · `-390.png`
- `MOD-06` Menu on 390 — `png/MOD-06-1280.png` · `-390.png`
- `MOD-10` Step 1 — provider — `png/MOD-10-1280.png` · `-390.png`
- `MOD-11` Step 2 — key — `png/MOD-11-1280.png` · `-390.png`
- `MOD-12` Saving key — `png/MOD-12-1280.png` · `-390.png`
- `MOD-13` Step 3 — verify: saved but unverified — `png/MOD-13-1280.png` · `-390.png`
- `MOD-14` Priced test — warn first — `png/MOD-14-1280.png` · `-390.png`
- `MOD-15` Model answers — dated evidence — `png/MOD-15-1280.png` · `-390.png`
- `MOD-16` Skipped — Connected, not tested — `png/MOD-16-1280.png` · `-390.png`
- `MOD-17` Test refused / failures — `png/MOD-17-1280.png` · `-390.png`
- `MOD-18` Save reply lost → Check status — `png/MOD-18-1280.png` · `-390.png`
- `MOD-19` Step 4 — models — `png/MOD-19-1280.png` · `-390.png`
- `MOD-20` Step 5 — access — `png/MOD-20-1280.png` · `-390.png`
- `MOD-21` Step 6 — done — `png/MOD-21-1280.png` · `-390.png`
- `MOD-25` Replace — review — `png/MOD-25-1280.png` · `-390.png`
- `MOD-26` Replace — outcomes — `png/MOD-26-1280.png` · `-390.png`
- `MOD-30` Access editor — `png/MOD-30-1280.png` · `-390.png`
- `MOD-31` Access states — `png/MOD-31-1280.png` · `-390.png`
- `MOD-40` Retire — review — `png/MOD-40-1280.png` · `-390.png`
- `MOD-41` Retire — blocked — `png/MOD-41-1280.png` · `-390.png`
- `MOD-42` Retire — outcomes — `png/MOD-42-1280.png` · `-390.png`
- `MOD-02-RM` Tables — reduced motion — `png/MOD-02-RM-1280.png` · `-390.png`
