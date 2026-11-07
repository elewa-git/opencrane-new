# Chat contracts

## Original call status

`GET /api/conversations/:conversationId/tool-requests/:logicalRequestId` reads
saved Ask approval and permit histories before one final participant access check.
It compares the request position with the person's current participation interval.
Shared child status belongs only to the requester. Missing or bad saved evidence
never proves non-dispatch. The reply excludes tool arguments and results, and the
route never saves an event, wakes a bridge or releases a credential. A read failure
returns 503. The optional retained-call reader is for the later authenticated
bridge connection; until it is connected, production status cannot be `eligible`.

## Dispatcher readiness in chat

Assistant session history and the existing WebSocket `ready` frame carry
`dispatcherReady`. `false` means the dev stack's dispatcher marker is missing or
does not match the recorded dispatcher PID and process start. This rejects a stale
marker after its PID is reused. The server reads the marker only after chat access
has passed.
The live subscription checks it on its existing 100 ms cycle and sends a new `ready`
frame when it changes, even if no conversation event was saved. Direct and group
chats report `true`. Production has no dev marker and reports `true`.
`test/chat-http.test.ts` checks the HTTP reply and both live readiness values.

The [server contract](../../README.robot.md) describes the existing chat commands.
The [qualified start contract](../../../../docs/process/p4-15-pr5g/README.robot.md)
describes personal execution-mode selection, initial input delivery and its checks.
Qualified personal starts use the existing one-use memory consumer after loaded evidence.
The private bridge acknowledgement carries the rendered input with its short-lived pass.
Memory-free and shared work cannot receive this field. Generated memory output is still
refused by the ordinary report writer. The backend fixture below checks recall delivery.

Credential renewal recognises a saved `agent.turn_started` for the same turn. For a
numbered start, it also requires saved initial-load evidence. The runner resends the
same report number when renewing; an equal or later number can renew only after that
load. A larger number cannot bypass missing initial-delivery dependencies or qualification
withdrawn before preparation. Without loaded evidence, replay still refuses initial delivery.
Renewal decides from saved start and initial-load evidence before recall preparation.
It does not repeat recall discovery or prepare or resend initial memory, and needs neither
the memory read database nor the member feed. The existing loaded-reference and membership checks still
run before and after signing. Older starts without report numbers predate initial delivery
and remain renewable through the same access checks.

`test/memory-delivery.test.ts` renews a recall turn through the real computer channel.
It checks one grant reply, no repeated discovery or input, and unchanged memory evidence.
Correct, Forget, removal and Stop each refuse renewal before the withdrawal reaction runs.

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

## Recall dispatch after admission

Qualified personal turns offer Recall, Remember and Correct from reviewed, free Allow policy
and both MCP-use permissions. The [Remember contract](../../../../docs/process/p4-15-pr4n/README.robot.md)
records Remember delivery. The [Correct contract](../../../../docs/process/p4-15-pr4o/README.robot.md)
records replacement delivery. Forget remains excluded. Shared and memory-free turns cannot use
this offer. It supplies definitions, not approval to discover tools or read facts.
The authenticated bridge accepts recall receipts only for an original delivery carrying
recall metadata. That metadata records its requester, expiry and frame size on the server.
After saving admission, `recallBridge` checks the saved requester, conversation and thread,
then invokes `preparePersonalRecallLoad`. Its separate local registration never leaves the
server. The computer keeps its own registry and caller credential.

One strict pending receipt binds the native numeric input generation and load id for this
connection. The helper verifies the computer generation against saved lifecycle evidence.
The native input generation is still separate from the saved memory input generation.
The server sends only the checked request, then waits for one loaded receipt. Duplicate,
missing, changed or refused replies cannot release input or credentials. Socket loss,
terminal reports and the ten-second pending limit abandon the attempt without resend.

Completion checks the original positions and deployment result. `confirm` repeats those
checks before and after signing credentials, retaining the original preparation deadline.
The complete frame limit includes the offered definitions and signed credentials.
The initial-memory consumer still saves loaded evidence and checks access before input.
Its synchronous release also requires the original live connection and pending attempt.
An established membership refusal remains decisive. No new event or wire field is added.

