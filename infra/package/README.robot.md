# Local Helm package: operator notes

This chart was written here because the OpenCrane 1 source folder named in
`plan.md` is not present on this box. Its chart version is `0.1.0`. It has no
external chart dependencies. The chart's services are ClusterIP only. It creates
no Ingress or Gateway. `preflight.mjs` compares every image with
`reviewed-images.json` and requires the exact digest; the chart repeats the
digest and exposure checks at render time. The server and website share one
source image, pinned by the OCI index digest in the local registry. A missing
entry always refuses installation. `npm run check:package-licences` checks the
reviewed contents of every pinned image. It refuses unknown application licences,
non-OSI application licences and operating-system packages without a matching
Debian main or PostgreSQL apt archive review.

`chart/.helmignore` excludes `templates/README.md` so Helm does not try to render
the guide as a Kubernetes resource. `chart-render.test.mjs` renders the real chart
with made-up digest-pinned images and credential reference names. It checks that
each rendered document is a Kubernetes resource and comes from a YAML template.
CI runs it beside the other package tests. A missing Helm binary fails the check;
the test never skips rendering. Run it locally with:

```sh
nice -n 10 node --test infra/package/chart-render.test.mjs
```

Claim a secondary slot with `infra/dev-stack/claim.sh`. Set `DEV_STACK_ID` to the
returned id. `infra/dev-stack/run.sh package-prepare --id "$DEV_STACK_ID"` creates
only `opencrane-package-$DEV_STACK_ID` and records its Kubernetes UID, cluster,
release name, worktree and heartbeat in the slot's private directory. An operator
cannot prepare a package while that slot's Compose processes or containers run. The
slot lock keeps these checks and the following operation together. An operator
then runs `prepare.ts` with the private values file. That command creates five
named Kubernetes secrets from files under the claimed slot. It also prepares the
development sign-in app inside the OpenCrane 2 Dev organisation. Never put secret
values in Helm values, command arguments or receipts.
The owner bootstrap links the separate development sign-in account to the
privately configured owner member in this install. It does not edit the existing
Zitadel user with that email.

The `runtime` secret supplies text settings to the server and workers.
The dispatcher maps `DATABASE_URL` to `HANDLER_DATABASE_URL` for its queue, manifest,
checkpoint and receipts. It maps `CONTENT_DATABASE_URL` to the secret's `DATABASE_URL`,
the existing server read-role URL, for the gateway configuration lock. It never uses
`PROJECTION_DATABASE_URL` for this connection. Offline Helm rendering checks both
references; this does not qualify live gateway delivery in a packaged install. The
`runtimeFiles` secret holds certificates, model files, the local stub key and
a fresh 32-byte conversation wrapping key. An init container copies those
files into memory, gives them to the `node` user and sets mode 0400. The
server, model process, workers and bootstrap Job mount the copy read-only.
The server and model process share a private volume. They wrap each
conversation key before saving it on the volume, which stays with the claimed
install when its Pod restarts. Preparing a new key Secret for an existing volume
would make its keys unreadable; a fresh install gets a fresh volume and Secret.
The model can call only the local stub. The `postgres` secret holds PostgreSQL startup
settings. The `nats` secret holds `nats.conf` and its private certificate files.
The `openfga` secret holds its database settings. The `bootstrap` secret holds
database setup credentials. The installer checks all six names and required
fields before Helm applies resources. NATS, PostgreSQL and OpenFGA URLs must use the private service
names in the chart.

Pass a JSON values file, which Helm accepts as YAML, with the reviewed images,
six secret names and all three exposure flags set to `false`:

```sh
infra/dev-stack/run.sh package-prepare --id "$DEV_STACK_ID"
DEV_STACK_ID="$DEV_STACK_ID" node --experimental-strip-types infra/package/prepare.ts /private/values.json
infra/dev-stack/run.sh package-up --id "$DEV_STACK_ID" --values /private/values.json
DEV_STACK_ID="$DEV_STACK_ID" infra/package/forward.sh
infra/dev-stack/run.sh package-down --id "$DEV_STACK_ID"
infra/dev-stack/down.sh --id "$DEV_STACK_ID"
```

