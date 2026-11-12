# Event log in PostgreSQL: comparison with JetStream

Date: 12 November 2026. Status: **Proposed**. Owner decision pending.

## Question

Should the silo keep JetStream for its event log alongside PostgreSQL, or put the
log in PostgreSQL and retire NATS? pg-boss stays for job queues, as the owner decided
on 12 November. This tests ADR 0001's previously untested PostgreSQL fallback; it
does not adopt Message DB or Emmett, supersede ADR 0001, or make the owner's decision.

## Options considered

| Option | Decision speed | Operations, restore and code |
| --- | --- | --- |
| Stay with JetStream plus PostgreSQL | Model/MCP p95 204/129 ms in the 100,000-event run | Keep two event/relational systems and 12 counted restore phases. Keep NATS credentials, placement and snapshot tooling. |
| Put events in PostgreSQL; retire NATS | Model/MCP p95 181/107 ms in the same run | One event/relational system and 10 counted restore phases. Review 1,567 gross existing NATS implementation lines for replacement/removal. Concentrate log, jobs and checkpoints on PostgreSQL. |
| Defer a product switch | Keep today's behaviour while evidence remains incomplete | Preserve the simplification option; qualify coordinated restore, dispatcher delivery and failure behaviour before deciding. |

Both stores passed the copied authority-volume scenario's latency bounds. Fifty
unrelated writer loops caused 100/100 valid JetStream probes to conflict and 0/100
PostgreSQL probes to conflict. These are single-primary, one-run development-host
measurements, with different local transports, not an HA or throughput comparison.
The PostgreSQL log used its own container; no 100,000-event log used the shared database.

## Proposed recommendation

**Defer a product switch.** PostgreSQL is a credible simplification candidate because
it could remove one operated system, one independently matched recovery point and
substantial NATS-specific code. Those operational benefits matter at least as much as
sub-second decision latency: decision 14 allows one minute for removing access, although
today's two-second check stays until its separate redesign. Both stores remain within the existing latency bounds, with different route timings;
these numbers alone do not justify adopting a migration or discarding the simplification option.

Ask the owner to weigh the evidence after a real coordinated PostgreSQL recovery,
checkpoint/pg-boss dispatcher proof, permission/retention controls, failure recovery and
a migration/rollback design are qualified. None is implemented by this throwaway spike.
Keep product storage unchanged while the proposal is considered.

## Consequences and limits

The spike implements all seven methods and exercises the five requested copied files:
two pass completely, three are partial due to 19 skipped NATS-specific cases; all 47
executed copied assertions pass. Six additional PostgreSQL tests cover concurrency,
rollback, access scope, SQL timeout and uncertain COMMIT recovery. A transaction lock
makes positions gap-free and ordered by commit but serialises appends. Production callers
must explicitly supply their complete access-subject list; this is not a drop-in swap.

Restore counts are design analysis, **PARTIAL**: a full silo restore is **NOT RUN** for
both options. PostgreSQL cluster recovery can include the event table and three existing
databases, but objects, computer homes, current deletion/key custody and external-effect
reconciliation still require coordination. pg-boss and OpenFGA remain. The inventory is
1,567 gross candidate lines in 12 files, including `infra/package` backup/restore paths;
replacement code and caller edits mean the net deletion count is **NOT RUN**.

No application, library or infrastructure source changes. No dependency added. PostgreSQL
and the existing `pg` client are permissively licensed; no new silo component is proposed
by this experiment. Local single-primary results do not qualify CNPG, R3, offline-source
restore, disaster recovery, a NATS-free product installation or the one-minute revocation journey.

Evidence: [results and commands](../../spikes/s0-9-postgres-event-store/README.md),
[method, restore phases and code inventory](../../spikes/s0-9-postgres-event-store/README.robot.md).
The PostgreSQL fallback category named in ADR 0001 has now been tried: untested fallback
store categories fall from **1 to 0**. Production readiness remains a separate question.
