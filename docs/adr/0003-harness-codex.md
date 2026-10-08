# ADR 0003: agent harness — Codex app-server (S0.1a and S0.1b)

**Status:** Draft. S0.1a local evidence and S0.1b's four scoped computer
proofs pass; this is **not the full S0.1 start-gate decision**. S0.1b ran on
k3d under gVisor on 1 October 2026; the real-model check, Pod approval/sub-agent
journeys and the MCP compatibility gap remain explicit below.
**Spike evidence:** [`spikes/s0-1-codex/`](../../spikes/s0-1-codex/), all 7
pass conditions re-run on 2026-09-30 (darwin/arm64, `@openai/codex`
0.159.2, Node 22.15.0) — 8 test files, 16 tests passing, verified 3+ clean
runs in a row from a clean state, reproducible with one command (`cd
spikes/s0-1-codex && npm install && npm test`).

**Round 2 note:** an independent verifier re-ran round 1's tests from a
clean copy and found real problems: a crash test that killed the wrong
process (the JS launcher, not the native binary — SIGKILL is uncatchable
and only ever hits the exact pid it's sent to), a bridge bug that could
shuffle the audit log, two refuted claims (the MCP headers, and
`review/start`'s "separate thread"), and an unbuilt design piece (the local
forwarding proxy). Every one of those is fixed in this round — see "What
changed" below. This ADR states only what round 2's tests actually proved;
round 1's now-refuted claims are not repeated as fact anywhere below.

## Question

Can Codex app-server be **the agent that runs inside an OpenCrane
computer** (README "Key ideas" #2: "the agent (Codex) runs *inside* its
computer"), driven by a thin bridge that turns its JSON-RPC events into
OpenCrane's own event catalogue (plan.md "Conversation stream and
audit")? Decide before the Phase 0 start gate (S0.1, S0.2, S0.7 must all
pass) — with the remaining qualification limits above.

## Options considered

| Option | Licence | Verdict |
| --- | --- | --- |
| **Codex app-server** | Apache-2.0 (binary bundles OSI-approved LGPL-2.1/MIT/BSD components too — see the spike README's licence note) | **Passes this spike's 7 conditions** (6 PASS, 1 PARTIAL) — see evidence below |
| OpenCode | — | Fallback per plan.md, not spiked |
| Goose | — | Second fallback per plan.md, not spiked |

## Decision

**Codex app-server passes the local half of S0.1**, against the real,
unmodified `@openai/codex` 0.159.2 binary (not mocked), driven by a plain
TypeScript bridge over its newline-delimited JSON-RPC-over-stdio protocol,
against a scripted stub model (OpenAI Responses API wire format) and a
hand-rolled stub MCP server. Full detail, every log line, and the "how we
learned the wire framing" source trail are in the spike's README;
condensed here:

| # | Pass condition | Result |
| --- | --- | --- |
| 1 | Thread + turn over JSON-RPC; streamed agent-message events; turn-completed | **PASS** — item-level streaming confirmed; token-level delta streaming (`item/agentMessage/delta`) is now genuinely exercised (round 2: 40 chunks per run, asserted in exact arrival order — needed the bridge ordering fix, below) |
| 2 | Shell approval request; approve continues, deny handled cleanly; do MCP calls approve too? | **PASS**, with a deviation — `approval_policy = "untrusted"` is a removed value in 0.159.2; approval is forced instead the way a real model would (`sandbox_permissions: "require_escalated"`). MCP tool calls approve through a **separate** mechanism (`mcpServer/elicitation/request`), on by default |
| 3 | MCP call via streamable HTTP pinned to 2026-07-28; result reaches the model; exact headers | **PARTIAL** — the call and result both work. The method/tool-name headers are **conditional**, not "sent regardless" (round 1's claim, now refuted): they appear only when the server's `initialize` answer is exactly `2026-07-28`, and Codex does not validate that answer at all (accepts `"1999-01-01"` without complaint). A genuinely STRICT server (2026-07-28 only, built and run this round) **cannot complete a handshake with Codex 0.159.x at all** — proven, not assumed. The per-server `protocol_version` config key the task brief named does not exist in this Codex version (`--strict-config` rejects it by name) |
| 4 | Per-turn header to model + MCP, changing per turn, no restart (else: a proxy) | **PASS** — built the proxy. `src/local-proxy.ts` is now real code: Codex's model provider and MCP server both point at 127.0.0.1 proxy ports; the bridge sets the turn token on both at `startTurn`; every proxied request gets the computer token and the current turn token as real HTTP headers, with zero leakage across two turns on one running process, and no Codex cooperation needed at all (unlike round 1's `[UNSTABLE]`/`experimentalApi`-gated field, now superseded). Also proves key custody: Codex's shell can read its own (placeholder) key and it lands in a real shell-snapshot file — but never anything else, because nothing else was ever given to it |
| 5 | Sub-agent support? | **PASS**, corrected and extended — round 1's claim that `review/start` "produced a genuinely separate reviewThreadId" is **refuted**: for the default (inline) delivery, it equals the root thread id, exactly as the generated protocol type's own doc comment says it should. `delivery: "detached"` needs a `historyMode: "legacy"` thread and gets no subagent tag. But `spawn_agent` — the actual delegation tool "Computers: delegated children" needs — **works live**, with the plain stub model, no multi-agent-capable model-catalog entry required: a genuine child thread, correct `parentThreadId`, its own `x-openai-subagent: collab_spawn` tag |
| 6 | Crash semantics: sent-before-kill; resume; what happens to the interrupted call | **PASS**, now a genuine hard kill — `SIGKILL` goes to the real `codex-rs` binary directly (round 1 killed only the JS launcher, which the native process survives — proven by directly observing the orphaned process outlive it). The rollout records the MCP call's *intent* before it's sent (read and asserted, before the kill); after a genuine hard kill, no `function_call_output` for it ever appears (asserted, not just expected); resume reports the turn `"interrupted"`, the shell item intact, no item at all for the MCP call, no automatic retry — all hard-asserted now, not merely logged |
| 7 | Event inventory, gaps noted | **PASS** (deliverable) — updated table in the spike's README, adding `item/agentMessage/delta` (now observed) and the `collabAgentToolCall` item type (from `spawn_agent`), mapped to events.md's `delegation.started`/`delegation.completed` pair |

### What this proves for the architecture in plan.md

- **"The computer is the actor"** (README "Key ideas" #2) holds up as a
  real, drivable JSON-RPC loop: thread → turn → streamed items → a
  completed turn, all observable and controllable from a thin external
  bridge process, with no need to touch Codex's internals.
- **The two-channel audit model (plan.md "Conversation stream and
  audit") is the right call, confirmed by a negative result, and refined
  this round**: the crash test shows Codex's own rollout records a call's
  *intent* (the function_call, with its arguments, before it's even sent)
  but never its *effect* — a genuine hard kill proves this cleanly, with
  no synthetic "aborted" result left behind to muddy it (round 1's
  launcher-only kill did leave one, which is exactly why it was a false
  signal). "Computer reports intent, gateway observes effect" is the
  precise split, not "Codex records nothing".
- **The local forwarding proxy from plan.md's computer design is now
  real, working code, not a hedge on the shelf.** It supplies the turn
  token to both the model provider and MCP servers as a genuine HTTP
  header, needs no Codex cooperation or capability flags, and is the
  answer to "on whose behalf" (README "Key ideas" #3) that the
  `[UNSTABLE]`-gated native field only partially was.
- **MCP 2026-07-28 as README "Key ideas" #5 describes it ("one request,
  one identity, no sessions") is confirmed broken for ordinary MCP
  servers in this Codex build — not merely unconfirmed.** A server that
  actually enforces it (built and run this round) cannot complete a
  handshake with Codex 0.159.x at all. This is a real gap between the
  plan's assumption and upstream's current behaviour, settled by direct
  experiment, not a configuration mistake on our side.
- **Approval is not simply a policy string any more.** `untrusted` is
  gone; a harmless sandboxed command needs no approval at all under
  `on-request`, and only a command that itself asks for escalation
  surfaces a prompt. Unchanged from round 1.
- **Sub-agent delegation works today, with the `v1` mechanism, and needs
  none of the machinery round 1 assumed it would.** `spawn_agent` is
  available to any model configuration by default (the `multi_agent`
  feature is stable and on by default); it does not need a
  multi-agent-capable model-catalog entry or reasoning effort `"ultra"` —
  those apply to the separate, currently-disabled `multi_agent_v2`
  ("collaboration") system, not the `v1` path plan.md's delegation design
  actually needs.

## Consequences

- **The bridge must branch on `turn.status`, not on notification method
  name,** to distinguish `agent.turn_completed` from `agent.turn_failed` —
  there is no separate "failed" notification, and a third status,
  `"interrupted"`, exists for the crash/resume case and needs its own
  handling (it is not simply a failure). **Still no catalogue event for
  `"interrupted"`** — open gap, unchanged from round 1.
- **The bridge needs an elicitation handler for MCP tool calls from day
  one**, separately from the shell/file-change approval handler — it is on
  by default, and a bridge without one will have every MCP tool call stall
  silently.
- **The bridge must serialise its own incoming-message handling.** Found
  this round: a bridge that dispatches `readline` "line" events
  fire-and-forget, with an `await` inside the handler before it logs or
  dispatches, can deliver notifications (and log them) out of the order
  Codex actually sent them — reproduced 3/3 times with a stream of 40
  delta chunks, fixed by chaining each line's handling onto the previous
  one's completion. This matters directly for the real audit stream this
  bridge pattern is meant to become: an out-of-order delta stream, or an
  out-of-order audit log, is a real correctness bug, not a cosmetic one.
- **Build the local forwarding proxy now, not as a hedge.** It is real,
  working code this round, needs no Codex-side capability flags, and
  covers both the model provider and every MCP server uniformly. The
  `responsesapiClientMetadata` field round 1 found is superseded by this
  and should not be relied on for anything the proxy already covers.
- **The MCP 2026-07-28 gap is a confirmed blocker, not an open question,
  for decision 5 in plan.md's "Responsibility split"** and for ADR 0002's
  gateway work: the gateway/decision-service design must tolerate (or
  itself terminate) a session-carrying, `2025-06-18`-proposing MCP client
  from Codex, because there is no known way to make Codex 0.159.x speak
  pure stateless 2026-07-28 to an ordinary third-party MCP server.
- **`spawn_agent` is ready to build the delegation design around now.**
  Plan.md's "Computers: delegated children" can target the `v1`
  mechanism directly; the `v2`/"collaboration" system (still disabled by
  default) is the one that may need a real model-catalog entry, and is a
  separate, later question.
- **Codex ships several features with no home in events.md yet** (a
  built-in "goal" tool/notification set, token-usage and rate-limit
  notifications, remote-control status) — unchanged from round 1, still
  needs an explicit suppress-or-adopt decision.
- **Network egress to chatgpt.com/github.com is neither confirmed nor
  ruled out.** This round's own logs show no evidence of it (the only
  `github.com` hits are the workspace's own git remote URL, echoed back
  in thread metadata, not a network call), but this bridge only ever sees
  Codex's JSON-RPC stdout, never its raw outbound traffic — settling this
  needs actual network-level instrumentation, which is squarely S0.1b's
  "gateway-enforced egress" territory.

## Later check — 7 October 2026

The packaged Codex 0.159.2 does use stateless MCP discovery when
`mcp_2026_07_28` is enabled. It sends POST `server/discover` and `tools/list`
with version `2026-07-28`, without `initialize` or a session header.
This corrects the earlier blocker above for that packaged version.

A separate blocker was measured: `thread/resume` accepts new MCP server config
but keeps the old tools when the thread is still loaded. After restarting Codex,
the same saved thread receives the new tools. The later reload check below shows
how to apply a new list without restarting Codex. The [computer check record](../../apps/computer/README.robot.md#governed-tools--7-october-2026)
links the offline probe and saved capture. No paid model was called.

## Open questions for the owner

See the spike's README for the full list; the ones that matter for this
decision specifically:

1. **MCP 2026-07-28 is a confirmed blocker for third-party servers on
   this Codex version** (not an open question about whether it's true —
   it is confirmed true this round). Does the gateway design (ADR 0002)
   need to plan around tolerating a `2025-06-18` + session-carrying MCP
   client indefinitely, or is this a hard prerequisite on an upstream
   Codex release before the full MCP journey can proceed? S0.1b qualifies
   the model path independently of this MCP gap.
2. **The local forwarding proxy now works end-to-end — should it become
   the ONLY turn-token mechanism**, with `responsesapiClientMetadata`
   dropped from the design entirely rather than kept as a redundant,
   less-capable alternative?
3. `spawn_agent` (the `v1` delegation path) works today with no
   model-catalog gating. Safe to build plan.md's "delegated children"
   design around it now? The `v2`/"collaboration" system is the one that
   may still need a real model provider — worth a follow-up once one is
   wired up, but it no longer blocks the `v1` decision.
4. Approval semantics changed from what the plan assumed (no more
   `untrusted`; escalation is per-command, not per-policy). Does the
   Allow/Ask/Block per-tool design (plan.md "Installing an MCP server")
   still map cleanly onto this, or does OpenCrane need its own
   always-intercept layer in front of Codex's own approval decision?
5. **Full S0.1 qualification remains open.** The scoped S0.1b evidence below
   closes the model/proxy/user-isolation/Pod-kill questions. Approval pause and
   resume, sub-agents and session-volume recovery were not rerun in this Pod.

## S0.1b computer proof — 1 October 2026

**Decision:** retain Codex app-server, using its native exec-server environment
for tool execution under a separate Unix user. Keep the local model forwarding
proxy and per-thread tokens. [S0.1b](../../spikes/s0-1b-proxy-gvisor/README.robot.md)
contains the runnable proof and [receipt](../../spikes/s0-1b-proxy-gvisor/evidence.json).

The real Agent Sandbox 1.0.4 Pod used RuntimeClass `gvisor`; CRI inspection
confirmed `io.containerd.runsc.v1`. Codex 0.159.2 ran as UID 1000; its actual
model-requested shell ran as UID 1001. A supervisor applies a seccomp filter
and `no_new_privs` before starting exec-server over stdio. The filter and UID
boundary survive arbitrary shell selection and descendants. A private 0600
Unix socket carries executor control; local model HTTP requires a random,
short-lived caller capability readable only by the Codex user. There is no
provider key in the computer. Codex's own approvals are not this boundary.

| S0.1b question | Live result |
| --- | --- |
| Stream through proxy and agentgateway | **PASS**: overlapping threads, token deltas, completed turns and recorded provider requests. |
| Caller and tool isolation | **PASS**: unauthenticated proxy request 401; model-requested shell UID 1001 cannot become Codex, read its files/process environment, or connect to proxy, control sockets, gateway or model. |
| Per-thread expiring tokens | **PASS**: distinct tokens, cross-thread/expired/forged/revoked token 403s at agentgateway's ext_authz; no denied call reaches the provider; proxy drops completed turns. |
| Pod killed mid-stream | **PASS**: external provider receipt and gateway log survive original Pod deletion. Sent is known; completion/usage is not. |

k3s NetworkPolicy was positively tested by removing and restoring the policy:
model access succeeds only while absent. It limits computer egress to the
gateway. Because Pod policy cannot distinguish local processes, an inherited
seccomp filter separately denies every tool socket, including loopback and
IPv6. This replaces S0.1a's unqualified egress uncertainty for this tested setup.

Alternatives: same-user Unix sockets do not separate Codex from its shell;
a configurable shell wrapper can be bypassed by another executable. A separate
tool Pod would allow separate Pod policy but changes the single-computer shape.
The chosen native executor seam keeps both users inside the gVisor computer
without patching Codex or relying on a prompt-level restriction.

Costs and limits: exec-server is experimental and pinned; the supervisor is
trusted. Commands and file tools launched through the native exec-server run as
a separate user under a seccomp filter with no networking. Codex itself runs as
UID 1000 and can reach the proxy and gateway. Same-UID local MCP servers,
Playwright or browser helpers, and package helpers are not allowed in the
computer until they have a separate identity and an authenticated egress route
through agentgateway. The opaque test issuer is in-memory, not production IAM
or event authority. A paid provider, MCP, approval pause/resume, sub-agent
token inheritance and session-volume recovery are **NOT RUN** here. The README
leaves a one-command owner-run real-model check. Missing external receipts still
mean an ambiguous outcome, never proof that retry is safe. Production
settlement must use durable external observations; an HTTP 200 for an
interrupted SSE stream is not completion.

## Implications for Phase 2

`npm install` currently fails: npm is deliberately removed, and an
executor-launched replacement cannot perform DNS or connect. Network `git
clone` fails: git is absent from the image, and adding it alone would not
overcome seccomp. Playwright web browsing fails through the executor because
Chromium cannot create network sockets. Local MCP servers stay outside the
computer, as the existing `<silo>-mcp` design proposes. The route out needs an
authenticated egress broker through agentgateway, with destination allowlists,
SSRF controls and DNS controls. Access needs either a pre-opened or brokered
channel, or a separately confined process allowed to connect only to the
gateway.

## 7 October 2026: reload one conversation's tools

The packaged Codex 0.159.2 does speak stateless 2026-07-28 when
`mcp_2026_07_28 = true`. The offline computer image check now asserts discovery,
list and call headers against the real proxy. This corrects the earlier strict
handshake blocker for this flag and package; it does not qualify other versions.

A loaded resume ignores changed MCP config. With `thread_unload_delay_secs = 0`,
unsubscribe closes only that thread and loaded-list confirms its removal. Resume
then keeps its id and history and replaces its tools. Another busy thread finishes
normally. Two threads using the same server key use separate load URLs. Unloading
also stops earlier background terminals for that conversation. The owner authorised
reload-on-change and failing the turn when unload cannot be confirmed. Codex is
never restarted for a tool-list change. The computer README.robot.md records R1–R8
and links the saved capture. The image build repeats the relied-on checks offline.
