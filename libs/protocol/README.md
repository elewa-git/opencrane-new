# Protocol

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

Client messages are `hello` or `validateEvent`; server messages are hello echoes,
errors or event-validation results. See [messages.ts](src/messages.ts).
The event-validation request carries `unknown` data: the server must validate it
against the [event catalogue package](../events/README.md) before accepting it.
`logoutResponseSchema` allows a nullable HTTP(S) provider logout URL.

Use `safeParse` when rejected input is expected, or handle the Zod error from `parse`.
Strict message schemas reject unknown fields, wrong discriminants and malformed values.
A matching static type does not guarantee a successful request or authorisation.
Callers must authenticate the socket, authorise operations and handle remote failures.

## Verification and dependencies

```sh
npm test -- libs/protocol
npm run typecheck -w libs/protocol
```

Tests cover valid/invalid messages and logout URL schemes. Server tests cover the
runtime socket boundary; Angular tests cover client handling. This skeleton is not a
live-qualified chat or command protocol and stores no recoverable state.
The only runtime dependency is Zod; the package is usable by browser and Node code.
See the [repository architecture](../../README.md) and [plan](../../plan.md).
