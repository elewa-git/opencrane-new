// Spike S0.2: agentgateway as the only way out of a computer, with
// OpenCrane deciding every sensitive call through ext_authz with full IAM
// context.
//
// Each `describe` block below matches one numbered pass condition from
// the spike brief. Tests run against real local processes (agentgateway,
// OpenFGA, and our four small TypeScript services), started once in
// `beforeAll` and stopped in `afterAll` -- nothing here is mocked.
//
// Tests in this file are NOT safe to run concurrently / out of order:
// several of them change shared state (revoking a grant, spending the
// budget, stopping a process) that later tests depend on. Vitest runs a
// single file's tests sequentially by default, and the package.json
// script passes --no-file-parallelism, so this is the only test file.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callMcp,
  callModel,
  getLogLines,
  jsonOf,
  mintComputerToken,
  mintTurnToken,
  restartDecisionService,
  sha256,
  sleep,
  startAll,
  stopAll,
  stopDecisionService,
  stopOpenFga,
  tamperSignature,
  testCredentialHash,
  testCredentialRaw,
  testDecideApproval,
  testGrant,
  testModelCredentialHash,
  testRevoke,
  testSetBudget,
  waitUntil,
} from "./helpers.js";

beforeAll(async () => {
  await startAll();
}, 60_000);

afterAll(async () => {
  await stopAll();
}, 20_000);

describe("1. every call reaches ext_authz with verified computer + turn claims", () => {
  it("a valid computer token + a valid turn token is allowed end to end", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({ computerToken, turnToken, bodyTool: "echo", toolArguments: { hello: "world" } });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.result.content[0].text).toContain("world");
  });

  it("no turn token at all is denied", async () => {
    const computerToken = await mintComputerToken();
    const res = await callMcp({ computerToken, turnToken: undefined, bodyTool: "echo" });
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.reason).toBe("turn_token_invalid");
  });

  it("a turn token with a bad signature is denied", async () => {
    const computerToken = await mintComputerToken();
    const goodTurn = await mintTurnToken();
    const res = await callMcp({ computerToken, turnToken: tamperSignature(goodTurn), bodyTool: "echo" });
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.reason).toBe("turn_token_invalid");
  });

  it("a computer token with a bad signature is denied by the gateway itself, before ext_authz", async () => {
    const goodComputer = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({ computerToken: tamperSignature(goodComputer), turnToken, bodyTool: "echo" });
    expect(res.status).toBe(401);
    // The gateway's own jwtAuth rejects this before the request ever
    // reaches the decision service: its response is plain text, not the
    // decision service's JSON deny shape.
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toMatch(/authentication failure|invalid|malformed/i);
  });

  it("no computer token at all is denied by the gateway itself", async () => {
    const turnToken = await mintTurnToken();
    const res = await callMcp({ computerToken: undefined, turnToken, bodyTool: "echo" });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("a just-expired computer token is denied by the decision service's own strict check, even inside the gateway's own leeway window", async () => {
    // Finding: agentgateway's own jwtAuth accepts a computer token for
    // roughly 60 seconds past its `exp` (an undocumented, unconfigurable
    // leeway -- there is no clockSkew/leeway field anywhere in its config
    // schema). This is a token 3 seconds past expiry: well inside that ~60s
    // window, so the gateway itself lets it through to ext_authz. What
    // must still catch it is the decision service's *own* re-verification,
    // which uses jose's default zero clock tolerance. If this test ever
    // starts seeing a 200, either the gateway stopped forwarding expired
    // tokens (fine) or the decision service's strict check regressed
    // (not fine, and the one this test exists to guard).
    const computerToken = await mintComputerToken({ ttlSeconds: 1 });
    const turnToken = await mintTurnToken();
    await sleep(3_000);
    const res = await callMcp({ computerToken, turnToken, bodyTool: "echo" });
    expect(res.status).toBe(401);
    // Distinguishes "the gateway itself rejected it" (text/plain, as in
    // the bad-signature test above) from "it reached the decision service,
    // which rejected it" (this service's JSON deny shape) -- proving the
    // gateway's leeway really did let this one through, and the decision
    // service's own check is what caught it.
    expect(res.headers.get("content-type")).toMatch(/json/);
    const body = await jsonOf(res);
    expect(body.reason).toBe("computer_token_invalid");
  }, 10_000);
});

