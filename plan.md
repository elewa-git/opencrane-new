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

## Phase 0: spikes (decide before building)

Each spike is one night of agent work plus a morning decision. The result is a one-page ADR in `docs/adr/`.

| # | Spike | Pass condition | Decides |
|---|---|---|---|
| S0.1 | **Codex app-server in a GKE Agent Sandbox Pod** | Streams a reply through agentgateway to a model; pauses for an approval and resumes; a sub-agent runs; after a Pod kill we can tell whether the call was sent | Harness choice (fallback: OpenCode, then Goose) |
| S0.2 | **agentgateway decision hook** | `ext_authz` fails closed when OpenCrane is down; oversized bodies are rejected; client headers are stripped; an injected credential reaches the MCP server and is not logged; the deny-until-approved flow works | Gateway choice (fallback: the Envoy stack) |
| S0.3 | **Warm pool + Pod Snapshots** | A warm Pod is bound to a computer identity at claim; suspend and resume with Codex and Chromium running; the token is refreshed on resume | Computer lifecycle |
| S0.4 | **Company brain isolation** | Cognee with one dataset per scope, and memify run per scope, cannot read another scope; the same test on SurrealDB with row-level permissions | Brain store: Cognee or SurrealDB |
| S0.5 | **Live view and takeover** | KasmVNC through the OpenCrane gateway: view-only for participants, control for the requester only; the agent pauses while a human is in control | Streaming component |
| S0.6 | **Kortix as a base?** | Self-hosted with our model gateway; check orgs/roles, change-request approvals, the sandbox layer and the licence | Whether to build the product layer on Kortix instead |

## Phases and acceptance

| Phase | Scope | Done when (live on a fresh install) | PRs (estimate) |
|---|---|---|---|
| **1. Foundation** | Repository scaffold (pnpm workspace, four apps: `web`, `server`, `computer`, `deploy`); CI with required checks; Helm umbrella from OpenCrane 1 charts; CNPG with backups on; Zitadel sign-in (copied auth library); OpenFGA with the first model | Sign in and out on the test silo; a backup exists; the restore drill passes | 10–14 |
| **2. Prototype: talk to your computer** | Computer image (Codex, runtimes, Playwright, MarkItDown); the bridge; claim and bind from the warm pool; chat UI from OpenCrane 1 components; file upload into the workspace; models through agentgateway with a simple cap | A person chats with their assistant, it reads an uploaded PDF, and the answer survives a reload and a Pod replacement | 15–20 |
| **3. Governed work** | Decision service: EUR price table, reserve-before-call, settlement from gateway logs; Allow/Ask/Block with the approval card; credential injection; an Odoo MCP adapter (from the `mcp-file-generator` template); screenshots; live view; takeover; audit | One Odoo read and one approved Odoo write pass live, with every refusal case; the budget stops the next call at its limit; takeover is audited | 25–35 |
| **4. Company product** | Groups, shared team assistants and child chats; members, tools, models, budgets, usage and audit screens; company brain (remember/recall/correct/forget, dreaming per scope, provenance); scheduled routines (Absurd schedule → message to the computer); delegation (Codex sub-agents under one root budget) | Each user story passes on the test silo, with cross-user, cross-scope and cross-silo denial | 35–50 |
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
3. History store: start with PostgreSQL only; add KurrentDB later if long histories or audit need it.
4. Cross-silo warm pools: per-silo pools for the MVP. Shared neutral pools only after a separate security ADR.
5. OpenFGA or SpiceDB. OpenFGA is the default for its Postgres backend; revisit if revocation latency fails a test.
6. The test silo and domain for weekly fresh installs, and the €5 live-provider envelope with a provider-side hard limit.
7. **Computer per assistant, not per conversation** (recommended). A person's assistant keeps one computer across its conversations, with the same logins, workspace and browser profile, like one laptop per colleague. A team assistant has one computer with team scope. Delegated children run as sub-agents in the same computer unless they need a different scope, in which case they get their own.

## Risks

- **Young components:** agentgateway had a high-severity MCP authorisation advisory in 2026, and Agent Substrate isn't ready. Pin versions, track advisories, and keep policy decisions in OpenCrane so the gateway can be swapped.
- **Harness dependency:** keep the computer bridge thin, so Codex can be swapped for OpenCode or Goose.
- **Dreaming and permission laundering:** consolidation runs per scope as a scoped principal, and memory never grants anything.
- **Snapshots hold memory:** use per-silo encrypted storage and short-lived tokens only.
- **Scope creep:** a phase starts only when the previous phase's live PASS is in the ledger.
