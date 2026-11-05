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

## Saved recall preparation

P4-15 PR 4m3 first split adds `preparePersonalRecallLoad` in `personal-memory-tools.ts`.
It receives trusted local caller identity and an untrusted `recall_pending` receipt.
It reads the saved computer turn, personal assistant owner and current memory policy;
it does not trust a caller-supplied turn summary, catalogue or qualification.
The deployment reader supplies measured identity and checks from its protected result.

Only `request` may cross the bridge. It repeats the strict receipt fields with type
`recall_load` and fixed recall definitions. It contains no registry, caller credential,
RAM approval or fact. `complete` consumes one exact `recall_loaded` receipt and returns
an approved local catalogue after repeating saved identity, membership, policy and
qualification checks. An invalid receipt consumes the attempt too. No receipt means
no completed preparation; completion after the original ten-second limit refuses.
The returned catalogue is not permission to release input or credentials.

Membership and memory-tool grant positions remain fixed across discovery, including
past team grants.
Conversation history loads before the two-second check over small access streams.
Saved Stop, closure, replacement and control changes refuse; unrelated activity does not.
Preparation and completion reject saved invalidated or ended memory even while the Stop
reaction is pending. They reuse `prepareLoadedMemory` to check loaded references and their
read permissions. Scope history loads before the short access check; later checks read
only new scope events. No fact is decrypted. A new load during confirmation refuses so it
cannot add unchecked references. Both return paths check the local caller after all waits.
Established MemberAccessRefused takes priority over dependency failures.

PARTIAL: no production bridge caller invokes this helper yet. The next split must bind
it to authenticated delivery, cancel abandoned loads, gate initial input and credentials,
and prove real backend recall with loaded evidence saved before bytes. The native numeric
input generation and saved memory input generation remain distinct existing identities;
this helper validates the former against its trusted local registration. Neither a receipt
nor this local approval replaces saved memory evidence. Admission remains disabled.