describe("2. permission uses live OpenFGA", () => {
  it("revoking the requester's tuple denies the very next call, within 2 seconds", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();

    // Baseline: allowed before revocation.
    const before = await callMcp({ computerToken, turnToken, bodyTool: "echo" });
    expect(before.status).toBe(200);

    await testRevoke();
    const t0 = Date.now();
    const elapsed = await waitUntil(async () => {
      const res = await callMcp({ computerToken, turnToken, bodyTool: "echo" });
      return res.status === 403;
    }, 2000, 50);
    expect(elapsed).toBeLessThan(2000);
    console.log(`[evidence] revoke-to-deny latency: ${Date.now() - t0}ms (elapsed=${elapsed}ms)`);

    await testGrant(); // restore for later tests
    const restored = await waitUntil(async () => {
      const res = await callMcp({ computerToken, turnToken, bodyTool: "echo" });
      return res.status === 200;
    }, 2000, 50);
    expect(restored).toBeLessThan(2000);
  });

  // This is last in the file (see the final describe block below) because
  // it kills OpenFGA outright -- nothing in this file needs live OpenFGA
  // after it runs.
});

describe("3. fail closed: decision service stopped", () => {
  it("calls are denied, never forwarded to the backend, while the decision service is down", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const mcpLogLinesBefore = getLogLines("mcp-stub").length;

    await stopDecisionService();
    const res = await callMcp({ computerToken, turnToken, bodyTool: "echo" });
    expect(res.status).toBe(503); // our failureMode.denyWithStatus
    const text = await res.text();
    expect(text).toMatch(/upstream call failed|connection refused|external authorization/i); // the gateway's own synthesized message, not decision-service JSON
    expect(mcpLogLinesBefore).toBe(getLogLines("mcp-stub").length); // never reached the backend

    await restartDecisionService();
    // decision-service restart creates a fresh OpenFGA store + grant, so
    // the happy path must work again immediately.
    const restored = await callMcp({ computerToken, turnToken, bodyTool: "echo" });
    expect(restored.status).toBe(200);
  }, 15_000);
});

describe("4. MCP 2026-07-28 only, and tool-name header/body agreement", () => {
  it("a request declaring a different protocol version is refused by the decision service (ext_authz)", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({ computerToken, turnToken, bodyTool: "echo", protocolVersion: "2025-06-18" });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.reason).toBe("unsupported_protocol_version");
  });

  it("a request whose tool-name header differs from the tool named in the body is refused by the decision service (ext_authz)", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({ computerToken, turnToken, bodyTool: "echo", headerTool: "read_file" });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.reason).toBe("tool_name_header_body_mismatch");
  });
});

