// Token issuer for the smoke run.
//
// Plain-English summary: this stands in for "the OpenCrane server mints
// short-lived signed tokens". It makes one signing key when it starts,
// publishes the public half at /jwks.json (agentgateway and the decision
// service both read it), and mints the two kinds of token the plan asks for:
//
//   - a COMPUTER token: which computer and assistant is calling;
//   - a TURN token: on whose behalf (requester, conversation, turn).
//
// Both are ES256-signed and short-lived. The signing key only ever lives in
// this process's memory; it is never written to disk.
//
// Adapted from spikes/s0-2-gateway/src/token-issuer/server.ts (the same
// claims and audiences), but as an in-process module with a random port.

import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const TOKEN_ISSUER_NAME = "https://token-issuer.opencrane.local/";
export const AUDIENCE_COMPUTER = "agentgateway";
export const AUDIENCE_TURN = "decision-service";

/** The header names the local forwarding proxy uses (same as spike S0.1a). */
export const COMPUTER_TOKEN_HEADER = "x-oc-computer-token";
export const TURN_TOKEN_HEADER = "x-oc-turn-token";

const KID = "smoke-key-1";
const ALG = "ES256";

export interface ComputerTokenRequest {
  silo: string;
  computer: string;
  assistant: string;
  ttlSeconds?: number;
}

export interface TurnTokenRequest {
  silo: string;
  conversation: string;
  turn: string;
  requester: string;
  assistant: string;
  delegation?: string[];
  ttlSeconds?: number;
}

export interface TokenIssuer {
  port: number;
  jwksUrl: string;
  mintComputerToken(req: ComputerTokenRequest): Promise<string>;
  mintTurnToken(req: TurnTokenRequest): Promise<string>;
  close(): Promise<void>;
}

/** Starts the issuer's JWKS server. Pass port 0 (the default) for a free port. */
export async function startTokenIssuer(port = 0): Promise<TokenIssuer> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = ALG;
  publicJwk.use = "sig";

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("token issuer failed to bind");

  return {
    port: address.port,
    jwksUrl: `http://127.0.0.1:${address.port}/jwks.json`,
    async mintComputerToken(req) {
      return new SignJWT({ typ: "computer", silo: req.silo, computer: req.computer, assistant: req.assistant })
        .setProtectedHeader({ alg: ALG, kid: KID })
        .setIssuer(TOKEN_ISSUER_NAME)
        .setAudience(AUDIENCE_COMPUTER)
        .setIssuedAt()
        .setExpirationTime(`${req.ttlSeconds ?? 600}s`)
        .sign(privateKey);
    },
    async mintTurnToken(req) {
      return new SignJWT({
        typ: "turn",
        silo: req.silo,
        conversation: req.conversation,
        turn: req.turn,
        requester: req.requester,
        assistant: req.assistant,
        delegation: req.delegation ?? [req.requester],
      })
        .setProtectedHeader({ alg: ALG, kid: KID })
        .setIssuer(TOKEN_ISSUER_NAME)
        .setAudience(AUDIENCE_TURN)
        .setIssuedAt()
        .setExpirationTime(`${req.ttlSeconds ?? 300}s`)
        .sign(privateKey);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
