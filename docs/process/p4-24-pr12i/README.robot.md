# Routine Stop integration contract

Part of #106. Base: `f9d0f0ff8`. Failing-first commit: `b10baa69c`.
The first regression reached real native closure but found no interrupted finish.
A second regression held acknowledgement after credential preparation; saved Stop
still returned sent. It now cancels the original one-use start wait.
The follow-up source assertion found an extra delivery Stop. Recovery now verifies
and reuses the existing owner, admin or approval prohibition. Test commits also include
`ea66f44c8` and `e1ee8c039`.

The existing models process polls saved allocated routine roots with its budget actor.
Each Stop command and finish command retains its own one-stream append. The reaction
uses the first matching prohibition, so retries preserve its source. Finish still
checks the exact occurrence, allocation, people, private thread, computer generation,
server closure and native terminal evidence. Its final append also checks worker ownership.
Bridge recovery reads saved open starts for cancellation only. Replay invokes neither
Stop nor finish. There are no new event/API fields or dependencies.

The sender, composition, company connections and protected authority/security tests
are unchanged. Execution remains disabled. Owner Ask, company credentials, normal
success, process-exit evidence and fresh-install qualification remain later work.

## Own checks

Environment: shared development host, disposable NATS/OpenFGA/PostgreSQL and a scripted
native bridge. No model calls, owner stack changes or fresh installation.
All tests, lint and typecheck run under `nice -n 10`. No full root suite is run locally.

The draft PR records the final source commit, checks and GitHub CI result.
Live qualification: NOT RUN.
