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
personal assistant id. `sessionSlug` formats the first message consistently for
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
