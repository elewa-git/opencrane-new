# Handoff: OpenCrane chat workspace

## Overview
This covers the person-facing side of OpenCrane: signing in, onboarding with the personal Agent, and the chat workspace where people and Agents work together. That includes project chats, streaming replies, tool calls, questions from the Agent, child-agent threads, new sessions, knowledge requests, the session panel, inline A2UI, and account and member settings.

Organisation administration is a separate package (`design_handoff_org_admin`).

## About the design files
The files in `design/` are **HTML design references**. They show the intended look and behaviour; they are not production code. Recreate them in `apps/opencrane-ui` (Angular) using its existing patterns: `features/chat/*`, `features/workspace/*`, `features/onboarding/*`, `core/*`, and `ui/*`. Several of these already exist, including `chat-thread`, `chat-composer`, `chat-asset-panel`, `elicitation-card`, `run-progress`, `tool-call-card`, `a2ui-surface` and `workspace-shell`, so update them rather than adding new ones. Do not copy the inline-styled HTML or `support.js` into the app.

- `design/workspace-live.offline.html` is the canonical screen. It is clickable and self-contained, so open it in any browser.
- `design/opencrane-frontend-wireframes.offline.html` is the full canvas, turns 1–13. **Start with its "Spec v1" block at the top**, which indexes the canonical frames and marks which ones are superseded.
- `design/*.dc.html` + `support.js` are the source, with exact inline values.

## Fidelity
**High fidelity** for `Workspace Live` and every frame listed under Spec v1 → Canonical screens. Frames marked "exploration" or "superseded" (2a–2c, 4a–4b) are not for build. 7h is the texture decision, which is already applied everywhere.

## Canonical screens (frame ids match the canvas)
| Flow | Frames | Notes |
|---|---|---|
| Sign-in & survey | 1a–1h | SSO first, then a magic link fallback. A four-step survey feeds SOUL.md. |
| Onboarding first chat | 1i, 5a, 11a, 8a | The survey continues in chat. It ends with the user's answer, then the Agent's confirmation, then the completion crease. 11a is the variant with no Agent. The onboarding chat never mounts the participants picker or the model picker. |
| Workspace | 8b–8j, **Workspace Live** | Rail states, streaming, composer, assets, tool lines, the ask card, inline A2UI, side panels and the compact layout. |
| New session | 12a, 12b | The draft opens in place and the To line works out the mode. Agent sessions lock at first send. |
| Agent threads | 10a–10g | `@agent` in a group spawns a governed child thread. The summary has its own states, and the result is published back. |
| Knowledge & trail | 3a–3c, 6a, 6b | Store requests come with a suggested scope. The panel holds subagents, decisions and memory. |
| A2UI catalog | 9a, 9b | Separate PR. The chat track only needs the fenced placeholder. |
| Settings | 13a, 13b | Account fields that come from SSO are read-only. Members has the inline invite panel. |

## Workspace Live (canonical)
The layout is: rail 236px | main (fluid; transcript max 780px, centred) | session panel 300px. The panel is collapsible and starts closed under 1100px.

**Rail (top to bottom)**
- Logo + ⌘K
- **New session** (orange `#f47920`, ⌘N): opens a draft
- **Ask your agent** (dashed teal fence, ⌘⇧A): the fast path to the personal Agent
- Groups: **Projects**, **Personal**, then **Archived · n** (collapsed)
- Footer: Settings, then the current user
- Rows show a lowercase slug with a state glyph in front:
  - `#` open (teal when active)
  - flutter triangle: an Agent is working
  - check: done
  - lock: closed or read-only
- Unread is a dark count pill. "Needs your answer" is a 6px orange dot.
- The active row is `#e1e7e8` with a 2px teal inset bar on the left.

**Header (56px).** Shows `#` and the title, plus **one** status at most:
- "Agent working": flutter glyph, teal text
- "Waiting on you": orange dot, amber text

Participant avatars and the panel toggle sit on the right. No pills in the header.

**Transcript**
- **Other people:** 30px avatar, then name and time, then 14px/1.6 text.
- **Own message:** right-aligned, background `#eef1f2`, radius `14 14 3 14`, max width 78%.
- **Agent turn:** 30px teal tile with the triangle mark, then "Agent" and the time/duration.
  - **Tool lines:** one light line each, e.g. "✓ Searched Finance / Q3 · 12 files ›". "after retry" is shown in green. Clicking a line opens the details. Never show a card per tool call.
  - **Prose:** 14.5px/1.7.
  - **Citations:** numbered chips with a dog-ear fold in the top-right corner.
  - **File result card:** opens the document.
  - **Elicitation card:** 2.5px orange left edge.
    - Open: "Needs your answer" with an orange dot, plus a primary and a secondary choice, "or reply below".
    - Answered: "✓ Answered by you", then the chosen answer in quotes.

**Composer**
- White card, radius 12, soft shadow, focus border `#9fdde8`.
- Toolbar order never changes: attach, voice, (mode, in agent sessions only), spacer, hint, (people, in group chats only), send.
- The send button is grey `#c9d1d2` when empty and teal `#0db5cc` when there is text.
- While a run is active, Send is replaced by **Stop** (red square + "Stop").
- Enter sends; Shift+Enter adds a new line.
- A feature that doesn't apply to a chat is **not mounted**, rather than shown greyed out.

