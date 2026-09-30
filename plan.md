# OpenCrane 2: plan

This file holds the current plan only. When a phase is done, record the evidence in a short changelog entry and cut the detail from here.

## Goal

Reach the MVP defined in the [product contract](docs/product/product-contract.md) and the [user stories](docs/product/user-stories-workspace-and-conversations.md): an employee signs in, gets useful work done by an assistant with company tools and knowledge, reviews consequential actions, collaborates in a group, and returns later without losing work. Administrators control members, tools, models, permissions and spending. The [27 September decisions](docs/product/accepted-decisions-2026-09-27.md) apply: EUR monthly hard budgets with reserve-before-call, per-tool Allow automatically / Ask / Block, paying-group attribution and fresh test qualification.

**Constraint:** keep the architecture as simple as possible and reuse open-source components everywhere; see the README for the component list.

## How work runs: nightly agentic cycles

- **Night.** An orchestrator agent takes items from the **ready queue**: GitHub issues with acceptance criteria and all decisions made. It runs up to three implementation agents in parallel on independent items. Each produces **one PR of at most about 1,500 non-generated lines**, with tests, passing required checks, and a short evidence note. A separate review agent checks each PR.
- **Morning (human, about 1–2 hours).** Review and merge, or send back. Answer the decisions the night raised, and move new items into the ready queue.
- **Weekly (human + agent).** One fresh install on the test silo with the scripted journeys; the results go in the deploy ledger. A capability is done only on a ledger PASS.
- **Rules:**
  - no stacked PRs deeper than two, and no consolidation PRs;
  - required checks on `main` from day one;
  - nothing merges red;
  - decisions are issues with a needed-by date, never prose in this file.

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

## Responsibility split: gateway vs server

The gateway **enforces**; the OpenCrane server **decides** and owns the truth. The gateway holds nothing it can't lose: no business state, no per-user secrets at rest, and no decisions beyond static rules generated from server configuration.

| Concern | agentgateway | OpenCrane server | Other |
|---|---|---|---|
| Computer tokens | Verifies signature, expiry and audience (JWKS) | Mints them at claim; holds the signing key | Secret store |
| Coarse allowlist (which models, MCP servers, web domains exist in this silo) | Enforces it (CEL rules, routes) | Generates the gateway config from admin settings | — |
| Fine decisions (this computer, this tool, these arguments; Allow/Ask/Block; human ∩ agent) | Calls `ext_authz`, fails closed | Decides | OpenFGA |
| Budgets | Rate limits as a safety net; usage logs | EUR price table, reserve before the call, settle from logs | Postgres |
| Approvals | Denies until approved | Approval records, UI, single-use approvals bound to arguments | — |
| Company model keys (BYOK) | Uses them as backend credentials | Admin screen writes or rotates them | Kubernetes Secret or Secret Manager |
| Personal / connection credentials (OAuth, bearer) | Injects them into the upstream request | Connect, consent, refresh, revoke; hands the credential to the gateway per call | Secret store |
| Model routing, failover, MCP protocol, tool federation | ✅ | — | — |
| Web egress | Forward proxy with allowlist and logging | Allowlist policy | NetworkPolicy makes the gateway the only way out |
| Live view and takeover (human → computer) | — | Its own authenticated proxy | KasmVNC |
| Audit | Emits OpenTelemetry logs | The authoritative record: decisions, approvals, reservations, reconciled with gateway logs | — |

## Design rules for the main building blocks

### Computers
- **One computer per assistant** (recommended; confirm as decision 7). Conversations are threads on that computer. A team assistant has its own computer with team scope only; group chats always use the team computer, never a personal one.
- **Binding:**
  - Warm Pods are tenant-neutral until claimed.
  - At claim, OpenCrane binds a Pod to one assistant and issues a short-lived token.
  - A Pod never returns to the pool after a binding ends; it is destroyed.
  - Idle computers are suspended to per-silo encrypted Pod Snapshots.
