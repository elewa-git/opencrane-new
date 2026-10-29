# Standalone Odoo discovery and read contract

See [README.md](README.md) and row 1 of the [accepted design](../../docs/specs/phase-3/p3-12-odoo-draft-note.md).
This completes the read half of row 1, part of [#53](https://github.com/elewa-git/opencrane-new/issues/53).
Odoo remains an ordinary MCP server. The product and dispatcher contain no Odoo-specific code
and supply no saved snapshot. Writes stay closed.

## Test dependencies

All lossless JSON imports use `@opencrane/events/lossless-json` directly.
The tool server does not depend on the models package.

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
`update_draft_order_note` always refuses execution after argument checks.

## Fixed Odoo reads

Operator settings `ODOO_ORIGIN` and `ODOO_DATABASE` must be provided together.
The origin must be HTTP(S), without credentials, query, fragment or a path beyond `/`.
The database contains 1–200 letters, digits, underscores, dots or hyphens.
Without these settings discovery works and reads return `read_unavailable`.
Only POST `/json/2/sale.order/read` and `/json/2/sale.order.line/read` can run.
Order fields: id, name, state, note, write_uid, write_date, order_line.
Line fields: id, name, product_uom_qty. Arguments contain only a positive safe integer orderId.
The request's Bearer header is forwarded with the fixed X-Odoo-Database header.
There is no credential registry, logging, retention, proxy inheritance, redirect or retry.
One 15-second deadline covers both requests. Each upstream reply is limited to 64 KiB.
An order may have at most 20 lines. More than 20 lines returns `record_limit`;
the server refuses the whole order rather than returning only some lines.
Missing or inaccessible records and non-drafts return `read_refused`; oversized records
return `record_limit`; malformed replies return `invalid_response`; outages return `read_unavailable`.
No refusal includes upstream error text or a partial snapshot.
The snapshot preserves source strings, false notes and exact number text for quantities.
`version` is the lossless-json-v1 digest of the complete snapshot. `noteDigest` is SHA-256
of the source note's UTF-8 bytes (empty bytes for false). `checkedAt` dates the completed read.
Readable content escapes HTML characters; raw facts remain in structuredContent.
The two reads are separate Odoo transactions. This version does not promise that the order
remained unchanged between them, and cannot authorise a write here.

## Tests, licences and remaining work

Tests use real HTTP to the standalone adapter. They need no private files or external service,
so root Vitest and ordinary CI can run them on a fresh checkout.
Source: AGPL-3.0-or-later. Reused packages: Fastify and Zod (MIT), and
`@opencrane/events/lossless-json` (AGPL-3.0-or-later) for lossless JSON. No new third-party package is added.
Fixture-free HTTP tests cover exact snapshots, source hashes, escaping, record bounds,
missing records, ACL refusals, fixed requests, per-call credentials and the shared deadline.
The opt-in `ODOO_FIXTURE_TEST=1` test reads existing fixture orders via 127.0.0.1:18069.
It opens writer.key and reader.key by private path with owner/mode checks and refuses symlinks.
It never changes fixture data. Ordinary CI skips it and opens no private files.
Reads on the existing fixture: PASS for both accounts, restricted reader and missing order.
Runtime image and hosted product journey: NOT RUN. Later design rows own image licence review,
scans/signature, hosted admission, network route, credential delivery, atomic writes and chat.

## HTTP dependency patches

Fastify is pinned to 5.12.6 (MIT). The shared lockfile also updates fast-uri
to 3.1.9 and 4.2.3 (BSD-3-Clause). Registry metadata and installed licence
files were checked. The [audit notes](../../docs/process/npm-audit.md#29-october-2026-update)
record the affected paths and the decoder override.
