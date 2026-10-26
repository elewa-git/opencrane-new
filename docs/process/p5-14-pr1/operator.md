# Local operator guide

Full P5-14 execution and P5-13 are **NOT RUN**. This guide describes existing commands;
it cannot yet recover a complete installation or authorise reopening.
The [index](qualification.json) links original receipts. The [accepted conditions](../../specs/phase-5/tickets.md)
and [decisions D06/D10/D11](../../specs/phase-5/decisions.md) govern recovery, ownership and evidence.

## Versions, custody and capacity

Source baseline: `690c2e44c`. Chart: `0.1.0`. [Reviewed images](../../../infra/package/reviewed-images.json)
list exact digests; the [package guide](../../../infra/package/README.robot.md) links
OSI application and Debian-main OS inventories. Old images cannot prove new source.
Live receipts need their own source/image versions, environment, date, install/storage
ids and empty/restored-state evidence. Source test services are not fresh product installs.

The package guide describes private values, six Secret references and TLS/NKey paths.
The [private owner file](../../../infra/dev-stack/README.robot.md#private-owner-email) supplies the test owner.
Receipts name custody ids/generations only. Keys, passwords, cookies, customer content
and archive bytes stay out of logs, errors, events and API replies. Export does not encrypt
its archive. Its private descriptor is not authenticated; replacing both files can defeat checksums.

The [claim limits](../../../infra/dev-stack/README.robot.md#parallel-journeys) allow owner plus two
secondary slots on this 8-core, 16 GiB box. Full slots queue. Secondary computers cap at
four Pods, 2 GiB memory and four 1 GiB storage claims; warm pool zero. Package main containers
cap at 500m CPU/512Mi or less; PostgreSQL/NATS volumes request 1Gi each. Optional owned
three-node targets cap each node at 768 MiB, then one CPU after creation; creation has no CPU cap.
Compose and package/target use cannot share a slot. Checks/builds use `nice -n 10`;
full root/fleet batches wait during live-view qualification. The owner stack stays untouched.

## Claim, install and cleanup

These [existing commands](../../../infra/package/README.robot.md) need reviewed pins and a private values file.
This sequence is a procedure, not evidence that it ran in this change:

```sh
npm ci
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
infra/dev-stack/run.sh package-prepare --id "$DEV_STACK_ID"
node --experimental-strip-types infra/package/prepare.ts /private/values.json
infra/dev-stack/run.sh package-up --id "$DEV_STACK_ID" --values /private/values.json
infra/package/forward.sh
```

Forwarding stays on loopback. With the existing `ZITADEL_KEY_FILE` path and read-only
provider setup, the repeat command is
`node --experimental-strip-types infra/package/fresh-twice.ts /private/values.json`.
It refuses automated fleet tasks; a human operator arranges qualification. The
[original core receipt](../p5-1-local.md#p5-2-two-fresh-installs) keeps failed attempts and a later passing pair.
Cleanup, including after failure, uses `infra/dev-stack/run.sh package-down --id "$DEV_STACK_ID"`,
then `infra/dev-stack/down.sh --id "$DEV_STACK_ID"`. Identity checks protect other installs;
uncertain state retains its ownership record for a retry.

## Event-only export and restore

The [export/restore contracts](../../../infra/package/README.robot.md#event-byte-export) use existing
`NATS_*` settings and TLS/NKey files. Export needs the administrative identity and an absent
destination below an owned 0700 directory; files are 0600. With private settings supplied:

```sh
node --experimental-strip-types infra/package/event-backup-run.ts "$SILO" "$ATTEMPT" /private/archive
node --experimental-strip-types infra/package/event-restore-run.ts "$SILO" /private/archive --disposable
```

For restore, `SOURCE_NATS_*` names the reachable unchanged source; `NATS_*` names a separate
empty disposable target. Both are standalone R1 servers. The operator isolates the target
and stops product processes; the flag does not prove Kubernetes ownership. Bounds are
64 MiB, 100,000 events, 1 MiB replies, 60 seconds overall and 65 seconds including shutdown.
Existing `EVENTS`, corrupt bytes and uncertain completion refuse without purge, overwrite
or retry. An uncertain target stays isolated even if bytes arrived. Original
[export](../p5-7-pr1/receipt.md), [restore](../p5-8-pr1/receipt.md) and
[interrupted-handler](../p5-9-pr1/receipt.md) receipts prove their stated subsets only.

## Recovery limits and qualification

Normal preparation/bootstrap use R1: one stored copy. R3 means three copies; process tests
and chart renders do not prove three Kubernetes nodes. [Recorded blockers](https://github.com/elewa-git/opencrane-new/pull/724)
include installer refusal, R1 bootstrap, missing current-source images and a failed registry
probe. Packaged placement, rotation, node loss/rejoin and full product journeys remain NOT RUN.
No coordinated-backup command exists. Missing steps include stopping writers/draining projections,
approved CNPG PostgreSQL installation, all-three-database backup/WAL recovery logs, matched
objects/computer volumes, positions/checksums/ownership, current key deletion state, complete
restore comparisons and safe admission resume. Local S3 proves no off-machine durability.
Handler manifests do not prove schema/package compatibility. Pinned upgrades, compatible
rollback and complete recovery are unqualified. Event archives cannot authorise reopening.

`npm run check:qualification` reads at most 1 MiB, 15 rows, 16 receipts per row and 16 local
links per receipt. It checks non-empty artefacts, starts no commands/network actions and writes
nothing. It checks consistency, not receipt authenticity, scan contents or actual execution.
The [checker](../../../scripts/check-local-qualification.mjs) lists required conditions. A row PASS needs
all conditions in one complete live receipt, source/image/freshness and vulnerability clearance.
Source, fresh, restored and hosted proof stay separate; historical failures remain.
Missing/empty scans cannot clear findings. `npm ci` reported seven High findings across all scopes;
shipped paths remain unassessed and dated runtime/image scans are missing.
Gate [H](../../specs/phase-5/decisions.md#owner-only-hosting-gates) still blocks hosted rows: owner-approved
cluster/region/OIDC/access/lifetime, off-machine storage/retention, custody/key recovery,
CPU/RAM/disk/object caps, integer euro-cent spending caps, teardown/stop rules, recovery targets
and real-zone disruption. Any model allowance is separate. Local PASS cannot clear H or hosted acceptance.
