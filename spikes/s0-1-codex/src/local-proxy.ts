// The local forwarding proxy from plan.md's computer design (see
// "Computers: ... Local forwarding proxy in every computer", decided from
// this spike's first round): Codex is configured to talk to 127.0.0.1
// only, for both its model provider and its MCP servers. This proxy sits
// at that address, adds the computer token (fixed for the computer's
// lifetime) and the CURRENT turn token (set by the bridge at each turn) as
// HTTP headers, and otherwise forwards the request unchanged to the real
// upstream -- a stub standing in for the gateway, in this spike.
//
// Why build this rather than rely on Codex's own turn-metadata field
// (`turn/start.responsesapiClientMetadata`, the mechanism the superseded
// first-round tests/04 used): that field is gated behind an
// `[UNSTABLE]`/`experimentalApi` capability flag, and even when enabled it
// never reaches MCP servers as a header -- only inside the JSON-RPC body's
// `_meta`, which a gateway's `ext_authz` hook would have to parse instead
// of reading a header. The proxy needs no cooperation from Codex at all:
// it works for every request Codex makes, to either upstream, simply
// because Codex has no other address to send anything to. It also gives
// OpenCrane, not Codex, control of what a real provider credential is --
// Codex is configured with a dummy value it can never turn into anything
// useful, because the proxy does not forward whatever Codex sent as a
// bearer/API key at all; it substitutes its own computer/turn tokens.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface ProxiedRequestRecord {
  method: string;
  path: string;
  /** The headers actually sent upstream (i.e. after this proxy's rewrites). */
  upstreamHeaders: Record<string, string | string[] | undefined>;
  /** The request body, parsed as JSON when possible (both upstreams speak JSON). */
  body: unknown;
  atMs: number;
}

export interface LocalForwardingProxy {
  url: string;
  port: number;
  requests: ProxiedRequestRecord[];
  setComputerToken(token: string): void;
  /** undefined = no turn currently active on this computer. */
  setTurnToken(token: string | undefined): void;
  close(): Promise<void>;
}

export interface LocalForwardingProxyOptions {
  /** The real upstream this proxy forwards to -- a stub standing in for the gateway. */
  upstreamUrl: string;
  computerToken?: string;
}

const COMPUTER_TOKEN_HEADER = "x-oc-computer-token";
const TURN_TOKEN_HEADER = "x-oc-turn-token";

export async function startLocalForwardingProxy(opts: LocalForwardingProxyOptions): Promise<LocalForwardingProxy> {
  const upstream = new URL(opts.upstreamUrl);
  let computerToken = opts.computerToken ?? "";
  let turnToken: string | undefined;
  const requests: ProxiedRequestRecord[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);

      // Start from Codex's own headers, but never forward whatever
      // "credential" Codex thinks it's sending -- Codex only ever holds a
      // dummy value (see codex-config.ts), and the real design point is
      // that the computer's actual identity comes from the tokens THIS
      // proxy adds, not from anything Codex supplies.
      const upstreamHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
      delete upstreamHeaders.host;
      delete upstreamHeaders["content-length"];
      delete upstreamHeaders.authorization;
      upstreamHeaders[COMPUTER_TOKEN_HEADER] = computerToken;
      if (turnToken !== undefined) upstreamHeaders[TURN_TOKEN_HEADER] = turnToken;
      else delete upstreamHeaders[TURN_TOKEN_HEADER];

      let parsedBody: unknown = undefined;
      try {
        parsedBody = body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
      } catch {
        // Not JSON (e.g. an SSE-framed request body never happens here;
        // this just guards against something unexpected) -- leave it out.
      }
      requests.push({
        method: req.method ?? "?",
        path: req.url ?? "/",
        upstreamHeaders: { ...upstreamHeaders },
        body: parsedBody,
        atMs: Date.now(),
      });

      const upstreamReq = httpRequest(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          path: req.url,
          method: req.method,
          headers: { ...upstreamHeaders, "content-length": String(body.length) },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstreamReq.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`proxy upstream error: ${err.message}`);
      });
      upstreamReq.end(body);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to bind local forwarding proxy");
  }
  const port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setComputerToken: (token: string) => {
      computerToken = token;
    },
    setTurnToken: (token: string | undefined) => {
      turnToken = token;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