describe("4b. deny by default: an explicit MCP method allowlist", () => {
  // Only server/discover, tools/list and tools/call are permitted. Every
  // case here used to be silently allowed through by an earlier version
  // of the decision service, whose "everything except tools/call is
  // read-only discovery" logic treated an unrecognised method the same as
  // a recognised one -- this block is the allow-by-default bug's test.
  it("resources/read is refused, not treated as read-only discovery", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const mcpLogLinesBefore = getLogLines("mcp-stub").length;
    const res = await callMcp({
      computerToken, turnToken, headerTool: null,
      bodyOverride: {
        jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "file:///etc/passwd" },
        _meta: { "io.modelcontextprotocol/protocol-version": "2026-07-28" },
      },
    });
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body.reason).toBe("method_not_allowed");
    expect(getLogLines("mcp-stub").length).toBe(mcpLogLinesBefore); // never forwarded
  });

  it("a case-variant method name ('Tools/Call') is refused, not matched loosely against 'tools/call'", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const mcpLogLinesBefore = getLogLines("mcp-stub").length;
    const res = await callMcp({
      computerToken, turnToken, headerTool: "echo",
      bodyOverride: {
        jsonrpc: "2.0", id: 1, method: "Tools/Call", params: { name: "echo", arguments: {} },
        _meta: { "io.modelcontextprotocol/protocol-version": "2026-07-28" },
      },
    });
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body.reason).toBe("method_not_allowed");
    expect(getLogLines("mcp-stub").length).toBe(mcpLogLinesBefore);
  });

  it("a JSON-RPC batch (a top-level array) is refused outright", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const mcpLogLinesBefore = getLogLines("mcp-stub").length;
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} }, _meta: { "io.modelcontextprotocol/protocol-version": "2026-07-28" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "danger_wipe", arguments: {} }, _meta: { "io.modelcontextprotocol/protocol-version": "2026-07-28" } },
    ]);
    const res = await callMcp({ computerToken, turnToken, headerTool: "danger_wipe", rawBody: batch });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.reason).toBe("json_rpc_batch_not_allowed");
    expect(getLogLines("mcp-stub").length).toBe(mcpLogLinesBefore);
  });

  it("a body with a duplicate top-level key is refused, not resolved by 'last value wins'", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const mcpLogLinesBefore = getLogLines("mcp-stub").length;
    // Two "params" keys: the first names danger_wipe, the second echo.
    // JSON.parse would silently keep only the second; this must be refused
    // before either one is ever acted on.
    const raw =
      '{"jsonrpc":"2.0","id":1,"method":"tools/call",' +
      '"params":{"name":"danger_wipe","arguments":{}},' +
      '"params":{"name":"echo","arguments":{}},' +
      '"_meta":{"io.modelcontextprotocol/protocol-version":"2026-07-28"}}';
    const res = await callMcp({ computerToken, turnToken, headerTool: "danger_wipe", rawBody: raw });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.reason).toBe("duplicate_json_key");
    expect(getLogLines("mcp-stub").length).toBe(mcpLogLinesBefore);
  });

  it("an unknown method is refused", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({
      computerToken, turnToken, headerTool: null,
      bodyOverride: { jsonrpc: "2.0", id: 1, method: "totally/unknown", _meta: { "io.modelcontextprotocol/protocol-version": "2026-07-28" } },
    });
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body.reason).toBe("method_not_allowed");
  });

  it("tools/list, being on the allowlist, is actually forwarded (a positive control for the test cases above)", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const mcpLogLinesBefore = getLogLines("mcp-stub").length;
    const res = await callMcp({
      computerToken, turnToken, headerTool: null,
      bodyOverride: { jsonrpc: "2.0", id: 1, method: "tools/list", _meta: { "io.modelcontextprotocol/protocol-version": "2026-07-28" } },
    });
    // The decision service allows it; the stub itself doesn't implement
    // tools/list, so it reports back its own "unknown method" JSON-RPC
    // error -- a 404 from the *backend*, never the decision service's 403
    // deny shape. That is exactly what distinguishes "allowed through" from
    // the refusals above.
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.error?.message).toMatch(/unknown method/);
    expect(getLogLines("mcp-stub").length).toBe(mcpLogLinesBefore + 1); // reached the backend
  });
});

describe("5. oversized request bodies are rejected, not truncated", () => {
  it("a body larger than the configured maxRequestBytes is rejected, and never reaches the backend", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const mcpLogLinesBefore = getLogLines("mcp-stub").length;
    const bigArg = "x".repeat(20_000); // config caps at 8192 bytes, allowPartialMessage: false
    const res = await callMcp({ computerToken, turnToken, bodyTool: "echo", toolArguments: { big: bigArg } });
    expect(res.status).toBe(413);
    expect(getLogLines("mcp-stub").length).toBe(mcpLogLinesBefore);
  });
});

describe("6. credential injection: no client spoofing, reaches the backend, never logged", () => {
  it("a client-supplied credential header is ignored; the gateway's injected credential reaches the MCP stub; the raw value never appears in any log", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const expectedHash = await testCredentialHash();
    const rawCredential = await testCredentialRaw();

    const res = await callMcp({ computerToken, turnToken, bodyTool: "echo", credentialHeader: "SPOOFED_BY_CLIENT" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.result._meta.receivedCredentialHash).toBe(expectedHash);
    expect(body.result._meta.receivedCredentialHash).not.toBe(sha256("SPOOFED_BY_CLIENT"));

    const allLogs = [...getLogLines("decision-service"), ...getLogLines("mcp-stub"), ...getLogLines("agentgateway")].join("\n");
    expect(allLogs.includes(rawCredential)).toBe(false);
  });
});

