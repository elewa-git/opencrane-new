# OpenCrane 2

[Changelog](CHANGELOG.md)

## The vision

**Every employee gets an AI assistant with its own computer, and the company stays in control.**

OpenCrane gives each person, and each team, an assistant that does real work: it reads documents, uses company tools, browses the web, runs code and remembers what matters. Each assistant has its own isolated computer, which you can think of as a managed laptop the company hands to a new colleague. That gives every assistant an identity, a network position and a workspace, and makes three questions easy to answer: **who is acting, what can it reach, and what would a mistake expose?**

The company decides:

- where OpenCrane runs;
- which models it uses;
- what each assistant may see and do;
- which actions need a person's approval;
- how much may be spent.

Humans and assistants live in **one identity and permission system**. An assistant never sees more than the person it works for, and never more than its own grants. People can watch their assistant work, take over its screen, and hand control back.

A **memory that learns and consolidates** ("dreaming") is scoped to people, assistants and groups, without ever letting knowledge cross a permission boundary.

## What you can do with it (target)

- **Ask your assistant for real work:** "prepare my customer meeting", "reconcile these invoices", "summarise this contract". It uses the company systems and knowledge you may access, **as you**. In Odoo, for example, it acts with your own Odoo rights.
- **Approve what matters:** each tool is set to *Allow automatically*, *Ask* or *Block*. Consequential actions show exactly what will change before you approve.
- **Watch and take over:** see screenshots or a live view of the assistant's computer, take control (for example to sign in), and hand it back.
- **Work together:** group chats with a shared team assistant, visible child chats, and delegation within one shared budget.
- **Remember and forget:** personal and team memory with provenance, correction and deletion.
- **Stay in control as a company:** members, tools, models, EUR monthly budgets, audit and usage, all administered in the product.

## Key ideas

