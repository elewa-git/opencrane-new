# ADR 0003: agent harness — Codex app-server (local spike, S0.1a)

**Status:** Draft, from spike S0.1a. Ready for the morning decision, but
**not the full S0.1 decision** — this is only the *local* half (no Pod, no
gVisor, no cluster). S0.1b (this same harness inside a real GKE Agent
Sandbox Pod) is still open; plan.md's start gate needs both.
**Spike evidence:** [`spikes/s0-1-codex/`](../../spikes/s0-1-codex/), all 7
pass conditions run on 2026-09-30 (darwin/arm64, `@openai/codex` 0.159.2,
Node 22.15.0) — 9/9 tests passing across 6 test files, reproducible with
one command (`cd spikes/s0-1-codex && npm install && npm test`).

## Question

Can Codex app-server be **the agent that runs inside an OpenCrane
computer** (README "Key ideas" #2: "the agent (Codex) runs *inside* its
computer"), driven by a thin bridge that turns its JSON-RPC events into
OpenCrane's own event catalogue (plan.md "Conversation stream and
audit")? Decide before the Phase 0 start gate (S0.1, S0.2, S0.7 must all
pass) — with the caveat above that S0.1b still needs to run.

## Options considered

| Option | Licence | Verdict |
|---|---|---|
| **Codex app-server** | Apache-2.0 | **Passes this spike's 7 conditions** (6 PASS, 1 PARTIAL) — see evidence below |
| OpenCode | — | Fallback per plan.md, not spiked |
| Goose | — | Second fallback per plan.md, not spiked |

## Decision

**Codex app-server passes the local half of S0.1**, against the real,
unmodified `@openai/codex` 0.159.2 binary (not mocked), driven by a plain
TypeScript bridge over its newline-delimited JSON-RPC-over-stdio protocol,
against a scripted stub model (OpenAI Responses API wire format) and a
hand-rolled stub MCP server. Full detail, every log line, and the "how we
learned the wire framing" provenance trail are in the spike's README;
condensed here:

| # | Pass condition | Result |
|---|---|---|
| 1 | Thread + turn over JSON-RPC; streamed agent-message events; turn-completed | **PASS** — item-level streaming confirmed; token-level delta streaming not exercised (stub sends whole messages) |
| 2 | Shell approval request; approve continues, deny handled cleanly; do MCP calls approve too? | **PASS**, with a deviation — `approval_policy = "untrusted"` is a removed value in 0.159.2; approval is forced instead the way a real model would (`sandbox_permissions: "require_escalated"`). MCP tool calls approve through a **separate** mechanism (`mcpServer/elicitation/request`), on by default |
| 3 | MCP call via streamable HTTP pinned to 2026-07-28; result reaches the model; exact headers | **PARTIAL** — the call and result both work, and the exact headers plan.md asks for (`mcp-method`, `mcp-name`, `mcp-protocol-version: 2026-07-28`, rich `_meta`) are all present; but the *stateless, session-less* 2026-07-28 behaviour plan.md describes is **not** what a third-party `mcp_servers.<id>.url` server gets — Codex still runs a classic `initialize` handshake and an `Mcp-Session-Id`, even with `features.mcp_2026_07_28 = true` explicitly enabled |
| 4 | Per-turn header to model + MCP, changing per turn, no restart (else: a proxy) | **PASS**, direct mechanism, no proxy needed — `turn/start.responsesapiClientMetadata` reaches both sides as `x-codex-turn-metadata`, confirmed across two turns on one running process. Gated behind `capabilities.experimentalApi = true`; upstream marks it `[UNSTABLE]` |
| 5 | Sub-agent support? | **PASS** — protocol-level (`Thread.parentThreadId`, `SubAgentSource`, `x-openai-subagent` header, a gated `spawn_agent` tool) and live (`review/start` produces a genuine separate thread + header) |
| 6 | Crash semantics: sent-before-kill; resume; what happens to the interrupted call | **PASS** — call confirmed sent (by an independent process) before `SIGKILL`; resume succeeds against the same `CODEX_HOME`, reports the turn `"interrupted"`, and has **no record at all** of the in-flight MCP call — no auto-retry |
| 7 | Event inventory, gaps noted | **PASS** (deliverable) — full table in the spike's README |

### What this proves for the architecture in plan.md