describe("6b. client headers are stripped to an allowlist before reaching either backend", () => {
  it("the MCP stub never sees Authorization, the turn token, or an arbitrary client header", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({
      computerToken, turnToken, bodyTool: "echo",
      extraHeaders: { "x-made-up-client-header": "leak-me", cookie: "session=super-secret" },
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const received: string[] = body.result._meta.receivedHeaderNames;
    expect(received).not.toContain("authorization");
    expect(received).not.toContain("x-turn-token");
    expect(received).not.toContain("x-made-up-client-header");
    expect(received).not.toContain("cookie");
    // The headers the MCP stub actually needs did still arrive.
    expect(received).toContain("mcp-protocol-version");
    expect(received).toContain("mcp-tool-name");
    expect(received).toContain("x-opencrane-credential");
  });

  it("the model stub never sees Authorization, the turn token, or an arbitrary client header", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callModel({
      computerToken, turnToken, maxTokens: 10,
      extraHeaders: { "x-made-up-client-header": "leak-me", cookie: "session=super-secret" },
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const received: string[] = body.receivedHeaderNames;
    expect(received).not.toContain("authorization");
    expect(received).not.toContain("x-turn-token");
    expect(received).not.toContain("x-made-up-client-header");
    expect(received).not.toContain("cookie");
    expect(received).toContain("x-opencrane-credential");
    expect(received).toContain("x-reservation-id");
  });

  it("a client-supplied x-opencrane-credential on the model route is overwritten exactly as on the MCP route", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const expectedHash = await testModelCredentialHash();
    const res = await callModel({ computerToken, turnToken, maxTokens: 10, credentialHeader: "SPOOFED_MODEL_CRED" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.receivedCredentialHash).toBe(expectedHash);
    expect(body.receivedCredentialHash).not.toBe(sha256("SPOOFED_MODEL_CRED"));
  });
});

describe("7. deny-until-approved, single use, bound to arguments", () => {
  const args = { path: "/tmp/spike-file" };

  it("first call with mode Ask is denied with an approval id", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({ computerToken, turnToken, bodyTool: "delete_file", headerTool: "delete_file", toolArguments: args });
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body.reason).toBe("approval_required");
    expect(typeof body.approvalId).toBe("string");
  });

  it("after approval, the identical retry passes exactly once", async () => {
    const decide = await testDecideApproval("delete_file", args, "approved");
    expect(decide.status).toBe(200);

    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const first = await callMcp({ computerToken, turnToken, bodyTool: "delete_file", headerTool: "delete_file", toolArguments: args });
    expect(first.status).toBe(200);

    const second = await callMcp({ computerToken, turnToken, bodyTool: "delete_file", headerTool: "delete_file", toolArguments: args });
    expect(second.status).toBe(409); // single use: already used
    const secondBody = await jsonOf(second);
    expect(secondBody.reason).toBe("approval_already_used");
  });

  it("changed arguments are treated as a new call and denied (a fresh approval is required)", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({ computerToken, turnToken, bodyTool: "delete_file", headerTool: "delete_file", toolArguments: { path: "/tmp/different-file" } });
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body.reason).toBe("approval_required");
  });

  it("an unknown/blocked tool is refused outright, with no approval path", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callMcp({ computerToken, turnToken, bodyTool: "danger_wipe", headerTool: "danger_wipe", toolArguments: {} });
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body.reason).toBe("tool_blocked");
  });

  it("an approval is bound to the requester, conversation and turn too: a second operator of the same assistant cannot spend it", async () => {
    const bobArgs = { path: "/tmp/bob-only-file" };
    await testGrant("user-bob", "assistant-alice"); // Bob also operates Alice's assistant

    // Alice asks, and her admin approves it -- for Alice's own requester,
    // conversation and turn.
    const aliceComputerToken = await mintComputerToken();
    const aliceTurnToken = await mintTurnToken({ requester: "user-alice", conversation: "conv-1", turn: "turn-1" });
    const aliceAsk = await callMcp({ computerToken: aliceComputerToken, turnToken: aliceTurnToken, bodyTool: "delete_file", headerTool: "delete_file", toolArguments: bobArgs });
    expect(aliceAsk.status).toBe(403);
    const decide = await testDecideApproval("delete_file", bobArgs, "approved", { requester: "user-alice", conversation: "conv-1", turn: "turn-1" });
    expect(decide.status).toBe(200);

    // Bob makes the exact same call (same assistant, same tool, same
    // arguments) in his own conversation/turn. If the approval were still
    // keyed only on assistant+tool+argsDigest, this would consume Alice's
    // approval and pass. It must not: Bob gets his own fresh 403 instead.
    const bobComputerToken = aliceComputerToken; // same assistant's computer
    const bobTurnToken = await mintTurnToken({ requester: "user-bob", conversation: "conv-bob", turn: "turn-bob" });
    const bobCall = await callMcp({ computerToken: bobComputerToken, turnToken: bobTurnToken, bodyTool: "delete_file", headerTool: "delete_file", toolArguments: bobArgs });
    expect(bobCall.status).toBe(403);
    const bobBody = await jsonOf(bobCall);
    expect(bobBody.reason).toBe("approval_required"); // a fresh approval, not "approval_already_used" and not 200

    // Alice's own retry, in her own turn, still works exactly once -- her
    // approval was never touched by Bob's attempt.
    const aliceRetry = await callMcp({ computerToken: aliceComputerToken, turnToken: aliceTurnToken, bodyTool: "delete_file", headerTool: "delete_file", toolArguments: bobArgs });
    expect(aliceRetry.status).toBe(200);
  });
});

