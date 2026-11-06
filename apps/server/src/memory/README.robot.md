# Memory contracts

The [server contract](../../README.robot.md) describes the existing memory commands.
The [initial personal load contract](../../../../docs/process/p4-15-pr5d/README.robot.md)
records the two evidence commands and their checks. The
[delivery contract](../../../../docs/process/p4-15-pr5f/README.robot.md) describes the
one-use internal consumer, current-reference checks and complete input limits.

Initial loading imports the deployment-owned collector reader. It accepts no caller evidence.
The collector contract defines the fixed files, current measurements and required complete
qualifications. Each command captures saved membership first and keeps one command-local
permission decision with its original access positions. MemberAccessRefused takes precedence
over dependency failures. The ten-second preparation and two-second append limits remain.
Confirmation reads watched positions in parallel. It evaluates membership positions before
other results, retaining removal priority, every position comparison and the original
deadline. A subject added during confirmation is also checked. A successful confirmation
waits for every read; any changed or unavailable position still refuses it.

Release reads all new rows returned by the relevant access, scope and turn streams,
including changes saved after the global position read. Relevant access or turn changes
refuse delivery; changed scope rows update the selected-reference check. Each stream
bounds its own read. Unrelated chat activity does not repeat validation.
Synchronous qualification and reference-expiry checks follow the last awaited read.
Failed validation retains the original block for a fully checked retry. The consumer
reserves each attempt before waiting and removes the block only when delivery begins.

The bridge passes checked saved withdrawal to the
[private reply clearance path](../chat/README.robot.md#live-private-reply-clearance)
before accepting a computer clearance receipt. Saved preparation supplies the requester,
computer generation, turn, thread and input generation; a receipt supplies no authority.
Completed turns remain tracked until checked clearance. Closure and replacement clear
the old binding without sending a Stop to a replacement process.
Saved Stop requests also clear an already delivered reply through its checked preparation.
The check uses `readChatStopRows`, outside any access deadline, and matches the conversation
and turn. A late completion cannot hide the Stop. Repeated polls notify the original
browser once and keep tracking until the computer confirms clearance.

## Recall delivery checks

The joined [backend fixture](../../test/recall-backend-delivery.test.ts) uses the same
MCP handlers and signed gateway contexts as production. Its response observer reads the
saved conversation evidence before the first result bytes leave the backend. Holding,
refusing or losing the append response cannot return fact text; an unknown append can
still leave loaded references in replay. Repeating that call never returns the old result.

Four content replies retain their measured byte totals under 64 KiB, with whole pages
under 16 KiB. The next call and a thirty-third distinct loaded reference return no facts.
The existing memory-context record tests separately exercise the exact cumulative byte
boundary. Discovery uses the local reviewed catalogue and makes no backend call.

Recall delivery reads the projection before its final `rights.confirm()`. That confirmation
uses the existing authority check with the original access positions and deadline.
No database read follows it. Full chat history remains outside the short check;
confirmation reads only later activity and the small access streams. Stop, removal,
closure and replacement saved during the final projection query refuse text and proof,
even when local withdrawal has not run yet.

Renewal is settled at its final access check's read. Correct or Forget saved after that
read is ordered after renewal and enforced at the next confirmation. Renewal releases
no memory text. The existing `memory-dispatch.test.ts` boundary assertions remain unchanged.

The [Remember contract](../../../../docs/process/p4-15-pr4n/README.robot.md) records native
write qualification checks and original agent-command status without resubmission.
Remember uses `rights.confirm()` after loaded-reference validation and as the event
store's final append check. This checks later turn, Stop and computer events alongside
the original access positions and deadline. Full conversation history stays outside
the short authority check. The backend tests hold the real PostgreSQL command lock,
save Stop or a replacement generation, then release the lock and require zero writes.
Separate cases save those events just before the append check. Local callers remain
registered in all four cases to represent delayed withdrawal.

The [Correct contract](../../../../docs/process/p4-15-pr4o/README.robot.md) extends the same
private offer to Correct. The backend checks deployment qualification before saving and
at append, alongside full turn confirmation with the original positions and deadline.
After saving, Correct repeats the qualification, membership and live-turn checks before
returning its exact text-free receipt. It keeps the original access positions and deadline.
A delayed save acknowledgement cannot release the receipt after access or the turn ends. Original-command status resolves a lost reply
without another revision. Public discovery still offers Recall alone; Forget stays held.
