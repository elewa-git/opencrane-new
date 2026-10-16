# Spec: Phase 5 — Qualification and hardening

## Problem statement

A passing development stack does not prove that a packaged silo can be installed,
upgraded or recovered. Operators need a repeatable install and evidence that events,
read tables and files still agree after failure. People need the same governed
work and company journeys on that install, including refusals and phone screens.

## Solution

Package the existing services in one Helm umbrella chart, which installs their
charts and settings together. Qualify it first on local k3d, then on an
owner-approved managed cluster. Use CloudNativePG (CNPG) to run PostgreSQL and its
backups, and three NATS replicas to keep three copies of the JetStream event log.
Run coordinated backup, restore and upgrade drills and retain safe evidence.

[Issue #15](https://github.com/elewa-git/opencrane-new/issues/15) owns this work.
Its [16 October default](https://github.com/elewa-git/opencrane-new/issues/15#issuecomment-6209646545)
allows local rows to start alongside Phase 4. This supersedes the issue's older
“Phase 4 complete” start blocker for local packaging. Paid hosting still waits.
The [ordered PR rows](tickets.md) and [decisions](decisions.md) need no new
architecture approval: the existing integration points are **CONFIRMED**.

P3-22 and P4-28 still own their product journeys and feature-phase completion.
Phase 5 runs those same acceptance criteria on new packaged installs. It neither
moves unfinished product work here nor declares either phase complete from source
checks. Local packaging can progress while those journeys remain NOT RUN.

## User stories

1. As an operator, I want one pinned package, so that I can reproduce an install.
2. As an operator, I want a fresh local install, so that old data cannot hide a missing step.
3. As an operator, I want PostgreSQL backups I can restore, so that backup status has proof.
4. As a person, I want one NATS node failure to preserve accepted changes and their order.
5. As an operator, I want events, read tables and volumes restored together, so that files and permissions agree.
6. As an operator, I want upgrades to preserve data and refuse unsafe rollback.
7. As a person, I want unsafe or unscanned uploads refused, even when the shared scanner fails.
8. As a requester, I want the complete governed-work journey on a fresh package, including my real Odoo rights.
9. As a colleague, I want company work and private memory to remain safe after restart and replay.
10. As an owner, I want local and hosted evidence kept separate, so that I know what is still unproved.

## Implementation decisions

- **Reuse packaging and operations.** Extend `infra/dev-stack` claims, identity setup,
  journey runners and cleanup, current image builds and licence inventories,
  `infra/devbox` prerequisites, `infra/nats` settings and `infra/clamav`. Adapt the
  OC1 chart/prerequisite assets named in the plan, recording their source commit.
  Use CNPG and the existing Agent Sandbox controller; add no replacement operator.
- **Start locally.** P5-1 is ready now on k3d. Subsequent local rows need only their
  listed prerequisites. Reserve a secondary through `infra/dev-stack/claim.sh`;
  preserve the owner stack and the owner-plus-two limit. Queue when resources are
  unavailable. Do not change Docker daemons, host routes, bridges or firewall rules.
- **Prove actual placement.** A three-process NATS setting is insufficient. Record
  three JetStream peers on distinct Kubernetes nodes, their volumes and stream
  replica count, plus TLS-authenticated routes. k3d nodes still share one physical
  host. Current one-node `ocn` cannot prove node placement; use the claimed local
  qualification resources, without rebuilding the owner's cluster. If these do
  not fit the existing caps, the affected drill is NOT RUN pending owner capacity.
- **Pin shipped contents.** Lock chart versions and runtime image digests, including
  PostgreSQL, backup helpers, NATS, gateway, scanner, computer and Codex. Check the
  actual image layers and bundled parts against [AGENTS.md](../../../AGENTS.md#licences).
  Application packages/binaries must be OSI-approved, including PSF/Python and
  accepted HPND variants. Record each allowed bundled DFSG-free notice and reason.
  The OS layer may use Debian **main**; reject `contrib`, `non-free`, BUSL, SSPL,
  KLv1 and other source-available components. Build-only data exceptions never ship.
  Unknown licences or open Critical/High findings block release qualification.
- **Preserve truth and access.** NATS events remain the only business truth.
  Commands make one conditional append to one stream. PostgreSQL and OpenFGA
  rebuild from events; SQL has no business rules. Replay starts no model, tool,
  routine or credential-release effect. Keep the event registry and catalogue in
  step if a later implementation changes events. Read history before checking
  access; only small authority streams enter the two-second write/turn check.
  Ordinary messages, turn starts and file arrivals cannot close authorised viewers.
- **Keep custody unchanged.** Reuse the accepted secret-store adapter and its
  references, not a new secret platform. Events contain ids only. Secret values
  are absent from events, logs, errors and receipts; computers/services keep only
  short-lived tokens. Backup manifests name required key/secret ids and generations,
  never values. Missing keys prevent recovery; old backup keys must not revive
  forgotten memory. Managed encryption and key recovery need their own evidence.
- **Share our scanner.** Follow the [10 October owner decision](https://github.com/elewa-git/opencrane-new/issues/15#issuecomment-6095325501):
  one separate service shared by silos inside our infrastructure, with no external
  scanning API and no ClamAV per silo. Reuse clamd INSTREAM and existing trusted,
  digest-bound admission evidence. This spec does not invent a scanner protocol or
  signing scheme. Missing, stale, forged or wrong-object/silo receipts never admit
  bytes. Unavailable scanning keeps uploads at typed 503. Malware, image signature,
  vulnerability and licence checks remain distinct; clean malware evidence grants
  neither publication nor tool access.
- **Keep local storage claims narrow.** Reuse the pinned local S3-compatible
  fixture for CNPG and coordinated drills. It proves local restore behaviour only.
  It is not durable off-machine storage, production HA, real-zone failover or
  managed-cluster acceptance. Record unsupported CSI snapshot/encryption conditions
  explicitly; a local file copy does not establish those guarantees.

## Backup, restore and upgrade contract

A usable backup contains JetStream events, all PostgreSQL databases (`opencrane`,
`jobs`, `openfga`), uploaded/generated objects and computer volumes. PostgreSQL
checkpoints alone cannot make separate backups consistent. Use a bounded operator
maintenance window through existing admission and worker controls:

1. Stop new work and effect-bearing reactions, pause computers and quiesce volume
   writes. Account for already-dispatched effects; unresolved ones remain held.
   If writers cannot be stopped, fail the set rather than label it complete.
2. Drain projections to a recorded event position. Record JetStream stream identity,
   retained sequence range, last sequence and per-subject expected positions used
   by the drill; record each projection/dispatcher checkpoint and CNPG recovery
   point (backup id and WAL/LSN, PostgreSQL's write-ahead-log position).
3. Save event snapshots, CNPG backup/WAL and the matched objects/volume snapshots
   while writers remain stopped. A manifest joins their ids, checksums, image/chart
   versions and safe key references. Incomplete sets stay unusable. Measure the
   pause and backup duration; resume only through normal access checks.
4. Restore into an empty, isolated target, with outbound effects and schedulers off.
   Verify every checksum, key reference and volume owner before serving. Reject a
   missing/corrupt part, mixed backup generations or a checkpoint ahead of restored
   events. Restore the source log, then rebuild projections and OpenFGA from it.
   Jobs are delivery state, never authority to redispatch old work.
5. Compare recorded event ids and per-stream ordering/positions, rebuilt rows and
   checkpoints, OpenFGA rights, audit and integer-cent reservations/settlements.
   Compare file hashes, authorised reads and computer/volume binding. Count zero
   replay effects. Restore forgotten-fact tombstones and current key-deletion
   state before memory reads; never recover deleted keys from an older set.
6. Reopen admission only after comparisons pass and short-lived credentials are
   renewed. Measure lost accepted events and recovery time. Local drills require
   zero missing acknowledged events through the chosen backup position; events
   after that point are outside the set and must be reported, not silently lost.

The upgrade drill starts from a pinned prior release, takes a verified coordinated
backup, upgrades the package, then repeats position, projection, rights and file
checks. Interrupt the upgrade deliberately. Demonstrate rollback only for a
compatible version; otherwise recover the verified set into a fresh target.
Do not claim `helm rollback` reverses event/schema changes or external writes.
Provider RPO/RTO (allowed data loss/recovery time) and retention targets remain
owner decisions; local measured times are not a production service promise.

## Testing decisions

Use existing journey runners and public authenticated API/browser paths. Real
NATS, CNPG PostgreSQL, OpenFGA, agentgateway, pinned Codex under gVisor, browser and
Odoo checks retain the source tickets' acceptance gates. Recording upstreams and
controlled fixtures remain useful where those tickets allow them; they cannot
replace Odoo ACL/readback, gateway enforcement, native memory isolation or pixels.
Unavailable dependencies are NOT RUN, never a mock-based live PASS.

[P3-22](../phase-3/tickets.md#p3-22--qualify-governed-work-twice-on-a-fresh-dev-stack)
and [P4-28](../phase-4/tickets.md#p4-28--qualify-the-complete-company-product-on-fresh-installs)
are incorporated in full, including every refusal row in their respective specs.
Each runs twice on independently fresh packaged state, with separate install ids,
empty event/database/object/volume state and fresh bootstrap. The second run cannot
reuse the first run's silo data. Existing external identity accounts and reviewed
images may be reused and must be named. Capture Linux browser comparisons at
**1280 and 390 pixels**, including dialogs, refusals, recovery and accessibility.
A restore target is a separate drill, never a fresh-install journey receipt.

Paid model checks retain the established shared **500-cent** qualification envelope:
verify its remaining balance and provider-side hard cap before any call. Local
packaging permission does not renew that allowance or authorise new hosting.
Missing allowance or credentials leaves the exact live condition NOT RUN.

## Qualification matrix

All live statuses below are **NOT RUN** by this documentation change. Each later
receipt uses PASS/FAIL/PARTIAL/NOT RUN separately for each environment and condition.

| Claim | Local k3d evidence | Managed-cluster evidence | Fresh-install journey evidence |
| --- | --- | --- | --- |
| Package and repeatable install | NOT RUN — P5-1/P5-2, pinned package and twice-empty state | NOT RUN — P5-15, owner hosting gate | NOT RUN — install ids and digests for each journey, not readiness alone |
| CNPG backup and restore | NOT RUN — P5-3, real CNPG to local S3 fixture | NOT RUN — P5-16, durable storage and recovery | NOT RUN — database restore alone proves no product journey |
| NATS R3, TLS and node loss | NOT RUN — P5-4/P5-5, three local nodes on one host | NOT RUN — P5-17, actual approved failure domains | NOT RUN — repeat access and event-position assertions during failures |
| Coordinated recovery and upgrade | NOT RUN — P5-7–P5-9/P5-12, matched events, databases, objects and volumes | NOT RUN — P5-16, off-machine restore and upgrade | NOT RUN — restored-state checks kept separate from empty installs |
| Scanner and replica security | NOT RUN — P5-6/P5-10, real refusals and two silos | NOT RUN — P5-17, hosted isolation and failure | NOT RUN — uploads, screenshots, gateway and live-view checks |
| Governed work | NOT RUN — P5-11; P3-22 owns dev/product completion | NOT RUN — P5-18 reruns full P3-22 | NOT RUN — twice fresh, real Odoo and browser, 1280/390 |
| Company product and memory | NOT RUN — P5-13; P4-28 owns dev/product completion | NOT RUN — P5-18 reruns full P4-28 | NOT RUN — twice fresh, native no-disk proof, replay, 1280/390 |
| Operator release evidence | NOT RUN — P5-14, local limits explicit | NOT RUN — P5-18, all hosted gates and no open Critical/High | NOT RUN — complete linked receipts, no inherited PASS |

**Source ready** follows the [engineering standard](../../process/standards.md#tests-and-evidence):
green required checks and an explicit remaining live-qualification issue. Relevant
web gates still apply. A capability is **done** only when its acceptance journey
passes live on a fresh install. Phase 5 completion additionally requires the full
managed journey list, restore drill and no open Critical/High finding, as in the plan.
A green `ci-ok` for this spec is source evidence only.

Receipts record date, source SHA and image/chart digests, environment and freshness,
command/journey, expected and observed result, safe artefact link and status. PASS
covers every condition claimed; FAIL records an observed mismatch; PARTIAL names
both completed and untested conditions; NOT RUN names the absent prerequisite.
Use the existing ledger with detailed artefact links. A skipped CI job proves
nothing about its condition. Record only the builder's own checks in receipts.

## Risks and unknowns

The [owner decision table](decisions.md#owner-only-hosting-gates) names who supplies
hosting, credentials, caps, storage and failure targets. These block P5-15–P5-18,
not P5-1. Missing product acceptance blocks only its dependent journey rows.
Shared-box capacity, CSI support, scanner evidence freshness and quiescing in-flight
work must be measured. Failed proof remains a failure; it is not an architecture
question or permission to weaken the source acceptance criteria.

## Out of scope

This change adds only documentation. Implementation rows add no new event store,
secret platform, operator, scanner wire protocol, product journey or paid service
without its existing gate. Feature gaps stay with Phase 3 or Phase 4. No production
HA, off-machine disaster recovery, paid provider use or managed acceptance follows
from k3d evidence. New dashboards, general backup frameworks and automatic external
write retries are outside this work.

## Self-review

Checked the row graph against #15 and its two owner comments, the plan, both prior
phase specs/tickets/decisions and the engineering standard. Kept product gates and
local/managed/fresh evidence separate. All implementation and live qualification
remain NOT RUN; [decisions.md](decisions.md#validation) records documentation checks.