- **"The computer is the actor"** (README "Key ideas" #2) holds up as a
  real, drivable JSON-RPC loop: thread → turn → streamed items → a
  completed turn, all observable and controllable from a thin external
  bridge process, with no need to touch Codex's internals.
- **The two-channel audit model (plan.md "Conversation stream and
  audit") is the right call, confirmed by a negative result**: the crash
  test shows Codex's own reported history genuinely has no idea what
  happened to an interrupted MCP call — only something *outside* Codex
  (standing in for the gateway) could see that the call was actually sent.
  "Computer reports are useful but not proof" is not a defensive
  assumption; it is exactly what we observed.
- **The turn-token mechanism plan.md's IAM section needs (README "Key
  ideas" #3, "the turn token says on whose behalf") already exists and
  works**, end to end, to both the model provider and MCP servers, without
  OpenCrane needing to build a forwarding proxy — but it is an unstable,
  experimental-flagged field today, not a stable public API.
- **MCP 2026-07-28 as README "Key ideas" #5 describes it ("one request,
  one identity, no sessions") is not yet true for ordinary MCP servers in
  this Codex build** — only the headers half is there; the stateless,
  session-less half is seemingly reserved for Codex's own hosted
  connectors right now. This is a real gap between the plan's assumption
  and upstream's current behaviour, not a configuration mistake on our
  side (we tried the matching feature flag explicitly and it made no
  difference).
- **Approval is not simply a policy string any more.** `untrusted` is
  gone; a harmless sandboxed command needs no approval at all under
  `on-request`, and only a command that itself asks for escalation
  surfaces a prompt. Whatever in plan.md assumed the older three-way
  model (untrusted/on-request/never) needs re-reading against this.

## Consequences

- **The bridge must branch on `turn.status`, not on notification method
  name,** to distinguish `agent.turn_completed` from `agent.turn_failed` —
  there is no separate "failed" notification, and a third status,
  `"interrupted"`, exists for the crash/resume case and needs its own
  handling (it is not simply a failure).
- **The bridge needs an elicitation handler for MCP tool calls from day
  one**, separately from the shell/file-change approval handler — it is on
  by default, and a bridge without one will have every MCP tool call stall
  silently (we hit this ourselves on the first pass).
- **Depending on `responsesapiClientMetadata` for the turn token is a
  calculated risk**, not a settled fact: it is `[UNSTABLE]` and
  capability-gated. The forwarding-proxy fallback design should stay on
  the shelf, documented, rather than being dropped as unnecessary.
- **The MCP 2026-07-28 gap is a real open item for decision 5 in
  plan.md's "Responsibility split"** and for ADR 0002's gateway work: if
  the gateway/decision-service design assumed a stateless MCP client on
  the computer side, it needs to instead tolerate (or itself terminate)
  a session-carrying MCP client, at least until upstream Codex extends
  2026-07-28 support to third-party servers.
- **Codex ships several features with no home in events.md yet** (a
  built-in "goal" tool/notification set, token-usage and rate-limit
  notifications, remote-control status) — these need an explicit
  suppress-or-adopt decision before Phase 1's event catalogue is
  considered complete for this harness.

## Open questions for the owner

See the spike's README for the full list; the ones that matter for this
decision specifically:

1. Does the "MCP 2026-07-28 only" decision (README #5) assume a Codex
   capability that does not exist yet for third-party servers? If the
   stateless behaviour is a hard requirement, S0.1b and the gateway design
   (ADR 0002) may need to plan around a session-carrying MCP client for
   longer than expected.
2. Is an `[UNSTABLE]`/`experimentalApi`-gated field an acceptable
   foundation for the turn token — something central to every `ext_authz`
   decision (plan.md "IAM context in every gateway decision")? Or should
   the forwarding-proxy fallback be built now, regardless of this PASS?
3. `spawn_agent` (the "headline" multi-agent path, vs. the `review/start`
   path this spike actually exercised) needs a multi-agent-capable model
   catalog entry and reasoning effort "ultra" — worth a follow-up spike
   once a real model provider is wired up, before relying on it for
   plan.md's "delegated children" design.
4. Approval semantics changed from what the plan assumed (no more
   `untrusted`; escalation is per-command, not per-policy). Does the
   Allow/Ask/Block per-tool design (plan.md "Installing an MCP server")
   still map cleanly onto this, or does OpenCrane need its own
   always-intercept layer in front of Codex's own approval decision?
5. **S0.1b is still required** before the Phase 0 start gate is fully met:
   this spike used plain local processes; Pod-level kill semantics,
   gVisor sandboxing, and gateway-enforced egress are all untested here.
