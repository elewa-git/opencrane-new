# Spike S0.2 — agentgateway decision hook

For people, read [README.md](README.md) first.

**Question:** can agentgateway be the *only* way out of a computer, with OpenCrane
deciding every sensitive call through `ext_authz` with full IAM context?

**Short answer: yes.** This is the second round of this spike: an independent
verifier ran the first round's build against a clean clone and against
adversarial inputs (JSON-RPC batches, duplicate keys, case-variant methods,
spoofed headers, another operator's approval) and found real gaps — a
reproducibility gap (`.tools/` is gitignored and nothing downloaded it), an
allow-by-default gap in the MCP method check, bearer tokens reaching
upstream backends, and one condition (8) that was reported as a documented
limitation when it was actually about four config lines away from working.
Every one of those is fixed and tested below; see "Findings and surprises"
for what changed and why. Everything in this README is backed by a real,
passing, non-mocked test run — see "How to run" below to reproduce it
yourself, from a genuinely clean clone.

## How to run (one command, from a clean clone)

```bash
cd spikes/s0-2-gateway
./scripts/run.sh
```

This downloads and checksum-verifies agentgateway and OpenFGA
(`scripts/fetch-tools.sh`, pinned SHA-256 per platform, darwin-arm64 and
linux-amd64), installs npm dependencies on first run, type-checks, then runs
the whole test suite. The test suite itself starts and stops every process
it needs (OpenFGA, agentgateway, the token issuer, the decision service, and
the two stub backends) — nothing is left running afterwards, and no state
persists between runs (`.state/` and OpenFGA's in-memory store are both
wiped every time). Typical run: **33 tests, all passing, in 10–17 seconds**
on an M-series Mac, reproduced 3/3 in a row both from a state with the
binaries already fetched and from a genuinely clean clone (verified by
deleting `.tools/`, `.state/` and `node_modules/` and running `./scripts/run.sh`
with nothing else present); the whole spike's on-disk footprint (binaries +
`node_modules`) is about **226 MB**, comfortably under the 1 GiB budget.

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
| Gateway config | `config/agentgateway.yaml` | Two routes (`/mcp`, `/v1/chat/completions`), each gated by `jwtAuth` (computer token) then `extAuthz` (the decision service), fail-closed, then a `transformations.request.replace` header allowlist and gateway-native `frontendPolicies.accessLog` usage logging. |
| Fetch script | `scripts/fetch-tools.sh` | Downloads agentgateway and OpenFGA for the running platform (darwin-arm64 or linux-amd64), verifies each against a SHA-256 pinned in the script itself, and is what makes `./scripts/run.sh` work from a clean clone. |
| Tests | `tests/s0-2-gateway.test.ts` (+ `tests/helpers.ts`) | One vitest file, 33 tests, against the real processes above: one per numbered pass condition, plus the fixes from this round's verifier (deny-by-default method allowlist, header stripping, approval binding, JWT expiry leeway, gateway-native usage logging). |

Real official release binaries (never built from source, never Docker):

