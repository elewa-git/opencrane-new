# Governed tool activity appears in chat

The chat transcript now shows when a reported tool call starts, finishes or
fails. If the turn ends before a finish report arrives, it says that the result
was not confirmed. The details drawer follows a call as its saved status changes.
Live starts and results are announced once to screen readers after the socket is
ready. Replayed history stays quiet, including after a new session replaces the
socket. Pressing Stop shows “Stopping…” until the server confirms that the turn
ended, and tool finishes can still update the transcript while it stops. If no
ending report arrives after ten seconds, the screen says “Stop not confirmed”,
keeps the reply active and offers Stop again. A late ending report still sets the
final turn state. Long tool names wrap inside the transcript on phone screens.
A restricted tool refusal is shown as an access refusal without guessing its cause.
After a reload, a saved Stop request does not make a turn look as if it is still
stopping; the turn status comes from its start and ending reports. Stop is not
sent for a turn the browser already knows has ended, and a late reply cannot
make it active again. If the Stop request takes longer than ten seconds, Stop
can be tried again while that request is still waiting.

The existing approval cards continue to show pending decisions, approved but
unused approvals, used approvals with unknown outcomes, denials, expiry and
cancellation from the approval read. The cards do not claim that the tool
server completed an action.

The screen slice covers these designed states:

- **Done or adapted:** WRK-01, WRK-02, WRK-03, WRK-04, WRK-07, WRK-10,
  WRK-11, WRK-14, WRK-16, WRK-17, WRK-18, WRK-19, WRK-20, WRK-21,
  WRK-22 and WRK-31.
- **Still to build:** WRK-05, WRK-06, WRK-12, WRK-13 and WRK-30.

These are the 21 states listed in issue #46. The generic access refusal does
not claim that missing review data caused it; the conversation feed does not
give the browser that detail. The handoff's WRK-15 state is outside issue #46.
WRK-30 needs evidence that a call was refused before dispatch and is safe to
repeat.
