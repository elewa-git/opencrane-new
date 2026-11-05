# Chat contracts

The [server contract](../../README.robot.md) describes the existing chat commands.
The [qualified start contract](../../../../docs/process/p4-15-pr5g/README.robot.md)
describes personal execution-mode selection, initial input delivery and its checks.
Qualified personal starts use the existing one-use memory consumer after loaded evidence.
The private bridge acknowledgement carries the rendered input with its short-lived pass.
Memory-free and shared work cannot receive this field. Generated memory output is still
refused by the report writer; native memory tool launch remains unbuilt.

Credential renewal recognises a saved `agent.turn_started` for the same turn. For a
numbered start, it also requires saved initial-load evidence. The runner resends the
same report number when renewing; an equal or later number can renew only after that
load. A larger number cannot bypass missing initial-delivery dependencies or qualification
withdrawn before preparation. Without loaded evidence, replay still refuses initial delivery.
Renewal does not prepare or resend initial memory, and needs neither the memory read
database nor the member feed. The existing loaded-reference and membership checks still
run before and after signing. Older starts without report numbers predate initial delivery
and remain renewable through the same access checks.

The withdrawal fixture now supplies a disposable PostgreSQL memory projection, encrypted
facts, recall settings, permissions and simulated deployment qualification. Its first
native start prepares and loads memory through the production path. Later withdrawal
requests use that saved input generation. Its second session represents older admitted
work. Replacement turn cases also resume older admitted work, so withdrawal of the first
turn's memory does not change the second turn's access.

The [private reply contract](../../../../docs/process/p4-15-pr3j/README.robot.md)
defines one-use server RAM delivery beside the unchanged text-free report writer.

Private reply delivery records the checked access and scope positions, then passes them
to `authorityFence` with the original start time and deadline. Conversation messages
cannot restart that check; Stop and closure still refuse delivery.

## Live private reply clearance

Part of #97, P4-15 PR 3k. Base includes PR 4m (#867), merged at
`64586a95c`; #863 is `5e5882fed`. Delivery remains linearised at the final
authority position read, as accepted on #863.

After delivery, private-output.ts retains only the exact recipient subscription and
its conversation, turn, thread, computer generation and input generation. It retains
at most 64 delivered identities per bridge. Reaching the limit clears the oldest
reply before adding another. Released text is never retained.

The checked memoryBridge withdrawal sends a strict id-only clearance to that original
subscription and clears matching pending server bytes. Duplicate clearance does nothing.
A computer receipt can release tracking only after this checked path ran; it cannot
select another recipient or authorise a different binding. Closing the chat or replacing
the computer clears the matching reply. Bridge loss clears all replies on that bridge;
browser loss removes its notification tracking. A new subscription receives no replay.

Tests use real memoryBridge detection and authenticated conversation subscriptions.
Rendering, streaming, admission, WebSocket history exclusion and fresh-install live
qualification remain outside this server/protocol change.
