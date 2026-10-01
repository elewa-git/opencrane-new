// Egress guard: a tiny "forward proxy" that refuses everything.
//
// Plain-English summary: Codex has its own background network calls (update
// checks, analytics, plugin and app lists) that are not model calls and do not
// go through our local proxy. We point Codex's standard proxy variables
// (HTTPS_PROXY, HTTP_PROXY) at this guard, with NO_PROXY set to 127.0.0.1, so:
//   - Codex's calls to our local proxy go straight there, as normal;
//   - any other outbound connection attempt arrives here, is written down
//     (host and port only), and is refused.
// So a smoke run can say exactly which hosts Codex tried to reach, and none of
// them can be a real model provider. It needs no secret and sees no content:
// for HTTPS it only ever sees the CONNECT line.

import { createServer, type Server } from "node:http";
import { once } from "node:events";

export interface EgressAttempt {
  kind: "connect" | "http";
  target: string;
  atMs: number;
}

export interface EgressGuard {
  port: number;
  url: string;
  attempts: EgressAttempt[];
  close(): Promise<void>;
}

export async function startEgressGuard(): Promise<EgressGuard> {
  const attempts: EgressAttempt[] = [];
  const server: Server = createServer((req, res) => {
    // A plain-HTTP proxy request carries the full URL in the request line.
    let target = req.url ?? "?";
    try {
      const url = new URL(target);
      target = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    } catch {
      // keep as is
    }
    attempts.push({ kind: "http", target, atMs: Date.now() });
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("egress guard: outbound connections are refused in this run\n");
  });
  server.on("connect", (req, socket) => {
    attempts.push({ kind: "connect", target: req.url ?? "?", atMs: Date.now() });
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("egress guard failed to bind");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    attempts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
