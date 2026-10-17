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
- **Keep access private.** Local and managed installs allow user access only through
  the tailnet; local automated browser checks may use loopback-only forwarding.
  Service endpoints stay private. Reject public ingress, LoadBalancer exposure and
  Tailscale Funnel. Inspect rendered and live resources/listeners, and require a
  probe from outside the tailnet to fail before accepting either install.
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
  scanning API and no ClamAV per silo. The current upload adapter has only raw TCP
  INSTREAM and clean/infected results; it has no authenticated upload proof.
  P5-6a/P5-6b add the [shared scanner contract](#shared-scanner-contract) and its
  callers. Image admission evidence remains a separate contract. Missing, stale,
  forged or wrong-byte/silo results never admit bytes; unavailable scanning keeps
  uploads at typed 503. A clean scan grants neither publication nor tool access.
- **Keep local storage claims narrow.** Reuse the pinned local S3-compatible
  fixture for CNPG and coordinated drills. It proves local restore behaviour only.
  It is not durable off-machine storage, production HA, real-zone failover or
  managed-cluster acceptance. Record unsupported CSI snapshot/encryption conditions
  explicitly; a local file copy does not establish those guarantees.

## Shared scanner contract

This is planned adapter work, not a claim about today's scanner. The
[upload adapter](../../../apps/server/src/files/scanner.ts) sends unauthenticated
clamd INSTREAM and returns only `clean` or `infected`;
[routes.ts](../../../apps/server/src/files/routes.ts) trusts that result before
storing the same buffer. The dated, digest-bound
[hosted admission checks](../../../libs/models/src/hosted-admission.ts) cover
`mcp.image_checked` only. No upload receipt can be reused from them.

- **Transport and identity.** Put a small HTTPS wrapper in front of our shared
  clamd. Callers use Node's HTTPS transport with the configured private service
  address, trusted CA and hostname verification; reject redirects and untrusted
  certificates. Keep clamd INSTREAM on service-local loopback, unreachable by
  silos. Extend the existing ES256 issuer/verifier in
  `libs/auth/src/tokens.ts` with a dedicated scanner audience and at most two-minute
  tokens. The existing trusted issuer issues them only to authorised server/image
  workers, binding the service identity, silo, purpose and request id from trusted
  deployment identity, never browser input. Keep issuance inside the existing
  trusted issuer process; expose no unauthenticated token-minting endpoint. Add
  that issuance path explicitly;
  current computer/turn tokens do not authorise scanning. The scanner checks issuer,
  configured JWKS, audience, expiry, token type and those bindings. Each allowed
  issuer/service maps to its permitted silo; a token naming another silo fails.
  Use existing secret-store custody for signing keys and TLS material, public-key
  distribution for verifiers and short-lived tokens for callers. Rotate through
  those paths; put only references in events/settings and no values in logs.
- **Exact upload bytes.** The server sends the bounded bytes, silo, file id, fresh
  request id, SHA-256 and byte count. The wrapper hashes/counts the bytes it actually
  feeds to INSTREAM and rejects any mismatch. Its typed HTTPS response contains
  `purpose=upload`, those bindings, verdict, engine/image digest, database manifest
  digest, database version/build time, `databaseUpdatedAt`, `checkedAt` and `expiresAt`. The caller
  validates the response on that authenticated connection against its pending
  request and unchanged buffer before storing bytes or emitting `file.uploaded`.
  The request id cannot be reused across attempts. This response is not a portable
  signed receipt: copied JSON or a browser-supplied result has no authority. A
  restart or lost response requires a new scan. No new signing scheme or scan store.
- **Database freshness.** Extend `infra/clamav/refresh.sh`'s candidate SHA-256
  manifest with each upstream-verified database's version/build time and the time
  FreshClam successfully checked the complete set against upstream updates. Retain
  safe updater evidence; a copy, mtime change or daemon restart is not an update
  check. The trusted packaging job binds this manifest to the reviewed scanner
  image digest in its release record. At service startup verify actual database
  bytes against that approved manifest, then start clamd with the immutable set
  and no reload. Report only that loaded set. Refuse unknown, altered or future
  metadata. `databaseUpdatedAt` means the last verified upstream update check for
  the whole set, not each signature file's build time (unchanged files may be old).
  Both service and caller require that check to be within 24 hours at admission.
  `checkedAt` cannot be in the future; `expiresAt` is at most two minutes after it
  and no later than database expiry. Expired proof requires a fresh scan. An old
  pinned release stays unavailable until a reviewed fresh manifest/set is deployed;
  the existing offline database alone is not freshness proof.
- **Separate image proof.** Upload responses never satisfy `mcp.image_checked`.
  The image worker binds its malware scan to silo, server id, installation attempt,
  platform and immutable image digest. It verifies the resolved image/layer bytes
  belong to that digest, scans all required contents, and fails if coverage is
  incomplete. Its result has `purpose=image`; an upload result cannot substitute.
  Only the trusted models worker writes the existing image event after checking
  this result. Keep image signature, vulnerability and licence checks independent,
  with the existing image date rules and `databaseUpdatedAt` for the verified set.
  A malware-only result never marks an image admitted.
- **Bound the adapter.** Reuse the pinned ClamAV image with non-OSI RAR plug-ins
  removed, INSTREAM framing, byte/time limits and strict clean verdict. Deny
  caller-supplied fetch URLs. Isolate request buffers and cleanup by silo/request;
  retain no customer bytes or reusable results. Unknown/malformed responses, bad
  authentication, stale signatures and outage fail closed as typed upload 503;
  a verified infected result keeps the existing rejection. Preserve upload size
  limits, the 60-second scan deadline and 4 KiB response bound. Adapt `scanner.ts`,
  `main.ts` wiring and `routes.ts`'s scan input/result check; changing only the host
  and port is insufficient. Keep existing event-only business writes. Any needed
  event-schema change updates both registry and catalogue in the implementation.

P5-6a delivers the wrapper, identity issuance, database manifest and real service
checks (450–600 lines). P5-6b delivers consumer wiring and separate upload/image
proof with two-silo, freshness and outage checks (450–600 lines). Together they
replace the former 500–600-line estimate. Neither row builds a scanner platform.

## Backup, restore and upgrade contract

A usable backup contains JetStream events, all PostgreSQL databases (`opencrane`,
`jobs`, `openfga`), uploaded/generated objects and computer volumes. PostgreSQL
checkpoints alone cannot make separate backups consistent. Use a bounded operator
maintenance window through existing admission and worker controls:

1. Stop new work and effect-bearing reactions, pause computers and quiesce volume
   writes (stop them and wait for pending writes to finish). Account for effects
   already dispatched; unresolved ones remain held.
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
images may be reused and must be named. Every fresh and restored test environment
must include `jente@elewa.ke` as a verified owner test user. Assert the trusted
issuer/subject and verified email, the event-backed owner role, and real browser
sign-in to that silo at 1280/390. Absence, an unverified identity, a non-owner role
or failed sign-in blocks acceptance. Use the existing identity/bootstrap path;
never grant production access by matching an email address. Capture Linux browser
comparisons at
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
| Scanner and replica security | NOT RUN — P5-6a/P5-6b/P5-10, real refusals and two silos | NOT RUN — P5-17, hosted isolation and failure | NOT RUN — uploads, screenshots, gateway and live-view checks |
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
secret platform, operator, custom scanner cryptography, product journey or paid service
without its existing gate. Feature gaps stay with Phase 3 or Phase 4. No production
HA, off-machine disaster recovery, paid provider use or managed acceptance follows
from k3d evidence. New dashboards, general backup frameworks and automatic external
write retries are outside this work.

## Self-review

Checked the row graph against #15 and its two owner comments, the plan, both prior
phase specs/tickets/decisions and the engineering standard. Kept product gates and
local/managed/fresh evidence separate. All implementation and live qualification
remain NOT RUN; [decisions.md](decisions.md#validation) records documentation checks.