The joined fixture uses the production chat sender and supplies saved admission, then runs
production preparation, the bridge, computer runner, loader, proxy and scripted native
discovery. That fixture does not call a model or recall facts. The backend fixture below
now checks delivery through the real gateway. Admission stays disabled. Fixtures do not
qualify deployment.

## Real backend recall fixture

`test/recall-backend-delivery.test.ts` sends a saved personal turn through the production
sender, catalogue assembler, authenticated bridge, private loader and local MCP proxy.
A scripted native peer calls the real gateway and memory backend. NATS, PostgreSQL and
OpenFGA are disposable services. Saved admission and deployment observations are fixtures;
no global admission or live qualification is enabled.

The fixture checks a stored own-person fact, loaded evidence before response bytes,
denied and unknown appends, duplicate calls, replaced client identity headers, whole-page
and turn limits, and separate same-person sessions. The tests in `memory-delivery.test.ts`,
`personal-recall-tools.test.ts` and the computer recall suites retain the discovery refusal
matrix. These are complementary checks; this fixture does not repeat every discovery
failure through the backend. See the [own-check receipt](../../../../docs/process/p4-15-pr4m3/backend-delivery.md).

## Routine hand-off completion

The bridge completes a routine sender's one-use wait only after the matching start
is saved and its existing credential acknowledgement path finishes without refusal.
The wait lasts at most ten seconds after preparation; cancellation and socket loss
settle it as unknown. A report captures its original pending attempt before waiting.
Immediately before sending credentials, the bridge verifies worker ownership, then
checks cancellation, the original deadline and the socket without yielding. Sending
and cancellation consume the same attempt once. A late handler sends only refusal.
The sender saves `routine.run_stop_requested` with source `delivery`, reason
`start_unconfirmed` and the activation admission as its cause. The occurrence stays
occupied; this is not termination evidence. Completion is local hand-off evidence, not a run result or
proof of remote receipt. Automatic execution stays off. No memory path changes.
See [the contract and own checks](../../../../docs/process/p4-24-pr10h/README.robot.md).

## Routine Stop and finish

The saved prohibition poll cancels the exact turn's pending start wait before sending
Stop. A handler held after credential preparation therefore returns only refusal when
resumed. Unconfirmed-delivery recovery reuses that verified prohibition instead of
saving another Stop source. Recovery reads accepted open starts once per connection from
the computer summary; it grants no execution permission. Allocation, occurrence,
private thread and generation checks
still apply. Concurrent chat polls share the startup read, and later starts enter through
normal admission. Startup recovery runs while the existing computer Stop timer is active.
Finished chats do not trigger another computer-history read. Ordinary conversation history
remains outside short access checks.

The models process uses its existing budget actor to apply saved Stop and then call
checked finish. The [server contract](../../README.robot.md#saved-routine-stop-recovery)
describes recovery. This does not register production routine delivery.

Normal completion retains the computer's checked native termination marker on the
server closure. A saved routine Stop can therefore finish as interrupted even when
the computer completed before receiving cancellation. The first closure remains final.

## Saved first child turn

`child-hold.ts` keeps a saved child input queued until the matching activation exists and
the internal models decision URL is configured. The bridge saves the computer's restricted
start report before asking the models process for admission. The request carries only the
child, input and prepared thread ids. The computer pass supplies its assistant, computer
and generation. The actor loads the original intent, current attempt and saved report,
then checks access, remaining root cents and current spending ceilings before the existing
computer start command. A lower ceiling can refuse an already allocated root.
It returns the stored root and turn binding. If capacity is busy, the decision service is
unavailable or its reply is lost, the bridge asks the computer to retry the same saved
report after a short wait. The socket stays open and no native turn starts before a pass
arrives. A saved computer start is returned on retry without saving another start.
The computer journal marks native execution before it begins. A process restart still
fails an unfinished private turn because its prepared thread died with the process.
No public follow-up or child start route is added.
