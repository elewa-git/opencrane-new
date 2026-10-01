# ADR 0004: pg-boss for ordered reactions, provisionally

**Status:** Proposed; S0.8 is PARTIAL. 2026-10-01.
[Evidence and reproducible commands](../../spikes/s0-8-handler-runtime/README.md).
This recommendation does not mark the Phase 1 gate as passed.

## Question and options

Which runtime gives ordered, single-writer event handlers, isolated retries,
dead letters, operator visibility and synchronous budget answers per silo?
Facts must remain in the event store; workflow histories and queue rows are
execution state, not a second source of business truth.

| Candidate | Evidence / limitation |
|---|---|
| pg-boss 12.35.0, MIT | Three host runs passed ordering, retry-in-place, guarded crash effects and operations assertions against embedded PostgreSQL. Visibility is partial; the budget benchmark is not the event-store path. |
| Temporal Server 1.32.0 / TS SDK 1.24.0, MIT | Three host runs passed ordering, poison/retry, guarded crash effects and operations assertions with PostgreSQL-backed Temporal. Visibility is partial; the budget benchmark is not the event-store path. The local-activity variant exceeded its ceiling and remains skipped. |
| Hatchet, MIT | NOT_RUN: CLI starts Docker; Go source build was not attempted within the disk allowance. No claim that Docker-free execution is impossible. |
| Restate | EXCLUDED before installation: server BSL-1.1 is not OSI-approved. Full licence text is saved with the spike. |

## Recommendation

**Use pg-boss for reactions, subject to completing the remaining qualification.** It adds
queues to the PostgreSQL already operated per silo and fits cron, fan-out and
ordered retries without a workflow service. The measured local workload does
not justify Temporal's extra services, history management and workflow
versioning burden. Temporal remains a credible alternative when durable
multi-step orchestration is required.

Use a queue per handler, key by stream, dispatch each stream sequentially and
deduplicate effects by event id in the same transaction as the handler's
checkpoint. Queue job-id deduplication expires with retention. Repair a failed
FIFO head with `retry()`; `redrive()` copies it behind successors and is not an
ordered repair. Audit any intentional skip.

**Do not select the budget implementation from this benchmark.** A silo-wide
budget naturally receives concurrent calls from many computers. The old ADR's
assumption of one caller was wrong. In the inherited run, 100 concurrent
requests had p99 5.5 s with staggered pg-boss polling and 48.1 s with NOTIFY;
Temporal's ordinary-activity version had p99 2.2 s. Sequential p50 was 21.1,
3.1 and 49.9 ms respectively. These are test-double observations, not an
`ext_authz` latency guarantee. A production budget actor must return only
after one conditional event-store append, recognise duplicate commands from
entity history, fence old writers and rebuild its projection. Neither adapter
nor the advisory-lock baseline proves that path.

## Consequences and remaining gate

- The three required clean host runs are now complete. Keep verdicts tied to
  assertions: runtime delivery and operations pass, while the full spike
  remains PARTIAL for visibility, production budget integration and licence
  audit.
- Ship durable per-handler attempt logs and an operator view. Both runtimes
  expose counts and last errors; the tested application log arrays are
  volatile. Temporal's UI shell/API check is not a browser-rendering test.
- Measure production budget contention and failure recovery against the real
  event store before choosing its transport. Reject the observed local-activity
  variant: its external ledger reached 740 cents against a 500-cent ceiling.
- Qualify multi-process lease expiry, lost replies, retry retention and crash
  recovery; SIGKILL plus a guarded SQL insert does not prove exactly-once
  external calls. Complete the linked-dependency licence audit and runtime
  image inventory; no non-OSI build data may ship inside a silo.
- Local footprint observations favour pg-boss: one Node app plus existing
  PostgreSQL. Temporal adds four services (which can share a process), workers,
  SQL schemas and UI. The spike's split processes are not a production HA test.
