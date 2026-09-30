# Architecture decision records

One page per decision: the question, the options, the choice, and why.
Each spike in [plan.md](../../plan.md)'s Phase 0 produces one ADR here.

| # | Decision | Spike | Status |
|---|---|---|---|
| [0001](0001-event-store.md) | Event store: NATS JetStream vs a PostgreSQL event store | S0.7 | Draft, from spikes |
| [0002](0002-gateway.md) | Gateway: agentgateway vs the Envoy stack | S0.2 | Draft, from spikes |
| [0003](0003-harness.md) | Agent harness: Codex vs OpenCode vs Goose | S0.1 | Draft, from spikes |

"Draft, from spikes" means the spike has run (or is running) in
[`spikes/`](../../spikes/) but the ADR page itself has not been written up
here yet, or is still being written up. This scaffold (Phase 1) does not
depend on which way any of these three decisions goes; it only reserves
their place in the record.

## Format

Keep each ADR to one page:

1. **Question** — what is being decided, and by when.
2. **Options considered** — with their trade-offs.
3. **Decision** — the choice, and the pass condition it met (see the
   Phase 0 table in plan.md).
4. **Consequences** — what this rules in or out elsewhere in the system.

A superseded ADR is not deleted: mark it "Superseded by NNNN" and add the
new one.
