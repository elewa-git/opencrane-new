# OpenCrane 2: plan

This file holds the current plan only. When a phase is done, record the evidence in a short changelog entry and cut the detail from here.

## Goal

Reach the MVP defined in the [product contract](docs/product/product-contract.md) and the [user stories](docs/product/user-stories-workspace-and-conversations.md): an employee signs in, gets useful work done by an assistant with company tools and knowledge, reviews consequential actions, collaborates in a group, and returns later without losing work. Administrators control members, tools, models, permissions and spending. The [27 September decisions](docs/product/accepted-decisions-2026-09-27.md) apply: EUR monthly hard budgets with reserve-before-call, per-tool Allow automatically / Ask / Block, paying-group attribution and fresh test qualification.

**Constraint:** keep the architecture as simple as possible and reuse open-source components everywhere; see the README for the component list.

## How work runs: nightly agentic cycles

Follow the [engineering standard](docs/process/standards.md) for the full review and evidence contract.

- **Night.** Take ready issues with acceptance criteria and decisions made. Up to three builders use separate worktrees and assigned files. Aim for at most about 1,500 non-generated added/deleted lines per coherent change. Each whole feature has a development branch and a well-described PR (Why / Functional outcome / Architecture / Evidence / Not in this PR). The orchestrator merges serially after gates, independent review by a different model and green CI. Small fixes belong inside their feature PR; never add co-author or AI attribution.
- **Review.** At most two passes: review the actual diff and evidence, then verify fixes and batched disputes. If blockers remain, hold the change for the owner's decision; never reset the count by renaming it.
- **Morning (human, about 1–2 hours).** Review results, resolve held blockers and decisions, and ready new issues.
- **Every day (agent).** Run smoke tests and most live journeys on a k3d test silo on the developer box; the results go in the deploy ledger.
- **Occasionally (human + agent).** Run a fresh production-like qualification install on a managed cluster. A capability is done only on a ledger PASS.
- **Weekly (human + agent).** Run journeys on a fresh test-silo install and record receipts. Source is ready with green checks and an explicit remaining live-qualification issue; a capability is done only on a live journey PASS.
- **Feature PRs.** One PR per whole feature, stacks at most two, no consolidation PRs.
- **Always.** Run `lint`, `typecheck`, `test` and `check:events` before landing and on `main`, plus the separate web build/tests. Repair or revert a failed combined result before landing more. Never turn an untested condition into PASS.
- **Commits.** One emoji plus a plain sentence; no co-author line or AI attribution. Decisions belong in issues with a needed-by date.

## MCP: version 2026-07-28 only

All network MCP traffic (remote and hosted servers, through the gateway) uses the stateless **2026-07-28** revision only:

- There is no handshake and no session.
- Every request carries its version and capabilities in `_meta`.
- Every request carries method and tool-name headers, so the gateway can route it.

Consequences:

- Registration rejects servers that don't implement `server/discover` for 2026-07-28.
- Codex pins `protocol_version = "2026-07-28"` for the gateway endpoint.
- The gateway rejects other versions.
- The tool-name header must match the tool in the body, or the call is refused.
- Application state crosses calls only through explicit IDs returned by tools.

Local stdio tools inside the computer (Playwright, document tools) are exempt until Codex supports 2026-07-28 over stdio; their network traffic still passes the gateway.

**Found in spike S0.1a:**

- **Codex speaks stateless 2026-07-28** when started with `features.mcp_2026_07_28 = true`. It calls `server/discover` first with `MCP-Protocol-Version: 2026-07-28`, then `tools/list` and `tools/call`. There is no `initialize`, no `Mcp-Session-Id` and no GET stream, and the method and tool-name headers are always present. Our MCP servers must return a full `DiscoverResult` (`resultType`, `supportedVersions`, `capabilities`, `serverInfo`, `ttlMs`, `cacheScope`).
- The flag is still marked "under development" in Codex 0.159, so its maturity is the remaining risk. We pin the Codex version and keep a test that fails if the flag's behaviour changes.
- Without the flag, Codex proposes 2025-06-18 and uses sessions. In either mode it accepts any version without checking, so OpenCrane's MCP servers and the gateway must **enforce** 2026-07-28 themselves.

## Responsibility split: gateway vs server

The gateway **enforces**; the OpenCrane decision service **decides** inside `ext_authz` and owns the truth. The gateway holds nothing it can't lose: no business state, no per-user secrets at rest, and no decisions beyond static rules generated from server configuration.

