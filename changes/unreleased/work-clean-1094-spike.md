Compare JetStream plus PostgreSQL with a throwaway PostgreSQL event log while keeping
pg-boss. Record contract, latency, contention, restore-step and code-removal evidence,
and a Proposed ADR that defers a product switch to the owner. Product behaviour is unchanged.

Mark the latency comparison PARTIAL because PostgreSQL model/MCP writes omitted
transactional access-subject comparisons. Pin global-only conflicts with a mutation-checked
test, document the disposable contract database setup, and clarify the compared code paths.
