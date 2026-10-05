# Planned customer installation

**Planned design.** This page describes the intended customer installation, not a
working deployment. Read the [system map](../../README.md) for today's code and the
[current plan](../../plan.md) for the remaining work.

## Where it will run

Each customer gets one [silo](../../GLOSSARY.md#silo) on Kubernetes. Each silo has its
own application, gateway, computers, event log, database and secrets. Silos share only
the cluster-wide services that the team running the cluster looks after.

The cluster must provide gVisor, the extra security layer for computers. It must also
provide storage that keeps computer files, encrypts them and can take snapshots
(point-in-time copies). Any ordinary Kubernetes cluster should work, from a developer's
machine to a managed cloud cluster.

## Target cluster drawing

This drawing is an earlier plan, kept for reference. Its arrows show intended
connections, not calls or deployments that exist today. Background jobs and computer
claims now live in `apps/ops`, although the drawing still shows them inside the server
box.

```text
                    EXTERNAL
   ┌──────────┐  ┌───────────┐  ┌────────────────┐  ┌───────────────┐  ┌──────────────┐
   │ Zitadel  │  │ Model     │  │ Remote MCP     │  │ Company       │  │ Web          │
   │ (sign-in)│  │ providers │  │ servers (later)│  │ systems (Odoo)│  │              │
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
 │                      │   wake-ups, settlement, memory tidy-up    │   │ Postgres     │  │
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

## Parts still to build or prove

| Part | Intended job | What remains |
| --- | --- | --- |
| Helm installation | Package one customer silo for Kubernetes. | Build the charts and prove a fresh customer install. |
| ingress-nginx and cert-manager | Route incoming traffic and renew encrypted-connection certificates. | Package and check them in the customer install. |
| CloudNativePG operator | A program that runs PostgreSQL inside Kubernetes and looks after standby copies and backups. | Replace the dev database setup and prove recovery after failure. |
| Replicated NATS JetStream | Keep several copies of the event log, so it keeps working when one server fails. | Package it, and test switching to a copy (failover) and restoring from backup. |
| Odoo tool server | Use the business system with the requesting person's own rights. | Build the connector; `infra/odoo` is a test system, not this connector. |
| Memory tool server | Remember, recall, correct and forget facts within the permitted scope. | Build the service and its replay and access checks. |
| Team assistants and delegation | Share work while keeping access and spending tied to the requester. | Finish the product flows and test them together. |
| Scheduled work | Start agreed work at set times. | Build the routines and check their permissions and spending. |
| Screen takeover | Let a person control the assistant's screen and hand it back. | Finish control permissions, recording and live checks. |
| Hosted tool servers | Run checked, ready-made tool server packages (container images) with limited internet access. | Finish the install and release flow and test it live. |
| Outgoing computer traffic | Make the gateway the only permitted route to outside services. | Finish the rules for all computer traffic and prove they hold. |
| Backup and restore | Recover the event log, read data and computer files together. | Prove recovery on a fresh customer installation. |
| Logs and traces | Follow a request across services without exposing private data. | Package the OpenTelemetry collector, which gathers logs and traces, and check it in a customer installation. |

## Rules the planned installation must keep

- Keep each customer's data and computers separate.
- Record every business change as an event; rebuild read tables and permissions from it.
- Keep model-written code inside the assistant's computer.
- Keep lasting secrets in the secret store and give computers only short-lived tokens.
- Check both the person's and the assistant's permissions before any model or tool call.
- Set money aside, in whole euro cents, before each call, and charge the real cost once its use is reported.
- Ask for approval of the exact tool action when its rule is Ask.
- Show remembered facts only to people who are allowed to see them. Remembering a fact never gives anyone extra access.
- Use only the application and operating-system components allowed by the
  [licence rules](../../AGENTS.md#licences).

## Where to read more

- [Current plan](../../plan.md): deployment choices, tool protocol versions and remaining work.
- [Computer storage and screen decision](../adr/0006-computer-disk-and-live-view.md): how computers keep files and show their screen.
- [Event catalogue](events.md): the record of changes and the work each change starts.
- [Product contract](../product/product-contract.md): the intended product behaviour.
