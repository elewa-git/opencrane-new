# Architecture decision records

One page per decision: the question, the options, the choice, and why.
Each spike in [plan.md](../../plan.md)'s Phase 0 produces one ADR here.

| # | Decision | Spike | Status |
| --- | --- | --- | --- |
| [0001](0001-event-store-nats-jetstream.md) | Event store: NATS JetStream vs a PostgreSQL event store | S0.7 | Draft, from spike evidence — ready for the morning decision |
| [0002](0002-gateway-agentgateway.md) | Gateway: agentgateway vs the Envoy stack | S0.2 | Draft, from spike evidence — ready for the morning decision |
| [0003](0003-harness-codex.md) | Agent harness: Codex vs OpenCode vs Goose | S0.1 | Draft, from spike evidence (local half only — S0.1b, inside an Agent Sandbox Pod under gVisor, is still open) |
| [0004](0004-handler-runtime.md) | Handler runtime: pg-boss vs Temporal vs Hatchet vs Restate (plan.md decision 7) | S0.8 | Proposed: pg-boss for reactions; qualification PARTIAL (visibility, production budget path and licence audit remain; Hatchet NOT_RUN, Restate excluded) |

## Format

Keep each ADR to one page:

1. **Question** — what is being decided, and by when.
2. **Options considered** — with their trade-offs.
3. **Decision** — the choice, and the pass condition it met (see the
   Phase 0 table in plan.md).
4. **Consequences** — what this rules in or out elsewhere in the system.

A superseded ADR is not deleted: mark it "Superseded by NNNN" and add the
new one.