| Name | Version | Platform | URL | Size | SHA-256 | Licence |
|---|---|---|---|---|---|---|
| agentgateway | v1.5.0 | darwin-arm64 | `github.com/agentgateway/agentgateway/releases/download/v1.5.0/agentgateway-darwin-arm64` | 87,439,776 bytes (~83 MiB) | `da432d35bd696da0564f7b2b6bbc783542b6b9c616d6c0c4d4c3daef9dfa11a1` (matched the release's own `.sha256` file) | Apache-2.0 |
| OpenFGA | v1.21.0 | darwin_arm64 | `github.com/openfga/openfga/releases/download/v1.21.0/openfga_1.21.0_darwin_arm64.tar.gz` | ~19 MiB compressed; extracted binary 62,498,306 bytes | `cb8adb607357c735c97412fe6a9c6bd30e10a0ab3838ef00f802f55276fb9baa` (matched the release's `checksums.txt`) | Apache-2.0 |

npm dependencies (all OSI-approved): `jose@6.2.12` (MIT, runtime), `typescript@5.9.3` (Apache-2.0, dev), `tsx@4.23.15` (MIT, dev), `vitest@3.2.7` (MIT, dev), `@types/node` (MIT, dev).

Both were the **latest stable (non-RC) releases** at the time of the spike
(2026-09-30): agentgateway ships no build newer than v1.5.0 as a GA tag, and
OpenFGA's v1.21.0 was its newest tagged release. `scripts/fetch-tools.sh`
pins the SHA-256 for both platforms this spike supports — darwin-arm64 (the
table above) and linux-amd64 (`agentgateway-linux-amd64`, SHA-256
`daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`;
`openfga_1.21.0_linux_amd64.tar.gz`, SHA-256
`0230a0f72c7bcc8ae6aeddd9dbf6d519e52934ab714b2900ce164d165b6df389`) — both
downloaded and checksum-verified during this round, though the test suite
itself only ran on the darwin-arm64 machine this spike was built on.

## Results

| # | Pass condition | Verdict | Evidence |
|---|---|---|---|
| 1 | Every call reaches `ext_authz` with verified computer + turn claims; no turn token or a bad signature is denied | **PASS** | 6 tests in `describe("1. …")`. Valid tokens → 200 with the MCP stub's real reply. Missing turn token → 401 `{"reason":"turn_token_invalid"}` (from the decision service). Tampered turn-token signature → 401 same reason, message `JWSSignatureVerificationFailed: signature verification failed`. Tampered **computer**-token signature → 401 **`content-type: text/plain`**, body `authentication failure: the token is invalid or malformed: …` — this is agentgateway's own `jwtAuth` rejecting it *before* the decision service is ever called (confirmed no new decision-service log line). A just-expired computer token (1 s TTL, checked 3 s later) is inside agentgateway's own ~60 s clock-skew leeway and gets past its `jwtAuth` — but is then denied (401, JSON, `computer_token_invalid`) by the decision service's own strict, zero-tolerance re-check, which is what actually enforces "short-lived" between 1 and roughly 60 seconds past expiry. See "Findings" for the leeway itself. |
| 2 | Live OpenFGA; deleting the requester's tuple denies the next call (< 2 s); OpenFGA down → deny | **PASS** | Revoke → next call denied: measured **3–4 ms** end to end (tuple delete via the OpenFGA HTTP API, `consistency: HIGHER_CONSISTENCY` on every Check, no cache) — far inside the 2 s target. Re-granting restores access, also within milliseconds. Killing the OpenFGA process and retrying the same call → 503 `{"reason":"iam_context_unavailable","message":"TypeError: fetch failed"}`, i.e. a fast fail, not a hang. |
| 3 | Fail closed: decision service stopped → calls denied, never forwarded | **PASS** | With the decision-service process killed, the same call returns **503** (`failureMode.denyWithStatus`), body `upstream call failed: Connect: Connection refused …`, and the MCP stub's request-log line count is provably unchanged (asserted in the test, not just eyeballed). Restarting the decision service (which re-bootstraps a fresh OpenFGA store + grant) immediately restores the happy path. |
| 4 | MCP 2026-07-28 only; tool-name header must match body, or refused — **say which layer** | **PASS** | Both checks are enforced **by the decision service (`ext_authz`), not natively by agentgateway`** — see "Findings" for why. A request with `mcp-protocol-version: 2025-06-18` → 400 `unsupported_protocol_version`. A request with header `mcp-tool-name: read_file` but body `params.name: "echo"` → 400 `tool_name_header_body_mismatch`. |
| 4b | **Deny by default** for the method itself: only `server/discover`, `tools/list` and `tools/call` (exact, case-sensitive) are permitted; everything else — `resources/*`, a case variant like `Tools/Call`, a JSON-RPC batch (a top-level array), a body with a duplicate top-level key, any unrecognised method — is refused before it is ever interpreted | **PASS** | 6 tests in `describe("4b. …")`, one per case above, each asserting a deny (400 for the two body-shape violations, 403 `method_not_allowed` for the rest) and an unchanged MCP-stub log-line count (never forwarded); plus one positive control (`tools/list`, on the allowlist, is genuinely forwarded — the stub's own 404 "unknown method" proves it reached the backend rather than being denied at `ext_authz`). This fixes the previous round's biggest finding: a method other than `tools/call` used to be allowed through unconditionally. |
| 5 | Oversized request bodies are rejected, not truncated | **PASS** | `includeRequestBody: {maxRequestBytes: 8192, allowPartialMessage: false}`. A 20,000-byte tool-call argument → **413 Payload Too Large**, body `external authorization failed`, and the MCP stub never saw the request (log line count unchanged in the assertion). Nothing was silently truncated and forwarded. |
| 6 | Client-supplied credential header can't spoof; the injected credential reaches the MCP server; the raw value never appears in gateway or decision-service logs | **PASS** | A call with `x-opencrane-credential: SPOOFED_BY_CLIENT` still reaches the MCP stub with the **real** per-call credential — proven by comparing SHA-256 hashes (`receivedCredentialHash` in the stub's reply equals the decision service's own hash, and differs from `sha256("SPOOFED_BY_CLIENT")`). The test then fetches the one raw credential value that existed during the whole run (via a test-only debug route) and greps the captured stdout/stderr of agentgateway, the decision service and the MCP stub for it: **zero matches**. Every log statement in the code only ever prints a SHA-256 hash of the credential, never the value itself. |
| 6b | Client headers other than a small allowlist never reach either backend: specifically, the computer JWT (`Authorization`) and the turn token (`x-turn-token`) never reach the MCP or model backend, and the model route's own `x-opencrane-credential` can't be spoofed either | **PASS** | 3 tests in `describe("6b. …")`. Both stubs now report back the exact header names they received (a test-only addition, see "What was built"). A call with a spoofed `x-opencrane-credential`, an invented `x-made-up-client-header`, and a `cookie` header reaches the **MCP** stub carrying only `content-type`, `accept`, `mcp-protocol-version`, `mcp-tool-name` and the real `x-opencrane-credential` — no `authorization`, no `x-turn-token`, no `cookie`, no made-up header. Same story on the **model** route, with `x-reservation-id` in place of the MCP headers, and its own `x-opencrane-credential` (a separate model-route credential) proven overwritten by hash comparison the same way condition 6 proves it for MCP. This fixes the previous round's other major finding: `preserveToken: true` (needed so the decision service can re-verify the computer token) was also letting both bearer tokens ride all the way to the stub backends. |
| 7 | Deny-until-approved: first Ask call denied with an approval id; after approval the identical retry passes once; a second identical retry is denied; changed arguments are denied | **PASS** | `delete_file` (mode Ask) → 403 `approval_required` + an `approvalId`. After approving (a stand-in admin action), the identical call → 200. The same call again → **409** `approval_already_used` (single-use enforced by an in-memory record keyed on `requester:conversation:turn:assistant:tool:sha256(arguments)` — see 7b). The same tool with different arguments → a **fresh** 403 `approval_required` with a **new** approval id — the old approval never covers different arguments. `danger_wipe` (mode Block) → 403 `tool_blocked`, no approval path at all. |
| 7b | Approvals are bound to the requester, conversation and turn, not just the assistant, tool and argument digest: a different operator of the same assistant can't spend someone else's approval | **PASS** | A new test in `describe("7. …")`. Bob is granted as a second operator of Alice's assistant. Alice asks for `delete_file` with a given argument, her admin approves it (for her own requester/conversation/turn). Bob then makes the *exact same call* (same assistant, same tool, same arguments) in his own conversation/turn: he gets his own fresh `403 approval_required`, not Alice's `200` or a `409 already used`. Alice's own retry afterwards still works exactly once, proving Bob's attempt never touched her approval record. This fixes the previous round's finding that a second operator could consume someone else's approval. |
| 8 | Model route: `ext_authz` reserves a worst-case amount from `max_tokens` **and `max_completion_tokens`** before forwarding; a request with no valid output bound is denied rather than assumed; once the budget is exhausted the next call is denied; the gateway logs usage with the reservation id | **PASS** | Ceiling set to $0.001; a 40-max-token call reserves $0.0008 (at a made-up $0.00002/token worst case) and is allowed (200, the model stub's real reply); the next identical call would push reserved spend to $0.0016 > the ceiling → **402** `budget_exhausted`. `max_completion_tokens` alone (no `max_tokens`) reserves correctly; when both are present, the **larger** of the two governs (tested: `max_tokens: 10` + `max_completion_tokens: 45` is denied at the 45-token price, not allowed at the 10-token one). A request with neither field set to a valid positive number — including `max_tokens: "999999"` (a string) and `max_tokens: 0` — is denied `400 no_output_bound`, not silently reserved at a made-up 1000-token default. Usage logging: see 8b. |
| 8b | Gateway-native usage logging: agentgateway's **own** access log (not the decision service's) records the reservation id and the model's actual reported usage | **PASS** | 2 tests in `describe("8b. …")`, reading `getLogLines("agentgateway")` directly. An allowed call's line reads `... route=default/model-route ... reservation="<id>" usageTotalTokens=<n>`, where `<id>` matches the decision service's own reservation id and `<n>` matches the model stub's real `usage.total_tokens` — read from **agentgateway's** captured stdout, not the decision service's log. A denied call's line carries `usageTotalTokens=0` and no `reservation="..."` field at all (there was no reservation to log). This directly contradicts the previous round's finding that this wasn't achievable: `frontendPolicies.accessLog.add` with `extauthz.reservationId` and `json(response.body).usage.total_tokens` (guarded by `proxy.route.name == "model-route"` so it never touches MCP responses) validates and works in v1.5.0. The earlier "CEL `has()` limitation" diagnosis was real for `has()` itself, but the fix was simply not to use `has()` — direct property access on the same dynamic map degrades gracefully to "field absent" instead of erroring. |

**33/33 tests pass, reproduced 3/3 in a row from a clean clone.** Re-run
`./scripts/run.sh` to reproduce every number above.

## Findings and surprises

- **`agentgateway` ships native `ai` and `mcp` backend types, but we did not use them.** Both are built for protocol revisions/provider shapes agentgateway itself recognises. The plan's MCP convention (2026-07-28: no handshake, no session, method+tool-name headers, `_meta` fields) is the *project's own* stateless convention, not a revision this agentgateway release (v1.5.0) ships support for, and our model stub is a minimal custom shape, not a real provider. We routed both as **plain HTTP backends** (`backends[].host`) instead, and did protocol-version and tool-name-agreement checks ourselves, in the decision service. This is exactly the "smallest workaround" the task invited us to propose if a capability were missing — the missing capability being *native understanding of a protocol revision that (by definition, being dated in the future of this release) agentgateway cannot know about*.
- **`jwtAuth`'s `preserveToken` defaults to stripping the verified header.** Without `preserveToken: true`, agentgateway consumes the `Authorization` header once it verifies the computer token, and the decision service — which wants to independently re-verify the same JWT rather than trust a forwarded claim — then sees "no bearer token found". Setting `preserveToken: true` fixed this. This is a real, easy-to-miss trap for exactly the "IAM context must always be verifiable at ext_authz" requirement in the plan.
- **`extAuthz.protocol.http.includeResponseHeaders` overwrites, it does not append.** We expected we would need a `requestHeaderModifier.remove` policy to strip a client-spoofed `x-opencrane-credential` header before `ext_authz` could safely re-add the real one. Empirically, that policy runs **after** `ext_authz` (it stripped the value `ext_authz` had just injected, breaking condition 6, until we removed it) — and it turned out to be unnecessary anyway: `includeResponseHeaders` replaces the header's value outright, so a spoofed client value never survives. One fewer policy than we expected, but only because we tested the ordering rather than assuming it.
- **Only one `jwtAuth` policy per route.** The plan wants both the computer token and the turn token "verified by the gateway". agentgateway's `jwtAuth` policy validates exactly one bearer-style credential in one location. We used it for the computer token (gateway-level, deny-before-`ext_authz`) and forwarded the turn token as a plain header for the decision service to verify itself with the same JWKS. Both tokens are end-to-end signature-verified before any decision is made; only *which process* does the verifying differs per token, and we've documented that split explicitly here and in the ADR.
- **`--validate-only` actually dials out.** Validating the config with a `jwks.url` pointing at a not-yet-running token issuer fails validation (`failed to load JWKS: fetch …`) rather than deferring the fetch to runtime. Useful to know for CI: validate only after — or alongside — bringing up dependent services, not standalone.
- **CEL's `has()` macro really does reject a dynamic map root** (`has(extauthz)`, `has(response.headers["x"])`) — that part of the previous round's finding was correct. What was wrong was the conclusion drawn from it: **plain property access on the same dynamic map, without `has()`, works fine and degrades gracefully.** `extauthz.reservationId` in an `accessLog.add` expression is simply absent from the log line — not an error — when the key wasn't set (a denied call, or a route that never set it); it only needed testing without `has()` in the way. The condition-8 usage-logging caveat in the previous README was a real config limitation reported as a design decision; it should have been "we didn't find the right expression yet," and now it's fixed (see condition 8b).
- **`policies.transformations.request.replace` runs after `extAuthz`, the same as `requestHeaderModifier`.** Proved live (not inferred from the `requestHeaderModifier`/credential-overwrite finding above, which is a different policy): a probe request with a spoofed `x-opencrane-credential`, an invented header, and a `cookie`, sent through a `transformations.request.replace` allowlist naming five headers, reached the backend with *exactly* those five names — the spoofed credential was already overwritten by `extAuthz`'s own header injection by the time `replace` read it. This is what the header-stripping fix (condition 6b) is built on: an explicit allowlist (`replace` computes the *entire* header set from scratch) rather than a deny-list of headers to `remove`, which would always be one unanticipated client header behind.
- **Config hot-reload is real and immediate.** Editing `config/agentgateway.yaml` while agentgateway is running reloads within about a second (`state_manager: loaded config from File(...)`), and an invalid edit is rejected with a specific parse error while the *previous good config keeps serving* — it never falls over. That's a nice property for iterating on policy without restarts, and also means a CI check should watch for `Failed to reload config` lines, not just crashes.
- **`bindAddress` is not a valid field under `gateways.<name>`** in this schema version (validation rejected it) even though the generated markdown schema documents it under the deprecated `binds[].listeners[]` shape. We dropped it; the gateway just listens on all interfaces, which is fine for a local spike.
- **agentgateway's own `jwtAuth` has an undocumented, unconfigurable expiry leeway of roughly 60 seconds** (there is no `clockSkew`/`leeway` field anywhere in its JWT config schema — checked exhaustively, not assumed). A computer token 30 seconds past `exp` is still accepted at the gateway; one over about a minute past is rejected. This is a real finding, not a defect we fixed: the design already has a second, independent, zero-tolerance check at the decision service (via `jose`'s default `clockTolerance`), which is what actually catches a token in that ~1–60 second window, and it must stay that way — see condition 1's expiry test and the comment above `verifyComputerToken`/`verifyTurnToken` in `src/decision-service/server.ts`.
- **The access-log line for a call appears slightly after the HTTP response does.** The two new `describe("8b. …")` tests originally asserted on `getLogLines("agentgateway")` immediately after `await callModel(...)` resolved and failed intermittently; polling for the line (see `findGatewayLine` in the test file) fixed it. Worth remembering for any future test against agentgateway's own log: it is not synchronous with the response the client sees.

## Simplifications and what was *not* exercised

- **The OpenFGA model is intentionally minimal**: one relation (`operator`, directly assigned to a user on an assistant), representing exactly "requester ∩ assistant" from the plan's IAM table. Team relations, tool-scoped grants, and delegation-chain checks are not modelled — they would be straightforward additions to the same store, not a different mechanism. The plan's "membership and role, team memberships, whether the assistant and computer are active" part of the IAM context is likewise not modelled at all here; this spike proves the *shape* of "ask OpenFGA, fail closed if unreachable," not the full context assembly.
- **Approval single-use is now bound to `requester + conversation + turn + assistant + tool + sha256(arguments)`** (condition 7b), not to a client-supplied approval-id header — this matches the plan's wording ("single-use approvals bound to an argument digest") while also closing the cross-operator gap the previous round found. A real MCP client still needs no special knowledge of approval ids to benefit: the identical retry, in the same turn, just works once approved.
- **The MCP stub's tools do nothing real** (`delete_file` and `danger_wipe` are no-ops that report success) — the spike is about the decision path, not about building real tools.
- **No rate limiting, no CORS, no observability/export integration** were configured; agentgateway supports all three, but none of the pass conditions needed them.
- **Budget settlement** (adjusting a reservation down to the model's *actual* reported usage after the call) is still not implemented — `ext_authz` is a pre-request hook only. The real system settles from the gateway's own observed-effect log (`effect.observed` → settle, per `events.md`), a separate mechanism from `ext_authz` and out of scope here. Condition 8b's gateway-native usage log is the piece that would feed that settlement step; it is not the settlement step itself.
- **Backend TLS** (`policies.backendTLS`) was inspected in the schema but never exercised live — every backend here is a local plaintext stub.
- **The header allowlist is per-route, not truly generic**: `config/agentgateway.yaml`'s two `transformations.request.replace` expressions each name their own five headers by hand. A server registering a *new* MCP header (the plan's install flow can add per-server headers) would need its allowlist updated in the same place the route itself is generated — worth a note for whatever generates gateway config from the MCP catalogue in Phase 3.

## Open questions for the owner

1. **Turn-token verification split** — is it acceptable, long-term, that the computer token is verified by agentgateway's `jwtAuth` while the turn token is verified independently by the decision service (both against the same JWKS, both fully signature-checked)? An alternative would be a second gateway in front of the decision service that itself runs `jwtAuth` on the turn token before proxying — more moving parts, same guarantee.
2. **The gateway's own ~60-second JWT expiry leeway** (see "Findings") has no config knob to remove in this agentgateway release. Is relying on the decision service's independent strict re-check as the real enforcement point (rather than trying to eliminate the gateway's leeway) an acceptable permanent design, or does it need escalating to agentgateway upstream as a configurability request?
3. **Native `mcp`/`ai` backend types** — once Codex (or whatever harness S0.1 lands on) speaks a protocol revision agentgateway natively recognises, does it make sense to revisit using agentgateway's own MCP client/multiplexer (tool-list caching, session management, etc.) instead of a plain HTTP passthrough? That would hand agentgateway more of the protocol-conformance work, at the cost of us no longer controlling the exact wire shape.
4. **Price table source** — the $0.00002/token figure here is invented. The real decision service needs a live price table (per the "Money" row of the IAM-context table) — is that expected to come from LiteLLM's cost map, per decision 3 in `plan.md`'s LiteLLM section, reusing the same mechanism already decided for BYOK/BYOM?