**Session panel.** The scope rung + "project" sits in the panel header. Below it:
- Files (n): a type swatch, name, then "who · when"
- Decisions (n): new entries settle in
- People (n)

## Interactions & behaviour (as prototyped)
1. Answering the elicitation sets it to answered and adds a decision to the panel. The Agent then replies: Folding… loader (about 1.4s), a tool line, then text streaming in with a teal caret.
2. Sending: the bubble lands, then the Agent replies the same way. The header changes from "Waiting on you" to "Agent working" to nothing.
3. Stop cancels streaming and keeps the partial text (or "Stopped.").
4. The transcript auto-scrolls to the bottom when new content arrives.

## Visual system
**Markers: colour means state, never scope**
- **Scope** is a 4-rung ladder glyph (8×10px; the active rung is ink, the others `#c9d0d1`): org, dept, project, personal/session. It is never coloured.
- **State:**
  - open `#` teal
  - working: flutter triangle `#0db5cc`
  - waiting: orange dot `#f47920`
  - failed: red × `#c1392b`
  - done: check `#2a7d4f`
  - closed: lock `#91989a`
- Statuses are a glyph plus words, never filled pills. Pills only survive for unread counts.

**Motion set**: only these 14 motions exist. Entrances use the paper ease `cubic-bezier(.32,.72,0,1)`; state changes and press use the standard ease `cubic-bezier(.4,0,.2,1)`.

| Motion | Duration | Use |
|---|---|---|
| Deal | 380ms, 34ms stagger | rows, chips, menus, rail entries |
| Unroll | 520ms | a new assistant turn |
| Ink | 420ms (blur 3px → 0) | assistant prose settling |
| Land | 340ms | a sent bubble dropping and flattening |
| Crease | 600ms scaleX | dividers, completion line |
| Dog-ear | 260ms scale | citation and selected-chip corners |
| Hinge | 420ms rotateY from the edge | side panels, thread views |
| Settle | 260ms, 12% overshoot | a state becoming final |
| Flick | 320ms, once | failure or invalid input, never loops |
| Press | 90ms translateY(1px) | every button and chip |
| Fold | 1.6s loop | "Folding…" while the Agent works |
| Flutter | 1.6s loop | rail row with a run in flight |
| Caret | 1s steps | streaming text |
| Grain | 1.4s loop | skeletons |

Each view gets one entrance chain of at most 2.4s. With `prefers-reduced-motion`, everything is instant, loops freeze and the caret stays solid. The exact `@keyframes` are in the `<helmet><style>` of either `.dc.html` file.

**Paper texture.** The `.oc-rice::before` overlay is a rice-paper texture at 42% opacity, embedded as a data URI in the source. Apply it to the main surface only.

## Design tokens
**Colours**
- Ink: `#16191a`
- Body text: `#2b3133`, `#454d4f`
- Secondary text: `#5a6264`, `#616a6c`, `#81888a`, `#91989a`
- Faint text: `#a7aeaf`, `#b3babb`
- Lines: `#dee3e4`, `#e1e6e7`, `#e6eaeb`, `#d9dfe0`, `#d3d9da`
- Backgrounds: app `#eceff0`, rail `#eef1f2`, main `#f7f9f9`, header `rgba(251,252,252,.85)`, panel `#f3f6f6`, card `#fff`
- Teal: `#0db5cc`, dark `#0a94a7` / `#0d8ba0`, tint `#e4f6f9` / `#eefafc`, fence `#9fdde8`, border `#cdeef3`
- Orange: `#f47920`; amber text `#9a6b2a`
- Green: `#2a7d4f`
- Red: `#c1392b`

**Type:** DM Sans for the UI, DM Mono for slugs (`#`), keyboard hints and citation numbers.
- Title: 15px / 600
- Body: 14–14.5px / 1.6–1.7
- Meta: 11–12.5px
- Section labels: 10px / 600 / uppercase / 0.09em tracking

**Radius:** 6 (rail rows), 7–8 (buttons), 10 (cards), 12 (composer), `14 14 3 14` (own bubble), 50% (avatars).

## State model (as prototyped)
- **Message:** `{id, author: user|person|agent, text, time}`. Agent turns add `{folding, status, tool?, streaming}`.
- **Elicitation:** `{state: open|answered, answer?}`.
- **Decisions:** a list of strings.
- **Panel:** `panelOpen` (user override, otherwise width ≥ 1100).
- **Derived:** `working` is true while any agent turn is folding or streaming. `waiting` is true while an elicitation is open.

## Accessibility
- The rail, transcript and composer are reachable by keyboard.
- Visible 2px focus outline in teal.
- Progress announced with `aria-live="polite"`.
- Statuses always pair a glyph with text.
- Hit targets are at least 44px on mobile.

## Files
- `wireframes/*.png`: one PNG per canonical wireframe frame, at 2x, sorted by flow (`00-spec-v1.png` first, then `01-` sign-in through `09-` texture). Filenames carry the frame id, e.g. `05-10c-agent-thread.png`. Superseded explorations (2a–2c, 4a–4b) are left out.
- `design/workspace-live.offline.html`: canonical clickable screen
- `design/opencrane-frontend-wireframes.offline.html`: full canvas (Spec v1 + turns 1–13)
- `design/Workspace Live.dc.html`, `design/Onboarding Wireframes.dc.html`, `design/support.js`: source
- Target: `apps/opencrane-ui/src/app/features/{chat,workspace,onboarding}`
