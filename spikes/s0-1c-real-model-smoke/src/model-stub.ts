// Stub model upstream: a stand-in for api.openai.com's Responses API.
//
// Plain-English summary: it answers POST /v1/responses with a Server-Sent
// Events stream shaped like the real one (created, text deltas, output item
// done, then a final `response.completed` event that carries the token usage),
// and GET /v1/models with a one-model list. It records every request it gets,
// so tests can see exactly what reached "the provider" after the proxy and the
// gateway have both done their work.
//
// Two safety habits that mirror the real run:
//   - it never stores a raw Authorization value, only a SHA-256 of it, so a
//     test can prove WHICH credential arrived without the stub holding it;
//   - it lists the header NAMES it received, so a test can prove the gateway
//     stripped everything it should have.
//
// Script (kept tiny on purpose): if the last user message in the request
// asks for read_notes, the first reply calls that fixed-file function;
// once the command's output is in the transcript, the reply is a short final
// message. Anything else gets the final message straight away.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { once } from "node:events";

export interface StubUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface RecordedUpstreamRequest {
  index: number;
  method: string;
  path: string;
  headerNames: string[];
  /** Every header EXCEPT authorization and cookie, with its value (the stub never keeps a credential). */
  headers: Record<string, string>;
  host: string | undefined;
  /** SHA-256 of the whole Authorization header value, or null when there was none. */
  authorizationSha256: string | null;
  contentType: string | undefined;
  bodyBytes: number;
  /** The body parsed as JSON, or the raw text when it did not parse. */
  body: unknown;
  receivedAtMs: number;
}

export interface ModelStubOptions {
  port?: number;
  /** Token usage reported in the final event of reply number `index` (0-based). */
  usage?: (index: number) => StubUsage;
  /** The model name the stub reports back (a real provider often adds a date suffix). */
  responseModel?: string;
  /** "cut-stream": send a few deltas, then close without a completed event (no usage). */
  mode?: "normal" | "cut-stream" | "error";
  /** Final message text. */
  finalMessage?: string;
  /** Pause between SSE events, to prove streaming rather than one lump. */
  eventDelayMs?: number;
}

export interface ModelStub {
  port: number;
  url: string;
  requests: RecordedUpstreamRequest[];
  /** Only the POST /v1/responses requests. */
  responseRequests(): RecordedUpstreamRequest[];
  setMode(mode: "normal" | "cut-stream" | "error"): void;
  close(): Promise<void>;
}

export const DEFAULT_STUB_USAGE = (index: number): StubUsage => ({
  inputTokens: 1000 + 100 * index,
  cachedInputTokens: 64,
  outputTokens: 120 + index,
});

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Text of the last user message in a Responses request body, or "". */
function lastUserText(body: unknown): { text: string; outputsAfter: number } {
  if (typeof body !== "object" || body === null) return { text: "", outputsAfter: 0 };
  const input = (body as Record<string, unknown>).input;
  if (!Array.isArray(input)) return { text: typeof input === "string" ? input : "", outputsAfter: 0 };
  let lastIdx = -1;
  input.forEach((item, idx) => {
    const rec = item as Record<string, unknown> | null;
    if (rec && rec.type === "message" && rec.role === "user") lastIdx = idx;
  });
  let text = "";
  if (lastIdx >= 0) {
    const content = (input[lastIdx] as { content?: unknown }).content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((c) => (typeof c === "object" && c !== null ? String((c as { text?: unknown }).text ?? "") : ""))
        .join("\n");
    }
  }
  const outputsAfter = input
    .slice(lastIdx + 1)
    .filter((item) => (item as { type?: string } | null)?.type === "function_call_output").length;
  return { text, outputsAfter };
}

