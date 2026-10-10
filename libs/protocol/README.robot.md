# Protocol

For people, read [README.md](README.md) first.

Protocol defines shared browser/server message schemas so the two sides cannot drift
through separate declarations. It owns wire shapes, not authentication, persistence
or event business rules. Both [web](../../apps/web/README.md) and
[server](../../apps/server/README.md) consume it.

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

Audit history uses `auditFilterSchema` and `auditResponseSchema`: request/permit/
conversation/turn ids, separate decision and observed outcome, integer cents and
fixed readable reasons. Strict metadata schemas reject private payload fields.
The Angular history views use this same contract; no event payload is passed to
browser rendering. See the [HTTP contract](../../apps/server/README.robot.md#permission-scoped-audit-p3-19).

The People & groups screen uses `groupRowSchema`, `groupsResponseSchema`,
`groupReceiptSchema`, `groupChangeSchema` and `createGroupCommandSchema` for its
flat group reads and create command. `removeMemberCommandSchema` checks the
strict member-removal request.
Spending reads use `effectListResponseSchema` and
`effectDetailResponseSchema`. Price table names can include version punctuation.
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
