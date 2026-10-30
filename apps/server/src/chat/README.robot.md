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
