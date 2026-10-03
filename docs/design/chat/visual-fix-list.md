# P2-5 chat UI fix list

<!-- Preserve the audit ids across severity sections. -->
<!-- markdownlint-disable MD029 -->

Build one shared SVG line-icon set first: 16px in the toolbar, about 10–11px in the rail, 1.5px stroke. Items 3, 12, 13, 15 and 32 all use it.

## Resolution — 3 October 2026

Item 0 is the shared SVG set in `apps/web/src/app/chat/icon.ts`; it was built
first. Items **1–30 and 32–42 are fixed within issue #30's personal-session
scope**. Item 31 uses its explicitly allowed documented deferral. Item 33 follows the owner default recorded on #30. Evidence and limitations are recorded in
[the fix-round receipt](fix-round-evidence.md), with all 40 built screenshots
in [the comparison page](comparison/index.html).

Scope qualifications:

- **6:** Files/Activity shell, counts, every recorded tool/failure and transcript
  jumps are implemented. The WAITING ON YOU ask card is excluded by issue #30;
  no ask-card event or interaction is invented.
- **7:** The bridge supplies exit codes and event times, but no provider response
  or retry count. Those rows say “not reported”. Retry focuses a new message;
  it does not claim to re-run a tool independently.
- **15, 36:** The member name comes from the signed-in profile returned by `/auth/me`.
  Organisation comes from the existing page metadata. Team/department data is
  not in the contract; the secondary label shows the personal session scope.
- **17:** Assistant files are grouped, counted and marked saved. Empty attachment
  groups are hidden: uploads and their progress/retry events are not delivered
  by P2-5. No invented uploading/final state is shown.
- **31 — Deferred:** connector selection has no scoped chat connector API.
  The 1j caption, menu footnote and IMPLEMENTATION.md now say so. No dummy
  toggles are presented as working controls.
- **33 — Fixed:** the owner default on #30 selects Workspace Live: PDF red
  `#c1392b`, DOCX blue `#2a5c9a`, XLSX green `#2a7d4f`, other types grey
  `#81888a`, in both the transcript and Files panel.

## High

1. **Phone main column is wider than 390px** (8c; 390). The bubble, prose, composer and Stop are clipped, and the panel toggle is off-screen. Give the main area one column that can shrink. Let the header title fill the spare space and end in an ellipsis, so the status and the 44px panel toggle always stay visible. Check that the page scroll width is 390.
2. **Attach menu covers the composer** (1j; both). Anchor the popover to the composer card, with its bottom edge 8–10px above the card's top border and its left edge aligned with the card. Use the same anchor at 390, so the menu never covers the input or the send button.
3. **Voice button is a music note (♩)** (all 13 frames; both). Replace it with a 16px stroked microphone in #81888a that matches the attach +. Keep the 44px hit area on phone, label it "Voice input" for screen readers, and add a thin divider before the mode control (1j). If voice will not work in this release, don't show the button at all (8d).
4. **Closed-session composer doesn't say why** (8d; both). Show a grey lock and "This session is closed. Start a new session to continue." inside a dimmed field. Don't show attach, voice or mode in this state, and remove the separate notice line under the card.
5. **Rail states besides the filled list are not built** (8b; both). Add the four 8b rail cards:
   - Empty: crane mark, "No conversations yet" and a teal New session button.
   - Loading: shimmer bars.
   - "Can't reach your pod": orange dot, a live "Retrying in Ns" countdown and a Retry now button.
   - "No assistant assigned": the mono "pod: … · waiting" line.

   Capture each one at 1280 and 390.
6. **Session panel is not the 8i tabbed shell** (8i; both). Add a Files | Activity tab bar: the active tab sits on a white pill, with its count under the label. Add an Activity timeline that lists every tool line and failure and jumps to its message, plus the footer note. Pin a "WAITING ON YOU" card at the top while an ask is open. Use the same shell for the 390 overlay.
7. **Failure details are a raw red band** (8f; both). Replace the band with the indented white 8f drawer. It holds grey mono rows for tool, error category, provider response and time · retries, then the sanitised-details footer with a teal retry or reconnect link. Never show the raw digest, and remove the blank gap above it on phone.
8. **Files the assistant made look like attachments** (8e, 7h; both). Add a "created" card style: #9fdde8 border, a 12px dog-ear top right with the Dog-ear motion, and a teal mono "Ag" badge before the meta line. The plain grey card stays for user attachments only.
9. **Mode strip sits outside the To card** (12a, 12b; both). Move it inside the To card as a second row, left-aligned under "To:". Set it in 11.5px teal #0a94a7, led by the filled teal triangle. Remove the centred grey line and the "Only you and your agent" helper.

