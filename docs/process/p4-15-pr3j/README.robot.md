# Private reply contract

Part of #97. Server part only; native admission remains disabled.

The bridge accepts strict `private_reply` reports with sequence, previousSequence,
conversationId, turnId, threadId, generation, inputGeneration and existing `text`.
Requester and assistant claims are refused. Saved server admission supplies identity.
Admission must follow the position captured when this bridge connection opens.
A failed position read refuses private delivery without delaying Stop. Saved preparation
must match admission and both generations, with loading proved.
Only the first output-loss record for a turn can release bytes. Deltas are not supported.

The strict notification reuses chat data fields `text` and `turnId`, with conversation,
turn, thread and generation identifiers. It has no durable cursor and bypasses the feed.
Subscribers must already be authenticated when the report arrives. At most one matching
subscriber receives it. Delivery requires a current access check and current loaded facts.

Limits: 24 KiB UTF-8 per reply, two pending replies per bridge, 64 across the process,
32 candidate sockets per reply and 4,096 registered private readers. Retention is at most
ten seconds. A subscriber with queued socket bytes is skipped. Encoded frames are at most
64 KiB. Bytes are cleared before sending, on disconnect, timeout or any failed check.
No server reply remains after completion of the attempt, including after turn completion.

The unchanged report writer saves `agent.output_lost` with no reply text or text hash.
Unknown append outcomes cannot release output. Duplicate reports, cold servers and new
connections cannot replay it. Ordinary human messages and completion records remain valid.
Whole histories load before the two-second access check; only new activity is read inside it.
After checking new turn and memory events, delivery records fixed positions for the
requester's member, assistant, discovered access and loaded scope streams. A position
beyond the checked history refuses delivery. The shared `authorityFence` compares those
recorded positions before sending; it does not replace them with a later global position.
Conversation and computer activity are checked separately for Stop, closure and other
terminal changes. Each access validation reads new activity once; harmless rows do not
repeat it. Ordinary messages cannot restart the delivery check. There is no
retry loop in the private reply code. Every read keeps the original two-second deadline.
The final reference, expiry and socket checks run synchronously before sending.
The existing loaded-reference checker remains unchanged.

Regression tests save member removal, Correct and Forget during the second incremental
scope read and while the subsequent scope-position response is held. Each requires zero
frames. Separate tests save an unrelated message during every incremental scope read
and every incremental conversation read; both require one frame. The deadline test
expires the original check while the scope-position response is held and requires zero
frames. All cases check buffer clearance.

Tests use real NATS, IAM and authenticated subscribers. Browser consumption, browser
clearance, streaming, cross-replica delivery and fresh-install qualification remain later work.
