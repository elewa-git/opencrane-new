# Protocol

For people, read [README.md](README.md) first.

`memberHeaderSchema` requires literal false role and removal flags.
`memberDetailSchema` accepts booleans for those flags. The directory accepts a
boolean `permissions.invite`; it does not give a Member directory access.
`memberRoleCommandSchema` checks the Member/Admin choice and member position.
`memberRoleReceiptSchema` checks the saved event reply. `memberRoleStatusSchema`
also checks the effect and separate content and IAM progress from the status GET.

`chatStateCommandSchema` strictly checks archive/read command ids and join ids.
Archive carries a boolean and non-negative expected position. Read carries a positive
safe position and event id. Conversation list rows optionally include `joinEventId`,
`archived`, `archivePosition`, `throughPosition` and `throughEventId`; old replies
still parse. The existing `chatChangeSchema` separates append and projection status.

Protocol defines shared browser/server message schemas so the two sides cannot drift
through separate declarations. It owns wire shapes, not authentication, persistence
or event business rules. Both [web](../../apps/web/README.md) and
[server](../../apps/server/README.md) consume it.

## Takeover approval cancellation

The fixed `takeover` cancellation cause is shared by event and approval reply
schemas. No new data field or event type is introduced. The saved cancellation time
supplies `endedAt`. Used approvals retain their existing evidence. The exact behaviour
is described in the [approval API](../../docs/api/approvals.md).

## Public contract and usage

Import `@opencrane/protocol` through [src/index.ts](src/index.ts).
From the repository root:

```sh
node --experimental-strip-types --input-type=module -e "import { clientMessageSchema } from '@opencrane/protocol'; console.log(clientMessageSchema.parse({type: 'hello', text: 'Hello'}))"
```