## Medium

10. **Template whitespace shows up in the prose** (workspace-live, 7h, 8b, 8c, 8d, 8e, 8f, 8h, 8j; both). The prose keeps the template's own spaces and line breaks. This causes a leading space in bubbles and paragraphs, a space before the comma after bold text, full blank lines between paragraphs, a space before the caret and a 50px gap above the A2UI fence. Remove the whitespace around text, bold and citation parts, or render each paragraph as its own block with 8–10px between them. Place the caret against the last character.
11. **Session title is cut at 45 characters and is not a slug** (workspace-live, 7h, 8b, 8c, 8d, 8e, 8f, 8h, 8i, 8j; both). Stop the fixed cut. Generate one short lowercase hyphenated slug (about 4 words, at most 24 characters, e.g. q3-board-pack) on the first send. Use it in the rail row, whether active or not, and after "#" in the header, which fills the free width and truncates with an ellipsis.
12. **State marks have no state colour or proper shape** (workspace-live, 7h, 8b, 8c, 8f, 8h, 8j; rail at 1280, tool lines at both widths). Use SVG icons for the four states:
    - Done: green check #2a7d4f.
    - Failed: red × #c1392b.
    - Closed: grey lock #91989a.
    - Working: filled teal triangle with the flutter motion.

    Give "stopped" its own lighter mark. Put each mark in a fixed 14px slot so the slugs line up. On tool lines, colour only the mark and keep the label grey.
