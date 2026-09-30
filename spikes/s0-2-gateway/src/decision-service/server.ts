// Decision service for spike S0.2.
//
// Plain-English summary: this is "OpenCrane deciding". agentgateway calls
// it (as an ext_authz HTTP target) before it forwards any sensitive call.
// This service:
//   1. checks the computer token and the turn token (signature, issuer,
//      audience, expiry, and that they agree on the same assistant),
//   2. checks MCP protocol version and that the tool-name header matches
//      the tool named in the JSON-RPC body,
//   3. asks OpenFGA "does this requester operate this assistant?",
//   4. applies a per-tool mode (allow / ask / block), with single-use
//      approvals bound to a digest of the call's arguments,
//   5. for model calls, reserves a worst-case budget amount before the
//      call is allowed to proceed,
//   6. releases a per-call credential (a stand-in for "this user's Odoo
//      login"), which the gateway injects into the upstream request, and
//   7. logs one decision record per call, with a digest of the IAM
//      context used -- never the raw credential.
//
// A handful of "/_test/..." routes exist so the test suite can simulate
// admin actions (revoke access, approve a pending request, change the
// budget) without needing a real admin UI.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { PORTS, URLS, FIXTURE } from "../shared/ports.js";
import { log, readJson, sendJson } from "../shared/http.js";
import {
  bootstrapOpenFga,
  checkOperator,
  deleteOperatorTuple,
  writeOperatorTuple,
  type OpenFgaHandle,
} from "./openfga-client.js";

const PROTOCOL_VERSION = "2026-07-28";

// ---------------------------------------------------------------------------
// Token verification. Both the computer token and the turn token are
// verified the same way: signature (against the token issuer's published
// JWKS), issuer, audience and expiry. Only the expected `typ` and audience
// differ.
// ---------------------------------------------------------------------------

const jwks = createRemoteJWKSet(new URL("/jwks.json", URLS.tokenIssuer));
const TOKEN_ISSUER = "https://token-issuer.opencrane.local/";

interface ComputerClaims {
  typ: "computer";
  silo: string;
  computer: string;
  assistant: string;
}
interface TurnClaims {
  typ: "turn";
  silo: string;
  conversation: string;
  turn: string;
  requester: string;
  assistant: string;
  delegation: string[];
}

class TokenError extends Error {}

async function verifyComputerToken(header: string | undefined): Promise<ComputerClaims> {
  if (!header?.startsWith("Bearer ")) throw new TokenError("missing computer token");
  const raw = header.slice("Bearer ".length);
  const { payload } = await jwtVerify(raw, jwks, { issuer: TOKEN_ISSUER, audience: "agentgateway" });
  if (payload.typ !== "computer") throw new TokenError("wrong token type in Authorization header");
  return payload as unknown as ComputerClaims;
}

async function verifyTurnToken(header: string | undefined): Promise<TurnClaims> {
  if (!header) throw new TokenError("missing turn token");
  const { payload } = await jwtVerify(header, jwks, { issuer: TOKEN_ISSUER, audience: "decision-service" });
  if (payload.typ !== "turn") throw new TokenError("wrong token type in turn token");
  return payload as unknown as TurnClaims;
}

// ---------------------------------------------------------------------------
// In-memory state: tool modes, approvals, budget, the released credential.
// All of this would be real content projections in OpenCrane; here it is
// deliberately a few plain objects, since the spike is about the gateway
// decision path, not about persistence.
// ---------------------------------------------------------------------------

const TOOL_MODES: Record<string, "allow" | "ask" | "block"> = {
  echo: "allow",
  read_file: "allow",
  delete_file: "ask",
  danger_wipe: "block",
};

type ApprovalStatus = "pending" | "approved" | "used" | "denied";
interface ApprovalRecord {
  approvalId: string;
  status: ApprovalStatus;
  toolName: string;
  argsDigest: string;
  createdAt: number;
}
const approvals = new Map<string, ApprovalRecord>(); // key: assistant:tool:argsDigest