- **No lasting secrets in a computer.** Codex, Playwright and KasmVNC run inside it. All network traffic goes through the gateway, and the package mirror is reached through it as well.
- **Delegated children** run as Codex sub-agents in the same computer. They get their own computer only when they need a different scope.

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

### Per-user MCP credentials (e.g. per-user Odoo)
- **Default:** one stateless MCP deployment. Per call, the decision service releases *this user's* lease for the selected profile, and the gateway injects it. The MCP server trusts only the injected credential and ignores identity in arguments.
- **Fallback, for servers that only take startup credentials:** one instance per user, scaled to zero when idle. Never inside the user's computer.
- **Team assistants** use either a company connection (a bot user owned by an admin) or the requester's own profile; this is decided per connection.
- **Audit:** every credential release is recorded (user, profile, computer, tool, request).

### Company brain
- **Scoped datasets:** one Cognee dataset per permission scope (person, team, space or channel).
- **Reads:** a read covers only the scopes that OpenFGA allows for the human ∩ agent.
- **Dreaming** (memify) runs per scope, as that scope's principal, and never across scopes. Every derived fact keeps provenance to its sources.
- **Promotion across scopes** (personal → team → company) is an explicit, approved grant change.
- **Access path:** the brain is reached as an MCP server (`remember`, `recall`, `correct`, `forget`) through the gateway, so it follows the same decision path as any tool.
- **Messy per-document sources** (mailboxes, CRM records) are queried live through MCP with the person's own credentials, not copied into the brain.

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
- **Web app:** the server streams chat text and activity to the browser over SSE. The live view is a separate stream.

### Live view and takeover
- **The stream never leaves the Pod directly.** The KasmVNC stream reaches people only through the OpenCrane server's authenticated proxy.
- **Permissions:** viewing is for conversation participants; control is for the requester or whoever they grant it to.
- **Takeover pauses the agent** and is audited as a human action. Browser sessions made during a takeover stay in the computer's profile, so snapshots are sensitive data.

## Event-driven core

Everything that happens is recorded as a **domain event**, and everything that follows is a **reaction** to one. There is no second datastore: events live in PostgreSQL, next to the state they describe.

- **Events are facts, named in the past tense:** `message.posted`, `approval.decided`, `effect.observed`, `member.removed`, `routine.due`, `memory.written`, `tool.list.changed`. Each has a typed schema in TypeScript and a CloudEvents-style envelope (id, type, source, time, subject, silo, principal, correlation ids: conversation, turn, permit, reservation, approval). The catalogue is documented with AsyncAPI.
- **Commands write one event, nothing else ("listen to yourself").** A command validates, then does **one atomic append** to the event log. State tables (conversations, budgets, approvals, memberships) are **projections** kept up to date by listeners. There are no multi-table business transactions and no "write state, then publish".
- **The only synchronous atomic step is a conditional append,** where a rule needs one consistent answer: an expected stream version, or a unique key, on the budget stream (reserve), the approval (use once) and state-guarded commands (only a *pending* approval can be decided). One stream per rule (for example one per budget) serialises concurrent writers without locks across tables.
- **Consistency windows are explicit:** the UI may lag its own writes by milliseconds, and revocation takes effect within a documented bound (target under 2 seconds) as listeners update OpenFGA and the credential-release rules.
- **Delivery:** the job queue (see decision 8) fans each event out to subscriber queues, **in order per stream** (per conversation, per budget). Delivery is at-least-once: handlers are idempotent (keyed by event id), retried with backoff, and failed events land in a monitored dead-letter queue that can be replayed. `LISTEN/NOTIFY` wakes the browser streams.
- **Three event sources, one log:**
  1. server commands (decisions, approvals, admin changes);
  2. computer reports (Codex events through the bridge);
  3. gateway observations (external calls from its logs).

  The audit view is a read over this log.
- **Examples of reactions:**