13. **Agent mark is an outline △** (workspace-live, 7h, 8b, 8c, 8i, 8j, 12a, 12b; both). Use one filled teal (#0db5cc) triangle everywhere △ appears now: the agent tile (12px), Ask your agent, the header, the mode chip (whose text also turns teal), People, the To chip, "Starting your computer…" and the rail. Use the flutter motion only on rail rows with a run in progress.
14. **Citation chip has brackets and grows on phone** (workspace-live, 7h, 8c, 8d, 8f, 8j; both). Show the number in DM Mono without brackets, plus the source name when there is one. Put the dog-ear inside the chip's top-right corner. On phone, keep the chip about 16–22px tall and get the 44px touch target from an invisible hit area. Join it to the word before it with a non-breaking space so it can't wrap onto its own line.
15. **Rail footer has no current-user block** (workspace-live, 7h, 8b, 8j, 12a, 12b; 1280). Show a Settings row with a stroked gear icon, then a divider, then the signed-in user: a 28–30px teal avatar with initials, the name at 13px/600 and an 11px grey "Org · Team" line. The whole user row links to the account page.
16. **Session panel header and section labels are off-spec** (workspace-live, 7h, 8f, 8i, 12a, 12b; 1280 and the 390 overlay). Put "Session" in bold ink on the left, and the 8×10 scope rung and scope word in grey on the right. Style section labels as 10px/600, uppercase, 0.09em tracking, in the form "FILES · n". Remove the rules between sections (12b's stop 18px short of the edge) and remove the "▰ workspace" line. If the 8i tabs replace this header, the rung goes at the end of the tab row.
17. **Panel Files list is not grouped** (8i; both). Split it into "ATTACHED BY YOU · n" and "CREATED BY ASSISTANT · n", hiding any empty group. Show each file as a white card row about 36px tall, with a live state on the right: time, final or dog-ear, upload bar, or a red Retry. Add the footer note.
18. **File card action is a stray ↗** (workspace-live, 7h, 8e, 8j; both, worst at 390). Let the name block fill the card's width. Replace ↗ with a right-aligned teal "Open" link, plus "Files" on assistant files. On phone, give each a 44px tap area.
19. **Connection and queued states are bare text or a red error** (8c, 8d; both). Show one strip above the composer: a rounded bordered card with an icon and words on the left and a seconds counter on the right. Use amber for reconnecting and a teal tint for "Starting your computer…", and say what happens to the message. The queued state must not use the red error banner. Show a visible teal Retry, drop the duplicate grey line, and collapse the strip completely when there is no state.
20. **Streaming turn has no "Writing…" row** (8c; both). While the agent streams, add a row under the prose: the fold loader and italic grey "Writing…" on the left, and a quiet bordered Stop on the right that calls the same stop action. Remove the row when the turn ends. The composer Stop stays.
21. **Phone composer is the full desktop card** (8d, 8j; 390). Make it one row: + (44px), a pill input that grows as you type, then send (44px). Move voice and mode into the + menu, drop the 10px mode text and hide the caption.
22. **Phone has two header bars** (8j, 12a; 390). Drop the separate OpenCrane bar and make ☰ the first item in the 56px session header. New session moves into the rail drawer. If the bar stays, add the crane mark next to the wordmark.
23. **Phone transcript stops short** (8f; 390). The last line is cut and "✓ Done" is hidden. Scroll to the bottom after the final layout, and pad the bottom of the transcript by the composer's height plus a small gap.
24. **Phone panel close button is a tiny ×** (8i; 390). Make it a 44×44 button with a 16px close icon, as the last item in the header row and centred vertically. Run the header divider across the full width.
25. **Draft opens under an invented hero** (12a, 12b; both). Remove the hero. Pin the To card right under the header, at the same inset and width as the composer column. On phone, left-align the To row and use the same 16px gutter as the composer.
26. **Draft header doesn't show "Draft"** (12a; both). Until the first send, show no "#", "New session" in grey #81888a and an 11px grey "Draft" label. Switch to "#" and the ink title after sending.
27. **Agent recipient chip is flat** (12a, 12b; both). Give it a #eefafc fill, a 1px #9fdde8 border and radius 6, lead it with the filled triangle, and end it with a grey × that removes the recipient and updates the mode strip. Add the dog-ear when the chip is selected.
28. **A2UI fence looks like "Ask your agent"** (8h; both). Use a solid 1px #9fdde8 border on white, radius 10, with the citation dog-ear in the corner. The header becomes a teal "Ag" chip and "Interactive · built from approved components" in 11px grey. Use even padding of 14–16px.
29. **Opening the file preview shrinks the shell** (8e; 1280). A grey band about 100px tall appears at the bottom. Keep the preview element out of the page grid, and give the desktop grid one full-height row.
30. **Keyboard hint is 9px plain mono** (8d; 1280). Raise it to 11px and draw each key as a DM Mono keycap (#eef1f2 fill, #dee3e4 border, radius 4) followed by its label. Show "esc stop reply" while a run is active.
31. **Connectors submenu is missing** (1j; both). Add a "Connectors ›" row that opens the side card from the wireframe. If connectors are deferred on purpose, say so in the 1j caption and in IMPLEMENTATION.md.

## Low

32. **Other icons are still text characters** (workspace-live, 8d, 12a, 1j; both). From the shared set:
    - Attach: a 16px + line icon.
    - Send: a white arrow on both the grey and the teal button.
    - Stop: an 8×8 red #c1392b rounded square.
    - Phone top bar: 18px menu and + icons with matching stroke, in 44px buttons (12a makes the + orange #f47920).
    - Attach menu: upload and folder icons in a fixed 16px column.
33. **File type swatch: the designs disagree** (workspace-live, 8i; both). Workspace Live colours the swatch by file type: pdf red, docx blue, xlsx green. 8i uses a small grey mono chip and keeps colour for states. Today's 34px teal tile matches neither, so the owner should pick one.

    Fixed: the owner default recorded on #30 selects Workspace Live colours: PDF red, DOCX blue, XLSX green and grey for other types.
34. **File card text is too small** (8e; both). Set the filename to 13px/500 on one line with an ellipsis, and the meta line to 11.5px #91989a.
35. **Rail status words are 9px** (8b; 1280). Raise them to 11px. The slug and its status must fit on one line in the 236px rail; if space is tight, shorten the status word, not the slug.
36. **People rows are heavy and the count is wrong** (workspace-live, 8i, 12a; both). Use one-line rows about 26px tall, with an 18px avatar and the department in grey on the right. Show the current user as a teal initials avatar, not a grey "Y". List people only, so the agent doesn't break the count.
37. **Open tool line keeps the closed chevron** (8f; both). Rotate the chevron when the details are open, and mark the line as expanded for screen readers.
38. **Time details are missing** (workspace-live; 1280). Add an 11px #a7aeaf time, right-aligned under your own bubble. Show "Agent 09:14 · 48s" once a run finishes.
39. **Agent turn keeps the desktop indent on phone** (8j; 390). Put the avatar, "Agent" and the time on one row, and start the prose, tool lines and cards at the 16px transcript padding.
40. **Attach menu polish** (1j; both). While the menu is open, give the + button a 26px #eef1f2 fill. Remove the heading or make it a 10px uppercase label. Make the footnote 12px grey under a divider. Use 32px rows with a hover band on desktop, and keep 44px rows on phone.
41. **Draft rail row and To label** (12a, 12b; 1280 for the row, both for the label). Give the "New session" row a #e7ebec rounded background while its draft is open. The label should read "To:" at 12.5px #91989a.
42. **12b capture is a copy of 12a** (12b; both). The images are identical. Capture the draft for a user with no personal agent (amber-bordered To card, dashed disabled agent chip, reason sentence) at 1280 and 390.