const budget = {
  ceilingUsd: 1.0,
  reservedUsd: 0,
};
const PRICE_PER_TOKEN_USD = 0.00002; // a made-up worst-case output-token price
interface Reservation {
  id: string;
  worstCaseUsd: number;
  requester: string;
  assistant: string;
  createdAt: number;
}
const reservations = new Map<string, Reservation>();

// The "per-user credential" the gateway injects into the upstream MCP
// request. Generated once at boot; never logged in full, only as a hash,
// so we can prove it reached the backend without ever printing it.
const RELEASED_CREDENTIAL = `cred_${randomBytes(24).toString("hex")}`;
const RELEASED_CREDENTIAL_HASH = sha256(RELEASED_CREDENTIAL);

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function argsDigestOf(args: unknown): string {
  return sha256(JSON.stringify(args ?? null));
}

function iamContextDigest(fields: Record<string, unknown>): string {
  return sha256(JSON.stringify(fields));
}

let fga: OpenFgaHandle | undefined;

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface JsonRpcBody {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: unknown };
  _meta?: Record<string, unknown>;
}

interface DecisionOutcome {
  status: number;
  body: Record<string, unknown>;
  responseHeaders?: Record<string, string>;
}

function deny(status: number, reason: string, extra: Record<string, unknown> = {}): DecisionOutcome {
  return { status, body: { decision: "deny", reason, ...extra }, responseHeaders: { "x-decision": "deny" } };
}

function allow(body: Record<string, unknown>, responseHeaders: Record<string, string>): DecisionOutcome {
  return { status: 200, body: { decision: "allow", ...body }, responseHeaders: { "x-decision": "allow", ...responseHeaders } };
}