| Event | Reaction |
|---|---|
| `approval.decided` | Wake the computer and deliver the decision |
| `effect.observed` | Settle the budget reservation |
| `member.removed` | Remove OpenFGA relations, stop credential release, suspend their computers |
| `routine.due` | Post the routine's message to its assistant |
| `memory.written` | Queue dreaming for that scope |
| `tool.list.changed` | Quarantine the MCP server until re-reviewed |

- **Rules:**
  - An **event never grants anything.** Each handler rechecks current permissions before acting.
  - Events are append-only. "Forget" purges payloads, or deletes the per-conversation key, and leaves a tombstone.
  - Handlers never call each other directly; they emit new events.
- **Later, without changing the core:** Debezium change data capture publishes the event log to NATS JetStream or Kafka for SIEM export, analytics across silos or external integrations. Postgres stays the source of truth.

## Data stores

**One PostgreSQL per silo** (a CNPG cluster with several databases, point-in-time backups to GCS) holds almost everything. Other stores are added only where Postgres genuinely can't do the job.

| Store | Holds | Why |
|---|---|---|
| **PostgreSQL (CNPG), database `opencrane`** | The **event log** (the source of truth; unique per stream and version), plus the projections built from it: members, assistants, computers, conversations, activity, approvals, budgets, MCP catalogue and connection metadata, and the audit view | One engine, transactions, point-in-time restore, well known; business rules in TypeScript |
| same cluster, database `absurd` | Durable jobs: approvals waiting, schedules, settlement, dreaming runs | Absurd runs on Postgres; no extra queue |
| same cluster, database `openfga` | OpenFGA relationships (humans, agents, scopes) | OpenFGA's Postgres backend; one backup with the rest |
| same cluster, database `cognee` (+ pgvector) | Cognee metadata and embeddings | Cognee supports pgvector and Postgres for relational data |
| **Cognee graph store** | The knowledge graph | Cognee's default embedded graph (Ladybug) on a per-silo volume with snapshots. Its all-Postgres graph option is attractive but documented as a demo; qualify it in S0.4 before relying on it |
| **Object storage (GCS)** | Uploads and generated files, Pod Snapshots, database backups | Not a database; per-silo buckets, encrypted |
| **Secret store** (Kubernetes Secrets or GCP Secret Manager) | Company model keys, per-user credentials, the token-signing key | Secrets never go in Postgres |

**Not in the first version:**
- **KurrentDB:** add it only if long histories or audit streams need it.
- **SurrealDB:** it replaces the Cognee stores only if spike S0.4 chooses it.
- **Redis:** only if the gateway runs several replicas and needs shared rate-limit counters. Budgets don't need it; they live in Postgres behind `ext_authz`.

**Zitadel** keeps its own database, run by the platform or as Zitadel Cloud. It is shared across silos with one organisation per customer, as in OpenCrane 1.

## Phase 0: spikes (decide before building)

Each spike is one night of agent work plus a morning decision. The result is a one-page ADR in `docs/adr/`.

| # | Spike | Pass condition | Decides |
|---|---|---|---|
| S0.1 | **Codex app-server in a GKE Agent Sandbox Pod** | Streams a reply through agentgateway to a model; pauses for an approval and resumes; a sub-agent runs; after a Pod kill we can tell whether the call was sent | Harness choice (fallback: OpenCode, then Goose) |
| S0.2 | **agentgateway decision hook** | Speaks MCP 2026-07-28 end to end; rejects other versions and header/body tool mismatches; `ext_authz` fails closed when OpenCrane is down; oversized bodies are rejected; client headers are stripped; an injected credential reaches the MCP server and is not logged; the deny-until-approved flow works | Gateway choice (fallback: the Envoy stack) |
| S0.3 | **Warm pool + Pod Snapshots** | A warm Pod is bound to a computer identity at claim; suspend and resume with Codex and Chromium running; the token is refreshed on resume | Computer lifecycle |
| S0.4 | **Company brain isolation** | Cognee with one dataset per scope, and memify run per scope, cannot read another scope; the same test on SurrealDB with row-level permissions | Brain store: Cognee or SurrealDB |
| S0.5 | **Live view and takeover** | KasmVNC through the OpenCrane gateway: view-only for participants, control for the requester only; the agent pauses while a human is in control | Streaming component |
| S0.6 | **Kortix as a base?** | Self-hosted with our model gateway; check orgs/roles, change-request approvals, the sandbox layer and the licence | Whether to build the product layer on Kortix instead |

