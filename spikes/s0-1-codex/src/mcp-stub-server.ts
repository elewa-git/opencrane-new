// Stub MCP server: a minimal, hand-rolled streamable-HTTP JSON-RPC 2.0
// server with one tool ("delayed_echo") that can be told to delay its
// reply. We hand-roll this rather than use the official MCP TypeScript SDK
// because, at the time of writing, that SDK does not implement the
// stateless 2026-07-28 MCP revision OpenCrane's plan calls for (see
// docs/architecture events.md / plan.md "MCP: version 2026-07-28 only").
//
// This server accepts both styles of request so we can observe, from real
// traffic, which one Codex actually sends:
//   - classic MCP HTTP: POST with an "initialize" handshake first, then
//     "tools/list" / "tools/call"; an Mcp-Session-Id header on the
//     initialize response that the client should echo back.
//   - stateless MCP: no initialize/session, each request stands alone and
//     carries its own version/capabilities in `_meta`.
//
// Every request (method, full headers, full JSON-RPC body) is recorded so
// tests can assert on it later — in particular, the exact headers Codex
// sends per docs/architecture/events.md's requirement ("method and
// tool-name headers", "_meta").

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface RecordedMcpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  receivedAtMs: number;
}

export interface McpToolCallRecord {
  requestId: unknown;
  args: unknown;
  meta: unknown;
  receivedAtMs: number;
  /** Set once the stub has finished waiting out its configured delay. */
  respondedAtMs?: number;
  /** Set if the HTTP response failed to send (e.g. the client vanished mid-delay). */
  writeFailed?: boolean;
  writeFailedReason?: string;
}

export interface McpStubServer {
  url: string;
  port: number;
  requests: RecordedMcpRequest[];
  toolCalls: McpToolCallRecord[];
  /** Every `initialize` request's proposed protocolVersion, in arrival order. */
  initializeVersionsSeen: string[];
  /** Milliseconds to wait before answering the next tools/call. 0 = immediate. */
  setNextCallDelayMs(ms: number): void;
  close(): Promise<void>;
}

export interface McpStubOptions {
  /**
   * When true, the stub answers `initialize` with 2026-07-28 ONLY if the
   * client proposed exactly that version, and otherwise refuses with a
   * JSON-RPC error instead of quietly accepting whatever the client asked
   * for (the stub's normal, permissive behaviour, used to observe what
   * Codex actually sends). This is what plan.md means by "the gateway
   * rejects other versions" (see docs/architecture/events.md and README
   * "MCP: version 2026-07-28 only") -- used here to find out what happens
   * to a real Codex turn when a server actually enforces that.
   */
  strict?: boolean;
  /**
   * Override the protocolVersion the stub replies with at `initialize`
   * (default: the real "2026-07-28"). Used to check, empirically, whether
   * Codex validates the server's answer at all -- see README "Findings".
   */
  respondProtocolVersion?: string;
}

const PROTOCOL_VERSION = "2026-07-28";