Client messages are `hello`, `validateEvent` or `subscribe`; resumed subscriptions
carry a projection generation, and every members reply carries that generation.
Server messages include hello echoes, errors, validation results and versioned members updates. See
[messages.ts](src/messages.ts), [realtime.ts](src/realtime.ts) and the
[subscription contract](../../apps/server/README.robot.md#members-realtime-and-shutdown).
The event-validation request carries `unknown` data: the server must validate it
against the [event catalogue package](../events/README.md) before accepting it.
`integrationsResponseSchema` defines MCP register rows and their shared state kinds;
`integrationsRefusalSchema` names the admin-only refusal without trusting cookie roles.

`chatContextSchema` includes the authorised member’s optional display name and
personal assistant id. Chat feed and live reply schemas type the computer state
as ready, starting, recovering or not applicable. They may include the time of
the latest computer loss. `sessionSlug` formats the first message consistently for
the server list, rail and header. Conversation list status distinguishes `stopped` from
`done`; both are derived from events, never a separate stored status.

Use `safeParse` when rejected input is expected, or handle the Zod error from `parse`.
Strict message schemas reject unknown fields, wrong discriminants and malformed values.
A matching static type does not guarantee a successful request or authorisation.
Callers must authenticate the socket, authorise operations and handle remote failures.

## Verification and dependencies

```sh
npm test -- libs/protocol
npm run typecheck -w libs/protocol
```

Tests cover valid and invalid messages. Server tests cover the runtime socket
boundary; Angular tests cover client handling. The package defines message shapes for
chat, settings and audit screens. It stores no recoverable state.
The only runtime dependency is Zod; the package is usable by browser and Node code.
See the [repository architecture](../../README.md) and [plan](../../plan.md).

Chat HTTP response schemas (`chatContextSchema`, `chatListSchema`,
`chatFeedSchema`, `chatRowSchema`) validate browser reads. Known display fields
are typed; unrendered event fields stay opaque. `WebSocketService.received` in the
web app delivers each validated envelope without Angular signal coalescing.

Audit history uses `auditFilterSchema`, `auditDetailFilterSchema`,
`auditResponseSchema` and `auditDetailSchema`: request/permit/conversation/turn
ids, event time, safe actor, command digest, separate decision and observed
outcome, integer cents and fixed readable reasons. Strict metadata schemas
reject private payload fields. Organisation filters include UTC bounds, event
family, actor id, outcome and event/request/permit reference. The list defaults
to 20 anchors and the detail defaults to 20 records; both stop at 50.
The Angular history views use this same contract; no event payload is passed to
browser rendering. See the [HTTP contract](../../apps/server/README.robot.md#permission-scoped-audit-p3-19).

The People & groups screen uses `groupRowSchema`, `groupsResponseSchema`,
`groupReceiptSchema`, `groupChangeSchema` and `createGroupCommandSchema` for its
flat group reads and create command. `removeMemberCommandSchema` checks the
strict member-removal request. `addMemberCommandSchema` checks an addition with
the same three fields.
Spending reads use `effectListResponseSchema` and
`effectDetailResponseSchema`. Price table names can include version punctuation.
Detail accepts optional nullable `resolutionReceipt` with only `changeRef`, `eventId`,
`position`, `time`, `resolvedBy`, `outcome` and non-negative safe integer `settledCents`.
The field is optional for older replies; the current server always sends it, using null
when no resolution was saved. Unknown receipt fields are rejected. It confirms only
the saved resolution, separately from current money. The existing detail schema and
export are reused, so strict browser reads continue to accept the server's response.
The browser sends one checked evidence entry when it settles or releases a hold;
the server contract still accepts one to ten entries.

`computerRecovered` describes the assistant's computer, rather than any one chat.
The browser compares `computerLostAt` with its last agent turn before showing a
lost-request notice. `lastConfirmedTurnAt` is calculated in the browser from loaded
turns that are Done; completed turns with lost output are excluded. It is not a
separate server field. Suspended and resumed computers use the starting state.

## Tool fields in chat rows

`chatRowSchema.data` allows optional strings `callId`, `serverId`, `toolName`,
`requestId` and `approvalId`. Tool rows check `status` as completed/failed;
decision rows check `outcome` as allow/ask/deny. Other rows keep their own string
values, including saved/kept_existing for delivered uploads. `durationMs` is a
non-negative integer. Tests parse all older conversation examples, HTTP feeds
and live delivery messages.
The browser receives these fields through the existing feed and live messages.
Tool outcomes accept `evidence: dispatch_refused` for a refusal after a saved start and
before sending. These rows retain `outcome: not_dispatched`.
Running tool lines and attempt lists are not rendered yet. Tests are in
`test/chat-mode.test.ts`.

## Member reads

Strict header, detail, directory and query schemas follow the
[member API](../../docs/api/members.md), including separate pages and silo counts.

`invitationEmailInputSchema` checks the Admin's email input.
`invitationEmailSchema` checks the [reply](../../docs/api/members.md#invitation-email),
which says that the person is confirmed when they accept. It carries no account
existence, verification or organisation claims.

`invitationCommandSchema` and `invitationStatusParamsSchema` follow the
[member API](../../docs/api/members.md#create-and-renew-email-invitations).
`apps/server/test/invitations.test.ts` tests both routes.

Model access reads use `modelAccessResponseSchema` and
`modelAccessCandidatesResponseSchema`. A grant response carries at most 100 rows
and an exact `grantTotal`; it does not repeat the grant rows inside explanations.
Grant rows name the grantee kind, safe display name, source, latest event and
whether the content table has applied it. Personal assistant names use the owner's
display name and the words `personal assistant`.
The response keeps provider binding, enabled-model, key and verification facts as
`not_available_yet` until those event-backed records are available.
Candidate reads require a kind and use an optional id cursor and a limit from 1 to
100. Group candidates include only the count of current joined members.

Model grant writes use `modelAccessCommandSchema` and return
`modelAccessReceiptSchema`. The [HTTP contract](../../apps/server/README.robot.md#model-grant-changes)
defines permission checks, conflicts and recovery.

`chatGroupsSchema` and `chatGroupSnapshotSchema` check the member-facing group
picker replies. `chatListSchema` accepts human group rows with their explicit
participants and optional recorded group association. See the
[group API](../../docs/api/group-chats.md) for the server checks and limits.

`memberAccessSchema` and `memberDepartureSchema` check recorded access and versioned
departure reviews. They keep recorded grant sources separate from checked
person/assistant permissions and unavailable use readiness. Departure revisions bind
the actual checked inputs. Missing permission evidence makes the review incomplete.
`permissions.remove` is a boolean. The server enables it only for a complete
review of an active non-owner. The removal route still checks the review again.

## Hosted tool policy

`toolPolicySchema.startupReviewRequired` is optional for older stored policies and
browser replies. The event fold derives it from a declared hosted startup contract
or a saved startup refusal. Startup policies remain unpublished while their runtime
is unavailable. Existing per-call policies, including memory registrations without
a startup contract, keep their existing publication checks. The field grants no
access by itself.

## Control history

`requester_only` and `control_conflict` have fixed human-readable refusal descriptions
in auditReasons. Refusal records use the existing actor, time and event reference fields.

Audit records may include computer id, generation, takeover/lease references,
reviewed requester event and affected-turn count. These are references, never
bearer credentials. Private affected-turn lists are not part of organisation history.

## Dated MCP catalogue evidence

Tool lists carry check and expiry dates; undated lists cannot authorise calls.
`toolPolicySchema.driftHeld` is optional for older replies. The shared event fold
sets it after a saved tool change. The field reports a hold; it grants no authority.
Unchanged checks preserve the approval rule revision while advancing the write position.
The [projection contract](../../libs/projections/README.robot.md#dated-mcp-catalogue-evidence)
records snapshot and expiry rules for #48 PR 1.

Tool policy replies also carry `silo` and `serverId`, taken from the saved events.
Older projected replies default these fields to null. The back end checks them during
replay; parsing a browser reply does not authorise a tool call.

## Inventory history availability

Departure routines and personal connections carry `absent_on_version` only after
a complete check. Known unsupported records carry `unsupported_history`. Missing,
changed or over-limit inventory inputs carry `unavailable`, with removal disabled.
The member inventory integration tests check overflow and the shared reply schema.

`chatListSchema` accepts optional nullable `nextCursor` alongside the existing rows.
New list replies include it; older replies remain valid. A non-null value requests the
next page of visible matches. Empty successful pages have a null cursor.
Group rows may omit `createdBy`: ordinary late joiners receive their join time and
current participants, without the original creator or group snapshot. See the
[server list contract](../../apps/server/README.robot.md#chat-ui-reads-and-stop).

## Tool access explanation messages

`toolAccessExplanationSchema` checks the safe explanation reply. MCP member access
rows can carry up to 50 `toolExplanations` and a nullable `toolExplanationTotal`.
A null total means the full count could not be checked. Grant sources distinguish `direct`, `group`
and `assistant`. Profile history absence and IAM failure remain separate fields.
Publication and availability stay unavailable until the missing checks are built.
See the [API contract](../../docs/api/members.md#tool-access-explanations).

The tool access route accepts either a full permitted explanation or a strict
missing-grant reply. The latter contains request ids, check time, permission results,
permission reasons, `complete: false` and `availability: unavailable`. It contains
no policy, catalogue, account, source or review-revision fields. Refused and failed
reads use the route's ordinary status replies. Member inventory rows retain their
admin-only tool explanation shape.

## Publication preparation (P3-4 PR 2a; Part of #45)

ToolPolicy optionally carries reviewRevision and the strict publication intent.
These are saved facts, with no gateway readiness claim. Older policy replies still parse.

## Child invitation acknowledgement

`chatParticipantCommandSchema` accepts `historyReleaseAcknowledged: true` on an
addition. The server requires it for shared children and rejects it for ordinary
groups. Remove and leave shapes are unchanged. See the
[child invitation contract](../../docs/api/group-chats.md#child-only-invitations).

## Hosted image admission receipts

`hostedAdmissionSchema` carries serverId, attemptId, imageDigest, platform,
queuedAt, status and optional checks. Status is checking, rejected, unavailable,
admitted or expired. Each check reuses the strict event receipt shape.
Attempt numbers are positive integers; queued requests contain no checks.

## Saved gateway receipt

ToolPolicy optionally carries `configurationObservation`, using the strict event schema.
Older policy replies still parse. The field contains safe configuration references and
the observation date. It is a saved fact, not a live Ready status or call permission.

## Saved budget stop replies

`budgetStopStatusSchema` strictly checks `not_stopped` or the saved stop id,
matching reasons, work execution, call statuses and observed positions. Reasons allow optional
`limitCents`, which the server includes only for the human message's author.
Each strict `calls` entry has a `reference` and a status: `held`, `possibly_sent`,
`charged` or `released`. Only held and possibly sent entries accept optional
`heldCents`; only charged entries accept optional `chargedCents`. Amounts are
non-negative integer euro cents. The server omits them for other participants.
No names, scope ids, configuration references or spending totals are accepted.
Approval cards accept an optional `turnId`; older replies still parse.

## Reviewed child answers

Final and interim text publication follow the [HTTP contract](../../docs/api/group-chats.md#reviewed-child-publication).
`chatRowSchema` includes `publicationKind: final | interim`. The server selects the
published entry fields before decrypting text for HTTP and sockets.

## Reviewed child requests

`childReviewInputSchema`, `childStartInputSchema`, `childRetryInputSchema` and
`childRequestStatusSchema` check
the [child request API](../../docs/api/group-chats.md#reviewed-child-requests).
Status and retry inputs are strict. Retry accepts only retryId and failureEventId.

## Child origin replies

`chatOriginSchema` accepts exactly a linked parent id, title, source message id and
positive source position, or `{status: "restricted"}` alone. Both alternatives reject
extra fields. See the [origin contract](../../docs/api/group-chats.md#child-origin).

## Reload cancellation position

ToolPolicy optionally carries `publicationRevision`, the positive saved event position
that invalidated approvals for a publication. It is distinct from the tool review position.
Older policy replies still parse. This field contains no tool text and grants no authority
without the matching saved publication and review.

## Saved budget stop notifications

`chatMessageSchema` and `serverMessageSchema` accept this strict `/ws` frame:

```json
{"version":1,"topic":"conversation","conversationId":"chat","type":"budget_stop","turnId":"original-turn","position":42,"generation":1}
```

It announces a saved stop for a visible human turn. It carries no stop id, amount,
reason, execution claim or call reference. The ordinary event at the same position
remains available to existing clients. The notification has no `row` or computer
fields. `position` belongs to the saved chat stop event, not the budget stream.

On notification or reconnect, the client GETs
`/api/conversations/:conversationId/budget-stops?turnId=original-turn`.
That read supplies the original stop id, reasons, execution status, calls and positions.
It can return unavailable while saved work is catching up. Unavailable never means
no stop or no previous effect. It never authorises another command or retries work.
A failed socket data read closes with code 1013. An authorised GET reports saved-history
failures as HTTP 503, never `not_stopped`.
The client replaces the status for that original turn; repeated delivery or GET
must not create a second notice. It retains the socket cursor and generation for
resubscription, and refreshes status even when no notification is replayed.

After refusal, the client clears protected status and ignores late socket and GET
callbacks from that subscription. A new selection or reconnect needs a new local
subscription revision so an old reply cannot restore access. Angular integration
and its delayed-callback tests remain with the screen work.

## Saved approval dates and cancellation reasons

The [approval API](../../docs/api/approvals.md) defines the optional UTC fields,
first-use retention and dated permit list. Dates come from approval event envelopes,
not read tables or the read clock. `approval.cancelled` has its own strict schema
with an optional `cancelReason`; old events still parse without one. Expiry uses
`approval.expired` and has no cancellation reason. Reads preserve unknown outcomes.

`apps/server/test/approvals.test.ts` checks restart, audit rebuild, delayed reads,
recorded causes, old cancellations, retry history and identical hidden-id refusals.
The reader recognises direct requester/assistant tool-grant revocations only.
Other access refusals do not invent cancellation evidence. A missing turn and
clock-only catalogue expiry still cancel without a reason. UI, native consent,
retry delivery and fresh-install qualification remain outside this change.

`childRequestStatusSchema` also accepts strict requester-only failed status with
stage, reason, attempt 1–3 and failureEventId. The server checks access before returning it.

## Named spending choices

`budgetChoicesQuerySchema` accepts only `kind: paying_group | assistant`, optional
stored-id `after` and `limit` (default 20, maximum 50). Choice names reuse the stored
team name schema. Choice ids and continuation accept saved resource ids, including a
colon, while rejecting NATS wildcard and separator characters. Save-command ids keep
their existing narrower validation; displaying an older id does not authorise a save.
`budgetChoicesResponseSchema` strictly checks `status: current | applying`, up to
50 rows and nullable `next`. Each strict row carries `id`, `displayName`, positive
resource `sequence` and a strict `cap`: `set` with non-negative safe integer
`ceilingCents`, `not_configured`, or `unavailable`. It accepts no totals.
See the [server contract](../../apps/server/README.robot.md#named-spending-choices)
for filtering, loading and access checks.

## Call spending pages

`spendingCallsQuerySchema` and `spendingCallsResponseSchema` define the strict
calls-only [spending API](../../apps/server/README.robot.md#bounded-call-spending).
Only bounded limit, continuation, payer/assistant filters and optional `month` are accepted.
`month` is strict `YYYY-MM` (01–12), meaning the original UTC reservation month.
It combines with both other filters and is bound into the signed continuation.
Rows contain safe references, original UTC dates, integer euro cents and accounting
evidence. Settled cents may be null; recorded zero remains zero. Replies carry
checkpoint, generation and continuation, without page totals or private work fields.
The server tests check these schemas alongside the current finance access rules.

## Saved integration facts

`integrationFactsSchema` strictly separates `installed`, `connected`, `allowedFor`
and `availability`. Dates and safe event/configuration references describe saved evidence.
Grant receipts are capped at 100; incomplete lists carry a null total. Publication retains
Disabled, Applying, Unknown and Ready. Availability cannot be Ready without a selected
requester and assistant, so this contract permits only unavailable. Account mode `none`
means no account required; other account verification remains unavailable.
See the [server contract](../../apps/server/README.robot.md#bounded-saved-integration-facts-part-of-623).

## Role and ownership audit detail

Audit operations also include `role_change`, `transfer_intent`, `appointment`,
`ownership_confirmation` and `step_down`. Optional previousRole, newRole and appointmentId
carry only event-proved facts. The detail-only `progress` object has `readModel` and `iam`
(current/applying) plus a fresh UTC `checkedAt`. It reports receipt processing, not the
person's current role, permission to act, or proof that a later change did not supersede it.

Removal uses the existing optional `memberId`, fixed `reason` and `progress` fields with
`operation: remove`. No new field name is introduced. Both current receipts prove only
that this exact removal reached the members table and permission service. They do not
prove departure cleanup finished; cleanup state is absent from this contract.
