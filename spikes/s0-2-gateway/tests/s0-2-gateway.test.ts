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
  startAll,
  stopAll,
  stopDecisionService,
  stopOpenFga,
  tamperSignature,
  testCredentialHash,
  testCredentialRaw,
  testDecideApproval,
  testGrant,
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
