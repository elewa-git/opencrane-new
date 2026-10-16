# Phase 5 — Decisions and research

Read on 16 October 2026 against `origin/main` at
`1b1faf3455d27555af7b6ab2cf392c0e1ac57734`. This is a documentation-only plan for
[#15](https://github.com/elewa-git/opencrane-new/issues/15). **Adopted** preserves
an existing decision; **Qualification default** defines how to prove it without
choosing new architecture. Existing integration points are **CONFIRMED**.
No stack, product code, dependency, test or paid service is added by this draft.

## Decisions carried forward

| ID / status / needed by | Decision | Reason and source |
| --- | --- | --- |
| D01 · Adopted · P5-1 | Local k3d rows start alongside Phase 4; hosted rows wait for owner hosting | [16 October default](https://github.com/elewa-git/opencrane-new/issues/15#issuecomment-6209646545) supersedes the older issue blocker only for local work. |
| D02 · Adopted · all | Event-only truth; one conditional append to one stream; PostgreSQL/OpenFGA rebuild; replay causes no external effects | [Plan](../../../plan.md#event-driven-core) and both accepted feature specs. No new store, SQL authority or workflow engine. |
| D03 · Adopted · P5-1–P5-5 | Helm umbrella, CNPG backups, NATS R3 with TLS routes and failover; existing Agent Sandbox/gVisor | #15 and the plan's [reuse list](../../../plan.md#copy-from-opencrane-1-source-commit-10abd0ef6). Reuse existing assets before adding packaging. |
| D04 · Adopted · all runtime rows | Digest/version pins and reviewed shipped inventory; OSI application contents and accepted bundled notices; Debian main OS boundary | [AGENTS.md licences](../../../AGENTS.md#licences). No unknown runtime licence or build-only exception hidden in a layer. |
| D05 · Adopted · P5-6 | Our separate scanner service shared across silos; no external API or per-silo ClamAV; typed upload 503 on outage | [10 October owner comment](https://github.com/elewa-git/opencrane-new/issues/15#issuecomment-6095325501). Keep existing scan/admission contracts and fail closed on missing, stale or forged evidence. |
| D06 · Qualification default · P5-3/P5-7–P5-9 | Local S3 fixture proves local restore only; quiesced matched backup set includes events, all databases, objects and volumes | #15 requires them together. Independent snapshots without recorded positions cannot prove consistency. No new backup operator. |
| D07 · Adopted · all | Existing secret custody, ids only in events/manifests; no values in events/logs/errors/receipts | [Phase 3 D14–D17](../phase-3/decisions.md#owner-decisions). No new secret store or invented scanner signing scheme. |
| D08 · Adopted · P5-11/P5-13/P5-18 | P3-22/P4-28 retain their complete product acceptance; rerun twice fresh on packaged installs at 1280/390 | [Phase 3 tickets](../phase-3/tickets.md) and [Phase 4 tickets](../phase-4/tickets.md). A source PASS does not complete either feature phase. |
| D09 · Adopted · P5-12/P5-13 | Memory remains off computer disk; forget/tombstones and current key-deletion state survive restore and replay | [Phase 4 memory contract](../phase-4/spec.md#implementation-decisions). Encrypted PVCs are not no-disk proof; old keys cannot revive forgotten facts. |
| D10 · Adopted · every live row | Current claim limits, owned cleanup and nice CPU priority; no owner-stack or host-network mutation | [Dev-stack contract](../../../infra/dev-stack/README.robot.md#parallel-journeys) and AGENTS.md. Local resources are finite, not permission for another unclaimed stack. |
| D11 · Adopted · every receipt | Source ready requires green checks and an outstanding live issue; done requires live fresh acceptance | [Engineering standard](../../process/standards.md#tests-and-evidence). Each environment keeps PASS/FAIL/PARTIAL/NOT RUN and untested conditions. |
| D12 · Adopted · model-dependent journeys | Existing shared 500-cent envelope, verified remaining balance and provider-side cap | [Phase 3 D26](../phase-3/decisions.md#owner-decisions) and [Phase 4 D29](../phase-4/decisions.md#owner-decisions). No fresh allowance or paid-provider use is inferred here. |

## Owner-only hosting gates

Gate **H** is a recorded owner decision plus usable resources, not an approval
inferred from this spec or a local PASS. P5-15–P5-18 remain blocked until it is
supplied. Routine manifest settings and fixes do not need another architecture
round. The owner supplies the following precise inputs:

| Input / needed by | Owner-only decision or provision | What remains blocked without it |
| --- | --- | --- |
| Provider and cluster · P5-15 | Provider/account, managed cluster and region, silo/domain/OIDC organisation, named operator access and permitted lifetime | Managed fresh install and managed product acceptance |
| Durable object storage · P5-15/P5-16 | Provider/bucket/region outside the source machine, encryption, retention/deletion rules, approved recovery destination | Off-machine backup/restore and durability claims; local S3 proves neither |
| Credentials and key recovery · P5-15/P5-16 | Scoped cluster/storage/registry/identity credentials via existing secret custody; authorised recovery of necessary encryption keys, preserving deletions | Hosted bootstrap and readable recovery; receipts name only ids/generations |
| Resources and spend · before P5-15 | Maximum nodes/CPU/RAM/disk/object capacity, hosting cap in integer euro cents, expiry/teardown owner and stop condition | Any paid provisioning, storage, restore target or failure drill; no unbounded retry/spend |
| Recovery targets · P5-16 | Required RPO/RTO, backup schedule/retention and acceptable maintenance window | Production recovery acceptance; local measurements cannot set the business target |
| Failure domains · P5-17 | Named real zones, placement, allowed node/zone disruption and recovery window | Real-zone failover claim; single-host k3d or one hosted zone is insufficient |
| Live model allowance · P5-11/P5-13/P5-18 when required | Confirm existing remaining shared 500-cent allowance, credentials and provider hard limit; any increase is owner-only | Paid-model condition remains NOT RUN; hosting spend is a separate cap |
| Extra local capacity · only if local preflight fails | Additional permitted local resources/window when three nodes, replicas or CSI proof cannot fit existing caps | Only the affected local drill; P5-1 design/package work remains ready |

No provider, bucket, cap, recovery target or real-zone disruption is selected by
this draft. These are the unresolved decisions. Product feature delivery is a
prerequisite, not an owner request to replace a real dependency with a mock.

## Research and reuse map

| Inspected source | Reuse and limits |
| --- | --- |
| [Plan](../../../plan.md), [standards](../../process/standards.md), [AGENTS.md](../../../AGENTS.md) | Phase 5 managed done-when, event/access invariants, licences, receipt meanings and landing gates. The issue's dated local-start default is linked back into the plan. |
| [Phase 3 spec](../phase-3/spec.md), [tickets](../phase-3/tickets.md), [decisions](../phase-3/decisions.md) | Full governed-work/refusal scope, real Odoo rights, gateway/OpenFGA, live view, native/browser checks and shared live-provider cap. P3-22 stays the product qualification owner. |
| [Phase 4 spec](../phase-4/spec.md), [tickets](../phase-4/tickets.md), [decisions](../phase-4/decisions.md) | Full MVP/refusal scope, requester isolation, memory deletion/no-disk/replay, routines and twice-fresh product evidence. P4-28 stays the product qualification owner. |
| [Dev-stack contract](../../../infra/dev-stack/README.robot.md), [claims](../../../infra/dev-stack/claim.sh), [compose](../../../infra/dev-stack/compose.yaml) | Existing identity setup, pinned PostgreSQL/NATS/OpenFGA/MinIO, bounded claims, cleanup and journeys. Compose freshness alone is not a packaged install. |
| [Dev-box prerequisites](../../../infra/devbox/README.robot.md) | Existing k3d/gVisor and pinned tooling. The current cluster is one node, so R3 placement needs a separate claimed local qualification target within caps. No silent change to owner `ocn`. |
| [NATS configuration](../../../infra/nats/nats.conf), [event-store decision](../../adr/0001-event-store-nats-jetstream.md) | TLS/client permissions, conditional append, replay and spike evidence. Historical spike success is not packaged R3/route/failure proof. |
| [Scanner contract](../../../infra/clamav/README.robot.md), [licences](../../../infra/clamav/LICENCES.md), [upload adapter](../../../apps/server/src/files/scanner.ts), [admission checks](../../../libs/models/src/hosted-admission.ts) | Pinned engine/signatures, non-OSI plug-in removal, clamd INSTREAM, strict clean verdict and bound/datable image checks. Packaging must preserve them; this draft defines no new wire receipt. |
| [CI](../../../.github/workflows/ci.yml), [package scripts](../../../package.json), [changelog check](../../../scripts/changelog-gather.mjs) | Existing Markdown/local-link/changelog gates. CI also runs source/web/test jobs; `ci-ok` aggregates their real results, not live qualification. |

The plan names OC1 prerequisite scripts, `apps/postgres`, Agent Sandbox hardening
and recovery helpers at source commit `10abd0ef6`. Implementers inspect and copy
only the required assets, preserving source/licence notes in the appropriate
maintainer record. This task did not copy or qualify OC1 code. It found no current
umbrella chart in this checkout and makes no claim that one is already installed.

## Risks and required proof

| Risk | Proof or response |
| --- | --- |
| Shared host cannot hold three nodes and required replicas | Preflight within existing caps, queue local work and report NOT RUN if capacity is absent; owner alone expands capacity. |
| Local CSI/snapshot or encryption support differs from hosting | Record the actual driver and unsupported condition. Local byte restore does not prove encrypted CSI snapshots or managed durability. |
| Acknowledgement lost during NATS failure | Compare event ids, expected subject positions and retained sequence range; reconcile uncertain append before retry. |
| Backups contain different moments or revived keys | Quiesce writers, reject incomplete/mixed manifests and restore current deletion state before reads. Never treat PostgreSQL as independent truth. |
| Restored jobs or upgrades repeat an external write | Keep effects disabled during replay; count zero calls and retain held uncertainty before normal admission. |
| Shared scanner widens file access or stale scans appear clean | Real two-silo refusal, digest/freshness/trust checks, EICAR and outage proof; never accept client-provided success. |
| Product features are incomplete when packaging lands | Name the missing P3/P4 condition and keep the packaged journey PARTIAL/NOT RUN; implement the feature in its original ticket. |
| Old source/spike receipts are mistaken for release evidence | Run the same journeys on the pinned package and fresh target; keep local, managed and restored receipts distinct. |

## Validation

Documentation checks on 16 October 2026, all under `nice -n 10`:

- **PASS** — `npm run lint:docs`: 247 maintained Markdown files, zero issues.
- **PASS** — `npm run lint:links`: 1,482 local targets, zero errors; 291 external targets excluded.
- **PASS** — `npm run lint:changelog`; the release note is a plain fragment and `CHANGELOG.md` is unchanged.
- **PASS** — row/graph check: 18 sequential rows, budgets at most 600 lines, 22 internal edges matching the table, no cycles.
- **PASS** — `git diff --check`; only the three spec files, plan links/scheduling text and release fragment change.

The existing Markdown gate required `npm ci` because this worktree had no installed
dependencies. No dependency manifest or lockfile changed. These are this draft's
own checks. Local product tests, stack startup, local/managed drills and all live
journeys are **NOT RUN**. Pushed-head CI is reported in the PR; no runtime capability
is claimed complete by this specification.
