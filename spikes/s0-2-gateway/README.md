# Spike S0.2 — agentgateway decision hook

**Question:** can agentgateway be the *only* way out of a computer, with OpenCrane
deciding every sensitive call through `ext_authz` with full IAM context?

**Short answer: yes**, with one honest caveat on the model-budget logging detail
(condition 8 below) and a handful of documented workarounds where this
agentgateway release (v1.5.0) doesn't natively understand the plan's own
2026-07-28 MCP convention. Everything in this README is backed by a real,
passing, non-mocked test run — see "How to run" below to reproduce it
yourself in under 10 seconds.

## How to run (one command)

```bash
cd spikes/s0-2-gateway
./scripts/run.sh
```

This installs dependencies on first run, type-checks, then runs the whole
test suite. The test suite itself starts and stops every process it needs
(OpenFGA, agentgateway, the token issuer, the decision service, and the two
stub backends) — nothing is left running afterwards, and no state persists
between runs (`.state/` and OpenFGA's in-memory store are both wiped every
time). Typical run: **17 tests, all passing, in under 5 seconds** on an M-series
Mac; the whole spike's on-disk footprint (binaries + `node_modules`) is about
**210 MB**, comfortably under the 1.5 GB budget.

To poke at it by hand instead of running the suite, start the services in
this order (each is one line):

```bash
.tools/openfga_1.21.0/openfga run --http-addr 0.0.0.0:8089 --grpc-addr 0.0.0.0:8090 --datastore-engine memory &
npx tsx src/token-issuer/server.ts &
npx tsx src/decision-service/server.ts &
npx tsx src/mcp-stub/server.ts &
npx tsx src/model-stub/server.ts &
.tools/agentgateway-darwin-arm64 -f config/agentgateway.yaml &
```

Then mint tokens and call the gateway, e.g.:

```bash
CT=$(curl -s -XPOST :4101/token/computer -d '{"silo":"acme","computer":"computer-alice","assistant":"assistant-alice"}' | jq -r .token)
TT=$(curl -s -XPOST :4101/token/turn -d '{"silo":"acme","conversation":"c1","turn":"t1","requester":"user-alice","assistant":"assistant-alice"}' | jq -r .token)
curl -i :3000/mcp -H "authorization: Bearer $CT" -H "x-turn-token: $TT" \
  -H "mcp-protocol-version: 2026-07-28" -H "mcp-tool-name: echo" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"hi":1}},"_meta":{"io.modelcontextprotocol/protocol-version":"2026-07-28"}}'
```

## What was built

| Piece | File | Role |
|---|---|---|
| Token issuer | `src/token-issuer/server.ts` | Mints a **computer token** (silo, computer, assistant) and a **turn token** (silo, conversation, turn, requester, assistant, delegation chain), both ES256-signed, both short-lived; publishes its public key at `/jwks.json`. Stands in for "the OpenCrane server, at claim and at message delivery". |
| Decision service | `src/decision-service/server.ts` + `src/decision-service/openfga-client.ts` | The `ext_authz` HTTP target. Verifies both tokens, checks MCP protocol version and tool-name agreement, asks OpenFGA "does this requester operate this assistant?", applies a per-tool Allow/Ask/Block mode with single-use approvals bound to an argument digest, reserves a worst-case model budget, releases a per-call credential, and logs one JSON decision record per call with an IAM-context digest. |
| MCP stub | `src/mcp-stub/server.ts` | A minimal stateless JSON-RPC server for the plan's 2026-07-28 convention: `server/discover`, `tools/call`, header/body version and tool-name checks repeated defensively, and it reports (as a hash only) whatever credential it was handed. |
| Model stub | `src/model-stub/server.ts` | A minimal OpenAI-shaped `/v1/chat/completions` endpoint that returns a canned reply and a `usage` block. |
| Gateway config | `config/agentgateway.yaml` | Two routes (`/mcp`, `/v1/chat/completions`), each gated by `jwtAuth` (computer token) then `extAuthz` (the decision service), fail-closed. |
| Tests | `tests/s0-2-gateway.test.ts` (+ `tests/helpers.ts`) | One vitest file, 17 tests, one per numbered pass condition (plus edge cases), against the real processes above. |

Real official release binaries (never built from source, never Docker):