1. **One computer per assistant.** A person's assistant keeps one computer across its conversations, with the same workspace, browser profile and logins, like one laptop per colleague. A team assistant has one computer with team scope.
2. **The computer is the actor.** The agent (Codex) runs *inside* its computer: it calls models, uses tools, browses and runs code there. The platform keeps the books and never runs model-written code itself.
3. **OpenCrane decides; the gateway enforces; the network guarantees.** Every outbound call from a computer goes through one gateway per silo, which asks OpenCrane for each sensitive decision. Network policy makes the gateway the only way out.
4. **No lasting secrets in a computer.** A computer holds only short-lived tokens. The gateway adds the right credential (company key, or *this person's* Odoo login) to each upstream request.
5. **MCP 2026-07-28 only.** All network tools use the stateless MCP revision: one request, one identity, no sessions.
6. **Memory never grants anything.** Permissions live only in the permission system. Knowledge, and the dreaming that consolidates it, stays inside its permission scope.
7. **Reuse before building, and keep it small.** Mature open-source components do the heavy lifting. OpenCrane's own code covers governance, identity binding, approvals, budgets and the product experience. Business rules live in typed TypeScript, not in SQL.
8. **Event-driven.** Every change is an event in the event store, the only source of truth. PostgreSQL holds content (who owns what, installed MCP servers, conversations) as projections that can be rebuilt by replay. [The event catalogue](docs/architecture/events.md) states exactly which event triggers which logic.
9. **Evidence over claims.** A capability is done when it passes live on a fresh installation.

## Architecture: the whole cluster

A conformant Kubernetes cluster hosts one **silo** per customer. It must provide a gVisor RuntimeClass and a CSI storage class with volume snapshots. k3d on a developer box, such as a DigitalOcean droplet, DigitalOcean Kubernetes, Hetzner and GKE are supported targets; GKE is not the platform. Each silo is fully isolated, with its own namespaces, database, gateway, computers and secrets.

```text
                    EXTERNAL
   ┌──────────┐  ┌───────────┐  ┌────────────────┐  ┌───────────────┐  ┌──────────────┐
   │ Zitadel  │  │ Model     │  │ Remote MCP     │  │ Company       │  │ Web          │
   │ (sign-in)│  │ providers │  │ servers (v2)   │  │ systems (Odoo)│  │              │
   └────▲─────┘  └─────▲─────┘  └───────▲────────┘  └──────▲────────┘  └──────▲───────┘
        │              │                │                  │                  │
 ═══════╪══════════════╪════════════════╪══════════════════╪══════════════════╪═════════════
        │  KUBERNETES  │                │                  │                  │
        │              │                │                  │                  │
 ┌──────┴────── PLATFORM (shared, operator-managed) ───────────────────────────────────────┐
 │ ingress-nginx · cert-manager · CNPG operator · Agent Sandbox + gVisor RuntimeClass      │
 │ warm pools · CSI volume storage · network-policy dataplane · OpenTelemetry collector    │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
        │              │                │                  │                  │
 ┌──────┴──────────────┴──── SILO "acme" (one per customer) ┴──────────────────┴──────────┐
 │                                                                                        │
 │  acme-app                                                                              │
 │  ┌───────────────┐   ┌───────────────────────────────────────────┐   ┌──────────────┐  │
 │  │ web (Angular) │──▶│ opencrane-server                          │──▶│ OpenFGA      │  │
 │  └───────▲───────┘   │ • API: chats, groups, admin, audit        │   │ humans +     │  │
 │          │           │ • claim & bind computers                  │   │ agents: who  │  │
 │  browser ┘           │ • decision service (ext_authz):           │   │ may do what  │  │
 │  (via ingress)       │   budgets, Allow/Ask/Block, credentials   │   └──────────────┘  │
 │                      │ • live-view / takeover proxy              │   ┌──────────────┐  │
 │                      │ • reactions + jobs (pg-boss): schedules,  │──▶│ Memory facts │  │
 │                      │   wake-ups, settlement, dreaming          │   │ Postgres     │  │
 │                      └──────▲─────────────▲──────────────┬───────┘   │ projection   │  │
 │                             │ext_authz    │live view     │claim      └──────────────┘  │
 │  acme-gateway               │             │              │                             │
 │  ┌──────────────────────────┴───────────┐ │              │                             │
 │  │ agentgateway: the ONLY way out       │─┼──────▶ models · remote MCP · web (allowlist)│
 │  │ • checks computer token (JWKS)       │ │                                            │
 │  │ • CEL allowlist, rate limits         │ │                                            │
 │  │ • asks the decision service          │ │                                            │
 │  │ • injects credentials, logs          │─┼──────▶ acme-mcp (hosted MCP servers)       │
 │  └──────────▲───────────────────────────┘ │         ┌────────────────────────────────┐ │
 │             │ all traffic,                │         │ Odoo MCP (stateless, per-call  │ │
 │             │ short-lived token           │         │ credential) · memory MCP       │ │
 │  acme-computers (gVisor)                  │         │ (remember/recall) · adapters   │ │
 │  ┌──────────┴──────────────────────────┐  │         │ ingress from the gateway only  │ │
 │  │ 💻 Alice's assistant   💻 Sales team │  │         └────────────────────────────────┘ │
 │  │ ├─ Codex app-server + bridge        │◀─┘                                            │
 │  │ ├─ workspace disk · python/node/git │   ┌─────────────────┐  ┌──────────────────┐   │
 │  │ ├─ Chromium + Playwright MCP        │   │ acme-db         │  │ acme-secrets     │   │
 │  │ ├─ KasmVNC (live view, takeover)    │   │ CNPG Postgres:  │  │ company keys,    │   │
 │  │ └─ MarkItDown / poppler             │   │ content (replay-│  │ per-user creds,  │   │
 │  │ warm pool · volume kept on suspend  │   │ able), OpenFGA  │  │ signing key      │   │
 │  └─────────────────────────────────────┘   └─────────────────┘  └──────────────────┘   │
 │    acme-events: NATS JetStream — every event, the only source of truth → projections   │
 │    ClamAV scanner (uploads) · package mirror access (npm / PyPI) through the gateway   │
 └────────────────────────────────────────────────────────────────────────────────────────┘
        (next silo: "globex" — same layout, nothing shared except the platform layer)

 Storage outside: S3-compatible per-silo buckets (encrypted files and backups) · any OCI registry (images & package mirror)
```

### How one request flows

1. Alice asks her assistant in the web app. **opencrane-server** appends `message.posted` to the event store; a reaction wakes Alice's computer. OpenCrane claims a warm Pod, mounts her computer's encrypted volume, and refreshes its computer and turn tokens. Codex resumes the thread from its session files.
2. **Codex** in the computer plans the work. Each model call, tool call or web request goes to **agentgateway** with the computer's short-lived token.
3. agentgateway checks the token and its allowlist, then asks the **decision service**. The service consults OpenFGA ("Alice ∩ her assistant may use Odoo read?"), reserves the worst-case EUR cost, and applies the tool's Allow/Ask/Block mode.
4. **Ask:** the call is refused with an approval id, Alice sees the approval card, and after she approves, the retry passes (single use, bound to those exact arguments).
5. **Allowed:** the gateway adds Alice's Odoo credential for that one request, and the stateless **Odoo MCP** acts in Odoo as Alice.
6. The result flows back as events (`agent.message_completed`, `effect.observed`); projections update the conversation, audit and usage, and the budget actor settles the actual cost. Alice can open the **live view** of her assistant's computer at any time and take over.

## Components

| Need | Component (open source unless noted) | OpenCrane's own part |
| --- | --- | --- |
| Sign-in | Zitadel | Map identities to members and agents |
| Permissions for humans and agents | OpenFGA (Postgres backend) | The authorisation model and the "human ∩ agent" rule |
| Agent loop, tools, sub-agents | Codex app-server | The bridge: messages in, events out, approvals relayed |
| Computers | `kubernetes-sigs/agent-sandbox` controller (`SandboxTemplate`, `SandboxWarmPool`, `SandboxClaim`) + gVisor RuntimeClass | Claim a warm Pod, bind it to an assistant, and mount its persistent volume |
| Browser, live view, takeover | Chromium, Playwright MCP, KasmVNC | View and control permissions, takeover audit |
| Egress, models, tools | agentgateway (one per silo) | Gateway config generated from admin settings |
| Budgets, approvals, credentials | — | The decision service behind `ext_authz` |
| Tool servers | MCP 2026-07-28 servers; our Odoo MCP; hosted adapters | Install flow, tool review, per-user connections |
| Memory | OpenCrane memory MCP on Postgres; Cognee later | Per-scope facts, full-text recall, correction, forgetting and nightly dreaming |
| Events (source of truth) | NATS JetStream (Apache-2.0) | The event catalogue, command handlers, projections, reactions |
| Content and jobs | PostgreSQL (CNPG) projections, pg-boss (ordered per stream, cron) | Rebuildable content tables, no business rules in SQL |
| Secrets | Kubernetes Secrets or an external secret store | Credential lifecycle: connect, refresh, revoke |
| Upload scanning | ClamAV scanner (from OpenCrane 1) | — |
| Packages | Any OCI registry; Nexus or another package mirror | — |
| Web app | Angular + PrimeNG, reusing OpenCrane 1 components | Chat, approvals, live view, admin |
| Deployment | Helm, one silo per customer, charts from OpenCrane 1 | Install and qualification scripts |

## Status

**Planning.** This repository starts OpenCrane 2. It succeeds the original OpenCrane platform (local folder `opencrane-2`, commit `10abd0ef6`) and reuses its product contract, decisions, hardened infrastructure and proven components. See [plan.md](plan.md) for the spikes, phases, rules and estimate: **a prototype in about 4–5 weeks and the MVP in about 12–16 weeks** of nightly agentic cycles.

Carried over so far:

- [Product contract](docs/product/product-contract.md)
- [Workspace and conversation user stories](docs/product/user-stories-workspace-and-conversations.md)
- [Accepted product decisions of 27 September 2026](docs/product/accepted-decisions-2026-09-27.md)
- [Architecture review brief that led to this version](docs/background/2026-09-30-architecture-thread-brief.md)

The Phase 1 [member authorisation projection](libs/authz/README.md) includes
real-service evidence for membership, revocation, retry and rebuild. Server wiring
and fresh-silo qualification are **NOT RUN**; see its [receipt](libs/authz/evidence.md).

## Licence

OpenCrane 2 is free software under the **GNU Affero General Public License v3.0 or later**, the same licence as OpenCrane. See [LICENSE](LICENSE). Only OSI-approved open-source components run inside customer silos. Third-party components keep their own licences: Codex, agentgateway and NATS are Apache-2.0; check KasmVNC (GPL-2.0) and every new component before bundling.