The forwarder binds only `127.0.0.1`, on port 25106 or 25206. No Tailscale
Funnel or public listener is created. A package namespace keeps its slot busy
after the launcher exits, including past the 15 minute claim grace period.
The chart caps each main container at 500m CPU or less and 512Mi memory or less;
the PostgreSQL and NATS volumes request 1Gi each.
Kubernetes errors also keep the slot busy. Cleanup checks the recorded worktree,
namespace UID, annotations and first Helm release secret UID before uninstalling.
It deletes only the package namespace in that slot. A failed Helm install can be
cleaned through `package-down` before releasing the slot. The installer saves an
ID from `randomUUID()` before calling Helm with
`--labels opencrane.dev/install-id=<id>`. Helm stores that label on its release
Secret. Cleanup requires the saved ID to match the label, including when the
Secret UID was already saved. If the launcher stops before saving the UID, cleanup
recovers it only from the matching Secret. A later foreign or unlabelled release
is refused. Older records without an install ID cannot authorise release removal.
If Kubernetes is unavailable during secondary
`down`, Compose stops while the package record stays in place for a retry.
Cleanup lets computer claims release their Pods and volumes before Helm removes
the computer warm pool.

`fresh-twice.ts` and `capture.mjs` refuse the owner id and any
`OPENCRANE_FLEET_TASK` marker before configuration is evaluated. The capture script
also reads the saved settings and refuses real mode before signing in or sending chat.
Importing the runner's assertion helpers does not start a qualification run.
The isolated refusal tests live in `infra/dev-stack/journey-refusal.test.ts`.

`fresh-twice.ts` repeats the preparation, Helm install, loopback forward,
browser capture and package cleanup on one claimed secondary slot. Pass the
slot id through `DEV_STACK_ID`, a private values file as its only argument,
and `ZITADEL_KEY_FILE` as a path. The runner reads the test owner's verified
email from Zitadel without changing the provider. It requires the slot's
existing test account and runs provider setup in read-only mode during private
preparation. This mode creates only the slot's local settings and credential
copies; it refuses a missing provider app or user.
It checks the saved claim
before each install, compares both Helm install ids, PVC UIDs and OpenFGA store
ids, and refuses older Kubernetes or silo events, old member or chat data, and
wrong owner bindings. The empty-data check covers conversations, files and all five
memory tables: facts, changes, dependencies, maintenance runs and maintenance
bindings. The runner fixture tests use fake Helm and kubectl commands. Each
refusal records no writes after the simulated namespace preparation; a valid
claim reaches both commands. The live runner checks the actual `/auth/me`
subject at 1280 and 390
through `capture.mjs`. The four PNG files for each run are saved with
`fresh-1-` or `fresh-2-` in `docs/process/p5-1-live/`. Browser failures keep the step and a short timeout or network error. Other
error text is withheld so cookies, tokens, Secret contents and page bodies cannot
enter the runner log. No extra browser retries are added.
A failed run still calls
owned `package-down`; inspect the claim before trying again. The operator
records the bridge probe, other-resource comparison and mobile screen review
in `docs/process/p5-1-local.md`.

The chart runs the member, catalogue, computer, conversation, file, budget and
audit workers, plus the dispatcher. It starts the model gateway beside the server
and installs the checked computer template and a zero-size warm pool. One computer
is claimed per assistant, including shared group assistants, and starts when needed.
The installer reads the server Service ClusterIP and puts that IP in the computer ConfigMap. The computer policy permits only TCP
port 43000 to the server Pod and has no DNS egress. The memory worker needs a
private key directory and is not started by this package. Object storage and
the scanner are outside this chart.
The licence inventory lists the components found by Syft in the pinned images.
`osi-licences.json` contains the OSI-approved IDs from SPDX licence list 3.28.0
(source JSON SHA-256
`f728c534d8bd1044fc515a2ddb2292be99559021d830bfa3281be0bcd36302ee`).
The Node packages and most PostgreSQL image packages were checked against signed
Debian main indexes. The five PostgreSQL apt archive packages in the PostgreSQL
image were checked against the signed `trixie-pgdg` main index. Their exact
package records and reviewed copyright licences are in `pgdg-trixie-main.json`.
These five inventory entries have a sixth field, `PGDG`, to name their source.
The checker requires each name, version and licence to match that review. Other
Debian packages must still match Debian main. Go modules without embedded
licence metadata were checked against their source licence files. Pass Syft JSON scan paths as `ROLE PATH` pairs
to `check-licences.py` to compare a fresh scan with the reviewed inventory.
The computer image uses its existing full licence inventory in
`apps/computer/licences.json`; this package checks that file's digest and its
image pin before installation.

## Private owner email