describe("8. model route: worst-case budget reservation", () => {
  it("reserves a worst-case amount before forwarding, denies the next call once exhausted, and logs the reservation id", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    await testSetBudget(0.001); // enough for exactly one small reservation at 0.00002 USD/token

    // On allow, the response the client sees comes from the backend (the
    // model stub's chat-completion JSON), not from the decision service --
    // ext_authz only gates the call. The reservation id travels to the
    // backend as an injected header (proven by test 6's credential-header
    // case) and is recorded in the decision service's own log, which is
    // where we read it back from here.
    const first = await callModel({ computerToken, turnToken, maxTokens: 40 }); // 40 * 0.00002 = 0.0008
    expect(first.status).toBe(200);
    const firstBody = await jsonOf(first);
    expect(firstBody.object).toBe("chat.completion"); // the model stub's own response shape

    const reserveLine = getLogLines("decision-service").find((line) => line.includes('"event":"reserve"'));
    expect(reserveLine).toBeDefined();
    const reservationId = (JSON.parse(reserveLine as string) as { reservationId: string }).reservationId;
    expect(typeof reservationId).toBe("string");

    const second = await callModel({ computerToken, turnToken, maxTokens: 40 }); // would push reserved to 0.0016 > 0.001 ceiling
    expect(second.status).toBe(402);
    const secondBody = await jsonOf(second);
    expect(secondBody.reason).toBe("budget_exhausted");

    const decisionLogs = getLogLines("decision-service").join("\n");
    expect(decisionLogs).toContain(reservationId);
  });

  it("max_completion_tokens alone (no max_tokens) still reserves a worst-case amount", async () => {
    await testSetBudget(1.0);
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const res = await callModel({ computerToken, turnToken, bodyOverride: { model: "stub-model", max_completion_tokens: 40, messages: [{ role: "user", content: "hi" }] } });
    expect(res.status).toBe(200);
  });

  it("whichever of max_tokens/max_completion_tokens is larger governs the reservation", async () => {
    await testSetBudget(0.0008); // enough for 40 tokens (0.0008), not for 45 (0.0009)
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    // max_tokens says 10 (cheap), max_completion_tokens says 45 (the real
    // governing bound, over the ceiling) -- the larger one must be used,
    // or this would be wrongly allowed at the cheap 10-token price.
    const res = await callModel({ computerToken, turnToken, bodyOverride: { model: "stub-model", max_tokens: 10, max_completion_tokens: 45, messages: [{ role: "user", content: "hi" }] } });
    expect(res.status).toBe(402);
    const body = await jsonOf(res);
    expect(body.reason).toBe("budget_exhausted");
  });

  it("a request with neither field set to a valid positive number is denied, not silently reserved at a made-up default", async () => {
    await testSetBudget(1.0);
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();

    const neither = await callModel({ computerToken, turnToken, bodyOverride: { model: "stub-model", messages: [{ role: "user", content: "hi" }] } });
    expect(neither.status).toBe(400);
    expect((await jsonOf(neither)).reason).toBe("no_output_bound");

    // A string is not a number: this used to silently fall back to a
    // default of 1000 tokens instead of being refused.
    const stringValue = await callModel({ computerToken, turnToken, bodyOverride: { model: "stub-model", max_tokens: "999999", messages: [{ role: "user", content: "hi" }] } });
    expect(stringValue.status).toBe(400);
    expect((await jsonOf(stringValue)).reason).toBe("no_output_bound");

    // Zero and negative are not real bounds either.
    const zeroValue = await callModel({ computerToken, turnToken, bodyOverride: { model: "stub-model", max_tokens: 0, messages: [{ role: "user", content: "hi" }] } });
    expect(zeroValue.status).toBe(400);
  });
});

