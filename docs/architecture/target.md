# Planned customer installation

**Planned design.** This page describes the intended customer installation, not a
working deployment. Read the [system map](../../README.md) for today's code and the
[current plan](../../plan.md) for the remaining work.

## Where it will run

Install one [silo](../../GLOSSARY.md#silo) per customer on Kubernetes.
Give each silo its own application, gateway, computers, event log, database and secrets.
Share only the cluster services managed by the operator.

Provide gVisor, the extra security layer for computers, and storage that can keep
computer files, encrypt them and take snapshots. Support ordinary Kubernetes clusters;
developer clusters and managed cloud clusters are both intended targets.

## Target cluster drawing

Keep this earlier design drawing as a plan. Its arrows show intended connections;
they do not claim that the calls or deployments exist today. Background jobs now live
in `apps/ops`; the older server box below groups them with the back end.

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

## Parts still to build or qualify

| Part | Intended job | What remains |
| --- | --- | --- |
| Helm installation | Package one customer silo for Kubernetes. | Build the charts and prove a fresh customer install. |
| ingress-nginx and cert-manager | Route incoming traffic and renew encrypted-connection certificates. | Package and check them in the customer install. |
| CloudNativePG operator | Manage PostgreSQL, standby copies and backups. | Replace the dev database setup and prove recovery after failure. |
| Replicated NATS JetStream | Keep the event log available when a server fails. | Package replicated storage and test failover and restore. |
| Odoo tool server | Use the business system with the requesting person's own rights. | Build the connector; `infra/odoo` is a test system, not this connector. |
| Memory tool server | Remember, recall, correct and forget facts within the permitted scope. | Build the service and its replay and access checks. |
| Team assistants and delegation | Share work while keeping access and spending tied to the requester. | Finish the product flows and test them together. |
| Scheduled work | Start agreed work at set times. | Build the routines and check their permissions and spending. |
| Screen takeover | Let a person control the assistant's screen and hand it back. | Finish control permissions, recording and live checks. |
| Hosted tool servers | Run reviewed tool images with limited outside access. | Finish the install and release flow and test it live. |
| Outgoing computer traffic | Make the gateway the only permitted route to outside services. | Finish and qualify the rules for all computer traffic. |
| Backup and restore | Recover the event log, read data and computer files together. | Prove recovery on a fresh customer installation. |
| Logs and traces | Follow a request across services without exposing private data. | Package the collector and check the customer deployment. |

## Rules the planned installation must keep

- Keep each customer's data and computers separate.
- Record every business change as an event; rebuild read tables and permissions from it.
- Keep model-written code inside the assistant's computer.
- Keep lasting secrets in the secret store and give computers only short-lived tokens.
- Check the person and assistant's permissions before calling a model or tool.
- Hold spending in whole euro cents before a call, and settle it from reported use.
- Ask for approval of the exact tool action when its rule is Ask.
- Keep remembered facts within their permission scope; memory never grants access.
- Use only the application and operating-system components allowed by the
  [licence rules](../../AGENTS.md#licences).

## Where to read more

- [Current plan](../../plan.md): deployment choices, tool protocol versions and remaining work.
- [Computer storage and screen decision](../adr/0006-computer-disk-and-live-view.md): how computers keep files and show their screen.
- [Event catalogue](events.md): the record of changes and the work each change starts.
- [Product contract](../product/product-contract.md): the intended product behaviour.
