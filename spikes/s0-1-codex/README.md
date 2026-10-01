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

**This is round 2.** An independent verifier re-ran round 1's tests from a
clean copy and found real problems: a crash test that killed the wrong
process, a bridge bug that could shuffle the audit log, two refuted claims
(the MCP headers, and `review/start`'s "separate thread"), and an unbuilt
design piece (the local forwarding proxy). Every one of those is fixed here,
with new or rewritten tests -- see "What changed from round 1" below for the
complete list, mapped to what was actually done about each.

## How to run it (one command)

```bash
cd spikes/s0-1-codex
npm install   # installs @openai/codex 0.159.2 locally (not global), plus typescript/vitest
npm test
```

This starts and stops everything itself (stub HTTP servers, local
forwarding proxies, `codex app-server` child processes) -- there is nothing
to start by hand, and nothing is left running afterwards (checked with
`ps aux` after every run in this session). A full run takes about 25-60
seconds (dominated by the crash test's built-in delays) and needs no
network access and no real API key (the stub model/MCP servers answer every
call). Always run it via `npm test`, not a bare `vitest run`: the script
pins `--test-timeout=60000`, and some tests (the crash test, a few of the
subagent ones) legitimately need more than vitest's 5-second default.

`npm test` runs eight test files under `tests/`, covering the seven pass
conditions plus one bridge-correctness regression test found while fixing
condition 6. Every claim in the results table below is something one of
these tests actually asserted in this session.

## What is in this folder

```
src/
  bridge.ts             the "computer"'s bridge: spawns `codex app-server`,
                         speaks its newline-delimited JSON-RPC, logs every
                         message to a JSONL file (in strict arrival order --
                         see "What changed"), answers server-initiated
                         requests (approvals, MCP elicitations), and can
                         drive local forwarding proxies' turn tokens
  local-proxy.ts         NEW this round: the local forwarding proxy from
                         plan.md's computer design. Codex talks only to
                         127.0.0.1; this sits there, adds the computer and
                         turn tokens as real HTTP headers, and forwards
                         everything else unchanged to the stub "gateway"
  codex-config.ts        builds an isolated config.toml pointing Codex at
                         our stub servers (directly, or via the proxies)
  model-stub-server.ts   a scripted OpenAI **Responses API** server (the
                         only wire_api Codex 0.159.2 supports for a custom
                         model provider): shell call -> MCP call -> final
                         message, a genuinely streamed (token-delta) reply,
                         or a `spawn_agent` call -- selectable per test
  mcp-stub-server.ts     a hand-rolled streamable-HTTP JSON-RPC MCP server
                         with one tool ("delayed_echo") whose reply can be
                         delayed on demand (for the crash test), and a
                         STRICT mode that only accepts protocol 2026-07-28
tests/
  01-basic-turn.test.ts        pass condition 1
  02-approvals.test.ts         pass condition 2
  03-mcp-protocol.test.ts      pass condition 3 (5 tests, see Findings)
  04-turn-token-headers.test.ts  pass condition 4: local forwarding proxy
                                 + credential custody (2 tests)
  05-subagents.test.ts         pass condition 5 (3 tests: inline review,
                                detached review, spawn_agent)
  06-crash-resume.test.ts      pass condition 6, now with a real hard kill
  07-bridge-ordering.test.ts   NEW: the bridge event-ordering bug, with a
                                regression test (many streamed deltas)
  harness.ts                   shared test scaffolding, incl. resolving the
                                real codex-rs binary and the proxy wiring
.tools/                        gitignored: downloaded reference docs/source
                                 (see "How we learned the wire framing"),
                                 generated protocol TypeScript bindings, and
                                 per-run JSONL logs (`.tools/logs/*.jsonl`).
                                 Per-test Codex homes (`.tools/home/<id>`)
                                 are deleted at the end of every test (see
                                 "What changed" -- this was a round-1 gap).
```

No GitHub-release binaries were needed for this spike (that allowance in
the brief is for things like `nats-server` / `agentgateway` / `openfga`,
none of which S0.1a touches). The only download is the npm package below.

### Downloads

| Package | Version | Source | Size | Licence |
|---|---|---|---|---|
| `@openai/codex` | 0.159.2 | `https://registry.npmjs.org/@openai/codex` (latest non-alpha `dist-tag: latest` at the time of this spike) | 13.2 KB unpacked (JS launcher) | Apache-2.0 |
| `@openai/codex-darwin-arm64` | 0.159.2-darwin-arm64 | pulled automatically as an npm `optionalDependency` of the above, for this machine's platform (darwin/arm64) | 331.5 MB unpacked (the real `codex-rs` binary) | Apache-2.0 for the binary itself, but see the licence note below |
| `typescript`, `vitest`, `@types/node` | latest at install time | npm registry | ~90 MB combined | Apache-2.0 / MIT |

**Licence note (round-1 gap, closed):** the `@openai/codex-darwin-arm64`
tarball bundles more than the `codex-rs` binary -- `rg` (ripgrep, MIT), a
`zsh` binary, a `codex-code-mode-host` helper, and a voice runtime built on
GStreamer/GLib (LGPL-2.1) plus libffi, PCRE2, Opus and zlib (all
OSI-approved; their own licence files ship alongside them under
`codex-resources/voice/licenses/`). All of it is OSI-approved, so nothing
here is excluded, but "the download's licence is Apache-2.0" undersold it:
if this package is ever baked into a container image (S0.1b), the bundled
LGPL-2.1 components carry their own notice/replaceability obligations that
a pure "Apache-2.0" label would miss. The npm tarballs themselves contain
no top-level `LICENSE` file (only the nested `codex-resources/voice/licenses/`
ones), which is itself worth flagging to the owner if this becomes a real
dependency.

**npm audit (unchanged from round 1, left open deliberately):** 5 findings
(1 critical, in `vitest` itself, plus `vite`/`esbuild`/`vite-node`/
`@vitest/mocker`), all fixable only by a `vitest` **major** bump
(2.1.9 -> 5.0.3). All are in `vitest`'s own dev/UI-server tooling, never
reachable from a headless `vitest run` (what `npm test` does), and a major
bump of the test runner is a real risk to re-verify blind this late in a
fix round -- left as a follow-up rather than attempted here. Flagged, not
silently dropped.

Total footprint: **≈ 372 MB** (`node_modules` 365 MB + `.tools` reference
material ~7 MB), comfortably under the 1 GB budget for this item. Per-test
Codex homes are genuinely deleted after every test now (`.tools/home` is
empty at the end of every run -- `du -sh .tools/home` checked after this
session's runs), closing round 1's gap where they were claimed-deleted but
weren't.

## Results

| # | Pass condition | Verdict | Evidence |
|---|---|---|---|
| 1 | Start a thread and a turn over app-server JSON-RPC; receive streamed agent message events and a turn-completed event. | **PASS** | `tests/01-basic-turn.test.ts` for the thread/turn lifecycle. `tests/07-bridge-ordering.test.ts` closes round 1's caveat: token-level streaming (`item/agentMessage/delta`) is now genuinely exercised (40 delta chunks per run), and asserted to arrive, both at the in-process handler and in the JSONL log, in exactly the order Codex sent them -- which needed the bridge fix below. |
| 2 | Approvals: shell command produces a server-initiated approval request under an approval-requiring policy; approving continues; denying handled cleanly; do MCP tool calls also approve? | **PASS**, with a deviation | `tests/02-approvals.test.ts`, 3/3 passing, unchanged from round 1 (the verifier confirmed it and only noted a minor strengthening opportunity -- not attempted this round to stay focused on the six required fixes). `approval_policy='untrusted'` is rejected outright by Codex 0.159.2; forced the prompt via `sandbox_permissions:'require_escalated'` instead. MCP tool calls approve via a separate mechanism, `mcpServer/elicitation/request`. |
| 3 | MCP: Codex calls the stub MCP tool via a configured streamable-HTTP server pinned to 2026-07-28; result reaches the model stub; exact headers. | **PARTIAL**, investigated properly this round | `tests/03-mcp-protocol.test.ts`, 5/5 passing. See "MCP 2026-07-28: investigated properly" below -- the per-server `protocol_version` config key the task brief assumed does not exist in 0.159.2 (proven: `--strict-config` rejects it by name); the method/tool-name headers are conditional on the server's answer, not sent "regardless" as round 1 claimed; and a genuinely STRICT server (2026-07-28 only) can never complete a handshake with this Codex build, though the turn still degrades gracefully. |
| 4 | Turn token and key custody: local forwarding proxy; Codex holds no real provider key; per-turn tokens switch without restart and never leak. | **PASS**, proxy built and proven | `tests/04-turn-token-headers.test.ts`, 2/2 passing. The local forwarding proxy (`src/local-proxy.ts`) is now real code, not just a design note: Codex's model provider and MCP server both point at 127.0.0.1 proxy ports; the bridge sets the turn token on both proxies at `startTurn`; every proxied request carries the computer token and the current turn token as real HTTP headers, on both sides, with zero leakage across turns, and no Codex restart needed. Separately: Codex's own env is provably readable by its shell (asserted, not assumed), and CODEX_HOME -- including a real shell-snapshot file this session found and inspected -- never contains anything but the harmless placeholder key, because nothing else was ever given to it. |
| 5 | Sub-agents: does this Codex version support spawning sub-agents? | **PASS**, corrected and extended | `tests/05-subagents.test.ts`, 3/3 passing. The round-1 claim that `review/start` "produced a genuinely separate reviewThreadId" is **refuted** and corrected: for the default (inline) delivery, `reviewThreadId` **is** the root thread id (confirmed against the generated protocol type's own doc comment). `delivery: "detached"` is rejected outright on a normal thread, and only works on a `historyMode: "legacy"` one, without a subagent header. But `spawn_agent` -- the actual delegation tool from plan.md's "Computers: delegated children" -- **does** work, live, with the plain stub model, needing no multi-agent-capable model-catalog entry at all: it creates a genuine child thread (`parentThreadId` correctly set) and its own `x-openai-subagent: collab_spawn`-tagged model call. This corrects round 1's "not exercised, needs a real model" caveat -- it turns out that caveat was unnecessary for the `multi_agent_v1` path. |
| 6 | Crash semantics: kill codex mid-flight during a delayed MCP call; determine from logs/session files whether the call was sent; restart and check resume + what happens to the interrupted call. | **PASS**, now a genuine crash test | `tests/06-crash-resume.test.ts`, passing (~20-25s), 3/3 clean runs checked this session. Fixed the verifier's central finding: `SIGKILL` now goes to the real `codex-rs` binary directly (`NATIVE_CODEX_BIN` in `harness.ts`), not the JS launcher -- see "What changed" for why the launcher-only kill wasn't a real crash. The rollout file is read **before** the kill and asserted to contain the MCP `function_call` intent (an "intent recorded" signal, distinct from proof the effect happened); asserted **after** the kill that no `function_call_output` for that call gets added (a true hard kill leaves nothing alive to write one); and the resume half is now hard-asserted, not just logged: `turn.status === "interrupted"`, the completed shell item survives, no item exists for the MCP call, and no `turn/started` fires on its own. |
| 7 | Event inventory: map every observed app-server notification to the OpenCrane catalogue events, noting gaps. | **PASS** (as a deliverable) | See the table below, updated this round with `item/agentMessage/delta` (now observed, not just theorised) and the `collabAgentToolCall` item type (spawn_agent), mapped to `delegation.started`/`delegation.completed` in events.md's "Routines and delegation" section -- not present in round 1's table at all. |

**Overall: 6 PASS, 1 PARTIAL, 0 NOT RUN.** The one PARTIAL (condition 3) is
partial for the same underlying reason as round 1 -- pure stateless
2026-07-28 is not yet true for an ordinary `mcp_servers.<id>.url` server in
this Codex build -- but this round replaces an assumption with a directly
reproduced negative result (a STRICT stub server, run against real Codex,
genuinely cannot complete its handshake).

## What changed from round 1 (every verifier issue, and what was done)

1. **Crash test didn't crash anything.** `bridge.kill('SIGKILL')` was
   killing `node_modules/.bin/codex`, the JS launcher, not the native
   `codex-rs` process it spawns. SIGKILL is uncatchable, so it only ever
   kills the exact pid it's sent to; the launcher's own signal-forwarding
   code never runs, and the native process -- which independently holds its
   own duplicated copies of the launcher's stdio pipes (`stdio: "inherit"`)
   -- survives and keeps running. Proved this directly: killing only the
   launcher left an orphaned native process that went on to write a
   synthetic `"aborted by user after 0.1s"` result and shut down gracefully
   a few hundred ms later, which is exactly the behaviour the verifier
   found. **Fix:** `harness.ts` now resolves and spawns the real
   `codex-rs` binary directly for this test (`NATIVE_CODEX_BIN`), so
   `bridge.pid` is the actual process SIGKILL hits.
2. **"No record at all" was false.** The rollout session file records the
   MCP `function_call` -- its arguments, its call id -- **before** the
   call is even sent over HTTP. **Fix:** the crash test now reads the
   rollout file itself, before the kill, and asserts the intent record is
   there; the README/ADR now call this an "intent recorded" signal,
   distinct from proof the call's effect happened (which only the gateway,
   standing outside Codex, can ever know).
3. **The resume half was only logged, never asserted.** A conditional
   `if (resumeError === undefined)` meant the test could "pass" whether or
   not resume actually worked. **Fix:** `turn.status === "interrupted"`,
   the missing MCP item, the surviving shell item, and the absence of an
   automatic `turn/started` are all hard `expect()`s now.
4. **The bridge could shuffle its own event order.** `handleIncoming` was
   called fire-and-forget (`void this.handleIncoming(...)`) per `readline`
   line, and internally `await`s an `appendFile` before dispatching to
   handlers -- so several lines arriving close together could have their
   `appendFile` calls finish in a different order than they arrived in,
   and notifications (and the JSONL log) could reach handlers out of
   order. Reproduced 3/3 times with a stub that streams 40 delta chunks.
   **Fix:** `bridge.ts` now chains every incoming line onto a single
   promise (`incomingChain`), so the next line's handling only starts once
   the previous one has fully finished -- with a `.catch()` so one bad
   message can't silently stall the whole queue forever. New regression
   test: `tests/07-bridge-ordering.test.ts`. Verified the fix actually
   matters by reverting it and watching the test fail with a visibly
   shuffled sequence, then restoring it and running 3/3 clean.
5. **The MCP header claims were half right, half refuted.** "Codex sends
   `mcp-method`/`mcp-name` on every request regardless" is false: they only
   appear when the server's `initialize` answer is exactly `2026-07-28`;
   answer anything else and those headers vanish, while
   `mcp-protocol-version` just echoes back whatever the server said,
   unvalidated (proved by making the stub answer `"1999-01-01"` -- Codex
   accepted it without complaint). **Fix:** `mcp-stub-server.ts` gained a
   `respondProtocolVersion` override and a `strict` mode; `tests/03-mcp-
   protocol.test.ts` now asserts both the "garbage version" case and a
   genuinely STRICT server's actual failure mode (see below), plus a
   dedicated test proving the task brief's `protocol_version` config key
   doesn't exist in this Codex version.
6. **`review/start`'s "genuinely separate reviewThreadId" claim was
   refuted.** For the default (inline) delivery, `reviewThreadId` equals
   the root thread id -- this is what the generated protocol type's own
   doc comment says it should do, not a bug. **Fix:** `tests/05-subagents
   .test.ts` now asserts this directly, tests the `detached` delivery path
   properly (rejected on a normal thread; works, un-tagged, on a
   `historyMode: "legacy"` one), and -- going further than just correcting
   the claim -- actually exercises `spawn_agent`, which the first round
   assumed was untestable without a real model-catalog entry. It isn't:
   see condition 5 above.
7. **The turn token never reached MCP as a header, and depends on an
   `[UNSTABLE]` field.** `responsesapiClientMetadata` is gated behind
   `experimentalApi`, and on the MCP side it only ever lands in the
   JSON-RPC body's `_meta`, never a header a gateway's `ext_authz` could
   read directly. **Fix:** built the local forwarding proxy design from
   plan.md as real code (`src/local-proxy.ts`), which needs no cooperation
   from Codex at all -- it works because Codex has nowhere else to send
   anything, to either upstream. `tests/04-turn-token-headers.test.ts`
   proves per-turn header switching (no restart, no leakage) through the
   proxy, and a whole separate test proves the credential-custody half:
   Codex's shell can read its own (dummy) key, and CODEX_HOME -- including
   a real shell-snapshot file -- never contains a real one.
8. **Security: the model key was readable by the agent's own shell, and
   written to shell snapshots.** Confirmed directly this round too (not
   just carried over): `tests/04-turn-token-headers.test.ts`'s credential
   test dumps `env` from inside a real sandboxed shell command and finds
   the (harmless, placeholder) key; separately walks CODEX_HOME and finds
   a genuine `.codex/shell_snapshots/*.sh` file containing it. The fix
   isn't in Codex -- it's the design choice, now proven to hold: never put
   anything but a placeholder there, and let the proxy supply real
   identity out-of-band.
9. **README inaccuracies: per-test homes not deleted; gitignored logs
   "meant to outlive the session".** Both fixed. `harness.ts`'s `stop()`
   now actually `rm -rf`s each test's `CODEX_HOME` (checked: `.tools/home`
   is empty after every run in this session). The "outlive the session"
   line is removed outright: `.tools/` is gitignored at the repo root, so
   nothing under it is ever committed -- the JSONL logs are working
   artefacts for this session only, not an evidence trail that persists.
   This README and the ADR are the persisted evidence.
10. **ADR repeats the refuted claims.** Rewritten -- see
    `docs/adr/0003-harness-codex.md`.
11. **Licences / npm audit.** Addressed honestly above, under "Downloads":
    the bundled LGPL-2.1 voice runtime is now called out; the npm audit
    findings are left open with a stated reason (dev-tooling only, fix
    needs a risky major bump) rather than silently ignored.
12. **Network egress to chatgpt.com/github.com.** The verifier observed
    outbound `CONNECT`s to `chatgpt.com:443`/`github.com:443`/
    `api.github.com:443` in one of their runs. This round's own JSONL logs
    show no `chatgpt.com` references at all, and the only `github.com`
    hits are the workspace's own git remote URL echoed back in thread
    metadata (`gitInfo.originUrl`), not a network call. This isn't a
    refutation, though: our bridge only ever sees Codex's JSON-RPC
    stdout, never its raw outbound TCP/HTTP traffic, so we have no way to
    confirm OR rule out background calls (telemetry, update checks,
    account sync) from here. **Left open, honestly**: this needs an actual
    network-level instrumentation (e.g. `HTTP_PROXY`/`HTTPS_PROXY`
    pointed at a logging proxy) to settle, which is squarely S0.1b's
    "gateway-enforced egress" territory, not something this local-only
    spike can determine either way.
13. **Sub-agent budgeting / "spawn_agent needs a real model catalog
    entry".** Refuted by direct evidence -- see condition 5 and point 6
    above. `spawn_agent` works today, live, with the plain stub model.

## Event inventory (pass condition 7)

Observed **notifications** (`codex -> client`, no reply expected), unioned
across every test run in this session (superset of round 1's table --
additions from this round marked **NEW**):

| app-server notification | OpenCrane catalogue event | Notes |
|---|---|---|
| `turn/started` | `agent.turn_started` | Direct match. |
| `turn/completed` | `agent.turn_completed` / `agent.turn_failed` | Direct match for the happy path. There is **no separate "failed" notification**: failure and interruption are both reported as `turn.status` values (`"completed"` \| `"interrupted"` \| others) inside this same message, so the bridge must branch on `turn.status`, not on the method name. `"interrupted"` (condition 6) has no catalogue event of its own yet -- still an open gap. |
| `item/started` + `item/completed` (`item.type: "agentMessage"`) | `agent.message_completed` | Match, at item granularity. |
| `item/agentMessage/delta` | *(no event -- and correctly so)* | **NEW, now genuinely exercised** (round 1 never triggered this; `tests/07-bridge-ordering.test.ts` does, 40 chunks per run, in order). events.md's own `agent.message_completed` row already says "Streamed text deltas are sent live and not stored as events" -- this finding confirms that design decision is exercisable, not just theoretical. |
| `item/started` + `item/completed` (`item.type: "commandExecution"`) | `agent.command_ran` | Direct match; carries `command`, `exitCode`, `aggregatedOutput`, `durationMs`. |
| `item/started` + `item/completed` (`item.type: "mcpToolCall"`) | *(no direct catalogue equivalent -- closest is `agent.command_ran`'s sibling for tool calls)* | Worth adding explicitly to the catalogue. |
| `item/started` + `item/completed` (`item.type: "collabAgentToolCall"`) | `delegation.started` / `delegation.completed` | **NEW**, from the `spawn_agent` test (condition 5): a genuine match for events.md's "Routines and delegation" pair -- carries `senderThreadId`, `receiverThreadIds`, `status`. Not present in round 1's inventory at all, since `spawn_agent` was never exercised. |
| `mcpServer/elicitation/request` (a **server request**, not a notification -- expects a reply) | `tool.approval_requested` (for an MCP tool) | See condition 2: this is the MCP-specific approval path, distinct from shell/file-change approval. |
| `item/commandExecution/requestApproval` (server request) | `tool.approval_requested` (for a shell command) | The v2 method name; the protocol also still defines a legacy `execCommandApproval` we never actually received from this build. |
| *(reply to the server request above)* | `approval.decided` | Not a separate message: it is simply the JSON-RPC **response** the bridge sends back to Codex's request id. |
| `item/fileChange/requestApproval`, `item/fileChange/patchUpdated` (protocol only) | `agent.file_changed` | **Still not exercised**: our scripted commands never write a file. Same gap as round 1. |
| `item/reasoning/summaryTextDelta`, item type `"reasoning"` (protocol only) | `agent.reasoning_summarised` | **Still not exercised**: our stub model never emits a reasoning block. Same gap as round 1. |
| `mcpServer/startupStatus/updated` | *(no catalogue equivalent)* | Per-thread MCP server lifecycle (`starting`/`ready`/`failed`). **NEW use found this round**: this is exactly how Codex reports a STRICT MCP server's handshake failure (condition 3) -- a real, useful health signal for the bridge to fold into `computer.ready`. |
| `thread/started`, `thread/status/changed` | *(no catalogue equivalent; informs `conversation.created`/activity)* | Thread-lifecycle bookkeeping internal to Codex. |
| `thread/tokenUsage/updated`, `account/rateLimits/updated` | *(no catalogue equivalent; relevant to budgets/usage)* | Useful raw signal for the decision service's usage/budget settlement. |
| `thread/goal/cleared` (and the `get_goal`/`create_goal`/`update_goal` tools Codex exposes by default) | *(no catalogue equivalent -- new concept)* | Still an open question below. |
| `remoteControl/status/changed` | *(irrelevant to OpenCrane)* | Codex's own desktop remote-control feature. |
| `configWarning`, `warning`, `deprecationNotice`, `serverRequest/resolved` | *(operational signals, not business events)* | Useful for the bridge's own logs; not catalogue events. |
| **Effects** (`effect.observed`/`effect.uncertain`/`effect.resolved`) | — | **By design, Codex never emits these at all.** They are gateway-observed, not computer-reported. The crash test (condition 6) independently confirms this is the right split: Codex's own rollout records an in-flight call's *intent*, never its *effect* -- only something outside Codex (this round: a genuine hard SIGKILL; the MCP stub, standing in for the gateway) can ever know whether the effect happened. |

## MCP 2026-07-28: investigated properly

The task brief's premise was that Codex's docs/changelog mention an
MCP-server config option, `protocol_version = "2026-07-28"` (v0.147+). This
round tested that directly rather than assuming it either way:

- **The key does not exist in 0.159.2.** A config.toml with exactly
  `mcp_servers.spike_mcp.protocol_version = "2026-07-28"`, parsed under
  `--strict-config` (which errors on any field this Codex version doesn't
  recognise), fails with `unknown configuration field
  'mcp_servers.spike_mcp.protocol_version'`. The exact same config, minus
  that one line, parses cleanly -- so this is specifically about that key,
  not a mistake elsewhere in the fixture. `tests/03-mcp-protocol.test.ts`
  asserts both halves.
- **`features.mcp_2026_07_28 = true` makes no observable difference**
  either (carried over from round 1, re-confirmed and now hard-asserted
  rather than only logged): Codex still proposes `2025-06-18` at
  `initialize` and still uses `Mcp-Session-Id`, flag on or off.
- **Codex does not validate the server's answer.** Made the stub answer
  `"1999-01-01"` instead of the real version: Codex accepted it without
  complaint, and the `mcp-protocol-version` header on the next `tools/call`
  just echoed that same garbage value back. The `mcp-method`/`mcp-name`
  headers, however, **vanished** in this case -- they only appear when the
  server's answer was exactly `"2026-07-28"`. So "Codex sends those headers
  on every request regardless" (round 1's README) was wrong: they are
  conditional, and a gateway that wants them **must** answer `2026-07-28`
  to Codex's `initialize` to get them.
- **A genuinely STRICT server (2026-07-28 only) cannot complete a
  handshake with Codex 0.159.x, full stop.** Built a `strict: true` mode
  for the stub MCP server that refuses any `initialize` whose proposed
  version isn't exactly `2026-07-28` -- i.e. exactly what plan.md's
  "MCP: version 2026-07-28 only" design wants a real gateway to enforce.
  Run against real Codex: `mcpServer/startupStatus/updated` reports
  `status: "failed"`, with Codex's own error naming the handshake failure.
  Since Codex always proposes `2025-06-18` and has no working config knob
  to change that, this failure is unconditional for this Codex version --
  **there is no way to make pure stateless 2026-07-28 "work" with Codex
  0.159.x for an ordinary `mcp_servers.<id>.url` server**, not a
  misconfiguration on our side. The good news: Codex degrades gracefully,
  not catastrophically. The turn still completes; the model sees a plain
  `"unsupported call: ..."` function_call_output for the tool it tried to
  use, and the bridge never hangs or crashes.

**Answer to the task's direct question ("report whether pure stateless v2
works with Codex 0.159.x")**: no, not for a regular server, and there is no
known workaround within this Codex version. The stateless behaviour appears
reserved for Codex's own hosted-Apps connector path.

## Local forwarding proxy: built, not just designed

Round 1 found the turn-token mechanism (`responsesapiClientMetadata`) and
flagged the proxy as an undecided hedge. This round builds it, because the
mechanism it was hedging against turned out to have a real gap (the MCP
side never gets a header, only body `_meta`) and a real fragility
(`[UNSTABLE]`, `experimentalApi`-gated).

`src/local-proxy.ts` is a plain Node HTTP server. Codex's `model_providers
.stub.base_url` and `mcp_servers.spike_mcp.url` both point at `127.0.0.1`
proxy ports (`harness.ts`'s `useLocalProxy` option wires this up). The
bridge calls `bridge.startTurn(params, turnToken)` instead of a bare
`request("turn/start", ...)`, which sets the current turn token on both
proxies **before** sending the request -- matching plan.md's "the bridge
sets the current turn token on the proxy at each turn" exactly. Every
proxied request, on either upstream, gets `x-oc-computer-token` (fixed for
the computer's life) and `x-oc-turn-token` (current turn) as real HTTP
headers; any `Authorization` header Codex itself sent is stripped, not
forwarded, and the body is passed through unmodified (including SSE
streaming, which just pipes through).

Proven, not assumed (`tests/04-turn-token-headers.test.ts`):
- Two turns, same running `codex` process throughout (`bridge.pid`
  unchanged, `bridge.exitInfo` still `undefined`), two different turn
  tokens: every proxied request in turn A carries token A, every one in
  turn B carries token B, on **both** the model side and the MCP side, and
  neither token ever appears during the other turn's window.
- The computer token is present on every single request, both turns, both
  upstreams.
- The stub "gateway" (the existing model/mcp stub servers, now reached
  only through the proxy) never sees an `Authorization` header from Codex
  at all -- the proxy substitutes its own tokens unconditionally.

This needs no cooperation from Codex and no capability flags: it works
because Codex has nowhere else to send anything, for every request, to
either upstream -- a materially stronger guarantee than the
`experimentalApi`-gated field round 1 relied on.

## Findings and surprises (new this round)

- **`spawn_agent` just works, with a plain stub model, no catalog entry.**
  The `multi_agent_v1` tool namespace (`spawn_agent`/`send_input`/
  `wait_agent`/`close_agent`/...) is offered to the model by default --
  the `multi_agent` feature is stable and on by default (`codex features
  list`). Calling it genuinely spawns a second thread
  (`item/completed` on a `collabAgentToolCall` item reports
  `receiverThreadIds`), with a real `parentThreadId` link (confirmed via
  `thread/read`) and its own `x-openai-subagent: collab_spawn`-tagged
  model call. Round 1's assumption that this needed a multi-agent-capable
  model-catalog entry and reasoning effort `"ultra"` was specifically
  about the newer `multi_agent_v2`/"collaboration" system (a separate,
  disabled-by-default feature); the `v1` path plan.md's "delegated
  children" design actually needs has no such requirement.
- **`review/start`'s thread id depends entirely on `delivery`, and the
  default isn't what it looks like.** Inline (the default) genuinely
  reuses the root thread id -- it is not "a separate thread", by design,
  per the protocol's own doc comment. Detached review needs
  `historyMode: "legacy"` (rejected outright on a normal thread) and, even
  then, gets no subagent header and a `parentThreadId` of `null` -- a
  structurally weaker link than `spawn_agent`'s.
- **A strict-config probe is a fast, reliable way to check whether a
  documented config key actually exists in an installed version.** Used
  this to settle the `protocol_version` question definitively in under a
  second, rather than guessing from behaviour.
- **The bridge's own correctness matters as much as Codex's.** The
  event-ordering bug was entirely our own code (an `await` inside a
  fire-and-forget async call), not a Codex quirk -- worth remembering
  before this bridge pattern gets reused for the real audit stream.
- Everything from round 1 that the verifier confirmed (approval mechanics,
  the namespaced MCP tool-exposure format, `wire_api = "responses"` being
  the only supported value, Codex's rich non-"thread/turn" protocol
  surface) still holds and isn't repeated here in full -- see the git
  history of this README for round 1's complete "Findings" section if
  needed.

## Open questions for the owner

1. **MCP 2026-07-28 for third-party servers is confirmed broken with this
   Codex version, not just assumed to be.** A real gateway enforcing
   "2026-07-28 only" (as plan.md's README "Key ideas" #5 and this file's
   own MCP section describe) will never successfully hand Codex an MCP
   server at all, for any third-party `mcp_servers.<id>.url` entry, on
   Codex 0.159.x. Does the gateway design (ADR 0002) need to tolerate
   `2025-06-18` + session-carrying MCP clients for longer than planned, or
   is this a hard blocker on an upstream Codex release?
2. **The local forwarding proxy is now a real, working design -- should it
   become the ONLY turn-token mechanism**, with the `responsesapiClientMetadata`
   field dropped from consideration entirely (rather than kept as a
   redundant path), given the proxy needs no capability flags and covers
   both upstreams uniformly?
3. **Approval semantics** (unchanged from round 1, still open): `untrusted`
   is gone, and approval is keyed to the command's own requested
   permission level, not a policy string alone. Does the Allow/Ask/Block
   per-tool design still map cleanly onto `on-request` + granular flags?
4. **Codex's built-in "goal" feature** (unchanged from round 1, still
   open): adopt, ignore, or suppress it?
5. **`spawn_agent` works today -- worth building the delegation design
   around it now**, rather than waiting on a "real model provider" that
   this round's evidence suggests isn't actually a prerequisite for the
   `v1` path. The newer `multi_agent_v2`/"collaboration" system (a
   separate, currently-disabled feature) is the one that might still need
   a real model-catalog entry -- not spiked this round, since `v1` already
   answers the "can Codex delegate to sub-agents at all" question plan.md
   asks.
6. **Network egress to chatgpt.com/github.com**: neither confirmed nor
   ruled out this round (see "What changed" #12) -- needs actual
   network-level instrumentation, which is S0.1b's job (gateway-enforced
   egress), not something a JSON-RPC-only bridge can observe.
7. **S0.1b** (this same harness inside a real GKE Agent Sandbox Pod with
   gVisor): everything here still assumes a normal local process; sandbox
   enforcement, network egress through a gateway, and Pod-level kill
   semantics are all still open. (This round's crash test DOES now use a
   genuine hard kill of the real binary, which is closer to what S0.1b
   will need to reproduce at the Pod level -- but it is still a plain
   `SIGKILL` of a local process, not a Pod eviction.)

## How we learned the wire framing

Nothing above was guessed: every wire-format claim came from one of these,
all fetched fresh for round 1 of this spike (kept, gitignored, under
`.tools/`) and re-used (not re-fetched) this round, plus the new direct
experiments described above:

- `codex app-server generate-ts --experimental` / `generate-json-schema
  --experimental` -- the actual generated TypeScript bindings for this
  exact installed version (0.159.2), under `.tools/protocol/`. This
  round's new findings (`ReviewStartResponse.reviewThreadId`'s doc
  comment, `ThreadHistoryMode`, `MultiAgentVersion`, the `multi_agent_v1`
  namespace tool schema) all came from reading these generated types and
  then confirming them against the real binary's own behaviour -- never
  asserted from the types alone.
- The official config docs (`config-reference.html` / `config-advanced
  .html`, under `.tools/docs/`) -- and, where they were silent or unclear
  (the `protocol_version` question), a direct `--strict-config` probe
  against the real binary instead of trusting the docs either way.
- `codex-rs/app-server/README.md` from the upstream repo, under
  `.tools/docs/app-server-README.md`.
- A handful of the upstream Rust integration tests
  (`codex-rs/core/tests/common/{responses,streaming_sse}.rs`,
  `.../suite/{mcp_turn_metadata,window_headers,spawn_agent_description}.rs`)
  -- read only to learn the exact SSE/JSON-RPC wire shapes and the
  `spawn_agent`/model-catalog machinery (Apache-2.0; not reproduced here,
  re-implemented in TypeScript against the same shapes), under
  `.tools/docs/codex-src/`.
- `codex features list` for the real, current feature-flag names and
  default states (`multi_agent`: stable, **true** by default;
  `multi_agent_v2`: stable, **false** by default; `mcp_2026_07_28`: under
  development, off by default).
- Everything else (the exact approval method names, the crash/resume
  behaviour, the shell-snapshot contents, the `collabAgentToolCall` item
  shape) came from running the real binary and reading what it actually
  said, logged verbatim to `.tools/logs/*.jsonl` by every test run.