describe("8b. gateway-native usage logging (agentgateway's own access log, not the decision service's)", () => {
  // agentgateway writes its access-log line for a call slightly after the
  // HTTP response is already back with the client (logging is a
  // post-response step), so these tests poll for the line to appear
  // rather than asserting immediately after the response resolves.
  async function findGatewayLine(sinceIndex: number, predicate: (line: string) => boolean): Promise<string | undefined> {
    let found: string | undefined;
    try {
      await waitUntil(async () => {
        found = getLogLines("agentgateway").slice(sinceIndex).find(predicate);
        return found !== undefined;
      }, 2000, 25);
    } catch {
      // waitUntil throws on timeout; `found` just stays undefined, and the
      // caller's own assertion produces the failure message.
    }
    return found;
  }

  it("agentgateway's own log records the reservation id and the model's actual reported usage", async () => {
    await testSetBudget(1.0);
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();

    const gatewayLogLinesBefore = getLogLines("agentgateway").length;
    const res = await callModel({ computerToken, turnToken, maxTokens: 40 });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const actualTotalTokens = body.usage.total_tokens as number;

    // The reservation id this exact call got, read from the decision
    // service purely to know which id to look for -- the assertions below
    // are all against agentgateway's own captured stdout, never against
    // the decision service's log.
    const reserveLine = getLogLines("decision-service")
      .filter((line) => line.includes('"event":"reserve"'))
      .at(-1);
    const reservationId = (JSON.parse(reserveLine as string) as { reservationId: string }).reservationId;

    const accessLine = await findGatewayLine(
      gatewayLogLinesBefore,
      (line) => line.includes("route=default/model-route") && line.includes(`reservation="${reservationId}"`),
    );
    expect(accessLine, `expected an agentgateway access-log line for reservation ${reservationId}; saw:\n${getLogLines("agentgateway").slice(gatewayLogLinesBefore).join("\n")}`).toBeDefined();
    // The token count is a CEL integer, not a string, so it is unquoted in
    // the log line (unlike the reservation id, which is a string).
    expect(accessLine).toContain(`usageTotalTokens=${actualTotalTokens}`);
  });

  it("a denied model call's access-log line carries no reservation id (there was none to log)", async () => {
    await testSetBudget(0.00001); // too small for any positive reservation
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();
    const gatewayLogLinesBefore = getLogLines("agentgateway").length;
    const res = await callModel({ computerToken, turnToken, maxTokens: 40 });
    expect(res.status).toBe(402);
    const accessLine = await findGatewayLine(gatewayLogLinesBefore, (line) => line.includes("route=default/model-route"));
    expect(accessLine).toBeDefined();
    expect(accessLine).not.toMatch(/reservation="[0-9a-f]+"/);
  });
});

describe("2b. missing IAM context: OpenFGA down means deny (destructive -- runs last)", () => {
  it("with OpenFGA unreachable, a call that would otherwise be allowed is denied instead", async () => {
    const computerToken = await mintComputerToken();
    const turnToken = await mintTurnToken();

    const before = await callMcp({ computerToken, turnToken, bodyTool: "echo" });
    expect(before.status).toBe(200);

    await stopOpenFga();
    const res = await callMcp({ computerToken, turnToken, bodyTool: "echo" });
    expect(res.status).toBe(503);
    const body = await jsonOf(res);
    expect(body.reason).toBe("iam_context_unavailable");

    // Deliberately do not restart OpenFGA: this is the last test in the
    // file, and afterAll() tears the whole stack down regardless.
  });
});
