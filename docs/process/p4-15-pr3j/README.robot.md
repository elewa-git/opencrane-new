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
The existing loaded-reference checker remains unchanged.

Tests use real NATS, IAM and authenticated subscribers. Browser consumption, browser
clearance, streaming, cross-replica delivery and fresh-install qualification remain later work.
