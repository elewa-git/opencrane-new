# Demo tool server contract

For people, read [README.md](README.md) first.
Part of #45, P3-4 PR 7. Owner hosting decision: this VPS, 178.62.34.187, separate process/port.

## Protocol and ownership

POST `/` accepts `server/discover`, `tools/list` and `tools/call`, with a JSON-RPC id.
Protocol header and `params._meta.io.modelcontextprotocol/protocolVersion` are `2026-07-28`.
The `mcp-method` and `mcp-name` headers agree exactly with the request. Replies are JSON.
The byte parser and method/name checks follow `apps/odoo-mcp/src/server.ts`.
Bounded Codex metadata follows `libs/models/src/mcp.ts`; discovery needs only protocol metadata.
Bodies are limited to 16 KiB. Duplicate JSON fields, malformed UTF-8, batches, notifications,
initialisation, cursors, sessions, credentials, unknown fields and methods are refused.
Errors use fixed codes and never return request values apart from a valid JSON-RPC id.
Logging is disabled. The process makes no outbound requests and performs no retries.

Both catalogue responses are complete, public, and have `ttlMs: 300000`.
Discovery includes serverInfo, capabilities.tools and experimental `io.opencrane/expectedRevision`.
Each tool declares integer `io.opencrane/costCents: 0` and `io.opencrane/review` in `_meta`.
The server declares; the admin review locks the exact definitions; changes remain held.
Recommended reviewed modes: `read_fixture_quote` Allow, `change_delivery_slot` Ask.
Both accept only `quoteId: DEMO-001`; the write also requires `slot: morning | afternoon`.
Every argument is named in the safe review fields. No arbitrary text is accepted.

`x-opencrane-mcp-revision` must equal the existing `catalogueDigest` of complete lossless
per-tool definition digests. The fixed catalogue cannot change through HTTP. Revision checking,
argument validation and the fixture change run synchronously, without an intervening await.
The header guards against changed tool definitions, not changed fixture state. Two concurrent
accepted calls with the same digest each apply once and return effectCount 1 then 2 on a fresh
process. There is no fixture-state precondition.
One accepted write increments effectCount once, even if it sets the same slot. Repeated requests
are new calls: an uncertain result must not be retried. There is no durable deduplication claim.
Only synthetic memory changes; nothing is written to the event store, database or supplier.
The quote starts at 12500 euro cents, morning, zero effects; every process start resets it.

## Settings and checks

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `18445` | Separate TCP port, integer 1024–65535; startup refuses an occupied port. |
| `TLS_CERT_PATH` | Unset | Path to the trusted hostname certificate chain in PEM format. |
| `TLS_KEY_PATH` | Unset | Path to its private key; never pass or print its value. |

Both TLS paths must be supplied together. With TLS, the listener binds 0.0.0.0; otherwise
it binds 127.0.0.1 for local checks only. SIGTERM/SIGINT close the listener.
The [runbook](../../docs/process/demo-tool-server/runbook.md) records deployment blockers and
start, stop and status commands for the transient user systemd unit. Systemd owns the process;
no shell keeps a numeric PID or signal trap. The unit is collected when the process exits.
Tests use the server’s `test/inventory.ts` helper for its real inventory parser.
They exercise protocol refusals before effects, metadata, revision
checks, concurrent accepted calls, id echo, JSON HTTP replies and reset on restart.
The oversized, malformed UTF-8 and tools/list argument fixtures otherwise satisfy the request
contract, so each test fails when its corresponding guard is removed. Tests need no external
services.
Source and reused `@opencrane/events`: repository AGPL-3.0-or-later. Fastify 5.12.5 and
Zod 4.6.5: MIT, checked in installed LICENSE files. Node uses its standard library.
No new third-party dependency, runtime image or product API/event is introduced.
