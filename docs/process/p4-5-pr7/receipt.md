# Group participant screen checks

Date: 10 October 2026. Browser: Chromium with intercepted API replies and reduced
motion enabled. The captures were regenerated after the access and participant fixes.
They show the participant and unavailable screens at 1280px and 390px, using the
THR-13 and THR-16 handoff frames as references. Both sizes have no horizontal overflow;
visible controls meet the 44px target.

The participant screen keeps the creator in the chat, marks a colleague who left the
company as removed, and offers only actions allowed by the participant read. Participant
events update the open rows and names without a reload. Search uses server results and
follows its next-page cursor. The phone picker is a modal dialog with trapped keyboard
focus. Back returns focus to Participants. Leaving a chat clears its transcript and
composer before the unavailable notice appears.

Component tests cover the creator lock, leave and purge, stale colleague, applying and
unknown results, same-command status checks, live participant removal, server search and
pagination, phone focus trapping and socket cache clearing after access loss. The browser
captures use fixtures. They do not prove live permissions or qualify a fresh installation.

- [1280px participant picker](captures/THR-13-1280.png)
- [390px participant picker](captures/THR-13-390.png)
- [1280px unavailable](captures/THR-16-1280.png)
- [390px unavailable](captures/THR-16-390.png)
