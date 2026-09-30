# OpenCrane 2

## The vision

**Every employee gets an AI assistant with its own computer, and the company stays in control.**

OpenCrane gives each person, and each team, an assistant that does real work: it reads documents, uses company tools, browses the web, runs code and remembers what matters. Every assistant works inside its own isolated computer, which you can think of as a managed laptop the company hands to a new colleague. That gives each assistant an identity, a network position and a workspace, and makes it easy to answer three questions: **who is acting, what can it reach, and what would a mistake expose?**

The company decides:
- where OpenCrane runs;
- which models it uses;
- what each assistant may see and do;
- which actions need a person's approval;
- how much may be spent.

Humans and assistants live in **one identity and permission system**. An assistant never sees more than the person it works for, and never more than its own grants. People can watch what their assistant is doing, step in and take over its screen, and hand control back.

A shared **company brain** builds up knowledge over time and consolidates it ("dreaming"), without ever letting knowledge leak across permission boundaries.

## What you can do with it (target)

- **Ask your assistant for real work:** "prepare my customer meeting", "reconcile these invoices", "summarise this contract". It uses the company systems and knowledge you may access.
- **Approve what matters:** each tool is set to *Allow automatically*, *Ask* or *Block*. Consequential actions show exactly what will change before you approve.
- **Watch and take over:** see screenshots or a live view of the assistant's computer, take control (for example to sign in), and hand it back.
- **Work together:** group chats with a shared team assistant, visible child chats, and delegation to other assistants within a shared budget.
- **Remember and forget:** personal and team memory with provenance, correction and deletion.
- **Stay in control as a company:** members, tools, models, EUR monthly budgets, audit and usage, all administered in the product.

## Design principles

1. **Reuse before building.** Use mature open-source components wherever one exists. OpenCrane's own code covers only what makes it OpenCrane: governance, identity binding, approvals, budgets and the product experience.
2. **The computer is the actor.** The agent runs *inside* its computer. The platform keeps the books (who may act, budgets, approvals, history) and never runs model-written code itself.
3. **OpenCrane decides; the gateway enforces; the network guarantees.** Every outbound call from a computer passes one gateway, which asks OpenCrane for decisions. Network policy makes the gateway the only way out.
4. **Memory never grants anything.** Permissions live only in the permission system. Knowledge and dreaming stay inside their permission scope.
5. **One owner per rule, in typed code.** Business rules live in TypeScript. The database holds data and only the constraints it must enforce.
6. **Evidence over claims.** A capability is done when it passes live on a fresh installation, not when its tests are green.
7. **Keep it small.** Few services, few libraries, small pull requests, and one short plan.

## Architecture

```
 Browser ──OIDC──▶ Zitadel (identities: humans + agent principals)
    │
    ▼
 OpenCrane app (TypeScript: API + decision service)  ◀──▶  PostgreSQL (CNPG)
 ├─ conversations, groups, approvals, admin, audit          app data, history, jobs (Absurd)
 ├─ claims a computer per conversation
 └─ decision service for the gateway (ext_authz)    ◀──▶  OpenFGA (who may see and do what)
    │
    ▼
 💻 Computer = GKE Agent Sandbox Pod (gVisor, warm pool, Pod Snapshots)
    ├─ Codex app-server (the agent harness) + a small bridge to OpenCrane
    ├─ workspace disk, python / node / git runtimes
    ├─ Playwright MCP → Chromium on a virtual display
    ├─ KasmVNC stream → live view and takeover (through the OpenCrane gateway)
    └─ MarkItDown / poppler for documents
          │  every call carries a short-lived computer token
          ▼
 🚪 agentgateway (one per silo) ──ext_authz──▶ OpenCrane decision service
    ├─▶ model providers   (reserve worst-case EUR cost before each call)
    ├─▶ MCP servers       (Allow / Ask / Block, credentials injected by the gateway)
    └─▶ web + package mirror (allowlist, logged)

 🧠 Company brain: Cognee, one dataset per permission scope, dreaming (memify) per scope
```

| Need | Component | OpenCrane's own part |
|---|---|---|
| Sign-in | Zitadel | Mapping identities to members and agents |
| Permissions for humans and agents | OpenFGA (Postgres backend) | The authorisation model; the "human ∩ agent" rule |
| Agent loop, tools, sub-agents | Codex app-server | The bridge: messages in, events out, approvals relayed |
| Computers | GKE Agent Sandbox + gVisor (open-source Agent Sandbox elsewhere) | Claim and bind a warm Pod to a computer identity |
| Browser, live view, takeover | Playwright MCP, Chromium, KasmVNC | View and control permissions; takeover audit |
| Egress, models, tools, budgets | agentgateway | Decision service: budgets, approvals, credential injection |
| Company brain and dreaming | Cognee (SurrealDB evaluated as an alternative) | Scope mapping, provenance, cross-scope promotion by approval |
| Data and durable jobs | PostgreSQL (CNPG), Absurd | Plain tables, no business rules in SQL |
| Upload scanning | ClamAV scanner (from OpenCrane 1) | — |
| Packages | Artifact Registry remote repositories (or Nexus) | — |
| Web app | Angular + PrimeNG, reusing OpenCrane 1 components | Chat, approvals, live view, admin |
| Deployment | Helm, one silo per customer, charts from OpenCrane 1 | Install and qualification scripts |

## Status

**Planning.** This repository starts OpenCrane 2. It succeeds the original OpenCrane platform (`opencrane-2` local repository, commit `10abd0ef6`), reusing its product contract, decisions, hardened infrastructure and proven components. See [plan.md](plan.md) for the phases, spikes and estimates.

Carried over so far:
- [Product contract](docs/product/product-contract.md)
- [Workspace and conversation user stories](docs/product/user-stories-workspace-and-conversations.md)
- [Accepted product decisions of 27 September 2026](docs/product/accepted-decisions-2026-09-27.md)
- [Architecture review brief that led to this version](docs/background/2026-09-30-architecture-thread-brief.md)

## Licence

OpenCrane 2 is free software under the **GNU Affero General Public License v3.0 or later**, the same licence as OpenCrane. See [LICENSE](LICENSE). Third-party components keep their own licences. Check each one before bundling: Codex and agentgateway are Apache-2.0; Cognee and KasmVNC have their own terms.
