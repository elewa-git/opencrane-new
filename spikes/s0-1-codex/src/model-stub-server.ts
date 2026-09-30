// Stub model provider server.
//
// Codex (0.159.2) only supports wire_api = "responses" for custom model
// providers (confirmed from the official config reference: "responses is
// the only supported value"). This server speaks that wire format: it
// answers POST <base_url>/responses with a scripted Server-Sent-Events
// (SSE) stream, built from the same event shapes the Codex test suite
// itself uses (codex-rs/core/tests/common/responses.rs), so real Codex can
// parse it.
//
// The script always has three steps, driven by how many prior
// "function_call_output" items are already present in the incoming
// request's `input` array (that count tells us which step of the
// conversation we are in — Codex resends the whole running transcript on
// every HTTP call):
//   step 0 (no outputs yet)   -> emit a shell command tool call
//   step 1 (1 output present) -> emit an MCP tool call
//   step 2 (2 outputs present)-> emit a final assistant message
//
// Every request (method, path, headers, full JSON body) is recorded so
// tests can inspect exactly what Codex sent (turn-token headers, window
// id, tool schema names, etc).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface RecordedModelRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  receivedAtMs: number;
}

export interface ModelStubOptions {
  /** Shell command the stub asks Codex to run, at step 0. */
  shellCommand?: string;
  /** MCP server id (namespace) + tool name the stub asks Codex to call, at step 1. */
  mcpNamespace?: string;
  mcpToolName?: string;
  mcpToolArguments?: Record<string, unknown>;
  /** Final assistant message text, at step 2. */
  finalMessage?: string;
  /**
   * When true, the scripted shell call asks for escalated (unsandboxed)
   * permission (`sandbox_permissions: "require_escalated"`), which always
   * surfaces an approval request regardless of approval_policy/sandbox
   * mode -- this is how a real model asks for extra trust, and it is the
   * reliable way to force an approval prompt for a harmless command like
   * `echo` in a test.
   */
  forceEscalatedShellApproval?: boolean;
  /**
   * "toolThenFinal" (default): shell call, then MCP call, then a final
   * message, driven by how many tool outputs are already in the request.
   * "alwaysFinal": skip both tool calls and always answer with the final
   * message straight away. Used by tests (e.g. sub-agent review calls)
   * that just need *some* well-formed reply, not the full script.
   */
  behavior?: "toolThenFinal" | "alwaysFinal";
}

export interface ModelStubServer {
  url: string;
  port: number;
  requests: RecordedModelRequest[];
  close(): Promise<void>;
}

/**
 * Codex resends the whole running transcript on every HTTP call (no
 * previous_response_id chaining in our stub setup), and a thread can carry
 * several turns. So we count function_call_output items only *since the
 * last user message*, not across the whole thread -- otherwise turn 2
 * would look like it was already at "step 2" because of turn 1's leftover
 * outputs still sitting earlier in the array.
 */
function countFunctionCallOutputs(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const input = (body as Record<string, unknown>).input;
  if (!Array.isArray(input)) return 0;
  let lastUserMessageIndex = -1;
  input.forEach((item, idx) => {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "message" &&
      (item as Record<string, unknown>).role === "user"
    ) {
      lastUserMessageIndex = idx;
    }
  });
  return input
    .slice(lastUserMessageIndex + 1)
    .filter(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "function_call_output",
    ).length;
}

/** SSE-encode a single JSON "event" the way the real Responses API does. */
function sseEvent(event: Record<string, unknown>): string {
  const kind = event.type as string;
  return `event: ${kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function evResponseCreated(id: string): Record<string, unknown> {
  return { type: "response.created", response: { id } };
}

function evCompleted(id: string): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  };
}

function evFunctionCall(callId: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function evFunctionCallNamespaced(
  callId: string,
  namespace: string,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      namespace,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function evAssistantMessage(id: string, text: string): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }],
    },
  };
}

export async function startModelStubServer(opts: ModelStubOptions = {}): Promise<ModelStubServer> {
  const shellCommand = opts.shellCommand ?? "echo hello-from-stub-shell";
  // Codex exposes a third-party MCP server's tools to the model as a
  // "namespace" tool group named `mcp__<server id>` (confirmed empirically:
  // see README.md "How we learned the wire framing"). The server id here
  // must match STUB_MCP_SERVER_ID in codex-config.ts.
  const mcpNamespace = opts.mcpNamespace ?? "mcp__spike_mcp";
  const mcpToolName = opts.mcpToolName ?? "delayed_echo";
  const mcpToolArguments = opts.mcpToolArguments ?? { message: "ping-from-model" };
  const finalMessage = opts.finalMessage ?? "Done: ran the shell command and the MCP tool.";

  const requests: RecordedModelRequest[] = [];
  let respId = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [], object: "list" }));
      return;
    }

    if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname.endsWith("/responses"))) {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          // keep raw string if it doesn't parse
        }
        requests.push({
          method: req.method ?? "POST",
          path: url.pathname,
          headers: { ...req.headers },
          body,
          receivedAtMs: Date.now(),
        });

        const step = opts.behavior === "alwaysFinal" ? 2 : countFunctionCallOutputs(body);
        respId += 1;
        const id = `resp-${respId}`;
        let events: Record<string, unknown>[];
        if (step === 0) {
          const shellArgs: Record<string, unknown> = { cmd: shellCommand };
          if (opts.forceEscalatedShellApproval) {
            shellArgs.sandbox_permissions = "require_escalated";
            shellArgs.justification = "S0.1a spike: forcing an approval prompt for the test.";
          }
          events = [
            evResponseCreated(id),
            evFunctionCall(`call-shell-${respId}`, "exec_command", shellArgs),
            evCompleted(id),
          ];
        } else if (step === 1) {
          events = [
            evResponseCreated(id),
            evFunctionCallNamespaced(`call-mcp-${respId}`, mcpNamespace, mcpToolName, mcpToolArguments),
            evCompleted(id),
          ];
        } else {
          events = [evResponseCreated(id), evAssistantMessage(`msg-${respId}`, finalMessage), evCompleted(id)];
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "close",
        });
        for (const ev of events) {
          res.write(sseEvent(ev));
        }
        res.end();
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to bind model stub server");
  }
  const port = address.port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
