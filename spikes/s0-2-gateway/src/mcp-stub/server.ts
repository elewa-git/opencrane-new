// A stub MCP server for spike S0.2, speaking (a stand-in for) the
// stateless MCP 2026-07-28 revision over plain HTTP JSON-RPC.
//
// Plain-English summary: one request, one identity, no session. Every
// request carries the protocol version and the tool name in headers
// (mirroring the plan's "the tool-name header must match the tool in the
// body, or the call is refused"), and the JSON-RPC body carries the same
// version again in `_meta`.
//
// This stub sits behind agentgateway; the primary enforcement of
// "2026-07-28 only" and "header must match body" is done by the decision
// service (ext_authz), which runs before the gateway ever forwards a
// request here. This stub repeats the same checks itself, defensively,
// exactly as the plan says a real MCP server should: "trusts only the
// injected credential and ignores identity in arguments".
//
// It never runs a model or executes real tools -- "delete_file" and
// "danger_wipe" are no-ops that just report success, so the spike can
// prove the *decision path*, not build a real tool.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { PORTS } from "../shared/ports.js";
import { log, readJson, sendJson } from "../shared/http.js";

const PROTOCOL_VERSION = "2026-07-28";

const TOOLS = [
  { name: "echo", description: "Returns whatever text it was given.", mode: "allow" },
  { name: "read_file", description: "Pretends to read a file.", mode: "allow" },
  { name: "delete_file", description: "Pretends to delete a file.", mode: "ask" },
  { name: "danger_wipe", description: "Pretends to wipe everything. Never allowed.", mode: "block" },
];

interface JsonRpcBody {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: unknown };
  _meta?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    sendJson(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
    return;
  }
  if (req.method !== "POST" || req.url !== "/mcp") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  const credentialHeader = req.headers["x-opencrane-credential"];
  const credentialHash = typeof credentialHeader === "string" ? createHash("sha256").update(credentialHeader).digest("hex") : null;

  let body: JsonRpcBody;
  try {
    body = (await readJson<JsonRpcBody>(req)) ?? {};
  } catch (err) {
    sendJson(res, 400, rpcError(null, -32700, `parse error: ${String(err)}`));
    return;
  }

  const headerVersion = req.headers["mcp-protocol-version"];
  const bodyVersion = body._meta?.["io.modelcontextprotocol/protocol-version"];
  log("mcp-stub", {
    event: "request",
    method: body.method,
    headerVersion,
    bodyVersion,
    headerTool: req.headers["mcp-tool-name"],
    bodyTool: body.params?.name,
    credentialHash, // only ever the hash, never the raw credential
  });

  if (headerVersion !== PROTOCOL_VERSION) {
    sendJson(res, 400, rpcError(body.id, -32600, `unsupported protocol version: ${String(headerVersion)}, need ${PROTOCOL_VERSION}`));
    return;
  }

  if (body.method === "server/discover") {
    sendJson(res, 200, rpcResult(body.id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: "s0-2-mcp-stub", version: "0.1.0" },
      tools: TOOLS,
    }));
    return;
  }

  if (body.method === "tools/call") {
    const headerTool = req.headers["mcp-tool-name"];
    const bodyTool = body.params?.name;
    if (headerTool !== bodyTool) {
      sendJson(res, 400, rpcError(body.id, -32602, `tool-name header (${String(headerTool)}) does not match body (${String(bodyTool)})`));
      return;
    }
    const tool = TOOLS.find((t) => t.name === bodyTool);
    if (!tool) {
      sendJson(res, 404, rpcError(body.id, -32601, `unknown tool: ${String(bodyTool)}`));
      return;
    }
    // A stub result. Echo actually echoes; everything else just reports
    // that it "ran", since these are no-ops.
    const resultText = tool.name === "echo" ? JSON.stringify(body.params?.arguments ?? {}) : `${tool.name} ok (stub, no real effect)`;
    sendJson(res, 200, rpcResult(body.id, {
      content: [{ type: "text", text: resultText }],
      _meta: {
        "io.modelcontextprotocol/protocol-version": PROTOCOL_VERSION,
        receivedCredentialHash: credentialHash,
        // The exact set of header names this stub received, so a test can
        // prove the gateway stripped the client's Authorization and
        // turn-token headers (and anything else not on its allowlist)
        // before forwarding -- not just that *some* credential arrived.
        receivedHeaderNames: Object.keys(req.headers),
      },
    }));
    return;
  }

  sendJson(res, 404, rpcError(body.id, -32601, `unknown method: ${String(body.method)}`));
});

server.listen(PORTS.mcpStub, () => {
  log("mcp-stub", { event: "listening", port: PORTS.mcpStub, protocolVersion: PROTOCOL_VERSION });
});
