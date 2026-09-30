// Token issuer for spike S0.2.
//
// Plain-English summary: this stands in for "the OpenCrane server mints
// short-lived signed tokens". It generates one signing key when it starts,
// publishes the public half at /jwks.json (so agentgateway and the
// decision service can verify signatures), and hands out two kinds of
// token on request:
//
//   - a COMPUTER token: says which computer and assistant is calling.
//   - a TURN token: says on whose behalf (requester, conversation, turn,
//     delegation chain).
//
// This is a stub: in the real system these are minted inside the claim
// and message-delivery commands, not from a free-standing HTTP endpoint.
// Here we expose them over HTTP purely so the test suite (and a human)
// can request tokens for different scenarios.

import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { PORTS } from "../shared/ports.js";
import { log, readJson, sendJson } from "../shared/http.js";

const ISSUER = "https://token-issuer.opencrane.local/";
export const AUDIENCE_COMPUTER = "agentgateway";
export const AUDIENCE_TURN = "decision-service";
const KID = "spike-key-1";
const ALG = "ES256";

const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = KID;
publicJwk.alg = ALG;
publicJwk.use = "sig";

interface ComputerTokenRequest {
  silo: string;
  computer: string;
  assistant: string;
  ttlSeconds?: number;
}

interface TurnTokenRequest {
  silo: string;
  conversation: string;
  turn: string;
  requester: string;
  assistant: string;
  delegation?: string[];
  ttlSeconds?: number;
}

async function signComputerToken(req: ComputerTokenRequest): Promise<string> {
  const ttl = req.ttlSeconds ?? 300; // 5 minutes, short-lived by design
  return new SignJWT({
    typ: "computer",
    silo: req.silo,
    computer: req.computer,
    assistant: req.assistant,
  })
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_COMPUTER)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(privateKey);
}

async function signTurnToken(req: TurnTokenRequest): Promise<string> {
  const ttl = req.ttlSeconds ?? 120; // turns are even shorter-lived
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
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_TURN)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(privateKey);
}

export { ISSUER };

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/jwks.json") {
      sendJson(res, 200, { keys: [publicJwk] });
      return;
    }
    if (req.method === "POST" && req.url === "/token/computer") {
      const body = (await readJson<ComputerTokenRequest>(req)) as ComputerTokenRequest;
      const token = await signComputerToken(body);
      log("token-issuer", { event: "issued", typ: "computer", ...body });
      sendJson(res, 200, { token });
      return;
    }
    if (req.method === "POST" && req.url === "/token/turn") {
      const body = (await readJson<TurnTokenRequest>(req)) as TurnTokenRequest;
      const token = await signTurnToken(body);
      log("token-issuer", { event: "issued", typ: "turn", ...body });
      sendJson(res, 200, { token });
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      sendJson(res, 200, { ok: true, issuer: ISSUER });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    log("token-issuer", { event: "error", message: String(err) });
    sendJson(res, 400, { error: String(err) });
  }
});

server.listen(PORTS.tokenIssuer, () => {
  log("token-issuer", { event: "listening", port: PORTS.tokenIssuer, issuer: ISSUER, kid: KID });
});