| Concern | agentgateway | Decision service (ext_authz) and server | Other |
| --- | --- | --- | --- |
| Computer tokens | Verifies signature, expiry and audience (JWKS) | Mints them at claim; holds the signing key | Secret store |
| Coarse allowlist (which models, MCP servers, web domains exist in this silo) | Enforces it (CEL rules, routes) | Generates the gateway config from admin settings | — |
| Fine decisions (this computer, this tool, these arguments; Allow/Ask/Deny; human ∩ agent) | Calls `ext_authz`, fails closed | Every allow/ask/deny decision, including budgets and approvals, is made in `ext_authz` | OpenFGA |
| Budgets | Usage log; rate limits as a safety net | `ext_authz` reserves worst-case cost before the call (single-writer budget actor per silo); a reaction to `effect.observed` settles it after the reply from the gateway's usage log, because real usage arrives only in the reply; admins set ceilings and a routine resets periods | Event store (budget stream), with a Postgres projection |
| Approvals | Denies until approved | `ext_authz` denies with “approval required” and records `approval.requested`; the person decides in the web app (`approval.decided`); on retry, `ext_authz` allows the call once, bound to requester, conversation, turn, assistant and argument digest | Event store (approval stream), with a Postgres projection |
| Company model keys (BYOK) | Uses them as backend credentials | Admin screen writes or rotates them | Kubernetes Secret or Secret Manager |
| Personal / connection credentials (OAuth, bearer) | Injects them into the upstream request | Connect, consent, refresh, revoke; hands the credential to the gateway per call | Secret store |
| Model routing, failover, MCP protocol, tool federation | ✅ | — | — |
| Web egress | Forward proxy with allowlist and logging | Allowlist policy | NetworkPolicy makes the gateway the only way out |
| Live view and takeover (human → computer) | — | Its own authenticated proxy | KasmVNC |
| Audit | Emits OpenTelemetry logs | The authoritative record: decisions, approvals, reservations, reconciled with gateway logs | — |
| Memory | Passes allowed scopes from `ext_authz` to the memory MCP | Resolves allowed scopes from IAM context; commands append `memory.*` events | OpenCrane memory MCP; Postgres memory projection |

Decisions happen in `ext_authz`; the server around it handles what happens before or after a request (UI, settlement, admin changes, schedules).

## Design rules for the main building blocks

### Computers

- **One computer per assistant** (owner decision 6). Conversations are threads on that computer. Group members always work as sub-agents of the group assistant, each in their own thread or sub-agent on its computer with their own personal memory plus the group memory. A team that wants separate desks creates more assistants.
- **Binding:**
  - Warm Pods are tenant-neutral until claimed.
  - At claim, OpenCrane binds a Pod to one computer identity, mounts its encrypted persistent volume at `/home/agent`, and issues short-lived computer and turn tokens.
  - A Pod never returns to the pool after a binding ends; it is destroyed.
  - Suspending stops the Pod but keeps the volume. Files, the Chromium profile and its logins, and Codex session files survive.
  - Resuming claims another warm Pod, mounts the volume, refreshes both tokens, and asks Codex to resume the thread from its session files. Open tabs, unsaved form text and running processes do not survive.
  - Pod Snapshots or gVisor checkpoint and restore may later provide faster resume behind the same interface; neither is required.
- **Portable Kubernetes:** a silo runs on any conformant cluster with a gVisor RuntimeClass and a CSI storage class with volume snapshots. Computers use the open-source `kubernetes-sigs/agent-sandbox` controller (`SandboxTemplate`, `SandboxWarmPool`, `SandboxClaim`), not a managed cloud variant.
- **No lasting secrets in a computer.** Codex, Playwright and KasmVNC run inside it. All network traffic goes through the gateway, and the package mirror is reached through it as well.
- **Local forwarding proxy in every computer** (found in spike S0.1a):
  - Codex talks only to `127.0.0.1`. The proxy adds the computer and turn tokens as HTTP headers before forwarding to the gateway.
  - **Turn tokens are kept per thread, never one per computer.** Several conversations, and several requesters on a team assistant, run as threads in the same computer at once. The proxy looks the token up from the thread id that Codex sends on every call (session and thread headers on model calls, `_meta` on MCP calls). Sub-agents inherit their parent's turn. A token is dropped when its turn ends, and a call with no live turn is refused. (Round 2 showed one global token sending Alice's request upstream as Bob's.)
  - **Only Codex may use the proxy.** An approved shell command could read the proxy address and get the tokens stamped on its own calls. So the proxy must authenticate its caller (for example a Unix socket that only the Codex user can open). S0.1b proves this under gVisor. Either way, gateway policy is the only enforcement point.
  - Codex holds **no real provider key**: a key given to Codex is readable by the agent's own shell commands and can be written to its session files.
  - Codex's own approval prompts are not policy. Policy lives at the gateway; inside the computer, Codex runs its sandbox with on-request approval.
  - The bridge logs and dispatches Codex notifications strictly in arrival order, but never waits for a handler to finish (a handler waiting for a human approval would otherwise block every thread).
- **Delegated children** run as Codex sub-agents in the same computer. A task needing a different computer uses another assistant; a member's personal memory stays in their own thread on the group assistant's computer.

### Installing an MCP server

1. **Register:** the admin enters a URL or picks an image.
2. **Validate:** SSRF guard for remote servers. Signed, scanned images for hosted servers, deployed in `<silo>-mcp` with egress to their upstream only.
3. **Discover:** `server/discover` (2026-07-28 required) and the tool list, through a quarantine route. Store schema digests.
4. **Review:** Allow automatically / Ask / Block per tool. Defaults come from MCP hints: read-only → Allow, destructive → Ask.
5. **Publish:** generate the gateway route, CEL allowlist and `ext_authz` binding.
6. **Grant:** OpenFGA relations for people, teams and assistants.
7. **Connect** (if the server needs credentials): the person or admin completes OAuth or a bearer login in OpenCrane. Credentials go to the secret store, bound to user + profile.
8. **Watch:** tool-list or schema changes are held until re-reviewed.

Hosted MCP servers never run inside the gateway.

**Gateway hardening (found in spike S0.2):**