## Phases and acceptance

| Phase | Scope | Done when (live on a fresh install) | PRs (estimate) |
|---|---|---|---|
| **1. Foundation** | Repository scaffold (pnpm workspace, four apps: `web`, `server`, `computer`, `deploy`); CI with required checks; Helm umbrella from OpenCrane 1 charts; CNPG with backups on; Zitadel sign-in (copied auth library); OpenFGA with the first model | Sign in and out on the test silo; a backup exists; the restore drill passes | 10–14 |
| **2. Prototype: talk to your computer** | Computer image (Codex, runtimes, Playwright, MarkItDown); the bridge; claim and bind from the warm pool; chat UI from OpenCrane 1 components; file upload into the workspace; models through agentgateway with a simple cap | A person chats with their assistant, it reads an uploaded PDF, and the answer survives a reload and a Pod replacement | 15–20 |
| **3. Governed work** | Decision service: EUR price table, reserve-before-call, settlement from gateway logs; Allow/Ask/Block with the approval card; the MCP install flow; per-user connections and credential injection; the Odoo MCP (our `odoo-mcp-server`, remote mode); screenshots; live view; takeover; audit | One Odoo read and one approved Odoo write pass live, with every refusal case; the budget stops the next call at its limit; takeover is audited | 25–35 |
| **4. Company product** | Groups, shared team assistants and child chats; members, tools, models, budgets, usage and audit screens; company brain as an MCP server (remember/recall/correct/forget, dreaming per scope, provenance); scheduled routines (Absurd schedule → message to the computer); delegation (Codex sub-agents under one root budget) | Each user story passes on the test silo, with cross-user, cross-scope and cross-silo denial | 35–50 |
| **5. Qualification and hardening** | Weekly fresh installs; backup/restore of Postgres, Cognee and snapshots together; security review of the gateway and live-view exposure; negative tests; operator docs | A release candidate passes the full journey list on a fresh install; no open Critical/High finding | 15–20 |

## Estimate

**Assumptions:**
- About **3 mergeable PRs per night** (three parallel agents, one PR each), **5 nights a week**.
- About 1–2 hours of human review each morning.
- A rework factor of **1.3–1.5×** for rejected PRs and fixes found during live runs.

These are planning estimates, not measurements. Re-estimate after Phase 2 from the real throughput.

| Milestone | Nights of agent work | Calendar (5 nights/week, with rework) |
|---|---|---|
| Phase 0: spikes and decisions | 6 | **Week 1–2** |
| Phase 1: foundation | 4–5 | Week 2–3 |
| **Phase 2: working prototype** | 5–7 | **About week 3–4** |
| Phase 3: governed work | 9–12 | Week 5–8 (first live governed action around week 6) |
| Phase 4: company product | 12–17 | Week 8–13 |
| Phase 5: qualification | 5–7 plus human-run live tests | Week 13–16 |
| **MVP** | **About 40–55 nights** | **About 11–16 weeks** |

**What moves the date:**
- **Human bandwidth, the main limit.** Morning review, decisions, and human-only steps: identity-provider changes, approvals that need a real re-login, visual approval.
- **Spike outcomes.** Adopting Kortix could cut Phases 2–4 substantially. A failed harness or gateway spike adds about 1–2 weeks.
- **Live bring-up.** OpenCrane 1 needed 20–30 ledger entries per fresh install. Scripted, weekly installs from Phase 1 onwards are meant to bring that down.

## Copy from OpenCrane 1 (source commit `10abd0ef6`)