| Name | Version | Platform | URL | Size | SHA-256 | Licence |
|---|---|---|---|---|---|---|
| agentgateway | v1.5.0 | darwin-arm64 | `github.com/agentgateway/agentgateway/releases/download/v1.5.0/agentgateway-darwin-arm64` | 87,439,776 bytes (~83 MiB) | `da432d35bd696da0564f7b2b6bbc783542b6b9c616d6c0c4d4c3daef9dfa11a1` (matched the release's own `.sha256` file) | Apache-2.0 |
| OpenFGA | v1.21.0 | darwin_arm64 | `github.com/openfga/openfga/releases/download/v1.21.0/openfga_1.21.0_darwin_arm64.tar.gz` | ~19 MiB compressed; extracted binary 62,498,306 bytes | `cb8adb607357c735c97412fe6a9c6bd30e10a0ab3838ef00f802f55276fb9baa` (matched the release's `checksums.txt`) | Apache-2.0 |

npm dependencies (all OSI-approved): `jose@6.2.12` (MIT, runtime), `typescript@5.9.3` (Apache-2.0, dev), `tsx@4.23.15` (MIT, dev), `vitest@3.2.7` (MIT, dev), `@types/node` (MIT, dev).

Both binaries were the **latest stable (non-RC) darwin-arm64 releases** at the
time of the spike (2026-09-30): agentgateway ships no macOS build newer than
v1.5.0 as a GA tag, and OpenFGA's v1.21.0 was its newest tagged release.

## Results

| # | Pass condition | Verdict | Evidence |
|---|---|---|---|
| 1 | Every call reaches `ext_authz` with verified computer + turn claims; no turn token or a bad signature is denied | **PASS** | 5 tests in `describe("1. …")`. Valid tokens → 200 with the MCP stub's real reply. Missing turn token → 401 `{"reason":"turn_token_invalid"}` (from the decision service). Tampered turn-token signature → 401 same reason, message `JWSSignatureVerificationFailed: signature verification failed`. Tampered **computer**-token signature → 401 **`content-type: text/plain`**, body `authentication failure: the token is invalid or malformed: …` — this is agentgateway's own `jwtAuth` rejecting it *before* the decision service is ever called (confirmed no new decision-service log line). |
| 2 | Live OpenFGA; deleting the requester's tuple denies the next call (< 2 s); OpenFGA down → deny | **PASS** | Revoke → next call denied: measured **3–4 ms** end to end (tuple delete via the OpenFGA HTTP API, `consistency: HIGHER_CONSISTENCY` on every Check, no cache) — far inside the 2 s target. Re-granting restores access, also within milliseconds. Killing the OpenFGA process and retrying the same call → 503 `{"reason":"iam_context_unavailable","message":"TypeError: fetch failed"}`, i.e. a fast fail, not a hang. |
| 3 | Fail closed: decision service stopped → calls denied, never forwarded | **PASS** | With the decision-service process killed, the same call returns **503** (`failureMode.denyWithStatus`), body `upstream call failed: Connect: Connection refused …`, and the MCP stub's request-log line count is provably unchanged (asserted in the test, not just eyeballed). Restarting the decision service (which re-bootstraps a fresh OpenFGA store + grant) immediately restores the happy path. |
| 4 | MCP 2026-07-28 only; tool-name header must match body, or refused — **say which layer** | **PASS** | Both checks are enforced **by the decision service (`ext_authz`), not natively by agentgateway`** — see "Findings" for why. A request with `mcp-protocol-version: 2025-06-18` → 400 `unsupported_protocol_version`. A request with header `mcp-tool-name: read_file` but body `params.name: "echo"` → 400 `tool_name_header_body_mismatch`. |
| 5 | Oversized request bodies are rejected, not truncated | **PASS** | `includeRequestBody: {maxRequestBytes: 8192, allowPartialMessage: false}`. A 20,000-byte tool-call argument → **413 Payload Too Large**, body `external authorization failed`, and the MCP stub never saw the request (log line count unchanged in the assertion). Nothing was silently truncated and forwarded. |
| 6 | Client-supplied credential header can't spoof; the injected credential reaches the MCP server; the raw value never appears in gateway or decision-service logs | **PASS** | A call with `x-opencrane-credential: SPOOFED_BY_CLIENT` still reaches the MCP stub with the **real** per-call credential — proven by comparing SHA-256 hashes (`receivedCredentialHash` in the stub's reply equals the decision service's own hash, and differs from `sha256("SPOOFED_BY_CLIENT")`). The test then fetches the one raw credential value that existed during the whole run (via a test-only debug route) and greps the captured stdout/stderr of agentgateway, the decision service and the MCP stub for it: **zero matches**. Every log statement in the code only ever prints a SHA-256 hash of the credential, never the value itself. |
| 7 | Deny-until-approved: first Ask call denied with an approval id; after approval the identical retry passes once; a second identical retry is denied; changed arguments are denied | **PASS** | `delete_file` (mode Ask) → 403 `approval_required` + an `approvalId`. After approving (a stand-in admin action), the identical call → 200. The same call again → **409** `approval_already_used` (single-use enforced by an in-memory record keyed on `assistant:tool:sha256(arguments)`). The same tool with different arguments → a **fresh** 403 `approval_required` with a **new** approval id — the old approval never covers different arguments. `danger_wipe` (mode Block) → 403 `tool_blocked`, no approval path at all. |
| 8 | Model route: `ext_authz` reserves a worst-case amount from `max_tokens` before forwarding; once the budget is exhausted the next call is denied; the gateway logs usage with the reservation id | **PASS, with one documented caveat** | Ceiling set to $0.001; a 40-max-token call reserves $0.0008 (at a made-up $0.00002/token worst case) and is allowed (200, the model stub's real reply); the next identical call would push reserved spend to $0.0016 > the ceiling → **402** `budget_exhausted`. The reservation id is logged with the reserved amount — **by the decision service's own structured log**, not by agentgateway's own access log. We tried to also add the reservation id to agentgateway's stdout access log via its `extauthz.*` CEL variable (see `config/agentgateway.yaml`'s trailing comment) and hit a genuine limitation: agentgateway's CEL dialect rejects `has()` on that dynamic map root in a way we could not work around while still validating cleanly on every reload. We are reporting the mechanism itself (reserve-before-forward, deny-on-exhaustion, logged reservation id) as fully proven, and flagging only the "which process's log" detail as not achieved exactly as worded. |

**17/17 tests pass.** Re-run `./scripts/run.sh` to reproduce every number above.

## Findings and surprises

- **`agentgateway` ships native `ai` and `mcp` backend types, but we did not use them.** Both are built for protocol revisions/provider shapes agentgateway itself recognises. The plan's MCP convention (2026-07-28: no handshake, no session, method+tool-name headers, `_meta` fields) is the *project's own* stateless convention, not a revision this agentgateway release (v1.5.0) ships support for, and our model stub is a minimal custom shape, not a real provider. We routed both as **plain HTTP backends** (`backends[].host`) instead, and did protocol-version and tool-name-agreement checks ourselves, in the decision service. This is exactly the "smallest workaround" the task invited us to propose if a capability were missing — the missing capability being *native understanding of a protocol revision that (by definition, being dated in the future of this release) agentgateway cannot know about*.
- **`jwtAuth`'s `preserveToken` defaults to stripping the verified header.** Without `preserveToken: true`, agentgateway consumes the `Authorization` header once it verifies the computer token, and the decision service — which wants to independently re-verify the same JWT rather than trust a forwarded claim — then sees "no bearer token found". Setting `preserveToken: true` fixed this. This is a real, easy-to-miss trap for exactly the "IAM context must always be verifiable at ext_authz" requirement in the plan.
- **`extAuthz.protocol.http.includeResponseHeaders` overwrites, it does not append.** We expected we would need a `requestHeaderModifier.remove` policy to strip a client-spoofed `x-opencrane-credential` header before `ext_authz` could safely re-add the real one. Empirically, that policy runs **after** `ext_authz` (it stripped the value `ext_authz` had just injected, breaking condition 6, until we removed it) — and it turned out to be unnecessary anyway: `includeResponseHeaders` replaces the header's value outright, so a spoofed client value never survives. One fewer policy than we expected, but only because we tested the ordering rather than assuming it.
- **Only one `jwtAuth` policy per route.** The plan wants both the computer token and the turn token "verified by the gateway". agentgateway's `jwtAuth` policy validates exactly one bearer-style credential in one location. We used it for the computer token (gateway-level, deny-before-`ext_authz`) and forwarded the turn token as a plain header for the decision service to verify itself with the same JWKS. Both tokens are end-to-end signature-verified before any decision is made; only *which process* does the verifying differs per token, and we've documented that split explicitly here and in the ADR.
- **`--validate-only` actually dials out.** Validating the config with a `jwks.url` pointing at a not-yet-running token issuer fails validation (`failed to load JWKS: fetch …`) rather than deferring the fetch to runtime. Useful to know for CI: validate only after — or alongside — bringing up dependent services, not standalone.
- **CEL's `has()` macro is pickier than it looks.** It rejects map-index expressions (`has(response.headers["x"])`) and, in this build, also rejected `has()` on the `extauthz` root variable itself even guarded by `has(extauthz) && …`. The `"key" in map ? map["key"] : default` form works for map indexing (used successfully in the `extAuthz.protocol.http.metadata` blocks); we never found a form that let us reach into `extauthz.*` safely enough to survive a live config reload, hence the condition-8 caveat above.
- **Config hot-reload is real and immediate.** Editing `config/agentgateway.yaml` while agentgateway is running reloads within about a second (`state_manager: loaded config from File(...)`), and an invalid edit is rejected with a specific parse error while the *previous good config keeps serving* — it never falls over. That's a nice property for iterating on policy without restarts, and also means a CI check should watch for `Failed to reload config` lines, not just crashes.
- **`bindAddress` is not a valid field under `gateways.<name>`** in this schema version (validation rejected it) even though the generated markdown schema documents it under the deprecated `binds[].listeners[]` shape. We dropped it; the gateway just listens on all interfaces, which is fine for a local spike.

## Simplifications and what was *not* exercised

- **Backend TLS** (`policies.backendTLS`) was inspected in the schema (cert/key/root/hostname/insecure/spiffe/ALPN all present) but never exercised live: every backend in this spike is a local plaintext stub. Real deployments would terminate TLS to the model provider and to remote MCP servers; that is unchanged by anything found here.
- **Settlement** (adjusting a budget reservation down to the model's *actual* reported usage after the call completes) is not implemented. `ext_authz` is a pre-request hook only; there is no second call back into the decision service once the backend responds. The real system would settle from the gateway's own observed-effect log (per the plan's event catalogue: `effect.observed` → settle), which is a separate mechanism from `ext_authz` and out of scope for this spike.
- **The OpenFGA model is intentionally minimal**: one relation (`operator`, directly assigned to a user on an assistant), representing exactly "requester ∩ assistant" from the plan's IAM table. Team relations, tool-scoped grants, and delegation-chain checks are not modelled — they would be straightforward additions to the same store, not a different mechanism.
- **Approval single-use is bound to `assistant + tool + sha256(arguments)`**, not to a client-supplied approval-id header — this matches the plan's wording ("single-use approvals bound to an argument digest") and means a real MCP client needs no special knowledge of approval ids to benefit: the identical retry just works once approved.
- **The MCP stub's tools do nothing real** (`delete_file` and `danger_wipe` are no-ops that report success) — the spike is about the decision path, not about building real tools.
- **No rate limiting, no CORS, no observability/export integration** were configured; agentgateway supports all three, but none of the 8 pass conditions needed them.

## Open questions for the owner

1. **Condition 8's "gateway logs usage"** — is logging the reservation id from the *decision service* (which is, after all, part of "OpenCrane deciding") acceptable, or does the plan specifically need agentgateway's own process to emit it (e.g. for a log pipeline that only watches the gateway's stdout)? If the latter, worth a short follow-up spike into agentgateway's CEL dialect limits, or into whether its native `ai` backend type (which does expose `llm.totalTokens` etc. to CEL) is worth adopting for the model route specifically, even while MCP stays on a plain HTTP backend.
2. **Turn-token verification split** — is it acceptable, long-term, that the computer token is verified by agentgateway's `jwtAuth` while the turn token is verified independently by the decision service (both against the same JWKS, both fully signature-checked)? An alternative would be a second gateway in front of the decision service that itself runs `jwtAuth` on the turn token before proxying — more moving parts, same guarantee.
3. **Native `mcp`/`ai` backend types** — once Codex (or whatever harness S0.1 lands on) speaks a protocol revision agentgateway natively recognises, does it make sense to revisit using agentgateway's own MCP client/multiplexer (tool-list caching, session management, etc.) instead of a plain HTTP passthrough? That would hand agentgateway more of the protocol-conformance work, at the cost of us no longer controlling the exact wire shape.
4. **Price table source** — the $0.00002/token figure here is invented. The real decision service needs a live price table (per the "Money" row of the IAM-context table) — is that expected to come from LiteLLM's cost map, per decision 3 in `plan.md`'s LiteLLM section, reusing the same mechanism already decided for BYOK/BYOM?