async function handleMcpAuthorize(req: IncomingMessage): Promise<DecisionOutcome> {
  const headers = req.headers;
  const body = (await readJson<JsonRpcBody>(req)) ?? {};

  let computer: ComputerClaims;
  let turn: TurnClaims;
  try {
    computer = await verifyComputerToken(headers.authorization);
  } catch (err) {
    log("decision-service", { event: "deny", route: "mcp", reason: "computer_token_invalid", message: String(err) });
    return deny(401, "computer_token_invalid", { message: String(err) });
  }
  try {
    const turnHeader = firstHeader(headers["x-turn-token"]);
    turn = await verifyTurnToken(turnHeader);
  } catch (err) {
    log("decision-service", { event: "deny", route: "mcp", reason: "turn_token_invalid", message: String(err) });
    return deny(401, "turn_token_invalid", { message: String(err) });
  }

  if (computer.assistant !== turn.assistant || computer.silo !== turn.silo) {
    log("decision-service", { event: "deny", route: "mcp", reason: "token_mismatch" });
    return deny(403, "computer_and_turn_token_disagree");
  }

  // --- MCP 2026-07-28-only, and header/body tool-name agreement ---
  const headerVersion = firstHeader(headers["mcp-protocol-version"]);
  const bodyVersion = body._meta?.["io.modelcontextprotocol/protocol-version"];
  if (headerVersion !== PROTOCOL_VERSION || (bodyVersion !== undefined && bodyVersion !== PROTOCOL_VERSION)) {
    log("decision-service", { event: "deny", route: "mcp", reason: "unsupported_protocol_version", headerVersion, bodyVersion });
    return deny(400, "unsupported_protocol_version", { headerVersion, bodyVersion, required: PROTOCOL_VERSION });
  }
  const headerTool = firstHeader(headers["mcp-tool-name"]);
  const bodyTool = body.params?.name;
  if (body.method === "tools/call" && headerTool !== bodyTool) {
    log("decision-service", { event: "deny", route: "mcp", reason: "tool_name_header_body_mismatch", headerTool, bodyTool });
    return deny(400, "tool_name_header_body_mismatch", { headerTool, bodyTool });
  }

  // --- Permission: requester ∩ assistant, via OpenFGA ---
  let operatorAllowed: boolean;
  try {
    if (!fga) throw new Error("OpenFGA not bootstrapped");
    operatorAllowed = await checkOperator(fga, turn.requester, computer.assistant);
  } catch (err) {
    // Missing IAM context (OpenFGA unreachable, slow, or not ready) must
    // deny, never silently allow.
    log("decision-service", { event: "deny", route: "mcp", reason: "iam_context_unavailable", message: String(err) });
    return deny(503, "iam_context_unavailable", { message: String(err) });
  }
  if (!operatorAllowed) {
    log("decision-service", { event: "deny", route: "mcp", reason: "not_operator", requester: turn.requester, assistant: computer.assistant });
    return deny(403, "not_authorized", { rule: "requester ∩ assistant" });
  }

  // Only a tool call carries a tool name to look a mode up for; other
  // methods (server/discover, and tools/list) are allowed read-only
  // discovery once identity and permission checks pass.
  if (body.method !== "tools/call") {
    logDecision("mcp", computer, turn, { method: body.method, mode: "n/a" }, "allow");
    return allow({ method: body.method }, { "x-opencrane-credential": RELEASED_CREDENTIAL });
  }

  const toolName = bodyTool ?? "";
  const mode = TOOL_MODES[toolName] ?? "block"; // unknown tool: safe default is Block

  if (mode === "block") {
    logDecision("mcp", computer, turn, { tool: toolName, mode }, "deny");
    return deny(403, "tool_blocked", { tool: toolName });
  }

  if (mode === "allow") {
    logDecision("mcp", computer, turn, { tool: toolName, mode }, "allow");
    return allow({ tool: toolName }, { "x-opencrane-credential": RELEASED_CREDENTIAL });
  }

  // mode === "ask": single-use approval bound to an argument digest.
  const digest = argsDigestOf(body.params?.arguments);
  const key = `${computer.assistant}:${toolName}:${digest}`;
  const existing = approvals.get(key);

  if (!existing) {
    const approvalId = randomBytes(8).toString("hex");
    approvals.set(key, { approvalId, status: "pending", toolName, argsDigest: digest, createdAt: Date.now() });
    logDecision("mcp", computer, turn, { tool: toolName, mode, approvalId }, "deny");
    return deny(403, "approval_required", { approvalId, tool: toolName });
  }
  if (existing.status === "pending") {
    logDecision("mcp", computer, turn, { tool: toolName, mode, approvalId: existing.approvalId }, "deny");
    return deny(403, "approval_pending", { approvalId: existing.approvalId, tool: toolName });
  }
  if (existing.status === "used") {
    logDecision("mcp", computer, turn, { tool: toolName, mode, approvalId: existing.approvalId }, "deny");
    return deny(409, "approval_already_used", { approvalId: existing.approvalId, tool: toolName });
  }
  if (existing.status === "denied") {
    logDecision("mcp", computer, turn, { tool: toolName, mode, approvalId: existing.approvalId }, "deny");
    return deny(403, "approval_denied", { approvalId: existing.approvalId, tool: toolName });
  }
  // status === "approved": single use, then mark used.
  existing.status = "used";
  logDecision("mcp", computer, turn, { tool: toolName, mode, approvalId: existing.approvalId }, "allow");
  return allow({ tool: toolName, approvalId: existing.approvalId }, { "x-opencrane-credential": RELEASED_CREDENTIAL });
}

interface ModelBody {
  model?: string;
  max_tokens?: number;
  messages?: unknown[];
}

