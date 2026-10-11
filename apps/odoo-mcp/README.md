# apps/odoo-mcp

## What this is

A standalone tool server that describes the Odoo draft-order tools.
Odoo is business software for sales, stock and accounts. MCP, the
[Model Context Protocol](../../GLOSSARY.md#mcp-server-tool-server), lets an assistant use tools.
This package offers discovery. Reading orders and replacing notes remain unavailable.

## Where it fits

This is a separate application under `apps`, alongside `apps/server` (the product back end)
and `apps/computer` (the assistant's computer). Neither application calls it yet.
It runs on the local machine and makes no connection to Odoo.

```mermaid
flowchart LR
  apps["apps<br/>applications"] --> adapter["apps/odoo-mcp<br/>Odoo tool server"]
  apps --> server["apps/server<br/>product back end"]
  apps --> computer["apps/computer<br/>assistant computer"]
  caller["Standalone HTTP caller"] -->|discovery| adapter
```

## What it is responsible for

- Describe the two tools without contacting Odoo or needing a credential.
- Return complete protocol, argument and result definitions.
- Check that request headers and metadata agree.
- Check note sizes in UTF-8 bytes without shortening the text.
- Refuse tool execution until each handler is ready.

## Processes it handles

1. **A caller discovers tools.** The server returns protocol and tool definitions.
2. **A caller sends an unsupported request.** The server refuses sessions, batches,
   unknown methods and mismatched protocol information.
3. **A caller asks to read or replace a note.** The server refuses without contacting Odoo.

## How to run or test it

The standalone process listens only on the local machine. `PORT` chooses its port.
These tests need no Odoo credentials or running fixture.

```sh
npm start -w apps/odoo-mcp
nice -n 10 npx vitest run apps/odoo-mcp/test/adapter.test.ts
```

## Where to read more

- [README.robot.md](README.robot.md): exact contracts, limits and remaining work.
- [Odoo fixture](../../infra/odoo/README.md): local fake records for future read tests.
- [Accepted design](../../docs/specs/phase-3/p3-12-odoo-draft-note.md): the planned product connection.