export async function startMcpStubServer(opts: McpStubOptions = {}): Promise<McpStubServer> {
  const strict = opts.strict ?? false;
  const respondProtocolVersion = opts.respondProtocolVersion ?? PROTOCOL_VERSION;
  const initializeVersionsSeen: string[] = [];
  const requests: RecordedMcpRequest[] = [];
  const toolCalls: McpToolCallRecord[] = [];
  let nextDelayMs = 0;
  let sessionCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        // keep raw
      }
      requests.push({
        method: req.method ?? "?",
        path: url.pathname,
        headers: { ...req.headers },
        body,
        receivedAtMs: Date.now(),
      });

      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("method not allowed");
        return;
      }

      const rpc = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
      const wantsSse = String(req.headers.accept ?? "").includes("text/event-stream");

      const respond = (result: unknown, error?: { code: number; message: string }) => {
        const payload: Record<string, unknown> = { jsonrpc: "2.0", id: rpc.id ?? null };
        if (error) payload.error = error;
        else payload.result = result;
        const text = JSON.stringify(payload);
        if (wantsSse) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "close",
          });
          res.write(`event: message\ndata: ${text}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(text);
        }
      };

      if (rpc.method === "initialize") {
        const proposedVersion = (rpc.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        initializeVersionsSeen.push(String(proposedVersion));
        if (strict && proposedVersion !== PROTOCOL_VERSION) {
          // Deny-by-default, per plan.md's "MCP: version 2026-07-28 only":
          // a real gateway/server enforcing the revision refuses anything
          // else outright, rather than accepting and echoing back whatever
          // the client proposed (the stub's default, permissive behaviour).
          respond(undefined, {
            code: -32600,
            message: `unsupported protocol version: ${String(proposedVersion)} (this server only speaks ${PROTOCOL_VERSION})`,
          });
          return;
        }
        sessionCounter += 1;
        res.setHeader("Mcp-Session-Id", `stub-session-${sessionCounter}`);
        respond({
          protocolVersion: respondProtocolVersion,
          serverInfo: { name: "s0-1-spike-mcp-stub", version: "0.1.0" },
          capabilities: { tools: {} },
        });
        return;
      }

      if (rpc.method === "notifications/initialized") {
        // Notifications get no JSON-RPC response body at all.
        res.writeHead(202, { "content-type": "application/json" });
        res.end();
        return;
      }

      if (rpc.method === "tools/list") {
        respond({
          tools: [
            {
              name: "delayed_echo",
              description: "Echoes a message back, optionally after a configured delay. For the S0.1a spike.",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
          ],
        });
        return;
      }

      if (rpc.method === "tools/call") {
        const params = rpc.params ?? {};
        const args = (params as Record<string, unknown>).arguments;
        const meta = (params as Record<string, unknown>)._meta;
        const record: McpToolCallRecord = {
          requestId: rpc.id,
          args,
          meta,
          receivedAtMs: Date.now(),
        };
        toolCalls.push(record);

        const delay = nextDelayMs;
        nextDelayMs = 0; // one-shot: only the next call is delayed

        // If the client (Codex) disconnects while we're still waiting out
        // the delay -- e.g. its process was killed -- record that plainly,
        // instead of only finding out when we try (and fail) to write the
        // response later.
        res.on("error", (err) => {
          if (record.respondedAtMs === undefined) {
            record.writeFailed = true;
            record.writeFailedReason = `response error: ${err.message}`;
          }
        });
        req.on("aborted", () => {
          if (record.respondedAtMs === undefined) {
            record.writeFailed = true;
            record.writeFailedReason = "request aborted by client before response was sent";
          }
        });

        const finish = () => {
          if (res.destroyed || res.writableEnded) {
            record.writeFailed = true;
            record.writeFailedReason = "response socket already closed when the delay elapsed";
            return;
          }
          record.respondedAtMs = Date.now();
          try {
            const messageText =
              typeof args === "object" && args !== null && "message" in args
                ? String((args as Record<string, unknown>).message)
                : "(no message)";
            respond({
              content: [{ type: "text", text: `echo: ${messageText}` }],
              isError: false,
            });
          } catch (err) {
            record.writeFailed = true;
            record.writeFailedReason = err instanceof Error ? err.message : String(err);
          }
        };

        if (delay > 0) {
          setTimeout(finish, delay);
        } else {
          finish();
        }
        return;
      }

      // Unknown method: standard JSON-RPC "method not found".
      respond(undefined, { code: -32601, message: `method not found: ${String(rpc.method)}` });
    });

    req.on("error", (err) => {
      // A client that vanishes mid-request (e.g. killed process) lands here.
      const last = toolCalls[toolCalls.length - 1];
      if (last && last.respondedAtMs === undefined) {
        last.writeFailed = true;
        last.writeFailedReason = err.message;
      }
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to bind MCP stub server");
  }
  const port = address.port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    requests,
    toolCalls,
    initializeVersionsSeen,
    setNextCallDelayMs: (ms: number) => {
      nextDelayMs = ms;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
