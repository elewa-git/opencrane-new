# PostgreSQL event store comparison

This throwaway experiment compares today's JetStream event log plus PostgreSQL with
an event log in PostgreSQL and NATS retired. pg-boss stays in both options.
No product code imports this folder, and this experiment makes no product change.
The [proposed recommendation](../../docs/adr/0007-postgres-event-store-comparison.md)
leaves the decision with the owner.

## Run it

From the repository root, install with `npm ci`. Provide `.tools/nats-server`,
OpenSSL, Docker, and the existing gateway binary fetched by
`bash spikes/s0-1c-real-model-smoke/scripts/fetch-tools.sh`. Then run:

```sh
bash spikes/s0-9-postgres-event-store/run.sh
nice -n 10 npx tsc --noEmit -p spikes/s0-9-postgres-event-store/tsconfig.json
```

The runner tests contracts first against `PG_TEST_URL`, then starts its own
`postgres:17.6-alpine` container named `pgtest-clean-1094`. It measures both stores
sequentially on this box and always removes that container with its volumes.
The 100,000-event logs use that private container and fresh local JetStream servers.
The shared test database holds only ordinary fixture projections, jobs and contracts.

## Results

Measured 12 November 2026 on the same Linux x86-64 box, Node 22.23.3.
This is a busy development machine, with one run and 30 samples per latency row.

| Measure | Result | JetStream plus PostgreSQL | PostgreSQL event log, NATS retired |
| --- | --- | --- | --- |
| (a) Decisions with 100,000 unrelated events | PASS | Model p95 204.08 ms; MCP 129.36 ms; destination 30.94 ms | Model p95 180.53 ms; MCP 107.17 ms; destination 42.71 ms |
| (b) Valid writes refused with 50 unrelated writers | PASS | 100/100 conflicts; 0 unavailable | 0/100 conflicts; 0 unavailable |
| (c) Restore steps and systems | PARTIAL | 12 planned steps; 2 event/relational systems | 10 planned steps; 1 event/relational system; full restore NOT RUN for either |
| (d) Existing product code that could go | PASS | 1,567 gross candidate lines across 12 files, including package backup/restore | Requires replacements and caller edits; net saving NOT RUN; no lines removed here |

Latency below gives **median / p95 / maximum**, in milliseconds, after adding
100,000 unrelated events. All three routes kept the existing volume test's bounds.

| Route | JetStream | PostgreSQL |
| --- | --- | --- |
| Model authorisation | 131.17 / 204.08 / 253.11 | 125.21 / 180.53 / 217.79 |
| MCP authorisation | 101.51 / 129.36 / 155.84 | 76.46 / 107.17 / 194.76 |
| Destination authority | 27.30 / 30.94 / 31.00 | 24.06 / 42.71 / 49.07 |

All seven methods exist: `ensureStream`, `append`, `readEvent`, `readStream`,
`subjectCount`, `subscribe`, `head`. Of the five copied contract files, **2/5 pass
completely** and **3/5 are PARTIAL** because NATS-specific cases are skipped.
All executed assertions in all five pass: 47 passed, 19 skipped, 0 failed.
Six additional PostgreSQL tests pass. There are no failing tests to explain;
[the detailed record](README.robot.md#contract-tests) names every skipped case and reason.

Fresh core journey: **FAIL** on the unchanged product’s 390 px upload-retry touch-target
assertion. The secondary stack was taken down; see the detailed record below.

## Read more

- [Detailed method, restore steps and code inventory](README.robot.md).
- [Raw latency samples](results/latency.jsonl) and [write counts](results/pressure.jsonl).
- [Fresh stack and source checks](README.robot.md#checks-and-journey).