- The decision service is deny-by-default: only `server/discover`, `tools/list` and `tools/call` pass, and batches, case variants, duplicate keys, `resources/*` and unknown methods are refused.
- Bearer tokens (computer and turn) and arbitrary client headers are never forwarded upstream; only a small header allowlist passes.
- Credential headers are overwritten on every route.
- Approvals are bound to requester, conversation, turn, assistant and the argument digest.
- Requests without an output-token bound are refused or capped before budget reservation. The bound must be a positive integer; the reservation covers prompt tokens, the output bound times `n`, and rounds cost **up**.
- The approval's argument digest is taken over a canonical JSON form (RFC 8785 style) that keeps number text exactly and refuses `__proto__`, `constructor` and duplicate keys. Lookups by tool name use maps, never plain objects. (Round 2 spent an approval with extra hidden arguments and gave `constructor` the Ask default.)
- Streamed model replies carry usage only in their last chunk. Settlement reads it from the stream (or agentgateway's native LLM fields), not from `json(response.body)`, which only works for replies that aren't streamed.
- agentgateway 1.5 drops leading zeros in fractional-second log timestamps; log ingestion must parse them carefully.

### Per-user MCP credentials (e.g. per-user Odoo)

- **Default:** one stateless MCP deployment. Per call, the decision service releases *this user's* lease for the selected profile, and the gateway injects it. The MCP server trusts only the injected credential and ignores identity in arguments.
- **Fallback, for servers that only take startup credentials:** one instance per user, scaled to zero when idle. Never inside the user's computer.
- **Team assistants** use the **requester's own profile by default**: the gateway injects the credential of whoever sent that turn, so Odoo applies that person's own rights and its audit shows the real person. A company connection (a bot user owned by an admin) is an opt-in, chosen per connection, mainly for routines with no person behind them. (Owner decision, 2026-10-01.)
- **Audit:** every credential release is recorded (user, profile, computer, tool, request).

### Memory

- **MVP store** (owner, 2026-10-01): `memory.*` events in NATS JetStream are the truth. Postgres projects memory facts per scope and searches them with full-text search; pgvector only if needed later.
- **Scopes:** person (preferences and personal facts), assistant notes (the assistant's own working notes), and group. Groups are flat; there are no organisation or department memory levels.
- **Group turns:** members always work as sub-agents of the group assistant. Each member's turn is their own thread or sub-agent in its computer, sees their personal memory plus the group's memory, writes preferences to personal memory and shared knowledge to the group. Any group member may write group memory, with no approval step.
- **Isolation:** turn tokens stay per thread; one member's personal memory never reaches another member's thread. Memory is never written to the shared computer's disk.
- **Access path:** Codex → local forwarding proxy → agentgateway (`ext_authz` passes allowed scopes from IAM context) → OpenCrane memory MCP (`remember`, `recall`, `correct`, `forget`). Effective rights on a turn = assistant grants ∩ requester rights; the MCP enforces those scopes on every read and write.
- **Turn start:** preferences and pinned facts from allowed scopes go into that thread's instructions with a size cap; fetch the rest with `recall`.
- **Dreaming:** a nightly per-scope job in the handler runtime uses a cheap model through the gateway with a budget. It merges duplicates, flags contradictions and expires stale facts, writing `memory.corrected` events with links to sources; it never crosses scopes. Replay rebuilds the projection without model calls.
- **External sources:** query mailboxes and CRM records live through MCP with the requester's own login by default.
- **No sharing between groups in the MVP;** sharing data across groups is a later design topic.
- **After the MVP:** Cognee may return as another projection, fed by replaying the same memory events plus document ingestion, without changing the agent's tools.

### Conversation stream and audit

- **Two channels, two trust levels.**
  1. The **event channel**: the server opens a WebSocket *into* each active computer's bridge (inbound only; NetworkPolicy allows ingress from the server alone). Over it, the server sends messages, approvals and Stop, and receives Codex events. These events are **reported by the computer**: useful, but not proof.
  2. **External effects** (model, tool and web calls) pass the gateway and are **observed by the gateway**: trusted evidence.
- **What the bridge forwards** (from Codex app-server): turn start and end, streamed message text, reasoning *summaries* (raw chain-of-thought is not available from reasoning models and is not stored), tool-call and command start/end with exit status, file changes in the workspace, approval requests, and errors.
  - Events carry a per-computer sequence number, so a reconnect resumes without loss or duplicates.
- **Stored:** chat messages and activity items go to append-only Postgres tables, encrypted like messages. Reasoning summaries follow the same retention rules. Screenshots are conversation files.
- **Audit record = server decisions + gateway observations + computer reports**, joined by shared ids: conversation, turn, step permit, reservation and approval. The gateway forwards the permit id upstream and logs it.
  - The audit view marks each line's source.
  - An effect in the gateway log without a matching permit or decision is an alert.
- **Web app realtime over WebSocket** (one connection per browser tab to opencrane-server). The browser never connects to the `EVENTS` stream.
  - **Subscribe:** the client sends `subscribe {conversation, since}`. The server checks OpenFGA, replays anything after `since` from the projection, then pushes live updates: chat text as it streams, activity, approvals, presence. Every message carries the conversation's position, so a reconnect resumes with no gaps.
  - **Revocation:** on `participant.removed` or `member.removed`, the server immediately unsubscribes the affected sockets, and closes the socket if the member is gone.
  - **Commands stay on the HTTP API** (the API of record for every client: idempotency keys, OpenAPI). The socket may carry lightweight actions (typing, presence, "mark read") as typed messages with request ids and acknowledgements.
  - **Protocol:** versioned, typed JSON messages (zod schemas shared with the web app) over the plain `ws` library.
  - **Security:** the session cookie is checked on upgrade, with a strict `Origin` check (defence against cross-site WebSocket hijacking), heartbeats, per-connection rate limits, and backpressure (drop live deltas, never drop state updates).
  - **Scaling across server replicas:** each replica receives the per-conversation updates it needs through internal NATS core subjects (not the `EVENTS` stream), so any replica can serve any socket. Ingress: WebSocket-enabled routes with long idle timeouts.
  - The live view and takeover already use WebSocket (KasmVNC), so the web app has one realtime technology.
- **Later option:** browsers connect to NATS over WebSocket directly, on a separate browser-facing account with redacted per-conversation UI subjects and short-lived tokens from an auth callout. Consider it only if the server's WebSocket layer becomes a bottleneck.

### Live view and takeover

- **The stream never leaves the Pod directly.** The KasmVNC stream reaches people only through the OpenCrane server's authenticated proxy.
- **Permissions:** viewing is for conversation participants; control is for the requester or whoever they grant it to.
- **Takeover pauses the agent** and is audited as a human action. Browser sessions made during a takeover stay in the computer's profile on its encrypted volume, so the volume is sensitive data.

## Event-driven core

**The event store is the only source of truth; PostgreSQL holds content that can be replayed from it.** Every state change is an event, and every piece of logic is a projection (event → content) or a reaction (event → action → new events). **Which event triggers which logic is defined in [docs/architecture/events.md](docs/architecture/events.md)**; CI keeps code and catalogue in step.

- **Events are facts, named in the past tense:** `message.posted`, `approval.decided`, `effect.observed`, `member.removed`, `routine.due`, `memory.written`, `mcp.tools_changed`. Each has a typed schema in TypeScript and a CloudEvents-style envelope (id, type, source, time, subject, silo, principal, correlation ids: conversation, turn, permit, reservation, approval). The catalogue is documented with AsyncAPI.
- **Commands write one event, nothing else ("listen to yourself").** A command validates, then does **one atomic append** to the event log. State tables (conversations, budgets, approvals, memberships) are **projections** kept up to date by listeners. There are no multi-table business transactions and no "write state, then publish".
- **The only synchronous atomic step is a conditional append,** where a rule needs one consistent answer: an expected stream version, or a unique key, on the budget stream (reserve), the approval (use once) and state-guarded commands (only a *pending* approval can be decided). One stream per rule serialises concurrent writers without locks across tables. Budgets use a **single-writer budget actor per silo**: one leader-elected process in the decision service handles reserve and settle requests **in order**, in memory, and appends each result. The expected stream version stays only as a fence, so a stale leader after failover can't write. There are no locks and, in normal operation, no conflicts. The budget stream holds every ceiling (global, paying group, optional assistant), so a single conditional append checks all of them and records the one charge; that is ample at silo scale. OpenFGA is a **projection** too: its tuples are rebuilt from membership and grant events, never edited directly.
- **Consistency windows are explicit:** the UI may lag its own writes by milliseconds, and revocation takes effect within a documented bound (target under 2 seconds) as listeners update OpenFGA and the credential-release rules.
- **Delivery:** JetStream **ordered consumers** feed projections (consumer sequence and row in one Postgres transaction) and a per-silo dispatcher. The dispatcher hands each event to the job queue (see decision 7), which fans it out to subscriber queues, **in order per stream** (per conversation, per budget), using pg-boss `key_strict_fifo` queues keyed by stream id. There is one writer per stream at a time, so **projections need no locks**, and different streams run in parallel. A failing event holds back only its own stream (strict FIFO) and raises an alert; it is never skipped. Delivery is at-least-once: handlers are idempotent (keyed by event id), retried with backoff, and failed events land in a monitored dead-letter queue that can be replayed. `LISTEN/NOTIFY` wakes the browser streams.
- **Three event sources, one log:**
  1. server commands (decisions, approvals, admin changes);
  2. computer reports (Codex events through the bridge);
  3. gateway observations (external calls from its logs).

  The audit view is a read over this log.
- **Examples of reactions:**

| Event | Reaction |
| --- | --- |
| `approval.decided` | Wake the computer and deliver the decision |
| `effect.observed` | Settle the budget reservation |
| `member.removed` | Remove OpenFGA relations, stop credential release, suspend their computers |
| `routine.due` | Post the routine's message to its assistant |
| `memory.written` | Mark that scope for nightly dreaming |
| `mcp.tools_changed` | Quarantine the MCP server until re-reviewed |

- **Rules:**
  - Ordering holds **within** a stream, never **across** streams (for example `member.removed` against a conversation's `message.posted`). Handlers therefore always recheck current state.
  - An **event never grants anything.** Each handler rechecks current permissions before acting.
  - Events are append-only. "Forget" purges payloads, or deletes the per-conversation key, and leaves a tombstone.
  - Handlers never call each other directly; they emit new events.
  - **Only OpenCrane's command handlers may publish to `ev.>`.** NATS runs with TLS and accounts; computers, the gateway and the browser never get publish rights (S0.7 ran without auth, so Phase 1 adds and tests this).
- **Later, without changing the core:** a JetStream consumer (or NATS-to-Kafka bridge) exports the event log for SIEM, analytics across silos or external integrations. JetStream stays the source of truth.

## Runtime and operations

- **No serverless platform in the MVP.** Projections and reactions are small TypeScript handlers in one `workers` Deployment per silo, fed by the dispatcher and pg-boss. Per-stream order, retries and dead-letter already come from pg-boss; a function platform would add cold starts and a second networking layer, and it would make per-stream ordering harder, not easier.
- **KEDA** (event-driven autoscaling) where scaling to zero pays off:
  - per-user hosted MCP instances (the fallback pattern);
  - the `workers` Deployment, scaled on queue depth (KEDA's PostgreSQL scaler).
  
  Computers are scaled by Agent Sandbox itself.
- **Logs and traces per handler:** every projection and reaction is a named handler with its own pg-boss queue (e.g. `settle-budget`, `wake-computer`, `update-openfga`).
  - Each run logs structured JSON with `handler`, `event_id`, `event_type`, `stream`, `attempt` and `trace_id`, and is one OpenTelemetry span.
  - A trace follows command → event → reactions → follow-up events.
  - Filter logs by `handler` in the chosen log store, such as Loki; each handler gets a dashboard (runs, failures, latency, dead-letter).
  - pg-boss keeps each job's state, attempts and last error in Postgres.
  - An admin "event timeline" view shows, for any event, which handlers ran, their status and a link to their logs.
  - Noisy or risky handlers can run as their own Deployment (label `handler=`) without changing code.
- **Watching the system:** OpenTelemetry from every component, to any compatible backend such as a Grafana stack (Prometheus, Loki, Tempo). Required metrics and alerts:
  - **projection lag:** checkpoint behind the `$all` head;
  - **dispatcher lag;**
  - **dead-letter size**, and **streams held** by a failing event;
  - **revocation latency:** `member.removed` → OpenFGA updated (target under 2 seconds);
  - **budget-actor latency;**
  - **gateway decision latency and fail-closed count;**
  - **effects without a permit**, which should always be zero.
- **Later:** Knative becomes worth considering only when assistants build and publish their own small apps (the "micro-app" idea). Those apps benefit from scale-to-zero serving; the core does not.

## Data stores

**One PostgreSQL per silo** (a CNPG cluster with several databases, point-in-time backups to S3-compatible object storage) holds almost everything. Other stores are added only where Postgres genuinely can't do the job.

| Store | Holds | Why |
| --- | --- | --- |
| **Event store (NATS JetStream, decision 2)** | Every event, one subject per entity (see the [catalogue](docs/architecture/events.md)). The only source of truth; R3 replicated, unlimited retention, backed up | Apache-2.0; per-subject conditional appends; ordered consumers; doubles as a bus |
| **PostgreSQL (CNPG), database `opencrane`** | **Content projections**, all replayable: members, teams, assistants and owners, computers, conversations, messages, activity, approvals, installed MCP servers and tool modes, connections (secret references only), grants, budgets, usage, routines, audit view, memory facts per scope (full-text search), plus projection checkpoints | Queryable content; drop and rebuild by replay; one engine, transactions, point-in-time restore, well known; business rules in TypeScript |
| same cluster, database `jobs` | pg-boss queues: ordered per-stream delivery to reactions, retries, dead-letter, cron (routines, monthly budget period, dreaming, housekeeping) | pg-boss runs on Postgres; no extra queue service |
| same cluster, database `openfga` | OpenFGA relationships (humans, agents, scopes) | OpenFGA's Postgres backend; one backup with the rest |
| **S3-compatible object storage** | Uploads and generated files, database backups | Not a database; per-silo buckets, encrypted; GCS, DigitalOcean Spaces or MinIO for local tests |
| **Secret store** (Kubernetes Secrets or an external secret store) | Company model keys, per-user credentials, the token-signing key | Secrets never go in Postgres |

**Not in the first version:**

- **SurrealDB:** ruled out by the OSI-only licence rule (BSL).
- **Redis:** only if the gateway runs several replicas and needs shared rate-limit counters. Budgets don't need it; they live in Postgres behind `ext_authz`.

**Zitadel** keeps its own database, run by the platform or as Zitadel Cloud. It is shared across silos with one organisation per customer, as in OpenCrane 1.

## IAM context in every gateway decision

`ext_authz` must **always** have the full IAM context of a call. It never decides on the computer's identity alone.

**Two tokens on every call:**

- The **computer token** (from claim and bind) says *which computer and assistant* is calling.
- The **turn token** says *on whose behalf*. The server issues it when it delivers a message, approval or routine firing to the computer; the bridge attaches it to every call Codex makes for that turn. It carries silo, conversation, turn, requester, assistant, and the delegation chain (root requester → parent turn). A routine firing carries the routine owner; a team assistant's call carries the person who asked.

Both are short-lived and signed by OpenCrane. The gateway verifies them and forwards their claims to `ext_authz`.

**What `ext_authz` assembles for each call:**

| Part | Source |
| --- | --- |
| Who | Requester, assistant, computer and delegation chain (from the tokens) |
| Live status | Membership and role, team memberships, whether the assistant and computer are active (projections) |
| Permission | OpenFGA: requester ∩ assistant may use this tool, model, scope or destination |
| Allowed memory scopes | IAM context: assistant grants ∩ requester rights for person, assistant notes and group scopes; passed through the gateway to the memory MCP, bound to this thread's turn |
| Tool rules | Allow / Ask / Block mode, and the approval state for these exact arguments |
| Credential | The connection and profile bound to the requester (or the company connection) |
| Money | Budget actor: reserve the worst case for the paying group |

**Always available:**

- The decision service, OpenFGA (backed by CNPG with a standby) and the budget actor run with at least 2 replicas each in the silo, with disruption budgets and high priority.
- If any part of the context can't be read, the decision is **deny** (fail closed), and the assistant pauses with a clear reason.

**Always current:**

- Permissions are never granted from a stale cache. OpenFGA is queried per decision, with higher consistency after a recent revocation.
- IAM projections are watched for lag, and a revocation takes effect within 2 seconds.
- Only immutable facts (tool schemas, price table) are cached.

**Always recorded:** each decision appends an event with the decision, the requester and assistant, and a digest of the IAM context used. Audit can then show exactly which rights allowed or refused a call.

## Phase 0: spikes (decide before building)

Each spike is one night of agent work plus a morning decision. The result is a one-page ADR in `docs/adr/`.

**Start gate:** the prototype and MVP work starts once **S0.1 (Codex in a computer), S0.2 (gateway + IAM context) and S0.7 (NATS JetStream event store)** pass. The other spikes run alongside, just ahead of the phase that needs them:

| Spike | Must pass before |
| --- | --- |
| S0.8 (handler runtime) | the reactions part of Phase 1's event core; pg-boss is the default if it hasn't reported yet |
| S0.3 (warm pool + suspend by disk) | Phase 2 |
| S0.5 (live view / takeover) | Phase 3 |

| # | Spike | Pass condition | Decides |
| --- | --- | --- | --- |
| S0.1 | **Codex app-server in an Agent Sandbox Pod under gVisor** | Streams a reply through agentgateway to a model; pauses for an approval and resumes; a sub-agent runs; after a Pod kill we can tell whether the call was sent | Harness choice (fallback: OpenCode, then Goose) |
| S0.2 | **agentgateway decision hook** | Every call reaches `ext_authz` with verified computer and turn token claims, and the decision uses live OpenFGA, membership and budget context (a revoked member is denied within 2 seconds; missing context → deny); speaks MCP 2026-07-28 end to end; rejects other versions and header/body tool mismatches; `ext_authz` fails closed when OpenCrane is down; oversized bodies are rejected; client headers are stripped; an injected credential reaches the MCP server and is not logged; the deny-until-approved flow works | Gateway choice (fallback: the Envoy stack) |
| S0.3 | **Warm pool + suspend by disk** | On k3d and GKE, a warm Pod is bound to a computer identity at claim; suspend keeps its volume; resume claims a warm Pod and mounts it; files, browser logins and the Codex thread survive; computer and turn tokens are refreshed; claim and resume latency are measured | Computer lifecycle |
| S0.5 | **Live view and takeover** | KasmVNC through the OpenCrane gateway: view-only for participants, control for the requester only; the agent pauses while a human is in control | Streaming component |
| S0.7 | **Event store: NATS JetStream (fallback: Postgres event store)** | Conditional append per entity subject (expected last-subject sequence); ordered replay into a projection with the consumer sequence checkpointed in the same Postgres transaction; dispatcher into pg-boss; replay rebuilds a projection; R3 failover without lost or reordered events; many-subject scale (at least 1M entity subjects); backup and restore of the stream | Event store (decision 2) |
| S0.8 | **Handler runtime: pg-boss vs Restate vs Hatchet vs Temporal** | Per-key ordered handlers (one writer per stream); retries and dead-letter; **logs and history per handler in a UI**; the budget actor as a keyed single writer; licence review; ops cost per silo | Handler runtime (decision 7) |

**After the MVP:**

- **S0.4 — optional Cognee projection:** reuse OpenCrane 1's isolation contract suite; qualify replay plus document ingestion, deletion after consolidation, deployed model and embedding settings, scope isolation through the memory MCP, latency and graph backend. This is not an MVP start gate.

## Phases and acceptance

| Phase | Scope | Done when (live on a fresh install) | PRs (estimate) |
| --- | --- | --- | --- |
| **1. Foundation** | Repository scaffold (npm workspaces, four apps: `web`, `server`, `computer`, `deploy`); CI with required checks; Helm umbrella from OpenCrane 1 charts; CNPG with backups; NATS JetStream `EVENTS` stream (R3); **event core**: typed catalogue, command → conditional append, projection runner with checkpoints, dispatcher → handler runtime, replay tool, per-handler logs and traces; Zitadel sign-in (copied auth library); OpenFGA as a projection; WebSocket realtime skeleton | Sign in and out on the test silo; `member.joined` flows through to members and OpenFGA projections; a projection is dropped and rebuilt by replay; backup and restore drill passes | 14–18 |
| **2. Prototype: talk to your computer** | Computer image (Codex, runtimes, Playwright, MarkItDown); the bridge; claim and bind from the warm pool; chat UI from OpenCrane 1 components; file upload into the workspace; models through agentgateway with a simple cap | A person chats with their assistant, it reads an uploaded PDF, and the answer survives a reload and a Pod replacement | 15–20 |
| **3. Governed work** | Decision service: EUR price table, reserve-before-call, settlement from gateway logs; Allow/Ask/Block with the approval card; the MCP install flow; per-user connections and credential injection; the Odoo MCP (our `odoo-mcp-server`, remote mode); screenshots; live view; takeover; audit | One Odoo read and one approved Odoo write pass live, with every refusal case; the budget stops the next call at its limit; takeover is audited | 25–35 |
| **4. Company product** | Flat groups, shared group assistants, child chats and member threads/sub-agents; members, tools, models, budgets, usage and audit screens; OpenCrane memory MCP on Postgres (remember/recall/correct/forget, full-text search, capped preferences and pinned facts at turn start, nightly per-scope dreaming); scheduled routines (`routine.due` → `message.posted` to the assistant); delegation (Codex sub-agents under one root budget) | MVP user stories pass on the test silo; any member writes group memory without approval; personal preferences stay in that member's thread, shared facts reach group members, no memory reaches disk or another group; correction, forgetting, replay and dreaming pass; cross-user, unauthorised-scope and cross-silo calls are denied | 30–45 |
| **5. Qualification and hardening** | Daily smoke tests and most live journeys on a k3d test silo; occasional fresh production-like installs on a managed cluster; backup/restore of NATS JetStream, Postgres and persistent volumes together; memory projection rebuilt by replay; security review of the gateway and live-view exposure; negative tests; operator docs | A release candidate passes the full journey list on a fresh managed-cluster install; no open Critical/High finding | 15–20 |

## Estimate

**Assumptions:**

- About **3 mergeable PRs per night** (three parallel agents, one PR each), **5 nights a week**.
- About 1–2 hours of human review each morning.
- A rework factor of **1.3–1.5×** for rejected PRs and fixes found during live runs.
- No work for optional Pod Snapshots or gVisor checkpoint and restore; suspend and resume use the persistent volume.

These are planning estimates, not measurements. Re-estimate after Phase 2 from the real throughput.

| Milestone | Nights of agent work | Calendar (5 nights/week, with rework) |
| --- | --- | --- |
| Phase 0: start-gate spikes S0.1, S0.2, S0.7 (others run alongside later phases) | 3 (+3 alongside) | **Week 1** |
| Phase 1: foundation (incl. event core) | 5–7 | Week 2–4 |
| **Phase 2: working prototype** | 5–7 | **About week 4–5** |
| Phase 3: governed work | 9–12 | Week 6–9 (first live governed action around week 7) |
| Phase 4: company product | 10–15 | Week 9–13 |
| Phase 5: qualification | 5–7 plus human-run live tests | Week 13–16 |
| **MVP** | **About 40–56 nights** | **About 12–16 weeks** |

Phase 4 saves about 5 PRs (2 nights): reusing Postgres removes Cognee deployment and graph work, while scope isolation and live memory tests still take time.

**What moves the date:**

- **Human bandwidth, the main limit.** Morning review, decisions, and human-only steps: identity-provider changes, approvals that need a real re-login, visual approval.
- **Spike outcomes.** A failed harness, gateway or event-store spike adds about 1–2 weeks before the start gate (the event store falls back to Postgres).
- **Live bring-up.** OpenCrane 1 needed 20–30 ledger entries per fresh install. Daily k3d runs from Phase 1 onwards, backed by occasional managed-cluster qualification, are meant to bring that down.

## Copy from OpenCrane 1 (source commit `10abd0ef6`)

Record the source commit in each copied file's header or README.

| Area | Copy | Change on copy |
| --- | --- | --- |
| Product | Contract, user stories, 27 September decisions (done), admin design targets (`docs/design/administration-lifecycle/`, `tests/design-targets/`) | None |
| Infrastructure | Prerequisite scripts (ingress, cert-manager, CNPG pins, CNI check, storage classes, DNS), `configure-oidc.sh`, the `apps/postgres` chart, the Agent Sandbox hardening chart, the ClamAV scanner, suspend/teardown/verify scripts | Target conformant Kubernetes; require gVisor and CSI volume snapshots; use the open-source Agent Sandbox controller; keep volumes on suspend; Postgres backups on; add the logout redirect in OIDC config |
| Libraries | `libs/backend/observability`; `infra/auth` (OIDC + encrypted sessions); `infra/workload-identity`; `infra/agent-sandbox` (claim adapter); `infra/mcp-remote-client` (SSRF guard); the MCP credential secret store; `infra/http`; members and invitations; BYOK and model registration | Logout follows `endSessionUrl`; step-up checks `auth_time`; grants become OpenFGA relations |
| Authorisation vocabulary | `libs/models/authorization` catalogue | Rewritten as the OpenFGA model |
| Frontend | Theme, UI elements, conversation components, **approval card**, A2UI rendering, onboarding, members; Storybook | About 5 libraries in total; Linux-only screenshots for about 30 key states |
| Process | A short AGENTS.md, the `review`, `review-verifier` and `deploy` agents, the dependency-boundary lint, the deploy-ledger practice | ESLint instead of custom style scripts |

**After the MVP, if Cognee returns:**

- the Cognee chart and patches, plus its key creator, after S0.4 qualification.

**Do not copy:**

- the KurrentDB turn protocol, activation queue, receipts and sagas;
- the SQL business-rule triggers and baseline tooling;
- per-attempt model keys and the pre-forward retry;
- the server-side model loop and turn compiler;
- McpTask, the run-tree ledger, skill-authoring, knowledge/retrieval, ResourceShare, usage snapshots;
- the separate artifact service and preprocessor;
- the heavyweight review gates.

## Open decisions (owner)

1. **Memory store: OpenCrane memory on Postgres for the MVP; Cognee deferred** (owner, 2026-10-01). `memory.*` events remain the truth; only person, assistant notes and flat group scopes, with no sharing between groups.
2. **Event store: NATS JetStream (decided direction; confirm in S0.7).** KurrentDB is ruled out: its KLv1 licence is not acceptable for customer silos. JetStream is Apache-2.0 (CNCF) and provides:
   - one subject per entity stream (e.g. `ev.conversation.<id>`);
   - **conditional appends** with `Nats-Expected-Last-Subject-Sequence`;
   - ordered consumers for projections;
   - durable consumers for the dispatcher;
   - R3 replication for high availability;
   - unlimited retention for the source of truth.

   It also serves as the message bus if one is needed later. Fallback if S0.7 fails: a PostgreSQL event store (Message DB, or Emmett once its licence is confirmed).
3. Cross-silo warm pools: per-silo pools for the MVP. Shared neutral pools only after a separate security ADR.
4. OpenFGA or SpiceDB. OpenFGA is the default for its Postgres backend; revisit if revocation latency fails a test.
5. The test silo and domain for weekly fresh installs, and the €5 live-provider envelope with a provider-side hard limit.
6. **Computer per assistant, not per conversation** (decided by the owner, 2026-10-01). A person's assistant keeps one computer across its conversations, with the same logins, workspace and browser profile, like one laptop per colleague. A team assistant has one computer with team scope, which its members share like a shared desk; a team that wants separate desks creates more assistants, each with its own computer. Members run as their own threads/sub-agents in that computer, with personal memory isolated per thread alongside group memory. Delegated children share the computer; a task needing a separate computer uses another assistant.
7. **Handler runtime: pg-boss (recommended), unless S0.8 favours Restate, Hatchet or Temporal.** Temporal (MIT) is the most complete: entity workflows as single writers per key, Updates for synchronous answers, native schedules and timers, and a per-run history UI. Its costs are a cluster per silo (or shared namespaces), determinism and versioning rules on workflow code, and keeping its workflow history from becoming a second source of truth; it would run processes, while facts stay in the event store. Restate's Virtual Objects give one writer per key, durable handlers and a UI per invocation; Hatchet (MIT, on Postgres) gives key-based concurrency queues with monitoring and logs per run. Either could replace pg-boss plus our own dispatcher and handler dashboards. Absurd is no longer needed. The computer design removes turn orchestration, so what remains is cron, retries, event fan-out and **ordered per-stream processing**. pg-boss does all of that natively on Postgres, the last through `key_strict_fifo` queues; Absurd adds durable multi-step workflows the design no longer needs.

8. **Money is integer EUR cents everywhere** (owner, 2026-10-01): every amount in events, projections and APIs is an integer number of euro cents (`…Cents`), never a float in euros.
9. **Tool-change events** (owner, 2026-10-01; names proposed). There are two kinds of tools, so two events:
   - `mcp.tools_changed`: a registered MCP server's tool list or schemas changed. The server is quarantined until re-reviewed.
   - `toolset.changed`: the computer's own tools changed, through a new computer image (CLI programs, runtimes, local stdio MCP such as Playwright) or Codex built-in tool settings (shell, `apply_patch`, `web_search`, `view_image`, `spawn_agent`). Admins review it, and computers pick it up at their next claim or resume.

   CLI programs are governed by what the image contains and by the gateway, which sees every network call they make; hosted built-ins such as `web_search` are allowed or stripped by the gateway on the model request.
10. **Sign-in is pinned to the silo's organisation in production** (owner, 2026-10-01): `OIDC_EXPECTED_ORG_ID` is required when `NODE_ENV=production`, so no other organisation on a shared Zitadel can sign in to a silo.
11. **Dev-only build data packages** (owner, 2026-10-01): transitive build-time data packages under CC-BY or CC0 (caniuse-lite, spdx data, mdn-data, from the Angular toolchain) are accepted. They never ship in a silo's runtime images, which stay OSI-only.
12. **Kubernetes-native computers** (owner, 2026-10-01): no cloud-specific feature or Pod Snapshot is required; suspend keeps the encrypted volume and resume mounts it in a warm Agent Sandbox Pod.

## Risks

- **Licences:** only OSI-approved open-source components run in customer silos. KurrentDB (KLv1) is ruled out. SurrealDB and Redpanda (BSL), EventSourcingDB (closed source) and Axon Server (commercial) fall under the same rule, and Restate's server licence must be checked in S0.8.
- **Young components:** agentgateway had a high-severity MCP authorisation advisory in 2026, and Agent Substrate isn't ready. Pin versions, track advisories, and keep policy decisions in OpenCrane so the gateway can be swapped.
- **Harness dependency:** keep the computer bridge thin, so Codex can be swapped for OpenCode or Goose.
- **Memory isolation:** enforce allowed scopes on every MCP call and test simultaneous member threads; no personal memory may leak through assistant notes, shared instructions or disk. Memory never grants anything.
- **Dreaming:** budget the nightly job, keep it within one scope, record changes as `memory.corrected`, and test correction, forgetting and replay.
- **Recall quality:** qualify Postgres full-text search on real tasks before adding vector search or a later projection.
- **Persistent volumes hold sensitive state:** use per-silo encrypted storage and short-lived tokens only; keep memory off the shared computer's disk and prevent a volume from being mounted by another computer identity.
- **Scope creep:** a phase starts only when the previous phase's live PASS is in the ledger.