The development owner email uses the [private host file](../dev-stack/README.robot.md#private-owner-email)
shared by development stacks. Preparation reads it before creating credentials,
then copies its value into the private runtime Secret as `DEV_OWNER_EMAIL`.
The packaged bootstrap receives that environment setting. The twice-fresh check
compares the member and both events against the private file's address.

## Optional PostgreSQL primary and standby

P5-3 PR 1 adds an offline render/refusal path only. The default remains the existing
one-instance PostgreSQL StatefulSet. `postgres.mode: cnpg` replaces that StatefulSet
with one `postgresql.cnpg.io/v1` Cluster named `postgres`, with two instances.
CNPG creates a separate ReadWriteOnce 1Gi data claim for each instance. Required
anti-affinity on `kubernetes.io/hostname` keeps them on different Kubernetes nodes;
a one-node cluster leaves the second instance pending. Each instance requests
50m CPU/64Mi memory and is limited to 500m CPU/384Mi memory. These settings are
fixed in the template; storage and placement overrides are refused.

The supported API contract is CNPG 1.30, listed in the upstream
[support table](https://cloudnative-pg.io/docs/1.30/supported_releases/). Older
contracts, including the retired 1.28 release, are refused. Values must include this reference-only block:

```yaml
postgres:
  mode: cnpg
  operatorContract: "1.30"
  superuserSecret: cnpg-superuser
  applicationSecret: cnpg-projection
```

The two names must differ from each other and from `secrets.postgres`. Both refer
to existing `kubernetes.io/basic-auth` Secrets containing `username` and `password`.
The usernames must be `postgres` and `projection`, respectively. No credential values
belong in Helm. Current preparation supplies `POSTGRES_*` fields, which are not
CNPG credentials. Missing references refuse; this change does not convert those
fields or check live Secret contents. Preparation remains unchanged.

`images.postgres` must pass the existing exact-digest review. In addition, the
trusted review file needs `cnpg.operatorContract: "1.30"` and `cnpg.image` equal to
that exact image. This records compatibility with CNPG's [image requirements](https://cloudnative-pg.io/docs/1.30/container_images/),
including a PostgreSQL version tag alongside the digest.
The shipped review has no CNPG approval, so preflight refuses CNPG with today's
images. Test reviews use made-up images only. A direct Helm render checks the
contract, references, immutable pins and private exposure; it does not perform
image review. Preflight remains required before installation. Operator installation,
its version/digest and licence review, and PostgreSQL image promotion remain later work.

The private `postgres` Service keeps the current hostname and selects only
`cnpg.io/cluster: postgres` plus `cnpg.io/instanceRole: primary`. Standby Pods have
`replica` as their instance role and cannot match this selector. CNPG's own default
Services are also ClusterIP. Render checks do not prove live routing or promotion.

CNPG initdb prepares `projections` for owner `projection`. Existing bootstrap still
creates the `server`, `dispatcher` and `openfga` roles and remaining databases.
The current database names map to the design's logical names as follows:

| Existing name | Logical name | Purpose |
| --- | --- | --- |
| `projections` | `opencrane` | Content projections and checkpoints |
| `handlers` | `jobs` | Dispatcher delivery state |
| `openfga` | `openfga` | Access projections |

No database is renamed. Remaining bootstrap wiring must check live Secret types,
fields and usernames, align CNPG passwords with bootstrap/runtime references, check
the installed operator API/version, and include `imageName` in the installer's
rendered-image check. The existing check recognises container `image` fields only.
These steps must happen before enabling an install; the current reviewed-image
refusal keeps that path closed. No bootstrap or event-store behaviour changes here.

[Bootstrap](https://cloudnative-pg.io/docs/1.30/bootstrap/),
[storage](https://cloudnative-pg.io/docs/1.30/storage/),
[scheduling](https://cloudnative-pg.io/docs/1.30/scheduling/) and
[labels](https://cloudnative-pg.io/docs/1.30/labels_annotations/) describe the CNPG contracts.
The [receipt](../../docs/process/p5-3-pr1/receipt.md) records checks and limits.
Backup/WAL, all-database restore, storage denial, live standby and promotion remain
NOT RUN under #15. Rendering is not live k3d proof.

## Three-peer NATS rendering

P5-4 PR 2 adds an opt-in render path. It does not install or qualify R3. The
ordinary installer still rejects `natsCluster` as an unsupported package setting,
even with complete references. Preparation and bootstrap still request R1.
The cluster render omits the R1 bootstrap Job. Other application templates are
unchanged and are not ready for an R3 installation. Never apply this output as a
working package. Route identity preparation is described below. R3 runtime wiring
and image promotion come later.

These chart-only settings are added to an otherwise complete values file:

| Setting | Default | Required for the cluster render |
| --- | --- | --- |
| `natsCluster.enabled` | `false` | `true` |
| `natsCluster.renderOnly` | `false` | `true`; otherwise rendering refuses |
| `natsCluster.routeCASecret` | empty | Separate Secret containing only public route trust in `ca.crt` |
| `natsCluster.peerCertificateSecrets` | empty list | Three distinct Secrets, ordered 0–2, each with `tls.crt` and `tls.key` |

The chart renders three one-replica StatefulSets, `nats-0` through `nats-2`.
Their Pods are `nats-0-0` through `nats-2-0`; each gets its own `data` PVC.
Required anti-affinity places peers on different Kubernetes nodes. Fewer than
three eligible nodes leaves Pods pending. The disruption budget keeps at least
two ready Pods during voluntary eviction. A TCP readiness probe checks the client
listener only; it does not prove an R3 stream or a working quorum.

The private headless Service `nats-routes` publishes addresses before readiness
so peers can discover each other during startup. Peer `i` advertises
`nats-i-0.nats-routes.<namespace>.svc.cluster.local:6222` and lists the other two
addresses explicitly. This render assumes Kubernetes' `cluster.local` DNS domain.
Each certificate must cover that peer's full DNS name and have both `serverAuth`
and `clientAuth` usages. Only that peer mounts its certificate Secret.
Route trust must contain a separate route-only issuer, never the client CA.
The chart rejects reused Secret names, but offline rendering cannot inspect
certificate contents or prove which issuer signed them. The separate preparation
command below checks issuer custody and certificate contents.

The ConfigMap uses a chart copy of `infra/nats/cluster.conf`; the render test
requires byte-for-byte equality. It includes the existing `nats.conf` from
`secrets.nats`, preserving client TLS and account permissions. Client files and
public NKey settings still come from that Secret. Route trust, identity, addresses
and storage are set explicitly per peer. Required Secret keys have no optional
fallback. No signing key belongs in the route trust Secret.

`chart-render.test.mjs` checks the real Helm output and uses the pinned NATS server
to parse each peer's configuration with disposable certificates. It checks missing
trust refusals, storage, node separation rules, private services, the disruption
budget and unchanged default rendering. `preflight.test.mjs` checks the ordinary
installer's refusal. Existing event-store cluster tests retain real TLS refusals.
[The receipt](../../docs/process/p5-4-pr2/receipt.md) separates source checks from
three-node placement, R3 bootstrap, rotation and P5-5, all still NOT RUN.

## Private NATS route preparation

P5-4 PR 3b adds `prepare-nats-routes.ts`. After ordinary private preparation, run
`DEV_STACK_ID="$DEV_STACK_ID" node --experimental-strip-types infra/package/prepare-nats-routes.ts /private/cluster-values.json`.
The values include the cluster render settings above. The command checks the recorded
package owner, uses its verified Kubernetes context, checks reviewed image pins and
renders the real chart in that namespace. There is no caller context override.
The claim-context change owned by p5-4-target1 can supply its verified record directly.

A separate 30-day route issuer signs three distinct keys and certificates. Each
certificate has exactly its peer's private DNS name and both TLS usages. The command
checks dates, signatures, key pairs and separation from the existing client issuer.
Only public `ca.crt` reaches the trust Secret; each peer Secret contains only its own
`tls.crt` and `tls.key`. All four Secrets are immutable and created without replacement.
The signing key stays under the claimed directory in `nats-routes`, with directory
mode 0700 and file mode 0600. No issuer key is mounted into a peer.

A successful retry verifies the saved namespace, references, object UIDs and exact
contents. Changed or foreign objects, missing objects and incomplete preparation
refuse without overwriting anything. An interrupted attempt requires operator inspection;
there is no automatic cleanup, renewal or recovery. Command output is withheld on failure.
The helper does not start NATS, change client settings, bootstrap R3 or enable installation.

`nice -n 10 node --experimental-strip-types --test infra/package/prepare-nats-routes.test.mjs`
runs disposable certificate and Kubernetes command fixtures, including pinned NATS parsing.
The [receipt](../../docs/process/p5-4-pr3/receipt.md) records source checks.
Live rotation and three-node installation remain NOT RUN.