export async function startModelStub(opts: ModelStubOptions = {}): Promise<ModelStub> {
  const usageFor = opts.usage ?? DEFAULT_STUB_USAGE;
  const responseModel = opts.responseModel;
  const finalMessage = opts.finalMessage ?? "Stub model: here is a short summary of the file.";
  const delay = opts.eventDelayMs ?? 15;
  let mode = opts.mode ?? "normal";
  const requests: RecordedUpstreamRequest[] = [];
  let replyCount = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://stub.invalid");
      let body: unknown = raw.toString("utf8");
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        // keep the raw text
      }
      const auth = req.headers.authorization;
      const record: RecordedUpstreamRequest = {
        index: requests.length,
        method: req.method ?? "?",
        path: url.pathname,
        headerNames: Object.keys(req.headers),
        headers: Object.fromEntries(
          Object.entries(req.headers)
            .filter(([name]) => name !== "authorization" && name !== "cookie")
            .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value ?? "")]),
        ),
        host: req.headers.host,
        authorizationSha256: typeof auth === "string" ? sha256Hex(auth) : null,
        contentType: req.headers["content-type"],
        bodyBytes: raw.length,
        body: raw.length === 0 ? undefined : body,
        receivedAtMs: Date.now(),
      };
      requests.push(record);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "stub-model", object: "model", created: 1700000000, owned_by: "stub" },
              { id: "stub-model-large", object: "model", created: 1700000001, owned_by: "stub" },
            ],
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (mode === "error") { res.writeHead(500); res.end("stub failure"); return; }
        const index = replyCount++;
        const usage = usageFor(index);
        const requestedModel =
          typeof body === "object" && body !== null ? String((body as { model?: unknown }).model ?? "") : "";
        const modelOut = responseModel ?? requestedModel;
        const { text, outputsAfter } = lastUserText(body);
        const shell = text.includes('read_notes');
        const respId = `resp_stub_${index}`;

        const events: Record<string, unknown>[] = [{ type: "response.created", response: { id: respId, model: modelOut } }];
        let output: unknown[];
        if (mode === "cut-stream") {
          events.push({
            type: "response.output_item.added",
            item: { type: "message", role: "assistant", id: `msg_${index}`, content: [{ type: "output_text", text: "" }] },
          });
          for (let i = 0; i < 3; i++) events.push({ type: "response.output_text.delta", delta: `part${i} ` });
          output = [];
        } else if (shell && outputsAfter === 0) {
          const item = {
            type: "function_call",
            call_id: `call_${index}`,
            name: "read_notes",
            arguments: "{}",
          };
          events.push({ type: "response.output_item.done", item });
          output = [item];
        } else {
          const item = {
            type: "message",
            role: "assistant",
            id: `msg_${index}`,
            content: [{ type: "output_text", text: finalMessage }],
          };
          events.push({
            type: "response.output_item.added",
            item: { ...item, content: [{ type: "output_text", text: "" }] },
          });
          const words = finalMessage.split(" ");
          for (const w of words) events.push({ type: "response.output_text.delta", delta: `${w} ` });
          events.push({ type: "response.output_item.done", item });
          output = [item];
        }
        if (mode !== "cut-stream") {
          events.push({
            type: "response.completed",
            response: {
              id: respId,
              object: "response",
              status: "completed",
              model: modelOut,
              output,
              usage: {
                input_tokens: usage.inputTokens,
                input_tokens_details: { cached_tokens: usage.cachedInputTokens },
                output_tokens: usage.outputTokens,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: usage.inputTokens + usage.outputTokens,
              },
            },
          });
        }

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        let i = 0;
        const timer = setInterval(() => {
          const ev = events[i++];
          if (ev === undefined) {
            clearInterval(timer);
            if (mode === "cut-stream") res.destroy();
            else res.end();
            return;
          }
          res.write(sse(ev));
        }, delay);
        res.on("close", () => clearInterval(timer));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub: not found", type: "invalid_request_error" } }));
    });
  });

  server.listen(opts.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("model stub failed to bind");

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    responseRequests: () => requests.filter((r) => r.method === "POST" && r.path === "/v1/responses"),
    setMode: (m) => {
      mode = m;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
