# ADR 0002: gateway — agentgateway

**Status:** Draft, from spike S0.2. Ready for the morning decision.
**Spike evidence:** [`spikes/s0-2-gateway/`](../../spikes/s0-2-gateway/), all 8 pass conditions run on 2026-09-30 (darwin/arm64, agentgateway v1.5.0, OpenFGA v1.21.0, Node 22.15.0) — 17/17 tests passing, reproducible with one command (`spikes/s0-2-gateway/scripts/run.sh`).

## Question

Can agentgateway be **the only way out of a computer**, with OpenCrane
deciding every sensitive call through `ext_authz` with full IAM context, as
laid out in plan.md's ["Responsibility split: gateway vs
server"](../../plan.md#responsibility-split-gateway-vs-server) and ["IAM
context in every gateway
decision"](../../plan.md#iam-context-in-every-gateway-decision)? Decide
before the Phase 0 start gate (S0.1, S0.2, S0.7 must all pass).

## Options considered

| Option | Licence | Verdict |
|---|---|---|
| **agentgateway** | Apache-2.0 | **Chosen** — see evidence below |
| The Envoy stack (Envoy + a hand-written `ext_authz` gRPC/HTTP filter chain) | Apache-2.0 | Fallback, not spiked. agentgateway already ships the pieces this spike needed (`jwtAuth`, `extAuthz` with HTTP protocol and body-size limits, CEL); Envoy would need the same policy surface hand-assembled from lower-level primitives |

## Decision

**agentgateway passes**, end to end, against real official binaries (not
mocked, not Dockerised): agentgateway v1.5.0 and OpenFGA v1.21.0, both
darwin-arm64 release binaries, run as local processes. The decision service,
token issuer, and both stub backends are plain TypeScript (Node 22, `jose`
for JWT, no web framework) — see the spike's README for the full write-up,
findings, and every log line behind each number below.

| # | Pass condition | Result |
|---|---|---|
| 1 | Every call reaches `ext_authz` with verified computer + turn claims; no turn token or a bad signature → deny | **PASS** — bad computer-token signature denied by agentgateway's own `jwtAuth`, before `ext_authz` is ever called; bad/missing turn token denied by the decision service |
| 2 | Live OpenFGA; revoking the requester's tuple denies the next call (< 2 s); OpenFGA down → deny | **PASS** — measured revoke-to-deny latency **3–4 ms**; OpenFGA down → fast-failing 503, not a hang |
| 3 | Fail closed: decision service stopped → denied, never forwarded | **PASS** — 503, and the backend's request-log line count is asserted unchanged |
| 4 | MCP 2026-07-28 only; tool-name header must match body, or refused (say which layer) | **PASS** — enforced by the decision service (`ext_authz`), not natively by agentgateway; see "Consequences" for why |
| 5 | Oversized request bodies rejected, not truncated | **PASS** — 413, `allowPartialMessage: false`, confirmed never reaching the backend |
| 6 | Client-supplied credential header can't spoof; injected credential reaches the MCP server; never logged | **PASS** — proven by hash comparison (reaches the server) and by grepping every captured log for the one raw value that existed during the run (zero matches) |
| 7 | Deny-until-approved, single use, bound to an argument digest | **PASS** — first Ask denied with an approval id; approved retry passes once; second identical retry denied (409, single use); changed arguments get a fresh approval id |
| 8 | Model route: reserve worst-case from `max_tokens`; deny once exhausted; log usage with the reservation id | **PASS, with one caveat**: the reservation id is logged by the decision service, not by agentgateway's own access log — a genuine CEL limitation we hit and documented, not something left untried |

### What this proves for the architecture in plan.md

- **"The gateway enforces; the OpenCrane server decides"** holds up as a real
  split, not just a diagram: agentgateway's `jwtAuth` genuinely gates the
  computer token before the decision service is ever invoked (measured: a
  bad-signature computer token never produces a decision-service log line),
  while every *fine* decision — permission, tool mode, approvals, budget —
  is entirely the decision service's, exactly as plan.md's responsibility
  table assigns it.
- **Fail-closed is agentgateway's default behaviour for `ext_authz`**, not
  something we had to add: `failureMode.denyWithStatus` is the only config
  needed, and an unreachable decision service produces a fast deny, not a
  timeout-shaped hang.
- **A revoked grant is enforced within milliseconds**, not the 2-second
  budget the plan sets as a target — because the decision service queries
  OpenFGA with `consistency: HIGHER_CONSISTENCY` on every single call rather
  than caching. At silo scale this is cheap; it should stay this way rather
  than being "optimised" into a cache later without re-measuring.
- **agentgateway does not need to understand OpenCrane's own protocol
  conventions to enforce them.** Routing MCP and model traffic as plain HTTP
  backends, with protocol-version/tool-name/budget logic entirely in the
  decision service, means the gateway config stays generic and portable —
  the "smallest workaround" the plan invites when a capability is missing,
  applied here because *no* gateway release can natively recognise a
  protocol revision dated after its own release.

## Consequences

- **Decision 4 in plan.md ("OpenFGA or SpiceDB")** gets a second point of
  support: OpenFGA's revocation latency was measured at single-digit
  milliseconds, nowhere near the "revisit if revocation latency fails a
  test" trigger.
- **The gateway config (`jwtAuth` + `extAuthz`, two routes) is a usable
  starting point** for Phase 3's real decision service, not throwaway code —
  see the spike's `config/agentgateway.yaml` and its inline comments for the
  exact traps found (`preserveToken`, header-modifier-vs-`ext_authz`
  ordering, the CEL `has()` limitation).
- **MCP and model traffic go through agentgateway as plain HTTP backends**,
  not its native `ai`/`mcp` backend types, until either (a) Codex/the chosen
  harness and the real MCP spec converge on a revision agentgateway
  recognises, or (b) it's worth adopting the native `ai` backend type for
  the model route specifically to get its built-in `llm.*` CEL fields (see
  open question 1 below). This is a design choice to revisit, not a defect.
- **The turn token is verified twice, by two different processes** (the
  decision service always; agentgateway never, since it has only one
  `jwtAuth` slot and that is spent on the computer token). Both
  verifications are against the same published JWKS, so there is no weaker
  guarantee — just two call sites instead of one, worth knowing about when
  reading gateway config expecting it to gate both tokens.
- **Phase 3's decision service** (EUR price table, reserve-before-call,
  settlement from gateway logs, approval UI) can be built directly on this
  spike's shape: token verification, OpenFGA check, tool mode, approval
  digesting, and budget reservation are all here in miniature, with the real
  gaps (a live price table, actual-usage settlement, a real credential
  store) called out explicitly in the spike's README rather than silently
  assumed away.

## Open questions for the owner

See the spike's README for the full list; the ones that matter for this
decision specifically:

1. Is decision-service-level logging of the reservation id (condition 8)
   acceptable, or does the architecture specifically need agentgateway's own
   process to emit it? If the latter, worth a short follow-up into
   agentgateway's native `ai` backend type (which does expose `llm.*` to
   CEL) for the model route only, while MCP traffic stays on a plain HTTP
   backend.
2. Is it acceptable, long-term, that the computer token is verified by
   agentgateway's `jwtAuth` while the turn token is verified independently
   by the decision service? Both are fully signature-checked against the
   same JWKS; only *which process* does the verifying differs per token.
3. The price table used here ($/token) is invented. Should the real decision
   service's budget reservation read from LiteLLM's cost map, reusing the
   mechanism already decided for BYOK/BYOM (plan.md, LiteLLM section)?
