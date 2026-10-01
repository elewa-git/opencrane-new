// Decision service for the smoke run (the ext_authz target).
//
// Plain-English summary: agentgateway calls this service before it forwards
// any model request. The service refuses the request unless ALL of these hold:
//
//   1. the body is one strict JSON object (no batch, no repeated keys);
//   2. the computer token and the turn token both verify (signature, issuer,
//      audience, expiry) and agree on silo and assistant;
//   3. the model is exactly the one model chosen for the run (allowlist);
//   4. no hosted tool is requested. A hosted tool is one the provider runs
//      for us (web search, code interpreter, file search, remote MCP, ...).
//      Only tools that Codex runs itself are allowed;
//   5. the output is bounded: `max_output_tokens` is present, a positive whole
//      number and at most the cap (2000). `max_tokens` and
//      `max_completion_tokens` are held to the same rule when present;
//   6. the run has not used up its model-request budget (default 6: the 7th
//      allowed request is the first one refused).
//
// Only then does it reserve a worst-case cost in euro cents and tell the
// gateway to go ahead. The gateway, not the proxy, is the enforcement point:
// the local proxy may add `max_output_tokens` for convenience, but nothing it
// does is trusted.
//
// Every decision is appended to a JSONL file. Tokens, bodies and credentials
// are never written to it.
//
// Adapted from spikes/s0-2-gateway/src/decision-service/server.ts. OpenFGA
// membership checks are left out here (S0.2 proved them); this spike is about
// the caps.

import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  AUDIENCE_COMPUTER,
  AUDIENCE_TURN,
  COMPUTER_TOKEN_HEADER,
  TURN_TOKEN_HEADER,
  TOKEN_ISSUER_NAME,
} from "./tokens.js";
import { costCents, priceFor, type PriceTable } from "./price-table.js";
import { DuplicateJsonKeyError, parseStrictJson, readBody, sendJson } from "./shared/http.js";

/** Hosted tools are never allowed. These tool types are run by Codex itself, so they are. */
export const SAFE_TOOL_TYPES: ReadonlySet<string> = new Set(["function"]);

/** Values of `tool_choice` that cannot select a hosted tool. */
const SAFE_TOOL_CHOICE_STRINGS: ReadonlySet<string> = new Set(["auto", "none", "required"]);
const SAFE_TOOL_CHOICE_OBJECT_TYPES: ReadonlySet<string> = new Set(["function", "allowed_tools"]);
/** `service_tier` values that do not cost more than the standard rate. */
const SAFE_SERVICE_TIERS: ReadonlySet<string> = new Set(["default"]);

export const DEFAULT_MAX_MODEL_REQUESTS = 6;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const MAX_BODY_BYTES = 2_000_000;

export interface DecisionServiceOptions {
  jwksUrl: string;
  /** The one model id that may be used in this run. */
  allowedModel: string;
  priceTable: PriceTable;
  maxModelRequests?: number;
  maxOutputTokens?: number;
  /** Where to append one JSON line per decision. Created if missing. */
  logPath?: string;
  port?: number;
}

export interface Reservation {
  reservationId: string;
  /** 1-based number of this allowed model request within the run. */
  requestIndex: number;
  model: string;
  outputBound: number;
  bodyBytes: number;
  worstCaseCents: number;
  requester: string;
  assistant: string;
  computer: string;
  conversation: string;
  turn: string;
  atMs: number;
}

export interface DecisionRecord {
  event: "decision";
  route: "responses" | "models";
  outcome: "allow" | "deny";
  reason?: string;
  detail?: Record<string, unknown>;
  reservationId?: string;
  requestIndex?: number;
  atMs: number;
}

export interface DecisionService {
  port: number;
  url: string;
  allowedModel: string;
  maxModelRequests: number;
  maxOutputTokens: number;
  /** How many model requests have been allowed so far (the counter). */
  allowedCount(): number;
  reservations(): Reservation[];
  decisions(): DecisionRecord[];
  close(): Promise<void>;
}

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