Record the source commit in each copied file's header or README.

| Area | Copy | Change on copy |
|---|---|---|
| Product | Contract, user stories, 27 September decisions (done), admin design targets (`docs/design/administration-lifecycle/`, `tests/design-targets/`) | None |
| Infrastructure | Prerequisite scripts (ingress, cert-manager, CNPG pins, CNI check, GKE storage and snapshots, DNS), `configure-oidc.sh`, the `apps/postgres` chart, the Agent Sandbox hardening chart, the Cognee chart and patches, the ClamAV scanner, suspend/teardown/verify scripts | Postgres backups on; warm pools allowed; Agent Sandbox v1.x; add the Cognee key creator; add the logout redirect in OIDC config |
| Libraries | `libs/backend/observability`; `infra/auth` (OIDC + encrypted sessions); `infra/workload-identity`; `infra/agent-sandbox` (claim adapter); `infra/mcp-remote-client` (SSRF guard); the MCP credential secret store; `infra/http`; `infra/workflows` (Absurd); members and invitations; BYOK and model registration | Logout follows `endSessionUrl`; step-up checks `auth_time`; grants become OpenFGA relations |
| Authorisation vocabulary | `libs/models/authorization` catalogue | Rewritten as the OpenFGA model |
| Frontend | Theme, UI elements, conversation components, **approval card**, A2UI rendering, onboarding, members; Storybook | About 5 libraries in total; Linux-only screenshots for about 30 key states |
| Process | A short AGENTS.md, the `review`, `review-verifier` and `deploy` agents, the dependency-boundary lint, the deploy-ledger practice | ESLint instead of custom style scripts |

**Do not copy:**
- the KurrentDB turn protocol, activation queue, receipts and sagas;
- the SQL business-rule triggers and baseline tooling;
- per-attempt model keys and the pre-forward retry;
- the server-side model loop and turn compiler;
- McpTask, the run-tree ledger, skill-authoring, knowledge/retrieval, ResourceShare, usage snapshots;
- the separate artifact service and preprocessor;
- the heavyweight review gates.

## Open decisions (owner)

1. Brain store: Cognee or SurrealDB. Decided by spike S0.4.
2. Build on Kortix, or on Codex plus our own product layer. Decided by spike S0.6.
3. **Event log store:** a PostgreSQL event table with (stream, version) uniqueness first, for one engine and one backup. KurrentDB is the upgrade if native streams, subscriptions and projections are wanted; it must then be the *only* place commands write.
4. Cross-silo warm pools: per-silo pools for the MVP. Shared neutral pools only after a separate security ADR.
5. OpenFGA or SpiceDB. OpenFGA is the default for its Postgres backend; revisit if revocation latency fails a test.
6. The test silo and domain for weekly fresh installs, and the €5 live-provider envelope with a provider-side hard limit.
7. **Computer per assistant, not per conversation** (recommended). A person's assistant keeps one computer across its conversations, with the same logins, workspace and browser profile, like one laptop per colleague. A team assistant has one computer with team scope. Delegated children run as sub-agents in the same computer unless they need a different scope, in which case they get their own.
8. **Job queue: pg-boss (recommended) or Absurd.** The computer design removes turn orchestration, so what remains is cron, retries, one-job-per-key and event fan-out. pg-boss does that natively on Postgres; Absurd adds durable multi-step workflows the design no longer needs.

## Risks

- **Young components:** agentgateway had a high-severity MCP authorisation advisory in 2026, and Agent Substrate isn't ready. Pin versions, track advisories, and keep policy decisions in OpenCrane so the gateway can be swapped.
- **Harness dependency:** keep the computer bridge thin, so Codex can be swapped for OpenCode or Goose.
- **Dreaming and permission laundering:** consolidation runs per scope as a scoped principal, and memory never grants anything.
- **Snapshots hold memory:** use per-silo encrypted storage and short-lived tokens only.
- **Scope creep:** a phase starts only when the previous phase's live PASS is in the ledger.
