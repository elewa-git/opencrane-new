// A stub OpenAI-compatible model endpoint for spike S0.2.
//
// Plain-English summary: a tiny stand-in for a real model provider. It
// accepts an OpenAI-style chat completion request and returns a canned
// reply plus a `usage` block, so the gateway/decision-service budget path
// (reserve a worst case from max_tokens, then see the real usage) has
// something real to call.

import { createServer } from "node:http";
import { PORTS } from "../shared/ports.js";
import { log, readJson, sendJson } from "../shared/http.js";

interface ChatRequest {
  model?: string;
  max_tokens?: number;
  messages?: Array<{ role: string; content: string }>;
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const body = (await readJson<ChatRequest>(req)) ?? {};
  const promptTokens = Math.max(1, JSON.stringify(body.messages ?? []).length / 4) | 0;
  const completionTokens = Math.min(body.max_tokens ?? 64, 64); // the stub never actually generates much
  log("model-stub", { event: "request", model: body.model, max_tokens: body.max_tokens });
  sendJson(res, 200, {
    id: `stub-${Date.now()}`,
    object: "chat.completion",
    model: body.model ?? "stub-model",
    choices: [{ index: 0, message: { role: "assistant", content: "This is a stub reply from the S0.2 spike model endpoint." }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
});

server.listen(PORTS.modelStub, () => {
  log("model-stub", { event: "listening", port: PORTS.modelStub });
});
