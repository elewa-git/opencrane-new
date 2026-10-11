# Group participant screen checks

Date: 10 October 2026. Browser: Chromium with intercepted API replies and reduced
motion enabled. The captures were regenerated after the access and participant fixes.
They show the participant and unavailable screens at 1280px and 390px, using the
THR-13 and THR-16 handoff frames as references. Both sizes have no horizontal overflow;
visible controls meet the 44px target.

The participant screen keeps the creator in the chat, marks a colleague who left the
company as removed, and offers only actions allowed by the participant read. Participant
events update the open rows and names without a reload. After a socket resync, the screen
replaces the picker rows and conversation names with the server's current state. Search
uses server results and follows its next-page cursor. The phone picker is a modal dialog
with trapped keyboard focus. Back returns focus to Participants. An uncertain participant
change keeps workspace links on the screen so its saved status can still be checked.
Leaving a chat clears its transcript and composer before the unavailable notice appears.

Component tests cover the creator lock, leave and purge, stale colleague, applying and
unknown results, same-command status checks, live participant removal, resync replacement,
workspace navigation during recovery, server search and pagination, phone focus trapping
and socket cache clearing after access loss. The browser captures use fixtures. They do
not prove live permissions or qualify a fresh installation.

The failing-first run on the code before the fixes failed both new cases: workspace
navigation was not cancelled, and the resync left Grace in the picker. The other 56 tests
passed. After the fixes, the changed direct-chat spec passed twice with 58 of 58 tests:
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm run test -w apps/web -- --watch=false --include=src/app/chat/direct-chat.spec.ts`.

- [1280px participant picker](captures/THR-13-1280.png)
- [390px participant picker](captures/THR-13-390.png)
- [1280px unavailable](captures/THR-16-1280.png)
- [390px unavailable](captures/THR-16-390.png)
