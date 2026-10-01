// The local forwarding proxy (plan.md, "Local forwarding proxy in every
// computer"), adapted from spikes/s0-1-codex/src/local-proxy.ts for the
// model path of this smoke run.
//
// Plain-English summary: Codex talks only to this proxy on 127.0.0.1. The
// proxy
//   - throws away whatever Authorization header Codex sent (it is only a
//     placeholder anyway);
//   - adds the computer token (fixed for the computer's life) and the turn
//     token (per thread, set by the bridge when a turn starts) as headers;
//   - for a model request, adds `max_output_tokens: 2000` to the body if the
//     body has none (a convenience, so Codex's normal requests pass the
//     gateway's bound rule; the gateway re-checks and does not trust this);
//   - forwards everything else unchanged to the gateway.
//
// Turn tokens are kept per thread, as the plan asks. The thread id comes
// from the `session-id` header Codex sends on model calls. A model call with
// no live turn token is refused here and never reaches the gateway. Listing
// models (GET) needs no turn, because Codex lists models before any turn.
//
// Nothing here is a security boundary: the gateway decides. The proxy only
// makes Codex's requests carry the identity the gateway needs.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { once } from "node:events";
import { COMPUTER_TOKEN_HEADER, TURN_TOKEN_HEADER } from "./tokens.js";

export const DEFAULT_MAX_OUTPUT_TOKENS_INJECTED = 2000;
/** The header Codex puts its thread id in on model calls (found by looking at real requests). */
export const THREAD_ID_HEADER = "session-id";

export interface ProxiedRequestRecord {
  method: string;
  path: string;
  threadId: string | undefined;
  /** The headers actually sent on to the gateway (tokens are included, so tests can check them). */
  forwardedHeaders: Record<string, string | string[] | undefined>;
  /** The body sent on to the gateway, parsed when it is JSON. */
  forwardedBody: unknown;
  /** The body Codex sent, parsed when it is JSON. */
  originalBody: unknown;
  /** Whether the proxy added max_output_tokens. */
  addedMaxOutputTokens: boolean;
  /** Set when the proxy refused the request itself. */
  refusedReason?: string;
  atMs: number;
}

export interface LocalForwardingProxy {
  port: number;
  url: string;
  requests: ProxiedRequestRecord[];
  setComputerToken(token: string): void;
  setTurnToken(threadId: string, token: string): void;
  clearTurnToken(threadId: string): void;
  close(): Promise<void>;
}

export interface LocalForwardingProxyOptions {
  /** The gateway's base URL, for example http://127.0.0.1:3000 */
  gatewayUrl: string;
  computerToken?: string;
  /** Set to 0 or undefined to leave bodies alone. Defaults to 2000. */
  injectMaxOutputTokens?: number | undefined;
  /** Turn off the injection entirely (used by tests that prove the gateway enforces the bound itself). */
  disableInjection?: boolean;
}

/** Adds `"max_output_tokens":N` as the last key of a JSON object text without touching the rest of the bytes. */
export function injectMaxOutputTokens(rawBody: string, value: number): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  if (Object.prototype.hasOwnProperty.call(parsed, "max_output_tokens")) return undefined;
  const end = rawBody.lastIndexOf("}");
  if (end < 0) return undefined;
  const before = rawBody.slice(0, end).trimEnd();
  const separator = before.endsWith("{") ? "" : ",";
  return `${before}${separator}"max_output_tokens":${value}${rawBody.slice(end)}`;
}

export async function startLocalForwardingProxy(opts: LocalForwardingProxyOptions): Promise<LocalForwardingProxy> {
  const gateway = new URL(opts.gatewayUrl);
  let computerToken = opts.computerToken ?? "";
  const turnTokens = new Map<string, string>();
  const requests: ProxiedRequestRecord[] = [];
  const injectValue = opts.disableInjection ? 0 : (opts.injectMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS_INJECTED);

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const original = Buffer.concat(chunks);
      const method = req.method ?? "GET";
      const path = req.url ?? "/";
      const threadHeader = req.headers[THREAD_ID_HEADER];
      const threadId = Array.isArray(threadHeader) ? threadHeader[0] : threadHeader;
      const isModelCall = method === "POST";

      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      // Whatever "credential" Codex holds is a placeholder. Never forward it.
      delete headers.authorization;
      headers[COMPUTER_TOKEN_HEADER] = computerToken;
      delete headers[TURN_TOKEN_HEADER];
      const turnToken = threadId === undefined ? undefined : turnTokens.get(threadId);
      if (turnToken !== undefined) headers[TURN_TOKEN_HEADER] = turnToken;

      let body = original;
      let originalParsed: unknown;
      try {
        originalParsed = original.length > 0 ? JSON.parse(original.toString("utf8")) : undefined;
      } catch {
        // not JSON: leave it alone
      }
      let added = false;
      if (isModelCall && injectValue > 0 && original.length > 0) {
        const injected = injectMaxOutputTokens(original.toString("utf8"), injectValue);
        if (injected !== undefined) {
          body = Buffer.from(injected, "utf8");
          added = true;
        }
      }
      let forwardedParsed: unknown;
      try {
        forwardedParsed = body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
      } catch {
        // not JSON
      }

      const entry: ProxiedRequestRecord = {
        method,
        path,
        threadId,
        forwardedHeaders: { ...headers },
        forwardedBody: forwardedParsed,
        originalBody: originalParsed,
        addedMaxOutputTokens: added,
        atMs: Date.now(),
      };
      requests.push(entry);

      // A model call with no live turn is refused here: it never reaches the gateway.
      if (isModelCall && turnToken === undefined) {
        entry.refusedReason = "no_live_turn_for_thread";
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "local proxy: no live turn for this thread", type: "no_live_turn" } }));
        return;
      }

      const upstreamReq = httpRequest(
        {
          hostname: gateway.hostname,
          port: gateway.port,
          path,
          method,
          headers: { ...headers, "content-length": String(body.length) },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
          res.on("close", () => upstreamRes.destroy());
        },
      );
      upstreamReq.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`proxy upstream error: ${err.message}`);
      });
      req.on("aborted", () => upstreamReq.destroy());
      upstreamReq.end(body);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("failed to bind the local forwarding proxy");

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setComputerToken: (token) => {
      computerToken = token;
    },
    setTurnToken: (threadId, token) => {
      turnTokens.set(threadId, token);
    },
    clearTurnToken: (threadId) => {
      turnTokens.delete(threadId);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
