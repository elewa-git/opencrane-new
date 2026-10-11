# Standalone Odoo discovery contract

See [README.md](README.md) and row 1 of the [accepted design](../../docs/specs/phase-3/p3-12-odoo-draft-note.md).
This is the first part of row 1, part of [#53](https://github.com/elewa-git/opencrane-new/issues/53).
The complete read implementation and its tests exceeded the owner's roughly 600-line target.
Bounded reads are deferred to the next part; this PR delivers discovery with execution closed.

## HTTP

`npm start -w apps/odoo-mcp` binds 127.0.0.1; `PORT` defaults to 3000.
POST `/` accepts one JSON-RPC request with an id. Protocol header and
`params._meta.io.modelcontextprotocol/protocolVersion` must both be `2026-07-28`.
`mcp-method` must match the method; `mcp-name` must match the called tool.
Discovery/listing are complete public results with zero cache lifetime and no next cursor.
Sessions, cursors, batches, initialise, resources, GET and unknown arguments are refused.
The catalogue is fixed for the process's lifetime. Both declared tools cost zero integer euro cents.
Requests are limited to 16 KiB and replies to 64 KiB. Invalid UTF-8 and duplicate JSON keys refuse.
Input and snapshot notes are limited to 2,048 UTF-8 bytes (2 KiB), without trimming.
`read_draft_order` and `update_draft_order_note` always refuse execution after argument checks.
There is no Odoo client, upstream configuration, credential registry or product route.

## Tests, licences and remaining work

Tests use real HTTP to the standalone adapter. They need no private files or external service,
so root Vitest and ordinary CI can run them on a fresh checkout.
Source: AGPL-3.0-or-later. Reused packages: Fastify and Zod (MIT), and
`@opencrane/models` (AGPL-3.0-or-later) for lossless JSON. No new third-party package is added.
Bounded snapshots, text escaping and ordinary-user Odoo reads: NOT RUN in this source slice.
Runtime image and hosted product journey: NOT RUN. Later design rows own image licence review,
scans/signature, hosted admission, network route, credential delivery, atomic writes and chat.