async function handleModelAuthorize(req: IncomingMessage): Promise<DecisionOutcome> {
  const headers = req.headers;
  const body = (await readJson<ModelBody>(req)) ?? {};

  let computer: ComputerClaims;
  let turn: TurnClaims;
  try {
    computer = await verifyComputerToken(headers.authorization);
  } catch (err) {
    log("decision-service", { event: "deny", route: "model", reason: "computer_token_invalid", message: String(err) });
    return deny(401, "computer_token_invalid", { message: String(err) });
  }
  try {
    const turnHeader = firstHeader(headers["x-turn-token"]);
    turn = await verifyTurnToken(turnHeader);
  } catch (err) {
    log("decision-service", { event: "deny", route: "model", reason: "turn_token_invalid", message: String(err) });
    return deny(401, "turn_token_invalid", { message: String(err) });
  }
  if (computer.assistant !== turn.assistant || computer.silo !== turn.silo) {
    return deny(403, "computer_and_turn_token_disagree");
  }

  let operatorAllowed: boolean;
  try {
    if (!fga) throw new Error("OpenFGA not bootstrapped");
    operatorAllowed = await checkOperator(fga, turn.requester, computer.assistant);
  } catch (err) {
    log("decision-service", { event: "deny", route: "model", reason: "iam_context_unavailable", message: String(err) });
    return deny(503, "iam_context_unavailable", { message: String(err) });
  }
  if (!operatorAllowed) {
    return deny(403, "not_authorized", { rule: "requester ∩ assistant" });
  }

  const maxTokens = typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : 1000;
  const worstCaseUsd = Number((maxTokens * PRICE_PER_TOKEN_USD).toFixed(6));

  if (budget.reservedUsd + worstCaseUsd > budget.ceilingUsd) {
    log("decision-service", {
      event: "deny", route: "model", reason: "budget_exhausted",
      reservedUsd: budget.reservedUsd, ceilingUsd: budget.ceilingUsd, worstCaseUsd,
    });
    return deny(402, "budget_exhausted", { reservedUsd: budget.reservedUsd, ceilingUsd: budget.ceilingUsd, worstCaseUsd });
  }

  budget.reservedUsd = Number((budget.reservedUsd + worstCaseUsd).toFixed(6));
  const reservationId = randomBytes(8).toString("hex");
  reservations.set(reservationId, { id: reservationId, worstCaseUsd, requester: turn.requester, assistant: computer.assistant, createdAt: Date.now() });

  log("decision-service", {
    event: "reserve", route: "model", reservationId, worstCaseUsd, maxTokens,
    reservedUsd: budget.reservedUsd, ceilingUsd: budget.ceilingUsd,
    iamContextDigest: iamContextDigest({ requester: turn.requester, assistant: computer.assistant, conversation: turn.conversation, turn: turn.turn }),
  });

  return allow({ reservationId, worstCaseUsd }, { "x-reservation-id": reservationId });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function logDecision(
  route: string,
  computer: ComputerClaims,
  turn: TurnClaims,
  extra: Record<string, unknown>,
  outcome: "allow" | "deny",
): void {
  log("decision-service", {
    event: "decision",
    route,
    outcome,
    requester: turn.requester,
    assistant: computer.assistant,
    computer: computer.computer,
    conversation: turn.conversation,
    turn: turn.turn,
    delegation: turn.delegation,
    ...extra,
    iamContextDigest: iamContextDigest({
      requester: turn.requester,
      assistant: computer.assistant,
      computer: computer.computer,
      conversation: turn.conversation,
      turn: turn.turn,
      ...extra,
    }),
  });
}

// ---------------------------------------------------------------------------
// Test-only helper routes (stand in for admin actions)
// ---------------------------------------------------------------------------

async function handleTestRoutes(req: IncomingMessage, url: URL): Promise<DecisionOutcome | undefined> {
  if (req.method === "POST" && url.pathname === "/_test/revoke") {
    const b = (await readJson<{ user: string; assistant: string }>(req)) ?? { user: FIXTURE.requester, assistant: FIXTURE.assistant };
    if (!fga) throw new Error("not bootstrapped");
    await deleteOperatorTuple(fga, b.user, b.assistant);
    return { status: 200, body: { ok: true } };
  }
  if (req.method === "POST" && url.pathname === "/_test/grant") {
    const b = (await readJson<{ user: string; assistant: string }>(req)) ?? { user: FIXTURE.requester, assistant: FIXTURE.assistant };
    if (!fga) throw new Error("not bootstrapped");
    await writeOperatorTuple(fga, b.user, b.assistant);
    return { status: 200, body: { ok: true } };
  }
  if (req.method === "POST" && url.pathname === "/_test/approvals/decide") {
    const b = (await readJson<{ assistant: string; toolName: string; arguments: unknown; decision: "approved" | "denied" }>(req)) as {
      assistant: string; toolName: string; arguments: unknown; decision: "approved" | "denied";
    };
    const digest = argsDigestOf(b.arguments);
    const key = `${b.assistant}:${b.toolName}:${digest}`;
    const record = approvals.get(key);
    if (!record) return { status: 404, body: { error: "no_pending_approval_for_that_exact_call" } };
    record.status = b.decision;
    return { status: 200, body: { ok: true, approvalId: record.approvalId, status: record.status } };
  }
  if (req.method === "GET" && url.pathname === "/_test/credential-hash") {
    return { status: 200, body: { hash: RELEASED_CREDENTIAL_HASH } };
  }
  if (req.method === "GET" && url.pathname === "/_test/credential-raw") {
    // Test-only: hands the test the raw credential value so it can grep
    // log files for it. This route (and its raw value) is never used by
    // the real decision path, and the credential itself is never printed
    // by any log statement in this service -- only its hash is.
    return { status: 200, body: { value: RELEASED_CREDENTIAL } };
  }
  if (req.method === "POST" && url.pathname === "/_test/set-budget") {
    const b = (await readJson<{ ceilingUsd: number }>(req)) as { ceilingUsd: number };
    budget.ceilingUsd = b.ceilingUsd;
    budget.reservedUsd = 0;
    reservations.clear();
    return { status: 200, body: { ok: true, budget } };
  }
  if (req.method === "GET" && url.pathname === "/_test/state") {
    return {
      status: 200,
      body: {
        budget,
        approvals: Array.from(approvals.entries()).map(([key, v]) => ({ key, ...v })),
        toolModes: TOOL_MODES,
        openfga: fga,
      },
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, fga });
      return;
    }
    const testResult = await handleTestRoutes(req, url);
    if (testResult) {
      sendJson(res, testResult.status, testResult.body, testResult.responseHeaders);
      return;
    }
    if (req.method === "POST" && url.pathname === "/authorize/mcp") {
      const outcome = await handleMcpAuthorize(req);
      sendJson(res, outcome.status, outcome.body, outcome.responseHeaders);
      return;
    }
    if (req.method === "POST" && url.pathname === "/authorize/model") {
      const outcome = await handleModelAuthorize(req);
      sendJson(res, outcome.status, outcome.body, outcome.responseHeaders);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    // Whatever went wrong, deny. This handler must never let an
    // unexpected exception turn into an implicit allow.
    log("decision-service", { event: "error", message: String(err) });
    sendJson(res, 500, { decision: "deny", reason: "internal_error", message: String(err) }, { "x-decision": "deny" });
  }
});

async function main(): Promise<void> {
  log("decision-service", { event: "bootstrapping_openfga" });
  fga = await bootstrapOpenFga();
  await writeOperatorTuple(fga, FIXTURE.requester, FIXTURE.assistant);
  log("decision-service", { event: "openfga_ready", storeId: fga.storeId, modelId: fga.modelId });

  server.listen(PORTS.decisionService, () => {
    log("decision-service", { event: "listening", port: PORTS.decisionService, credentialHash: RELEASED_CREDENTIAL_HASH });
  });
}

main().catch((err) => {
  log("decision-service", { event: "fatal", message: String(err) });
  process.exit(1);
});