class Deny extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(reason);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Reads a property only if the object itself owns it (never from the prototype chain). */
function own(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

function isPositiveWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Checks one `tools` array. Returns the list of tool types seen (for the log).
 * Throws Deny for the first hosted or unknown type.
 */
export function checkTools(tools: unknown, depth = 0): string[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw new Deny(400, "tools_not_an_array");
  if (depth > 3) throw new Deny(400, "tools_nested_too_deep");
  const seen: string[] = [];
  for (const tool of tools) {
    const type = own(tool, "type");
    if (typeof type !== "string") throw new Deny(403, "hosted_tool_refused", { type: "missing_or_not_a_string" });
    if (!SAFE_TOOL_TYPES.has(type)) throw new Deny(403, "hosted_tool_refused", { type });
    seen.push(type);
    if (own(tool, "tools") !== undefined) seen.push(...checkTools(own(tool, "tools"), depth + 1));
  }
  return seen;
}

function checkToolChoice(choice: unknown): void {
  if (choice === undefined) return;
  if (typeof choice === "string") {
    if (!SAFE_TOOL_CHOICE_STRINGS.has(choice)) throw new Deny(403, "hosted_tool_refused", { toolChoice: choice });
    return;
  }
  const type = own(choice, "type");
  if (typeof type !== "string" || !SAFE_TOOL_CHOICE_OBJECT_TYPES.has(type)) {
    throw new Deny(403, "hosted_tool_refused", { toolChoice: typeof type === "string" ? type : "unknown" });
  }
  if (type === "allowed_tools") checkTools(own(choice, "tools"), 1);
}

export async function startDecisionService(opts: DecisionServiceOptions): Promise<DecisionService> {
  const maxModelRequests = opts.maxModelRequests ?? DEFAULT_MAX_MODEL_REQUESTS;
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  const reservations: Reservation[] = [];
  const decisions: DecisionRecord[] = [];
  let allowed = 0;

  if (opts.logPath) mkdirSync(dirname(opts.logPath), { recursive: true });

  function record(entry: DecisionRecord, extra: Record<string, unknown> = {}): void {
    decisions.push(entry);
    if (opts.logPath) {
      appendFileSync(opts.logPath, `${JSON.stringify({ ...entry, ...extra, time: new Date().toISOString() })}\n`);
    }
  }

  // Both tokens are checked here, even though agentgateway's own jwtAuth has
  // already checked the computer token. agentgateway allows an unconfigurable
  // grace period after a token expires (found in S0.2); jose's default has
  // none, so this check is the one that really enforces "short-lived".
  async function verifyComputer(req: IncomingMessage): Promise<ComputerClaims> {
    const raw = header(req, COMPUTER_TOKEN_HEADER);
    if (!raw) throw new Deny(401, "computer_token_missing");
    try {
      const { payload } = await jwtVerify(raw, jwks, { issuer: TOKEN_ISSUER_NAME, audience: AUDIENCE_COMPUTER });
      if (payload.typ !== "computer") throw new Error("wrong token type");
      return payload as unknown as ComputerClaims;
    } catch {
      throw new Deny(401, "computer_token_invalid");
    }
  }

  async function verifyTurn(req: IncomingMessage): Promise<TurnClaims | undefined> {
    const raw = header(req, TURN_TOKEN_HEADER);
    if (!raw) return undefined;
    try {
      const { payload } = await jwtVerify(raw, jwks, { issuer: TOKEN_ISSUER_NAME, audience: AUDIENCE_TURN });
      if (payload.typ !== "turn") throw new Error("wrong token type");
      return payload as unknown as TurnClaims;
    } catch {
      throw new Deny(401, "turn_token_invalid");
    }
  }

  async function readJsonObject(req: IncomingMessage): Promise<{ body: Record<string, unknown>; bytes: number }> {
    let raw: Buffer;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      throw new Deny(413, "body_too_large");
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(raw.toString("utf8"));
    } catch (err) {
      throw new Deny(400, err instanceof DuplicateJsonKeyError ? "duplicate_json_key" : "malformed_json");
    }
    if (Array.isArray(parsed)) throw new Deny(400, "json_array_not_allowed");
    if (typeof parsed !== "object" || parsed === null) throw new Deny(400, "malformed_json");
    return { body: parsed as Record<string, unknown>, bytes: raw.length };
  }

  /** POST /authorize/responses: a model request. */
  async function authorizeResponses(req: IncomingMessage): Promise<Record<string, string>> {
    const { body, bytes } = await readJsonObject(req);

    const computer = await verifyComputer(req);
    const turn = await verifyTurn(req);
    if (!turn) throw new Deny(401, "turn_token_missing");
    if (computer.assistant !== turn.assistant || computer.silo !== turn.silo) {
      throw new Deny(403, "computer_and_turn_token_disagree");
    }

    // (d) model allowlist: exact match on a string, nothing else.
    const model = own(body, "model");
    if (typeof model !== "string" || model !== opts.allowedModel) {
      throw new Deny(403, "model_not_allowed", { model: typeof model === "string" ? model.slice(0, 80) : typeof model });
    }
    if (!priceFor(opts.priceTable, model)) throw new Deny(403, "model_has_no_price");

    // (c) hosted tools refused.
    const toolTypes = checkTools(own(body, "tools"));
    checkToolChoice(own(body, "tool_choice"));

    // Extra cost guards: a premium service tier, or a background run.
    const tier = own(body, "service_tier");
    if (tier !== undefined && !(typeof tier === "string" && SAFE_SERVICE_TIERS.has(tier))) {
      throw new Deny(403, "service_tier_not_allowed");
    }
    if (own(body, "background") !== undefined && own(body, "background") !== false) throw new Deny(403, "background_run_not_allowed");

    // Refuse references, media and multiplicative work: byte bounds only cover inline text.
    if (own(body, "previous_response_id") != null || own(body, "conversation") != null ||
        (own(body, "n") !== undefined && own(body, "n") !== 1) || own(body, "stream") !== true) {
      throw new Deny(403, "unbounded_request");
    }
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(inspect); return; }
      const object = value as Record<string, unknown>;
      for (const [key, nested] of Object.entries(object)) if (key.toLowerCase() === "tools") checkTools(nested);
      if (["input_image", "input_audio", "input_file", "item_reference"].includes(String(object.type)) ||
          ["file_id", "file_url", "image_url", "audio", "video"].some(key => Object.hasOwn(object, key))) {
        throw new Deny(403, "non_text_input");
      }
      Object.values(object).forEach(inspect);
    };
    inspect(body);

    // (a) output bound. `max_output_tokens` is the Responses API field and
    // must be there. The two older names are held to the same rule if present.
    const bound = own(body, "max_output_tokens");
    if (bound === undefined) throw new Deny(400, "no_output_bound");
    if (!isPositiveWholeNumber(bound)) throw new Deny(400, "output_bound_not_a_positive_whole_number");
    if (bound > maxOutputTokens) throw new Deny(400, "output_bound_too_large", { bound, cap: maxOutputTokens });
    for (const legacy of ["max_tokens", "max_completion_tokens"]) {
      const value = own(body, legacy);
      if (value === undefined) continue;
      if (!isPositiveWholeNumber(value)) throw new Deny(400, `${legacy}_not_a_positive_whole_number`);
      if (value > maxOutputTokens) throw new Deny(400, `${legacy}_too_large`, { value, cap: maxOutputTokens });
    }

    // (b) request counter. Everything above is synchronous from here on, so
    // two requests can never both take the last slot.
    if (allowed >= maxModelRequests) {
      throw new Deny(403, "model_request_cap_reached", { cap: maxModelRequests });
    }
    allowed += 1;

    // Reserve a worst-case cost. Each token takes at least one byte of the
    // request body, so the body size is a safe upper bound on prompt tokens.
    const worstCaseCents = costCents(opts.priceTable, model, { inputTokens: bytes, outputTokens: bound });
    const reservationId = `rsv_${randomBytes(8).toString("hex")}`;
    const reservation: Reservation = {
      reservationId,
      requestIndex: allowed,
      model,
      outputBound: bound,
      bodyBytes: bytes,
      worstCaseCents,
      requester: turn.requester,
      assistant: computer.assistant,
      computer: computer.computer,
      conversation: turn.conversation,
      turn: turn.turn,
      atMs: Date.now(),
    };
    reservations.push(reservation);
    record(
      { event: "decision", route: "responses", outcome: "allow", reservationId, requestIndex: allowed, atMs: Date.now() },
      {
        model,
        outputBound: bound,
        bodyBytes: bytes,
        worstCaseCents,
        toolTypes,
        requester: turn.requester,
        assistant: computer.assistant,
        computer: computer.computer,
        conversation: turn.conversation,
        turn: turn.turn,
      },
    );
    return { "x-reservation-id": reservationId };
  }

  /** GET /authorize/models: listing models is free, so it needs a valid computer token only. */
  async function authorizeModels(req: IncomingMessage): Promise<Record<string, string>> {
    await verifyComputer(req);
    // A turn token is optional here (Codex lists models before any turn), but
    // a bad one is still refused.
    await verifyTurn(req);
    record({ event: "decision", route: "models", outcome: "allow", atMs: Date.now() });
    return {};
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://decision.invalid");
    const route = url.pathname === "/authorize/responses" ? "responses" : url.pathname === "/authorize/models" ? "models" : undefined;
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!route) {
        sendJson(res, 404, { decision: "deny", reason: "unknown_route" }, { "x-decision": "deny" });
        return;
      }
      const extraHeaders = route === "responses" ? await authorizeResponses(req) : await authorizeModels(req);
      sendJson(res, 200, { decision: "allow" }, { "x-decision": "allow", ...extraHeaders });
    } catch (err) {
      // Whatever goes wrong denies. An unexpected error is never an allow.
      const deny = err instanceof Deny ? err : new Deny(500, "internal_error");
      record(
        { event: "decision", route: route ?? "responses", outcome: "deny", reason: deny.reason, detail: deny.detail, atMs: Date.now() },
        { status: deny.status },
      );
      sendJson(res, deny.status, { decision: "deny", reason: deny.reason, ...deny.detail }, { "x-decision": "deny" });
    }
  });

  server.listen(opts.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("decision service failed to bind");

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    allowedModel: opts.allowedModel,
    maxModelRequests,
    maxOutputTokens,
    allowedCount: () => allowed,
    reservations: () => [...reservations],
    decisions: () => [...decisions],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
