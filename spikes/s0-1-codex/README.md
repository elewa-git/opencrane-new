# Spike S0.1a: Codex app-server as the agent harness (local part)

Can [`@openai/codex`](https://github.com/openai/codex) in **app-server**
mode be the agent that runs inside an OpenCrane "computer"? This is the
**local** half of spike S0.1 (see plan.md's Phase 0 table): everything here
runs as plain local processes on this machine, with a scripted stub model
and a scripted stub MCP server standing in for a real model provider and a
real MCP tool server. There is no Pod, no gVisor, no cluster -- that is
spike S0.1b, later, on a real cluster.

Everything in this folder is throwaway spike code, not production code:
comments favour "here is what we found" over polish.

## How to run it (one command)

```bash
cd spikes/s0-1-codex
npm install   # installs @openai/codex 0.159.2 locally (not global), plus typescript/vitest
npm test
```

This starts and stops everything itself (stub HTTP servers, `codex
app-server` child processes) -- there is nothing to start by hand, and
nothing is left running afterwards. A full run takes about 20 seconds and
needs no network access and no real API key (the stub model/MCP servers
answer every call).

`npm test` runs six test files under `tests/`, one (or a small group) per
pass condition below, against a real, unmodified `codex` binary. Every
claim in the results table is something one of these tests actually
asserted in this session -- see the file name next to each row.

## What is in this folder

```
src/
  bridge.ts             the "computer"'s bridge: spawns `codex app-server`,
                         speaks its newline-delimited JSON-RPC, logs every
                         message to a JSONL file, answers server-initiated
                         requests (approvals, MCP elicitations)
  codex-config.ts        builds an isolated config.toml pointing Codex at
                         our two stub servers
  model-stub-server.ts   a scripted OpenAI **Responses API** server (the
                         only wire_api Codex 0.159.2 supports for a custom
                         model provider): shell call -> MCP call -> final
                         message, or "always answer immediately"
  mcp-stub-server.ts     a hand-rolled streamable-HTTP JSON-RPC MCP server
                         with one tool ("delayed_echo") whose reply can be
                         delayed on demand, for the crash test
tests/
  01-basic-turn.test.ts        pass condition 1
  02-approvals.test.ts         pass condition 2
  03-mcp-protocol.test.ts      pass condition 3
  04-turn-token-headers.test.ts  pass condition 4
  05-subagents.test.ts         pass condition 5
  06-crash-resume.test.ts      pass condition 6
  harness.ts                   shared test scaffolding
.tools/                        gitignored: downloaded reference docs/source
                                 (see "How we learned the wire framing"),
                                 generated protocol TypeScript bindings, and
                                 per-test JSONL logs (`.tools/logs/*.jsonl`)
```

No GitHub-release binaries were needed for this spike (that allowance in
the brief is for things like `nats-server` / `agentgateway` / `openfga`,
none of which S0.1a touches). The only download is the npm package below.

### Downloads

| Package | Version | Source | Size | Licence |
|---|---|---|---|---|
| `@openai/codex` | 0.159.2 | `https://registry.npmjs.org/@openai/codex` (latest non-alpha `dist-tag: latest` at the time of this spike) | 13.2 KB unpacked (JS launcher) | Apache-2.0 |
| `@openai/codex-darwin-arm64` | 0.159.2-darwin-arm64 | pulled automatically as an npm `optionalDependency` of the above, for this machine's platform (darwin/arm64) | 331.5 MB unpacked (the real `codex-rs` binary) | Apache-2.0 |
| `typescript`, `vitest`, `@types/node` | latest at install time | npm registry | ~90 MB combined | Apache-2.0 / MIT |

Total footprint: **≈ 370 MB** (`node_modules` 365 MB + `.tools` reference
material 7 MB), comfortably under the 1.5 GB budget. `df -h /` was checked
before and after the crash test (the only test that idles for several
seconds); free space moved from 10 GiB to 6.2 GiB over the whole spike
session, almost all of it unrelated npm/tooling churn on this machine, not
this folder. Per-test Codex homes (`~30-90 MB` each, mostly SQLite state
files) are deleted at the end of a run rather than committed; only the
small (\<1 MB total) JSONL evidence logs and this README are meant to
outlive the session.

## Results

| # | Pass condition | Verdict | Evidence |
|---|---|---|---|
| 1 | Start a thread and a turn over app-server JSON-RPC; receive streamed agent message events and a turn-completed event. | **PASS** | `tests/01-basic-turn.test.ts`. `thread/start` → `turn/start` → observed, in order: `turn/started`, `item/started`/`item/completed` for a `userMessage` then an `agentMessage` item, `turn/completed` with `turn.status === "completed"` and the final text in `turn.items`. Caveat: this confirms **item-level** streaming (message lifecycle events); our stub model emits its reply as one `response.output_item.done` (no `response.output_text.delta` chunks), so **token-level delta streaming** (`item/agentMessage/delta`) was not exercised -- see Findings. |
| 2 | Approvals: shell command produces a server-initiated approval request under an approval-requiring policy; approving continues, denying is handled cleanly. Do MCP tool calls also produce approval requests? | **PASS**, with a deviation | `tests/02-approvals.test.ts` (3 tests). **Deviation:** `approval_policy = "untrusted"` is refused outright by 0.159.2 ("no longer supported; remove this setting"), and a harmless command like `echo` under `on-request` + `workspace-write` just runs without any prompt -- approval is keyed to whether the *command* asks for escalation, not to the policy name alone. We forced the prompt the way a real model would: the stub's shell call sets `sandbox_permissions: "require_escalated"`. That reliably produced a server request (`item/commandExecution/requestApproval`); replying `{decision: "accept"}` let the turn continue to completion, and replying `{decision: "decline"}` also let the turn reach `turn/completed` cleanly (Codex fed the rejection back to the model as a normal tool result; the bridge did not hang or crash). **MCP tool calls do produce their own approval request**, but via a *different* method, `mcpServer/elicitation/request` (an "MCP elicitation", tagged `_meta.codex_approval_kind: "mcp_tool_call"`), which fired even under plain `on-request` with no escalation flag -- it is evidently the default for any MCP tool call in this build. |
| 3 | MCP: Codex calls the stub MCP tool via a configured streamable-HTTP server pinned to protocol 2026-07-28; the result reaches the model stub. Report the exact headers Codex sends. | **PARTIAL** | `tests/03-mcp-protocol.test.ts` (2 tests). The call happened and the result reached the model stub (its `function_call_output` text contained our stub's `"echo: ping-from-model"`) -- confirmed. **Headers exactly as plan.md hoped for**: `mcp-method: tools/call`, `mcp-name: delayed_echo`, `mcp-protocol-version: 2026-07-28`, plus a rich `_meta` (`callId`, `itemId`, `threadId`, `sessionId`, `windowId`, `x-codex-turn-metadata`). **But** "pinned to 2026-07-28" as a *stateless, session-less* revision (plan.md: "no handshake and no session") is **not** what happens for a regular `mcp_servers.<id>.url` server: Codex still performs a classic MCP `initialize` handshake (JSON-RPC body `protocolVersion: "2025-06-18"`) and then reuses an `Mcp-Session-Id` header on every later request. We re-ran the same test with `features.mcp_2026_07_28 = true` explicitly enabled, and the handshake and session id were both still there -- see Findings for why. |
| 4 | Per-turn header for the turn token, to both the model provider and MCP servers, changing per turn without a restart (else: a local forwarding proxy). | **PASS** (direct mechanism found; no proxy needed) | `tests/04-turn-token-headers.test.ts`. `turn/start.responsesapiClientMetadata` (an arbitrary string map, one per turn) is flattened by Codex into an `x-codex-turn-metadata` JSON blob that it sends **both** as an HTTP header to the model provider on every Responses-API call for that turn, **and** inside `params._meta["x-codex-turn-metadata"]` on every MCP `tools/call` for that turn. We ran two turns on the *same* thread (same running `codex` process, same pid throughout) with two different token values and confirmed both sides saw the right value each time. **Caveat:** this field is gated behind the `experimentalApi` capability opt-in on `initialize`, and is explicitly documented upstream as `[UNSTABLE]` -- see Findings. |
| 5 | Sub-agents: does this Codex version support spawning sub-agents? | **PASS** (evidence found, both from the protocol and from a live run) | `tests/05-subagents.test.ts`, plus direct inspection of the generated protocol types. **Protocol-level:** `Thread.parentThreadId` ("only set if this thread is a subagent"), a `SubAgentSource` enum (`review` \| `compact` \| `thread_spawn` \| `memory_consolidation` \| `other`, the last three others carrying `parent_thread_id`/`depth`/`agent_path`), and a `spawn_agent` tool (gated behind a model's `multi_agent_version` + reasoning effort "ultra" -- **not exercised live**, since our stub model has no real model-catalog entry to declare that support). **Live evidence:** calling `review/start` on a thread produced a genuinely separate `reviewThreadId`, and the model call it triggered carried an `x-openai-subagent: review` header that the root turn's own call did not have. |
| 6 | Crash semantics: kill Codex mid-flight during a delayed MCP call; was the call sent; resume afterwards; what happens to the interrupted call? | **PASS** (for what is testable locally) | `tests/06-crash-resume.test.ts`. The MCP stub (a process independent of Codex) recorded the `tools/call` *before* we sent `SIGKILL` to the `codex` process -- so the call was genuinely sent. Its delayed reply then failed to deliver once the timer fired (`writeFailed: true`, the client socket was already gone) -- this is exactly OpenCrane's own `effect.uncertain` case. We then started a **new** `codex app-server` process against the **same** `CODEX_HOME` and called `thread/resume` with the original thread id: it succeeded, returned the same thread id and its saved rollout, and the interrupted turn's status was `"interrupted"` (a third state, distinct from `"completed"`/`"failed"`). The earlier, already-finished shell-command item was still there in full; **no item at all was recorded for the in-flight MCP call** -- Codex's own history genuinely does not know what happened to it. No automatic retry occurred on resume; a fresh `turn/start` would be needed to continue. |
| 7 | Event inventory: map every observed app-server notification to OpenCrane's catalogue events, noting gaps. | **PASS** (as a deliverable) | See the table below, built from the union of every notification/server-request method actually observed across all six test files' JSONL logs in this session. |

**Overall: 5 PASS, 1 PARTIAL, 0 NOT RUN.** The one PARTIAL (condition 3) is
partial because one half of the stated expectation (stateless,
session-less MCP) is contradicted by what we actually observed, not
because we failed to test it -- see Findings and the ADR for the decision
this implies.

## Event inventory (pass condition 7)

Observed **notifications** (`codex -> client`, no reply expected), unioned
across every test run in this session:

| app-server notification | OpenCrane catalogue event | Notes |
|---|---|---|
| `turn/started` | `agent.turn_started` | Direct match. |
| `turn/completed` | `agent.turn_completed` / `agent.turn_failed` | Direct match for the happy path. There is **no separate "failed" notification**: failure and interruption are both reported as `turn.status` values (`"completed"` \| `"interrupted"` \| others) inside this same message, so the bridge must branch on `turn.status`, not on the method name, to tell `agent.turn_completed` from `agent.turn_failed`. |
| `item/started` + `item/completed` (`item.type: "agentMessage"`) | `agent.message_completed` | Match, at item granularity. Streamed **text deltas** (`item/agentMessage/delta`) exist in the protocol but were not exercised (our stub sends whole messages, not delta chunks) -- gap in this spike's evidence, not in Codex. |
| `item/started` + `item/completed` (`item.type: "commandExecution"`) | `agent.command_ran` | Direct match; carries `command`, `exitCode`, `aggregatedOutput`, `durationMs`. |
| `item/started` + `item/completed` (`item.type: "mcpToolCall"`) | *(no direct catalogue equivalent -- closest is `agent.command_ran`'s sibling for tool calls)* | Worth adding explicitly to the catalogue: this is exactly the "tool-call start/end" OpenCrane's own audit design (plan.md "Conversation stream and audit") asks the bridge to forward. |
| `mcpServer/elicitation/request` (a **server request**, not a notification -- expects a reply) | `tool.approval_requested` (for an MCP tool) | See condition 2: this is the MCP-specific approval path, distinct from shell/file-change approval. |
| `item/commandExecution/requestApproval` (server request) | `tool.approval_requested` (for a shell command) | The v2 method name; the protocol also still defines a legacy `execCommandApproval` we never actually received from this build. |
| *(reply to the server request above)* | `approval.decided` | Not a separate message: it is simply the JSON-RPC **response** the bridge sends back to Codex's request id. OpenCrane's own `approval.decided` event would be emitted by the server *before* the bridge replies, not derived from Codex. |
| `item/fileChange/requestApproval`, `item/fileChange/patchUpdated` (protocol only) | `agent.file_changed` | **Not exercised**: our scripted commands never wrote a file. Present in the generated protocol types but no live evidence from this spike. |
| `item/reasoning/summaryTextDelta`, item type `"reasoning"` (protocol only) | `agent.reasoning_summarised` | **Not exercised**: our stub model never emitted a reasoning block. Present in the protocol (and in the upstream test fixtures we read) but no live evidence from this spike. |
| `mcpServer/startupStatus/updated` | *(no catalogue equivalent)* | Per-thread MCP server lifecycle (`starting`/`ready`/`error`), scoped to one Codex process. OpenCrane's own `mcp.server_registered`/`discovered`/`published` events are silo-wide admin concepts at a different layer; this is closer to a health signal the bridge could fold into `computer.ready`. |
| `thread/started`, `thread/status/changed` | *(no catalogue equivalent; informs `conversation.created`/activity)* | Thread-lifecycle bookkeeping internal to Codex; OpenCrane's own conversation/computer events are the source of truth, this is just Codex's mirror of them. |
| `thread/tokenUsage/updated`, `account/rateLimits/updated` | *(no catalogue equivalent; relevant to budgets/usage)* | Useful raw signal for the decision service's usage/budget settlement, but not itself a catalogue event. |
| `thread/goal/cleared` (and the `get_goal`/`create_goal`/`update_goal` tools Codex exposes to the model by default) | *(no catalogue equivalent -- new concept)* | Codex has its own built-in "goal" tracking feature, unrelated to anything in events.md. The platform will want to either suppress it (`optOutNotificationMethods`, or `disabled_tools`) or deliberately adopt it; left as an open question below. |
| `remoteControl/status/changed` | *(irrelevant to OpenCrane)* | Codex's own desktop remote-control feature; the real bridge should not need to handle this at all. |
| `configWarning`, `warning`, `deprecationNotice`, `serverRequest/resolved` | *(operational signals, not business events)* | Useful for the bridge's own logs; not catalogue events. |
| **Effects** (`effect.observed`/`effect.uncertain`/`effect.resolved`) | — | **By design, Codex never emits these at all.** They are gateway-observed, not computer-reported (plan.md's own two-channel model: "these events are reported by the computer: useful, but not proof"). Our crash test independently confirms why that split is the right call: Codex's own history had **no record whatsoever** of the interrupted MCP call, even though the call genuinely happened -- only something *outside* Codex (our MCP stub, standing in for the gateway) could see that it did. |

## Findings and surprises

- **The protocol is much richer than a plain "thread/turn" JSON-RPC API.**
  This is a "v2"-era app-server (`generate-ts`/`generate-json-schema`
  subcommands exist and dump the whole schema), with dozens of methods
  for projects, sections, skills, plugins, realtime voice, remote control,
  and more. Treat everything under `.tools/protocol/v2/*.ts` (generated
  directly by `codex app-server generate-ts --experimental`, not
  hand-written) as the ground truth over any older documentation.
- **`wire_api = "responses"` is the only supported model-provider wire
  format.** The config reference is explicit about this. There is no Chat
  Completions path to test or fall back to for a custom provider.
- **MCP tool exposure to the model uses a namespaced `function_call`**: a
  server configured as `mcp_servers.spike_mcp` shows up to the model as a
  `"type": "namespace"` tool named `mcp__spike_mcp` containing child tools;
  a call comes back as `{"type":"function_call","namespace":"mcp__spike_mcp","name":"delayed_echo",...}`.
  We only discovered the exact namespace string (`mcp__<server id>`, not
  the server id alone) by reading the model stub's own captured request
  body -- get this wrong and Codex silently answers
  `"unsupported call: ..."` back to the model instead of erroring loudly.
- **`approval_policy = "untrusted"` is a removed/rejected value** in
  0.159.2 (`codex app-server` exits immediately with a clear error). Only
  `"on-request"`, `"never"`, or a `{ granular = {...} }` table are accepted
  now. Whatever wrote the original plan assumed the older three-way
  untrusted/on-request/never model; that has changed upstream.
- **Approval is about the command's requested permissions, not (only) the
  policy.** Under `on-request` + `workspace-write`, a plain `echo` just
  runs -- no prompt at all. The model has to ask for escalation itself
  (`sandbox_permissions: "require_escalated"`) for a prompt to appear. A
  "computer" that wants to force approval on *everything* would need the
  granular table (`sandbox_approval = true` etc.) or a `"read-only"`
  sandbox, not just picking an approval-policy string.
- **MCP tool calls are approved through a completely different mechanism**
  (an "MCP elicitation": `mcpServer/elicitation/request`, distinct from
  `item/commandExecution/requestApproval`) and it fired by default with no
  configuration at all -- worth knowing, since a bridge that only
  implements shell-command approval will silently stall on an MCP tool
  call's implicit approval prompt (ours did, until we added a handler for
  it).
- **The 2026-07-28 MCP revision, as plan.md describes it (no handshake, no
  session), is not what a regular `mcp_servers.<id>.url` entry gets in
  this Codex build** -- see condition 3. The `features.mcp_2026_07_28`
  flag exists (confirmed via `codex features list`, `"under development"`,
  off by default) and the app-server README ties a very similarly-named
  flag (`codex_apps_mcp_2026_07_28`) explicitly to the **host-owned
  "Hosted Codex Apps" connector**, not to arbitrary third-party servers.
  Enabling `mcp_2026_07_28` for our own stub server made no observable
  difference to the handshake or session-id behaviour. The one part of the
  2026-07-28 ask that *is* already true today is the headers
  (`mcp-protocol-version`, `mcp-method`, `mcp-name`) -- Codex sends those
  on every request regardless.
- **The per-turn "turn token" mechanism exists and works well, but is
  explicitly unstable.** `responsesapiClientMetadata` on `turn/start` is
  gated behind `capabilities.experimentalApi = true` at `initialize`, and
  the generated type's own doc comment marks related fields `[UNSTABLE]`.
  This is the right mechanism today, but a real integration should expect
  it to move, and should keep the local-forwarding-proxy fallback design
  on the shelf rather than deleting it.
- **Sub-agents are a first-class, and apparently actively developed,
  concept** (`SubAgentSource`, `Thread.parentThreadId`,
  `x-openai-subagent` headers, a whole `spawn_agent` tool), but the
  "headline" multi-agent path (`spawn_agent`) needs a model the catalog
  marks as multi-agent-capable plus reasoning effort `"ultra"` -- we did
  not attempt to fake that up for a stub model in this spike. `review/start`
  was an easier, still-genuine, sub-agent path to exercise live.
- **Crash resume tells you a status, not an answer.** After a kill and
  resume, Codex reports the interrupted turn as `"interrupted"` and simply
  has no record of the MCP call that was in flight -- it does not guess,
  retry, or mark it failed. This is a clean confirmation of OpenCrane's own
  "computer reports are not proof" design, not a gap in Codex.
- **Every approval/elicitation handler the bridge doesn't implement
  becomes a silent stall**, not an error: our first pass at the model
  stub's script (before we added the `mcpServer/elicitation/request`
  handler) had the MCP call time out and come back to the model as
  `"user rejected MCP tool call"` with no visible error anywhere -- worth
  a defensive default (loudly refuse, rather than silently reject) in the
  real bridge.

## Open questions for the owner

1. **2026-07-28 MCP for third-party servers**: does OpenCrane's "MCP
   2026-07-28 only" decision (README "Key ideas" #5, plan.md) assume a
   Codex capability that does not exist yet for ordinary
   `mcp_servers.<id>.url` entries (only for Codex's own hosted-Apps
   connector)? If the stateless, session-less behaviour is a hard
   requirement for the gateway design, that may need to wait on upstream
   support, or the gateway/decision-service needs to tolerate a
   session-carrying MCP client after all.
2. **Turn-token mechanism stability**: are we comfortable depending on an
   `[UNSTABLE]`/`experimentalApi`-gated field (`responsesapiClientMetadata`)
   for something as central as "on whose behalf" (README "Key ideas" #3,
   plan.md's `ext_authz` turn token)? Should the local-forwarding-proxy
   fallback be built now anyway, as a hedge?
3. **Approval semantics changed from what the plan assumed**: `untrusted`
   is gone, and approval is now keyed to the command's own requested
   permission level, not (only) a policy string. Does the product's
   Allow/Ask/Block per-tool design (plan.md "Installing an MCP server")
   still map cleanly onto `on-request` + granular flags, or does OpenCrane
   need its own layer that always intercepts before Codex decides whether
   to even ask?
4. **Codex's built-in "goal" feature** (`get_goal`/`create_goal`/`update_goal`
   tools, `thread/goal/*`): adopt it, ignore it, or suppress it
   (`disabled_tools`/`optOutNotificationMethods`)? It is on by default and
   currently has no home in events.md.
5. **Sub-agent budgeting**: `spawn_agent` needs a multi-agent-capable model
   catalog entry and reasoning effort "ultra" -- worth a follow-up spike
   once a real model provider is wired up, to see the "delegation"
   concept (plan.md "Computers: delegated children") actually exercised,
   rather than only the `review/start` path this spike used.
6. **S0.1b** (this same harness inside a real GKE Agent Sandbox Pod with
   gVisor): everything here assumes a normal local process; sandbox
   enforcement, network egress through a gateway, and Pod-level kill
   semantics (vs. our plain `SIGKILL`) are all still open.

## How we learned the wire framing

Nothing above was guessed: every wire-format claim came from one of these,
all fetched fresh for this spike (not reused from any earlier
session) and kept, gitignored, under `.tools/`:

- `codex app-server generate-ts --experimental` / `generate-json-schema
  --experimental` -- the actual generated TypeScript bindings for this
  exact installed version (0.159.2), under `.tools/protocol/`.
- The official config docs (`docs/config.md` in the repo redirects to
  `developers.openai.com/codex/config-reference` and `.../config-advanced`
  -- fetched and parsed for every `model_providers.*`/`mcp_servers.*`/
  `approval_policy`/`features.*` key actually used here), under
  `.tools/docs/`.
- `codex-rs/app-server/README.md` from the upstream repo (a running
  changelog of app-server behaviour), under `.tools/docs/app-server-README.md`.
- A handful of the upstream Rust integration tests themselves
  (`codex-rs/core/tests/common/{responses,streaming_sse}.rs`,
  `.../suite/{mcp_turn_metadata,window_headers}.rs`,
  `responses_headers.rs`) -- read only to learn the exact SSE/JSON-RPC
  wire shapes (Apache-2.0; not reproduced here, re-implemented in
  TypeScript against the same shapes), under `.tools/docs/codex-src/`.
- `codex features list` for the real, current feature-flag names and
  default states (e.g. `mcp_2026_07_28`).
- Everything else (the namespace tool-exposure format, the exact approval
  method names this build sends, the crash/resume behaviour) came from
  simply running the real binary and reading what it actually said, logged
  verbatim to `.tools/logs/*.jsonl` by every test run.
