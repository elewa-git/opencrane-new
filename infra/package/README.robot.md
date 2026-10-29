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

Preflight and Helm run from the values file's directory and receive only its
filename. The private directory remains in the child process's working directory,
outside its command arguments. The chart, preflight script and image review use
absolute paths under this worktree so they remain available from that directory.

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

## Package image promotion

`Dockerfile` accepts `SOURCE_REVISION`, the full Git commit hash, and records it as
`org.opencontainers.image.revision`. Build from that committed source with
`nice -n 10 docker build --build-arg SOURCE_REVISION=<commit> -f infra/package/Dockerfile .`.
The build runs npm at nice priority too. An absent or wrong label refuses promotion.

The final stage starts from `scratch` and copies the cleaned runtime filesystem.
The Node base and application copy remain build stages only. Their deleted files
are absent from every shipped layer. The final stage restores Node's entry point,
version environment variables, working directory, user and default command.
`image-layers.test.py` reads each layer from a real Docker save archive. It checks
removed paths, one layer with filesystem contents, runtime settings and required
executable files. Docker may also add an empty layer for `WORKDIR`:

```sh
nice -n 10 docker image save -o /tmp/package-image.tar <local-image>
PACKAGE_IMAGE_NAME=<local-image> \
  PACKAGE_IMAGE_ARCHIVE=/tmp/package-image.tar PACKAGE_IMAGE_REVISION=<commit> \
  nice -n 10 python3 infra/package/image-layers.test.py
```

All three environment variables are required; a missing archive fails the test.
The archive must identify the same image that the container checks exercise.
The recursive import check compares the packaged TypeScript files with the source
checkout. It follows runtime imports after removing TypeScript types, starting at
both bootstrap programs. Removing a required imported file refuses even when
`bootstrap.ts` remains. The existing bootstrap source suite also checks that every
imported dev-stack file has an explicit Docker context exception.

The container check runs the real bootstrap entry point and its owner subprocess.
A read-only test loader first imports the real service packages, then supplies
made-up database, event-log, access and Kubernetes replies. Only the identity file
and service-account reads receive made-up data. The generated environment files
stay in the container's temporary filesystem. The container keeps the image's
user and entry point, has no network and mounts no host settings. Its success
requires the final owner-ready update; a settings refusal cannot pass. Failures
withhold dependency output and fixture values.
These checks do not replace the complete Syft scan, licence review or fresh install.

The existing `natsCluster` review binds `replicas: 3`, both role pins and
`sourceRevision` to `imageId`, Syft's image configuration digest, and `scanSha256`
from the Syft JSON bytes. Docker inspection may identify that configuration or the
image index; both reports must name the same reviewed repository digest.
The server inventory records the same `sourceRevision`; the website
shares that inventory. These fields are reviewed evidence, not an automatic claim
that bootstrap or a live installation passed. Preflight requires the source revision
alongside the existing R3 role bindings. Synthetic records prove source checks only.

After inspecting bootstrap in the actual image, scan it with Syft's `--scope all-layers`.
Save `docker image inspect <immutable-pin>` as JSON. Run the existing checker with
the expected commit, that inspection and the scans:

```sh
nice -n 10 python3 infra/package/check-licences.py \
  --promotion <commit> <inspection.json> server <scan.json> web <scan.json>
```

This checks image identity, the exact scan checksum, every inventoried component,
application licences and the existing signed-index package lists. It still requires
a new Debian-main review when the image changes. It does not fetch or authenticate
a new index itself. An operator must verify the signed index and record its hashes
before changing the inventory and index pin together. Never change only the expected pin.
The command writes nothing and withholds input paths and dependency errors on failure.
The preflight test suite also runs the Python licence and promotion refusal tests.

The shipped image and inventory remain unchanged. The private registry is unavailable;
R3 approval and release qualification remain blocked. Unknown licences or open
Critical/High findings also block qualification. The
[first image receipt](../../docs/process/p5-4-images1/receipt.md) records the original refusals.
The [layer receipt](../../docs/process/p5-4-images2/receipt.md) records the flattened local
build. The [bootstrap receipt](../../docs/process/p5-4-images3/receipt.md) records
the local import fix and synthetic setup checks. The
[candidate receipt](../../docs/process/p5-4-images4/receipt.md) records a separate
455-component inventory and authenticated Debian-main evidence. Its inventory uses
the checksum of the unchanged approved list plus three additions and two removals.
The candidate checker compares the reconstructed list with the actual all-layer scan.
It checks saved image, source, scan and notice checksums, the image configuration and
index, Debian signatures and every installed package/version pair. Run it with:

```sh
nice -n 10 python3 docs/process/p5-4-images4/check-candidate.py /tmp/p5-4-images4
```

The directory must contain the files named in `candidate.json`. Missing or altered
bytes refuse with fixed error text. The original `notices.json` retains all 43
Node section checksums and their earlier NOT RUN status.
The [Node declaration record](../../docs/process/p5-4-images5/node-notices.json)
adds individual reasons against those same checksums, without changing the original.
Its checker first runs the candidate check, then checks the full notice, sections,
licences and reasons. Fixed component and licence pairs identify every grant under
its reviewed notice checksum, including both preamble grants. All ten unresolved
section and name pairs must appear exactly once with BLOCKED status and a reason.
The compressed `node-LICENSE.gz` beside it contains the actual
archived notice bytes for licence fixtures; it is not shipped in the runtime image.

```sh
nice -n 10 python3 docs/process/p5-4-images5/check-node-notices.py /tmp/p5-4-images4
```

This record checks Node declarations only. Unresolved references remain BLOCKED;
a passing check does not approve their licences or prove they are absent at runtime.
NAIST dictionary and HPND sell-variant terms are accepted only for the exact ICU
section and named components. Application and general bundled checks are unchanged.
Other bundled declarations, including Go, kubectl, agentgateway and Corepack's own
bundled dependencies, remain outstanding. A passing inventory or Node comparison
is only part of image review. Approved pins and licence rules are unchanged.
Registry publication, promotion, vulnerability clearance and fresh R3 installation
remain NOT RUN.

The separate [PCRE record](../../docs/process/p5-4-images6/pcre.json) resolves only
`V8 PCRE test suite` by reviewing the actual source file's embedded BSD-3-Clause
terms for Cambridge and Google. It keeps the historical ten-reference checker and
records unchanged. It makes no claim that source, compiled or bundled test copies
are absent. The full source fixture keeps the actual attribution, conditions and
disclaimer. Distribution materials must keep these terms if code is shipped.

```sh
nice -n 10 python3 docs/process/p5-4-images6/check-pcre.py \
  /tmp/p5-4-images4 /tmp/p5-4-images6
```

The first directory contains the unchanged candidate evidence. The second contains
the five upstream files named in `pcre.json` and an `upstream` Git repository with
commit `bd96dfbf0361576724b65322046e2ca9f9609cb9`. The checker verifies the signed
Node release checksums and Git tag using the recorded upstream release keyring.
It compares the Git source, version header and notice with the reviewed bytes, then
checks the official binary archive, candidate binary, all shipped layers and archived
Dockerfile. The source tarball omits this test file; its absence grants no approval.
The [receipt](../../docs/process/p5-4-images6/receipt.md) gives source links and limits.
This check resolves only its named reference. Other references and bundles,
vulnerability clearance, source-bound R3 approval and publication remain
outstanding. No approved image, inventory or binary pin changes.

The separate [Valgrind record](../../docs/process/p5-4-images7/valgrind.json) resolves
only `V8 Valgrind client API`. It reviews the full header and adjacent `LICENSE`
from that same signed Node release and Git commit. Both files contain the same
Julian Seward grant. Its BSD-style four conditions match SPDX `bzip2-1.0.6`.
This DFSG-free term is accepted only for the exact header bundled inside Node/V8;
it is not added to the OSI list or general bundled allowances. The record gives
the full reason, including attribution, honest origin, marked changes and no
endorsement. The GPL notice explicitly describes the rest of Valgrind.

```sh
nice -n 10 python3 docs/process/p5-4-images7/check-valgrind.py \
  /tmp/p5-4-images4 /tmp/p5-4-images6
```

The checker reuses the signed release/tag and official binary checks above. It
also requires both Valgrind files in the release archive to match Git and the
reviewed checksums. Missing source cannot prove compiled or bundled absence.
The compressed fixtures keep the complete header and licence text. The candidate
check still reads every shipped layer and the archived Dockerfile. The
[receipt](../../docs/process/p5-4-images7/receipt.md) records checks and remaining
coverage limits. Historical records and PCRE's separate resolution are unchanged.

The separate [Wasm API record](../../docs/process/p5-4-images8/wasm.json) resolves
only `V8 Wasm C/C++ API` from the complete Apache-2.0 terms in
`deps/v8/third_party/wasm-api/LICENSE`. Its two headers add no further grant or
attribution. `README.v8` identifies Apache 2.0 and says it is shipped. The pinned
API directory has no NOTICE file. The record retains the complete licence and
headers in compressed fixtures; recipients of distributed code still need the
full terms, marked changes, relevant source attribution and any supplied NOTICE.

```sh
nice -n 10 python3 docs/process/p5-4-images8/check-wasm.py \
  /tmp/p5-4-images4 /tmp/p5-4-images6
```

This checker reuses the signed release/tag, official binary and all-layer checks.
All four API files must agree between Git, authenticated release source and the
reviewed checksums. Missing files prove no compiled absence. The
[receipt](../../docs/process/p5-4-images8/receipt.md) records its own checks and limits.
The historical ten-reference validation and PCRE/Valgrind records stay unchanged.
Seven references, Corepack/Go/kubectl/agentgateway bundles, vulnerability clearance,
exact-source R3 approval and publication remain outstanding.

The [Corepack inventory](../../docs/process/p5-4-images9/inventory.json) adds exact
file and launcher-link comparisons for Corepack 0.34.6. Its compressed source
fixture retains all 54 files. The compressed range list accounts for all 967,004
bundle bytes, including generated helpers, dependency labels and inline attribution.
The checker verifies the compressed range file's checksum before decompressing it.
Loading, decompression and parsing failures return fixed error text without local paths.
The [receipt](../../docs/process/p5-4-images9/receipt.md) explains every table column.

```sh
nice -n 10 python3 docs/process/p5-4-images9/check-corepack.py \
  /tmp/p5-4-images4 /tmp/p5-4-images6
```

The same saved signed Node evidence supplies Git, release source and official
installed copies; the candidate comparison checks every layer, including hidden
or additional copies. Observed module versions and patched cache labels do not
prove complete source ancestry. All dependency grants remain BLOCKED, including
Undici's embedded llhttp Wasm and the retained inline MIT claims. Corepack's own
MIT declaration grants no blanket approval. Historical resolutions, approved
inventory and runtime pins are unchanged. Promotion still refuses exact-source R3.

## Private owner email

The development owner email uses the [private host file](../dev-stack/README.robot.md#private-owner-email)
shared by development stacks. Preparation reads it before creating credentials,
then copies its value into the private runtime Secret as `DEV_OWNER_EMAIL`.
The packaged bootstrap receives that environment setting. The twice-fresh check
compares the member and both events against the private file's address.

## Optional PostgreSQL primary and standby

P5-3 adds rendering and installer refusal checks. Live installation is not yet tested.
The default remains the existing one-instance PostgreSQL StatefulSet. `postgres.mode: cnpg` replaces that StatefulSet
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
fields. The installer checks live Secret contents before calling Helm.
Preparation remains unchanged.

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

No database is renamed. `infra/dev-stack/cnpg.ts` checks the advertised
`postgresql.cnpg.io/v1` Cluster API and requires exactly one operator Deployment
selected by `app.kubernetes.io/name=cloudnative-pg`. Its `manager` container must
use `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.<patch>`, optionally with a digest.
This checks the declared version; it does not approve the operator image or prove
that its running binary is healthy. Digest/licence promotion remains later work.

Before Helm runs, the installer reads both basic-auth Secrets in the owned namespace.
It compares their passwords with bootstrap and runtime connections in memory,
including the existing server, dispatcher and OpenFGA roles and database names.
All four generated role passwords must contain exactly 64 lower-case hexadecimal
characters, as bootstrap requires. The installer also checks the connections after
bootstrap imports its own Secret over the runtime Secret. Conflicting connection
fields refuse before Helm, even when the runtime connections are valid.
It refuses connection query parameters that override checked fields. Errors discard
private values and dependency output. Rendered `imageName` fields must match the
exact reviewed PostgreSQL image; container `image` fields retain their existing check.
The shipped review still refuses CNPG. Preparation and bootstrap remain unchanged.

`cnpg-install.test.mjs` runs the installer with synthetic Kubernetes replies and a
synthetic review, then inspects real Helm resources. Incomplete inputs never reach
Helm; image refusals allow rendering but never installation. Complete CNPG and
standalone fixtures reach the release check. These fixtures do not qualify live CNPG.
The [installer receipt](../../docs/process/p5-3-pr2/receipt.md) records local checks.

The installer and route-preparation tests share `expired-certificate-fixture.mjs`.
It signs a peer certificate with an ordered start and end date in the past.
This avoids negative certificate lifetimes, which some OpenSSL versions refuse.
The fixture checks both dates before the expired identity reaches validation.

The fresh-install runner and NATS route preparation tests use `packaged-fixture.ts`
to copy the installer and its local imports into temporary worktrees. The helper
checks imports with the installed TypeScript parser. A new local import must join
the shared file list before either fixture can run. A negative fixture adds an
unlisted local import and checks that copying refuses with the missing filename. These checks do not change
installation behaviour or replace the existing ownership and certificate assertions.

[Bootstrap](https://cloudnative-pg.io/docs/1.30/bootstrap/),
[storage](https://cloudnative-pg.io/docs/1.30/storage/),
[scheduling](https://cloudnative-pg.io/docs/1.30/scheduling/) and
[labels](https://cloudnative-pg.io/docs/1.30/labels_annotations/) describe the CNPG contracts.
The [receipt](../../docs/process/p5-3-pr1/receipt.md) records checks and limits.
Backup/WAL, all-database restore, storage denial, live standby and promotion remain
NOT RUN under #15. Rendering is not live k3d proof.

## Local database backup preview

P5-3 PR 3a adds render/refusal support after PR #738 merged at
`ced4d8002413382f369d99901eb55a4c9e480909`. It uses CNPG 1.30's existing native
[`barmanObjectStore` contract](https://github.com/cloudnative-pg/cloudnative-pg/blob/release-1.30/docs/src/appendixes/backup_barmanobjectstore.md).
Upstream deprecated native support in 1.26. Its 1.30 documentation now identifies
1.31 as the last minor release with native support and removal from 1.32 onwards.
A future upgrade needs a separately tested migration. This preview adds no plugin,
operator, image or registry change. Image/helper compatibility and shipped inventory
belong to p5-4-images1.

The ordinary PostgreSQL and CNPG renders stay unchanged when `postgres.backup` is
absent. For a preview, add this block under the existing CNPG settings, replacing
`cluster-test` with the Helm release namespace:

```yaml
postgres:
  mode: cnpg
  operatorContract: "1.30"
  superuserSecret: cnpg-superuser
  applicationSecret: cnpg-projection
  backup:
    enabled: true
    renderOnly: true
    method: barmanObjectStore
    destinationPath: s3://database-backups/local-check
    endpointURL: https://backup-store.cluster-test.svc:9000
    endpointCA: { name: backup-trust, key: ca.crt }
    s3Credentials:
      accessKeyId: { name: backup-identity, key: ACCESS_KEY_ID }
      secretAccessKey: { name: backup-identity, key: ACCESS_SECRET_KEY }
```

The endpoint must name an HTTPS Service in that namespace, ending in `.svc` or
`.svc.cluster.local`, with an optional port from 1 to 65535 and trailing slash.
URL credentials, query strings, fragments and other paths refuse. The S3 bucket
name has 3–63 lower-case letters, digits or hyphens, starting and ending with a
letter or digit. Optional path segments use letters, digits, underscores or hyphens.
The CA certificate and both credentials refer to existing Secret names and keys.
No Secret or credential value is rendered. Rendering checks their shape only;
it cannot establish trust, read the references or verify the endpoint's owner.

The Cluster requests AES256 object-store encryption for both `data` (base backup)
and `wal` (write-ahead log). One `ScheduledBackup` names that Cluster, explicitly
uses `barmanObjectStore`, and fixes `schedule: "0 0 0 * * *"`, `suspend: true` and
`immediate: false`. The [upstream scheduling contract](https://github.com/cloudnative-pg/cloudnative-pg/blob/release-1.30/docs/src/backup.md#scheduled-backups)
uses six fields including seconds. The suspended schedule requests no scheduled
or immediate base backup; no on-demand `Backup` is emitted. Overrides, inline
credentials, other methods and standalone backup settings refuse.

Suspension does not stop WAL archiving if someone applies the Cluster directly.
The package installer therefore refuses any `postgres.backup` setting before Helm,
even with ordinary CNPG image approval. Removing this refusal needs compatible
images and backup helpers, live credential/CA/endpoint checks and storage proof.
The preview must not be installed directly. AES256 settings request server-side
encryption; rendered YAML does not prove encryption or constitute a database backup.

Real Helm and installer tests cover the preview and refusals. The installer uses
synthetic Kubernetes replies and image approval. All three database recovery,
missing WAL, denied storage access, encryption, standby promotion and fresh-install
backup work remain **NOT RUN**. Local S3 would prove local recovery only. The
matched event/database/object/volume set in the accepted design remains later work.

### Ownership timeout tests

`chart.test.mjs` checks cancellation and deadline expiry while a real child process
stands in for a stalled namespace or node query. Docker and Kubernetes replies are
test fixtures. The tests do not contact an installed stack.

The backup checker, ownership checks and real `commandTimeout` function share a
controlled clock. The fixture records the time read when a timeout is calculated.
It then adds a 10 ms scheduling pause before the first child starts, followed by
50 ms for its ownership reply. Real timers still stop the stalled child.
Each child timeout must be positive and no greater than the time remaining at its
calculation. Timeouts must never increase. The first timeout must be 500 ms and
the last must be 440 ms. These comparisons have no tolerance.

Comparing against the later child start time previously allowed only 2 ms for
scheduling. That comparison rejected a valid timeout whenever the delay exceeded
2 ms. The controlled pause reproduces that failure without depending on how busy
the runner happens to be.

## Exact database recovery preview

P5-3 PR 3b builds on PR 3a, merged as PR #749 at
`441c96a4f6f87bcc9410335c332972895c9a5d83`. The accepted design is backup steps
3–4 and D03/D06/D07 in `docs/specs/phase-5/`. This preview follows the CNPG 1.30
[recovery contract](https://github.com/cloudnative-pg/cloudnative-pg/blob/release-1.30/docs/src/recovery.md)
and the native object-store contract linked above. Native support is deprecated;
this change adds no plugin.

For a recovery preview, use `postgres.recovery` instead of `postgres.backup`.
Keep the existing CNPG mode, operator contract and role Secret references.
This example names a recorded source and an exact WAL position:

```yaml
recovery:
  enabled: true
  renderOnly: true
  method: barmanObjectStore
  source: recorded-origin
  serverName: postgres
  destinationPath: s3://database-backups/local-check
  endpointURL: https://backup-store.cluster-test.svc:9000
  endpointCA: { name: backup-trust, key: ca.crt }
  s3Credentials:
    accessKeyId: { name: backup-identity, key: ACCESS_KEY_ID }
    secretAccessKey: { name: backup-identity, key: ACCESS_SECRET_KEY }
  recoveryTarget:
    backupID: "20261026T120000"
    targetLSN: "0/7000028"
    targetTLI: "2"
```

`source` binds `bootstrap.recovery.source` to exactly one `externalClusters` entry.
`serverName` selects the source server's folder within the saved S3 path; it is
never inferred from the new Cluster name. Both names use 1–63 lower-case letters,
digits or hyphens, starting and ending with a letter or digit. Storage addresses,
CA and credential references use the same validation as the backup preview.
The references must exist in the fresh target namespace. YAML checks their shape,
not their contents, ownership, permissions or availability.

The target requires a Barman timestamp ID (`YYYYMMDDTHHMMSS`), a hexadecimal LSN
with 1–8 digits on each side of `/`, and a quoted decimal timeline from 1 to
4294967295. There is no `latest` fallback. Other targets and overrides refuse.
Recovery replaces `initdb` and keeps the actual `projections` database, `projection`
owner, application Secret and superuser Secret. These package names differ from
the older `opencrane`/`jobs` labels in the accepted design; no database is renamed.
No backup writer or schedule is emitted. Any simultaneous `postgres.backup`
setting refuses, even when disabled, so recovery cannot write into its source.

The description is for a fresh Cluster with new storage in an isolated namespace,
not an existing installation. Rendering cannot prove that a destination is empty.
The package preflight refuses every recovery setting before Helm, even with
synthetic ordinary CNPG image approval. The preview must not be applied directly.
Opening installation needs reviewed images/helpers, checks of the fresh target
and private storage references, and real recovery proof with effects kept stopped.
No image or inventory files change here.

Real Helm tests check exact values, unchanged ordinary resources and refusals.
Installer tests use synthetic Kubernetes replies. Live restore, WAL availability,
missing/corrupt backups and denied storage access remain **NOT RUN**. Rendered YAML
does not prove storage access or a usable restore. A database-only restore would
still not qualify the matched event/database/object/volume recovery set.

## Three-peer NATS rendering

The chart describes three peers for preview or checked installation. Installation
requires `renderOnly: false`. Preflight accepts only the four settings below and
requires `reviewed-images.json` to contain `natsCluster.replicas: 3`, plus
`natsCluster.server` and `natsCluster.web` equal to the exact reviewed image pins.
The shipped review has no such approval, so its old image still refuses.
Preparation can pass preflight before route objects exist. Image promotion is separate.

| Setting | Default | Required for the cluster |
| --- | --- | --- |
| `natsCluster.enabled` | `false` | `true` |
| `natsCluster.renderOnly` | `false` | `true` for preview; `false` for installation |
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
budget and unchanged default rendering. `preflight.test.mjs` checks image compatibility
and refusal of the shipped image. Existing event-store cluster tests retain real TLS refusals.
[The receipt](../../docs/process/p5-4-pr2/receipt.md) separates source checks from
three-node placement, R3 bootstrap, rotation and P5-5, all still NOT RUN.

## Private NATS route preparation

P5-4 PR 3b adds `prepare-nats-routes.ts`. After ordinary private preparation, run
`DEV_STACK_ID="$DEV_STACK_ID" node --experimental-strip-types infra/package/prepare-nats-routes.ts /private/cluster-values.json`.
The values include the cluster render settings above. The command checks the recorded
package owner, uses its verified Kubernetes context, checks reviewed image pins and
renders the real chart in that namespace. Each Secret read and creation checks the
package owner and namespace UID again. The private kubeconfig travels in the child environment.
Without a separate target, it uses the existing `k3d-ocn` context. There is no caller
context override. Offline chart rendering does not connect to Kubernetes.

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
Installation reuses this validation without generating or creating objects. It
requires the exact saved namespace, context, worktree, references, object UIDs and
contents, immutable objects, distinct peer keys, exact DNS names, valid dates, both
TLS usages and separate route trust. The live NATS client CA must still match the
prepared client CA. Every object operation rechecks ownership.
The target must be recorded and isolated, with exactly three recorded node UIDs,
three different hostnames and three Ready, schedulable nodes without blocking taints.
`cnpg-install.test.mjs` uses synthetic Kubernetes replies and real Helm to check
admission and refusal. Live R3 remains NOT RUN; see the
[installer receipt](../../docs/process/p5-4-pr5b/receipt.md).

`nice -n 10 node --experimental-strip-types --test infra/package/prepare-nats-routes.test.mjs`
runs disposable certificate and Kubernetes command fixtures, including pinned NATS parsing.
The [receipt](../../docs/process/p5-4-pr3/receipt.md) records source checks.
Live rotation and three-node installation remain NOT RUN.

## Packaged bootstrap

P5-4 PR 5a carries one replica choice through preparation and bootstrap. The private
settings writer chooses `1` when `natsCluster` is absent or explicitly disabled.
It chooses `3` when `enabled` is `true` and `renderOnly` is a boolean. Missing or
invalid flags and conflicting modes refuse before credentials or Secrets are written.
It writes the same value to `NATS_REPLICAS` and `COMMAND_NATS_REPLICAS`.
The preparation entry point runs image and settings preflight first. It does not
require route objects, which the separate route preparation command creates later.

Before any Helm command, the installer requires both runtime replica settings to
match the chart's count. Any same-named setting in the bootstrap Secret must also
match; bootstrap cannot supply a missing runtime setting. It compares the Secret
fields in memory and reports only a fixed error, never their supplied values.
`cnpg-install.test.mjs` records executed commands and checks that mismatches,
missing fields and conflicting overrides run no Helm command. Matching R1 inputs
reach rendering and the existing-release check. Prepared R3 with a synthetic image
review reaches exactly one install; the shipped review still refuses.

Bootstrap requires both replica settings to be exactly `1` or `3` and to agree.
It checks them before database setup, stream provisioning and private owner files.
It passes that count to the existing `EVENTS` stream and writes it into the owner's
private `command.env`. The dispatcher consumer inherits the stream's count.
An existing incompatible stream refuses without changing its configuration or data.
There is no extra stream or automatic conversion from R1 to R3.

Before provisioning, bootstrap polls the authenticated `bootstrap.meta` service.
For R3, the JetStream metadata leader must report at least three distinct current,
online metadata peers, including itself. Replies from followers cannot grant readiness.
For R1, the leader alone suffices; a standalone server has no metadata group.
A metadata group stores the shared stream and consumer settings, separately from events.
Each request waits at most one second. Failed readiness checks run again after at
most 200 ms, within one 120-second deadline. Expiry names the replica count and
limit, closes the connection and leaves the stream and consumer untouched.
Only unavailable readiness reads are retried. Incompatible-stream refusals fail
immediately. The bootstrap failure stage names the replica count and time limit.
The NATS settings expose this one read service only to the command key; no HTTP
monitoring port or system-account credentials are added.

The leader's report does not show whether it has received each peer's storage
statistics. For R3 only, bootstrap retries the explicit peer-offline placement
refusal: `JetStreamApiError`, status 400, code 10005 and description
`no suitable peers for placement, peer offline`. The fixed backoff is 200 ms,
shortened only to stop at the deadline. Metadata readiness and placement share the
same 120-second deadline; placement gets no new time allowance. Expiry reports a
fixed placement error and closes the connection without adding a consumer.
Every later setup request on bootstrap's dedicated connection also uses only the
remaining time, capped by the SDK's own request timeout. This covers both API
checks, stream lookup or creation, and dispatcher consumer creation. Bootstrap
checks the deadline after each reply and each setup step. A late successful reply
refuses before the SDK can start another request; a late placement refusal gets
no extra wait or retry. The connection closes on refusal. A request already sent
may have reached NATS, so refusal does not undo a stream or consumer that
NATS has already created.
Every other creation error, including timeouts, lost replies and other JetStream
codes or refusal descriptions, fails immediately. R1 creation is never retried.
The [readiness evidence](../../docs/process/ci-flakes-15.md) records the checks.

The Helm preview includes the same Job, service account and private mounts as the
default render. The shipped image pin is unchanged and has not been qualified for
this source. Image promotion and live controller, storage and placement checks
remain separate work.

The chart tests inspect real Helm output and the existing preparation fixture's
written settings. `bootstrap.test.ts` executes the bootstrap functions with disposable
TLS NATS peers and captures the private settings passed to the owner command.
It checks standalone and clustered R1, R3, consumer inheritance, invalid settings,
an unchanged incompatible stream, delayed metadata readiness, placement recovery,
shared-deadline refusal and immediate refusal of other creation errors.
Late-reply tests make metadata ready at 119,800 ms and receive a setup reply at
120,800 ms. They check refusal at each request, no later setup requests and no
consumer after late stream creation. Another test checks that all five SDK
requests receive the decreasing time left. A late placement refusal checks that
bootstrap neither waits again nor creates a stream or consumer.
Every clustered bootstrap test prepares real NATS placement statistics and removes
the empty R3 setup stream before replacing replies or clocks. It still requires
zero streams before provisioning. It polls the real account count for at most
20 seconds after deletion and reports the last count on expiry. This allows the
account report to catch up without adding a fixed wait.
The ordinary R3 test uses real time.
These are source checks. Images, controller and storage prerequisites, and
live Kubernetes placement are NOT RUN. The
[receipt](../../docs/process/p5-4-pr5a/receipt.md) records the checks.

## Event-byte export

`event-backup-run.ts SILO ATTEMPT DESTINATION` uses the existing `NATS_*`
connection settings and TLS/NKey files. It is a local operator command, with no
application endpoint. The existing administrative command identity can snapshot;
projection, dispatcher, computer and gateway identities cannot. No account grants
change. Operators supply the source silo id and a fresh attempt id. Every retained
event must name that silo. Empty logs are refused because they cannot prove this binding.

The destination must be absent, below a real, owned mode-0700 directory with no
symlink ancestors. New directories use 0700; temporary and final files use 0600.
A successful capture publishes `events.snapshot`, then `descriptor.json` last.
Handled failures remove the owned destination. A killed process can leave partial
files; a directory without its descriptor is unusable and is never overwritten.
No archive is encrypted by this command. Both files remain private operator material.

The strict descriptor records `kind=event-bytes-only`, silo, attempt, stream name,
creation time, configuration, retained range, per-subject last global positions,
event count, identity digest, archive byte count and SHA-256. NATS-generated metadata
is omitted because INFO and SNAPSHOT annotate it differently. Free-form descriptions,
customer metadata and unsupported configuration values refuse. The identity digest
hashes UTF-8 JSON arrays `[globalSequence, natsSubject, eventId]`, each followed by a
newline, in global order. Event bodies never enter the descriptor or command output.

Limits are 64 MiB each for scanned event bytes and snapshot bytes, 100,000 events,
1 MiB per management reply, two seconds per request and 60 seconds overall.
Tests can tighten the byte/time bounds. Connection setup shares the command's
60-second deadline; a 65-second process limit also bounds shutdown. SIGINT/SIGTERM
cancel capture. Snapshot messages with failure status headers refuse, including
empty final messages with status 500 (block read failure) or 408 (acknowledgement
timeout). These failures remove partial output and publish no descriptor. Errors
never include the server's status description.
Lost connections, missing final chunks, malformed replies, holes,
changed creation time, configuration or retained positions refuse. The command
saves no consumer state and never changes admission or resumes work.

P5-7 PR 1 covers event-byte proof only. Stable positions are not proof of quiescing.
CNPG/WAL, objects, volumes, custody inventory and coordinated restore remain later
work, with live P5-3/P5-5 still required. See the
[receipt](../../docs/process/p5-7-pr1/receipt.md).

## Event-referenced object copy

`collectObjectBackup` in `object-backup.ts` accepts source and empty disposable NATS
connections, the existing scoped `storageClient`, and options naming the private
event archive directory, a new destination, silo, attempt and `backupKeyFile`. `writersStopped: true`
and `disposable: true` are required. The operator must stop writers and keep them
stopped throughout. Unchanged positions alone cannot prove this.

The helper restores the checked archive into that disposable server before reading
its `file.uploaded` events. It reuses event descriptor, subject, silo and source
position checks. Both NATS servers must be standalone, with the source reachable.
The target stays isolated and is left intact on success or failure; dispose of it
separately. No product process starts. This helper has no command-line wrapper.

Only the fixed `files` bucket is read. Addresses must match the event's silo,
conversation id, file id and hash. Delivered files and screenshots stay included;
unreferenced objects are outside scope. Matching duplicates share one copy;
conflicting counts or hashes refuse. Capture is limited to 1,000 distinct objects,
64 MiB of object bytes and 60 seconds including archive validation and restore.
Tests may tighten those limits. Existing event archive limits still apply separately.

Absolute directories must be owned, mode 0700, with no symlink ancestors. The new
destination must not exist. Object files and the descriptor use exclusive mode 0600.
Each object is counted, hashed, encrypted and flushed before `descriptor.json` is published.
The key file contains exactly 32 raw bytes, belongs to the process user and has mode
0600. Missing files, links, other modes and other lengths refuse before capture.
The caller passes its path in process memory through `backupKeyFile`; neither key
nor path belongs in command arguments, logs, events or the descriptor. No wrapper
accepts this path on the command line. Keep the key separate from the copied files.

Node's built-in AES-256-GCM encrypts each file with a fresh random 12-byte nonce.
The associated data is UTF-8 JSON `[identity, sha256]`, using the opaque object
identity and archived content hash. Each file contains that nonce, ciphertext,
then the 16-byte authentication tag. No plaintext object is written. The descriptor
uses version 2 and `encryption: aes-256-gcm`; object byte counts still count plaintext.
`readBackupObject(directory, keyFile, reference)` in `event-restore.ts` reuses the
private-file checks, authenticates the encrypted bytes and checks their plaintext
length and hash before returning any bytes. Changed ciphertext, nonce, tag,
identity, hash or key refuses with `Object restore refused`. It returns checked
bytes to its caller; uploading restored files and reopening an installation remain
outside this helper. The reference must come from the checked archive's inventory.

Capture cancellation reaches the HTTP request before headers, during region lookup
and during object download. Requests also have socket and absolute time limits.
All replies except expected object downloads are limited to 64 KiB before the SDK receives them;
headers are limited to 16 KiB. A failed capture destroys its active request.
The private descriptor binds silo, attempt, event archive and descriptor hashes to
each object's opaque identity, byte count and SHA-256. Names, addresses and bytes
never enter diagnostics or the descriptor. A failed capture removes only its own
output and returns `Object backup refused` without a dependency error or cause.
The archive and source positions are checked again before completion. Each encrypted
file's hash is calculated from the nonce, ciphertext and tag sent to disk. Every saved
file must still match that hash before completion, including after later files copy.
An optional final callback receives each filename and original encrypted hash after
its copy finishes. Combined capture keeps these hashes for its final comparison.

`apps/server/test/object-backup.test.ts` runs in the existing CI test glob with
real disposable NATS and scoped MinIO. Selected stream faults are injected after
opening a real object response. The [receipt](../../docs/process/p5-7-pr2/receipt.md)
records local checks. P5-7 remains PARTIAL: CNPG/WAL, computer volumes,
coordinated-set completion, admission reopening and fresh-install recovery are NOT RUN.
The private descriptor is trusted operator material, not an authenticated manifest.

## File object restore

`restoreObjectBackup` in `object-restore.ts` accepts the stopped NATS target and
`proof` returned by `restoreEventBackup`, plus source and target `storageClient`
instances. The caller supplies `directory` for objects, `eventDirectory`,
`backupKeyFile`, `silo`, `attempt`, `targetSilo`, and true `stopped`, `exclusive`
and `disposable` confirmations. These confirmations alone never authorise a target.
`provisionDisposableObjectTarget(silo)` creates a fresh local MinIO container with
new private credentials and no product processes or existing data mounts. It uses
the linux/amd64 image manifest listed in the
[CI download notes](../../scripts/ci/README.robot.md#test-image-downloads), so it
does not fetch the index's attached build records from the mirror. It issues
one short-lived lease and writes an owner marker with the silo and a random instance
id into `opencrane-restore/owner`. It returns `client`, `name` and an explicit `close`
operation. The caller retains the target for inspection until it chooses to close it.
Only clients registered by that provisioner in this process can restore files.

Docker starts from the private directory and receives only `environment` as the
environment filename. No private directory or credential value enters its command
arguments. Directory creation and every later setup failure return
`Disposable storage provisioning refused`. Cleanup still attempts container and
directory removal; cleanup failures cannot replace the provisioning refusal.
Explicit `close` failures return `Disposable storage cleanup refused`.
`apps/server/test/disposable-object-target.test.ts` observes the real Docker launch
arguments and injects directory, file and Docker failures, including simultaneous
setup and cleanup failures. It uses disposable MinIO and removes its containers
and volumes even when the injected cleanup fails.

Restore claims the registered instance once, including after a failed attempt.
It refuses a foreign silo, an unmanaged client, a closed instance or a second claim.
Before bucket creation, before each upload and after readback, it checks the actual
Docker process list contains only MinIO, checks the loopback port matches the client,
and reads the exact owner marker back from that endpoint with a byte limit. Missing,
changed or oversized markers refuse. Endpoint and lease swaps cannot reuse caller
declarations to authorise another silo. No product process receives these credentials.
Docker administrators remain trusted: they can inspect credentials or alter running
containers. This helper does not claim isolation against host administrators.
Endpoint comparison also rejects the source address.
The private descriptors remain trusted operator material, not signed manifests.

Before creating the files bucket, it checks the merged version-2 encrypted descriptor,
both archive hashes, silo and attempt, private paths/modes/owners, every file's
authentication, count and checksum, and the checked events' addresses and MIME types.
Matching upload references share one object; conflicting references refuse.
At most 1,000 objects and 64 MiB of plaintext stay in memory. The whole operation
has 60 seconds; `timeoutMs` may shorten it and `signal` may cancel it.

Only the local MinIO fixture is qualified. Atomic bucket creation must refuse an
existing bucket, even if empty; S3 providers that accept repeated creation are
unsupported. Each upload also requires the address to be absent. Every object is
read back, counted and hashed, with its stored MIME type checked. No failure deletes
or resends anything. All failures return `Object restore refused; keep target isolated`.
A rerun refuses the leftover bucket. Credentials and paths stay out of diagnostics.
Bytes grant no access: replay/access comparison and current custody/deletion checks
still apply. No scan, delivery, event recreation or admission reopening runs here.
The [object-only receipt](../../docs/process/p5-8-pr2/receipt.md) records the checks.

## Computer volume inventory

`collectComputerVolumeInventory` in `computer-volume-inventory.ts` takes reachable
source and empty disposable NATS connections and the private archive directory,
silo and attempt. Its Kubernetes settings are the caller's already checked context,
private kubeconfig path, namespace and namespace UID (from package ownership checks).
It verifies that namespace against Kubernetes twice. It neither claims a namespace
nor changes any Kubernetes resource. The optional read function is for controlled tests.

The existing restore and history readers check and replay the archive. Assistant
creation and computer claim/ready events supply the current generation and exact
Sandbox UID. Missing or conflicting bindings refuse, including older readiness
records without a generation or Sandbox UID. Lost and retired computers still
require their retained home. Repeated claims must advance the generation by one;
a computer cannot change assistant or name. Empty inventory requires no archived claims.

The helper reuses the lifecycle client's label, home owner and suspension checks.
It requires exactly one matching Sandbox and `home-<computerId>` PVC, with one
controller owner reference to that exact Sandbox UID. The PVC must have phase
`Bound` and a `spec.volumeName`. The helper reads that named PersistentVolume
and requires phase `Bound` and a `spec.claimRef` with the exact PVC namespace,
name and UID. Missing volumes, old claim UIDs and foreign claims refuse. The
second observation repeats these checks and compares the PV name, UID and resource
version as well as the PVC and Sandbox records. Kubernetes credentials need read
access to those cluster-wide PersistentVolumes. The kubeconfig path stays in
`KUBECONFIG`, outside command arguments. The suspension report must
say `Suspended=True`, `reason=PodTerminated`, and name the current Kubernetes
resource generation. That generation is separate from the archived computer generation.
All Pods in the namespace are checked, including unrelated Pods mounting the home.
Partial lists, duplicate ownership, denial, timeout and changed resources refuse.

Limits are 1,000 assistants, 10,000 resources per list, 2 MiB per Kubernetes reply
and 60 seconds overall. Kubernetes commands have an eight-second request limit and
a ten-second process limit, with cancellation and bounded output. Existing event
archive limits apply. Source/target history and private archive files are rechecked.
The returned private record contains only silo, attempt, archive/descriptor hashes,
namespace name/UID/version and each assistant/computer generation with Sandbox and
PVC and backing PersistentVolume names/UIDs/versions. It saves no file and emits
no event or public API response.
Every failure returns only `Computer volume inventory refused`, without a cause.

`libs/event-store/test/computer-volume-inventory.test.ts` uses real disposable NATS
archive/replay and synthetic Kubernetes replies. The target remains isolated and
must be disposed of by the caller. A result describes observations during this call;
it cannot lock out later writers. Keep writers stopped through later byte capture.
P5-7 PR 3a is the first volume part only. Live volume capture, CSI snapshots, custody
backup and live quiescence remain NOT RUN. This is not coordinated-set completion.

## Computer home export

`collectComputerVolumeExport` in `computer-volume-export.ts` uses the inventory's
source, empty disposable target and options, plus `backupKeyFile`, a new absolute
`destination`, and `writersStopped: true`. Keep writers stopped throughout. The
inventory checks suspension and absence of Pods again after copying; the helper
does not stop writers itself. There is no command-line or public API wrapper.

The trusted internal reader receives the checked inventory, cancellation signal and
one requested home, in that argument order. For each home it supplies that exact
identity, one Readable, its expected byte count and SHA-256. Every inventoried home
is required, including lost and retired homes. Zero homes is valid only when the
event-derived inventory is empty. All homes share a 64 MiB plaintext limit and one
60-second deadline, including inventory checks. Reaching the deadline refuses;
exactly 64 MiB is allowed. The helper reads homes sequentially inside one pair of
inventory observations. Missing, substituted or wrong-generation replies refuse.
The reader must honour cancellation before returning a stream. The helper destroys
active streams and any stream returned after cancellation. Tests may shorten the deadline.
Caller-declared metadata is not proof that a live PVC supplied those bytes.
Kubernetes export and mount/Pod ownership proof remain later work.

The inventory's optional fifth argument runs the copy between its two observations.
It receives a copy of the checked identities. Later ownership, resource version,
history or archive changes refuse completion. Stable observations cannot prevent
changes after the final check. Dispose of the isolated NATS target separately.

The key uses the existing private 32-byte key-file checks. Directories must be
owned, mode 0700 and free of symlink ancestors; existing destinations refuse.
Files are named `home-0000.enc`, `home-0001.enc` and so on, in inventory order.
Each is mode 0600: a random 12-byte nonce, AES-256-GCM ciphertext, then the 16-byte
tag. Associated data is UTF-8 JSON
`[2, "volume-export-only", "aes-256-gcm", binding, entry]`. `binding` is the complete
checked inventory, including namespace, Sandbox, PVC/PV, generation, silo, attempt
and both event archive hashes. Each `entry` has `file`, `home`, `byteCount` and
`sha256`, in that order. `home` is the full matching inventory entry. Swapping files
or identities fails authentication. No plaintext file is made and no archive is
extracted. The helper counts and hashes bytes as they arrive.

Each encrypted home has an in-memory hash calculated from the nonce, ciphertext and
tag sent to disk. The saved file must still match that hash after all copies and
inventory checks. The optional sixth argument receives each filename and encrypted
hash after its copy finishes, so combined capture can retain the original output.

After complete input, encryption and flush, the inventory checks run again.
Only then is the private descriptor published and returned with version 2,
`kind: volume-export-only`, `encryption: aes-256-gcm`, `binding` and `exports`.
`volumeExportDescriptorSchema` checks this format before publication. It rejects
unknown fields at every level, unsupported versions or encryption, unsafe file
names, missing or duplicate entries, identity mismatches and aggregate overflow.
Version 1 is no longer accepted. Schema checks alone do not authenticate files;
recovery must also verify each file's GCM tag against its associated data.
Errors contain only `Computer volume export refused`, without a cause. Failure
removes owned output where possible; incomplete output is never a completed export.
Keys, key paths and home contents stay out of descriptors and diagnostics. A valid
32-byte key cannot be identified as the wrong recovery key during encryption;
independent decryption checks that changed keys or authenticated data refuse.

P5-7 PR 3c extends #753's writer and keeps #743's inventory unchanged.
`libs/event-store/test/computer-volume-export.test.ts` uses real disposable NATS,
synthetic Kubernetes replies and distinct local streams through the production
writer. It checks independent decryption, second-home failures, retained homes,
strict descriptors, changes during either copy and shared size/deadline boundaries.
The [local receipt](../../docs/process/p5-7-pr3c/receipt.md) records these checks.
Live PVC capture, CSI, custody backup and coordinated recovery remain NOT RUN.

## Matching component capture

`collectBackupCapture` in `backup-capture.ts` composes the existing event, object and
home collectors. Supply the source connection, two distinct owned disposable NATS
connections, the existing storage client, export options, a trusted home reader and
a Kubernetes reader (or `undefined` for the existing adapter). The namespace/context
must already be checked. Both targets must be empty; they remain intact and isolated
on success or failure. Lost completion is unknown and never triggers erase or resend.

The absent destination is created under an owned private directory. Its `events`,
`objects` and `homes` children retain the existing formats. One original deadline
(at most 60 seconds) and cancellation cover the sequence, including final checks.
Each stage receives only the remaining time. Keep `writersStopped` true throughout;
the helper checks it between stages and during home copying. It does not stop or
resume admission, and this assertion does not prove live quiescence.

The helper checks silo, attempt, event archive and descriptor hashes across components.
It retains each encrypted archive's hash when that archive is written, before any
later copy can change it. The event snapshot must match the hash recorded during
snapshot writing. After copying, the helper authenticates every file and home against
its descriptor with the existing restore checkers, checks source history again, and
compares every saved archive with its original output. All checks use the time left
from the original deadline. Any mismatch refuses the whole set before returning
counts and hashes labelled `capture-components-only`. No combined manifest
is saved. Failed attempts may leave partial component evidence; it is not a usable
system backup. Errors withhold dependency messages, private paths and content.

`infra/package/backup-capture.test.ts` uses real disposable NATS and MinIO,
synthetic Kubernetes records and two distinct home streams. It checks matching and
empty-home results, refusals, original-deadline expiry, cancellation, lost completion
and zero calls at actual replay, scheduler, model, tool and credential entry points.
It also replaces an already saved first home while the second home is read, and
replaces a saved event or file archive during a later file copy. Each refuses the set;
changes during the final source check remain covered.
P5-7 PR 4a is partial component evidence. P5-3 remains required. CNPG/WAL, custody
capture, live mounted-source proof, admission stop/resume and the final complete
manifest remain later work. Live qualification: NOT RUN.

## Event-byte restore

`event-restore-run.ts SILO DIRECTORY --disposable` restores the event-only export.
`SOURCE_NATS_*` supplies the reachable source connection; `NATS_*` supplies the
separate disposable target, using the same TLS/NKey fields as export. The operator
must isolate that target and keep all product processes stopped. The explicit flag
confirms it is disposable; this command does not prove Kubernetes ownership.
Both servers must be standalone, without advertised cluster or domain settings, and the
archive must describe one replica. Offline-source and clustered restore are later work.

Before mutation, the helper checks private files, the strict export descriptor,
size/SHA-256, source creation time/configuration, range, ordered event ids and subject
positions. The source must still match the capture. It requires the precise NATS
stream-not-found response for target `EVENTS`; an existing stream, even empty,
refuses. NATS also refuses a competing creator at restore start. No path deletes,
purges or overwrites a stream, and no transfer is retried. NATS assigns a new stream
creation time; that identity must remain stable during target proof checks.

The command uses the export's 64 MiB, 100,000-event, 1 MiB reply and 60-second bounds.
Native restore sends 32 KiB frames and one empty completion frame. An uncertain
completion, timeout, partial transfer or failed close returns a fixed error and
leaves the target isolated. A lost completion reply refuses even if all bytes were
saved. Inspect or dispose of that owned target separately; rerunning refuses any
existing `EVENTS`. The command starts no readers, scheduler or dispatcher.

Tests use real disposable TLS NATS processes and inject selected transport faults.
They restart the event-store client, check stale-position refusal and prove command
history prevents a repeated command after native deduplication is lost. Executable
output checks include private canaries and failed connection cleanup.
See the [receipt](../../docs/process/p5-8-pr1/receipt.md). P5-8 remains partial:
all databases/CNPG, object and volume ownership, current custody/deletion state,
rights/cents comparisons, outbound-effect suppression and reopening are NOT RUN.
A partial event archive cannot authorise a full restore; full P5-8 needs live P5-7.

## Combined event and file restore

`restoreRecoveryBackup` in `recovery-restore.ts` takes source and target NATS
connections, source and target storage clients, and the file restore options without
`proof`. It also requires `volumeDirectory`, `effectsDisabled: true` and `memory`,
containing the trusted
current NATS `source`, `sourceDirectory` and prepared `candidateDirectory`. These
private connections and paths stay in memory; there is no new command-line argument.
The archive source and current deletion evidence are separate inputs. The stopped,
exclusive and disposable confirmations must be true, and both silo declarations must match.
Both event sources must stay reachable and stopped. Operators remain responsible for
stopping their writers and effects; this helper never starts or stops product processes.

`provisionRecoveryEventTarget(silo)` starts a fresh standalone local NATS process
with an empty private directory and a random private token. It returns a connection
and an explicit `close()` operation. The temporary mode-0600 configuration is removed
once the server starts. NATS receives only its configuration filename in arguments;
the private directory is its working directory. Tokens and private paths stay out of
arguments and returned errors. Directory creation, configuration writes and startup
failures return `Recovery event target refused`. Cleanup attempts connection close,
child termination and directory removal even if an earlier step fails. Explicit
cleanup failures return `Recovery event target cleanup refused`; cleanup cannot
replace a startup refusal. Only that registered connection, server identity and
running child can be claimed, once.
`apps/server/test/recovery-event-target.test.ts` inspects the real spawn arguments
and injects setup and cleanup failures, including simultaneous failures.
The file target must come from `provisionDisposableObjectTarget(silo)`. Host
administrators and the operator's private archive directories remain trusted.

Before mutation, the helper reuses object restore validation against the source:
private descriptors, matching silo/attempt/archive hashes, encrypted object checks,
and event-derived addresses and MIME types. It erases the checked plaintext.
It checks that NATS contains no streams and storage contains only its owner-marker
bucket. It verifies the actual storage owner and process list before native restore.
Immediately before native restore, `checkComputerVolumeBackup` checks the version-2
multi-home descriptor, both exact event archive hashes, silo and attempt. It reuses
the inventory's event reader to require every retained computer and generation,
including an explicitly empty export when events contain no computer claims.
Every listed encrypted home must be present, with no extra files. The backup key
comes from the same private `backupKeyFile` used by the object copy.

Private files and directories must have their expected permissions, owner and real
paths, without symlinks. Their identities and modification times must stay unchanged
through validation. Private reads allow 1 MiB for the event descriptor, 2 MiB for
the home descriptor and 64 MiB for the event archive.
Each home is authenticated with the exporter's complete associated data. Decrypted
chunks are counted, hashed and immediately erased; none are extracted or returned.
All homes share the descriptor's 64 MiB allowance and the original recovery bounds.
Cancellation and deadline checks continue between chunks. Source history and input
files are checked again before returning. This checks saved bytes, not mounted ownership.

Native restore then validates the reachable source again. Its exact result goes to
object restore, which repeats validation against the restored events and reads back
all uploaded bytes. Only confirmed completion of both stages calls `checkMemoryRestore`
with the trusted current source and restored target. The existing check requires a
standalone source and target, a matching history prefix, identical current key folders,
permanent deletion markers and usable surviving keys. It checks all deletion, identity
and stability conditions before decrypting any surviving fact. It changes no custody.
No stage deletes, retries, recreates events or starts actors.

The whole sequence shares one cancellation signal and a deadline of at most 60 seconds.
`timeoutMs` can shorten it. Cancellation closes the NATS connection and active storage
requests. Failed or uncertain completion returns only
`Recovery restore refused; keep both targets isolated`. Successful completion returns
only `{ kind: 'events-objects-and-custody-only' }`. Targets stay intact until the operator
explicitly disposes of them; a second attempt with either claimed target refuses.
There is no command-line wrapper or new archive format.

P5-8 PR 3c is PARTIAL. This result never authorises replay, reads or reopening.
Mounted computer-volume restoration, CNPG/WAL and database restore, full comparisons and credential
renewal still block reopening. Coordinated live recovery is NOT RUN. The
[receipt](../../docs/process/p5-8-pr3c/receipt.md) records local fixture checks.
`recovery-custody.test.ts` restores real events and objects from an old archive, then
checks current deletion markers. It refuses stale or missing custody, unavailable
surviving keys, missing next-revision or orphan markers, changed inventories, wrong
identities, non-prefix history and source movement with zero decryption. Wrong-key
authentication has a separate case. Exercised probes forbid database opening, replay,
key changes, schedulers, models, tools, scanning, delivery and credential release.

## Interrupted handler upgrade check

`upgrade-recovery.ts` collects ordered ids, positions and event SHA-256 values,
plus the members checkpoint and a digest of all six tables owned by that projection.
It stores no event bodies or row values in the comparison result. Writers and
reactions must already be stopped. The checker requires matching event order,
unique ids, complete positions from one, rows and checkpoints. The export descriptor
must agree with those event identities and per-subject positions. The existing
restore helper checks archive bytes; the comparison does not authenticate an archive.

`upgrade-recovery.test.ts` uses the existing SIGKILL fixture after a committed
256-event scan chunk. It retains the failed attempt's previous/target manifests,
refuses a different manifest without changing parked jobs, then restores the earlier
export through `restoreRecoveryBackup` into privately provisioned disposable NATS
and object storage. Current events and memory keys are checked separately from the
frozen archive. Coordinated capture includes two distinct non-empty homes. Only after these checks
does the fixture rebuild disposable projections and rights in a separate database.
No dispatcher, reaction worker or scheduler starts during recovery. A tested local
recording endpoint guards reaction callbacks in both processes and receives zero calls.
A lost restore completion remains uncertain; that target gets no projection, retry
or stream deletion. Truncated bytes and mixed attempts refuse before transfer. The source stays reachable
and unchanged, as required by the event restore contract.

Run the `infra/package/upgrade-recovery*.test.ts` files with Vitest and
`PG_TEST_URL` pointing to a throwaway PostgreSQL admin database, under `nice -n 10`.
The root Vitest file list includes them in CI. Safe fixture results go to
`.tools/upgrade-recovery-proof.json` and `.tools/upgrade-recovery-uncertain.json`.
See the [receipt](../../docs/process/p5-9-pr1/receipt.md). Handler manifests describe
subscriptions only; they cannot establish package/schema rollback compatibility.
Coordinated databases/WAL, mounted volumes, pinned-release upgrade and full P5-9
remain NOT RUN. Later fixture increments below cover objects, custody and rights.

### Budget comparison after interruption

`upgrade-recovery-budget.ts` hashes all rows in `model_budgets`, `model_budget_calls`,
`model_budget_effects` and `model_current_effects` in stable order. It compares that
hash and the budget checkpoint with the saved source and checked archive position.
The fixture uses the existing accounting events and `rebuildBudgetProjection`.
Only the source starts a BudgetActor to save three acknowledged reservations,
a 70-cent settlement and an unresolved effect before export. Recovery starts no
BudgetActor, provider, scheduler, dispatcher or reaction worker.

The same archive restores into empty NATS. Two budget rebuilds retain the original
reservation and permit ids, 210 held cents and 70 settled cents. The unresolved
90-cent reservation stays held. Event comparison and an append spy check for new
spend or retries. Lost completion starts no budget replay and leaves all four budget
tables absent. The recording endpoint is exercised before its count is reset.

`upgrade-recovery-budget.test.ts` changes real database rows before collecting them.
It covers changed holds, missing settlement amounts and saved effects, changed current
effect state, lost reservations, duplicate effects, budget totals, changed identities
and ahead checkpoints. No test substitutes an already calculated hash.
The [budget receipt](../../docs/process/p5-9-pr2/receipt.md) records only event-to-budget
projection proof. CNPG/WAL, objects, volumes, rights, compatible packaged rollback,
admission reopening and full coordinated P5-7–9 remain NOT RUN.

### File comparison and authorised reads after interruption

`upgrade-recovery-files.ts` hashes complete file rows in stable order and reads each
stored object to check its actual byte count and SHA-256. The result contains only
counts, hashes and the files checkpoint. Collection allows 1,000 rows, 64 MiB and
60 seconds. Both checkpoints must equal the checked archive position.

The fixture acknowledges a text upload and a PNG screenshot before export. It uses
the merged encrypted object capture and disposable restore helpers. It rebuilds
members, conversations, files and OpenFGA twice, retaining uploaded/delivered states
and original addresses. Existing event and integer-cent budget comparisons remain.
An in-process HTTP server permits only GET and uses the existing file list/view
handlers. The reader gets the original bytes; another member or silo gets none.
Later turn activity preserves reads, while a recorded member removal refuses them
even with unchanged read tables and OpenFGA. These later fixture events are outside
the archive comparison. No admission or product access rules change.

Guards count upload, scan, delivery, scheduler, computer-credential, model-start and
tool-dispatch entry calls. Each is exercised before resetting its count. Replay
requires zero calls. Uncertain event or object restoration starts neither replay
nor the read server. The [receipt](../../docs/process/p5-9-pr3/receipt.md) stays PARTIAL:
volumes, CNPG/WAL, coordinated backup, pinned package rollback and live recovery
remain NOT RUN. The HTTP fixture does not qualify admission reopening.

### Checked recovery before fixture replay

P5-9 PR 4a replaces both manual restore calls with the combined helper after the
same HandlerRuntime interruption. The fixture supplies two distinct event sources:
the unchanged archived history and a current copy with a later memory deletion.
Both current key folders carry the deletion markers. A surviving fact still has
usable material. The helper completes custody checks before either rebuild starts.
Two rebuilds compare event order, full rows, rights, file bytes and exact cents.
The recorded memory deletion never enters the archived event comparison.

The home exporter checks synthetic Kubernetes replies and the actual event history.
The next fixture increment below captures two homes. Removing a retained home
from both the saved inventory and its files refuses before either target changes.
This validates the saved inventory; it does not restore a mounted home.
Missing custody, recreated material in both key folders, a changing inventory,
corrupt bytes and mixed attempts refuse. Lost event/object completion preserves
saved bytes, starts no replay or read server and never retries restoration.
Existing ahead-checkpoint comparison tests and later reader revocation/activity
checks remain in place. All effect probes are exercised before their counts reset.

The [receipt](../../docs/process/p5-9-pr4a/receipt.md) records the fixture checks.
Recovery remains PARTIAL. CNPG/WAL, mounted restore, credential renewal, reopening
and a pinned-package upgrade remain NOT RUN. There is no new CLI or runtime API.

### Coordinated capture before fixture interruption

P5-9 PR 4b starts from #772, merged as
`6077ef801cd23bb8b21a1424ded2cd348e1ce813`. The fixture replaces its separate
collectors with `collectBackupCapture`. It seeds two distinct non-empty homes
through `recovery-homes.ts`, reuses that helper's synthetic readers, and gives
capture two separate empty NATS readers. Checked recovery receives the exact
`events`, `objects` and `homes` directories from that capture. Its registered
restore target is separate from both capture readers.

Both home archives must authenticate before recovery writes to its targets.
Changing either home's authentication tag refuses. Removing a home from the
saved inventory and files, or mixing attempts, also prevents comparisons.
Changing the first saved home while the second is copied refuses the capture.
Writer resumption, cancellation and expiry of the original capture deadline
stop before restore or comparisons. The time test spends 40 seconds in the
object stage, then passes the original 60-second limit in the home stage.
Readers close and their cancellation signals are aborted after capture stops.

The existing 256-event interruption, parked jobs, current deletion history,
revoked-reader refusals and two matching rebuilds remain covered. Lost restore
completion leaves targets isolated without erase or resend. Exercised effect
entry points observe zero replay calls. No production restore or export changes.

The [receipt](../../docs/process/p5-9-pr4b/receipt.md) records this fixture's checks.
Recovery remains PARTIAL: validating homes does not restore mounted volumes.
CNPG/WAL, the full manifest, live quiescence, credential renewal, reopening and
pinned-package upgrade remain NOT RUN.

## Memory restore preflight

`memory-restore-check-run.ts` validates custody, the server's private revision-key
folder, before calling `apps/ops/src/replay.ts` for memory. Stop all readers, writers,
cleanup jobs and effect workers on both installations. Keep both key folders fixed
through validation and replay. The flag confirms this operator responsibility;
stable event positions alone cannot prove it. The operator must identify the
trusted current source. An archive's inventory is never current deletion evidence.

```sh
node --experimental-strip-types infra/package/memory-restore-check-run.ts SILO --confirm-stopped
```

| Setting | Meaning |
| --- | --- |
| `SOURCE_NATS_*` | Existing NATS connection settings for the trusted current source |
| `NATS_*` | Existing projection-reader connection settings for the isolated restored target |
| `SOURCE_MEMORY_KEY_DIRECTORY` | Current source custody, including permanent empty deletion markers |
| `MEMORY_KEY_DIRECTORY` | Candidate custody already prepared outside this command |
| `DATABASE_URL` | Target projection database, opened only after validation succeeds |

The command requires distinct standalone NATS servers and complete event logs from
position 1. The target must be an exact prefix of the source, including event bodies.
Each log is limited to 100,000 events and 64 MiB; each folder to 100,000 entries.
Validation has a 60-second deadline and command setup stops after 65 seconds.
Folders must be owned by the process user, mode 0700, without symlinks. Files must
be owned regular files, mode 0600, with 32 bytes or an empty permanent marker.
Unknown names and pending files refuse. Source and candidate inventories must match
exactly, including markers for identities absent from the archive. No keys are copied.

`memoryErasureHistory` supplies historical dependants and superseded revisions.
Their source and candidate keys must be destroyed, including the next candidate
revision of a forgotten fact. `memoryKeys` checks identities and authenticates
surviving ciphertext. Every live, unreplaced revision must have an available key
in both folders. Matching empty files cannot prove valid custody for a live fact.
All deletion markers, key identities and final folder/history stability checks
finish before any surviving value is decrypted. Authentication must return a value;
a null result refuses. Destroyed material is never decrypted or reconstructed.
Missing, unverified, changing or damaged evidence produces only a fixed refusal.

The isolated test uses the unchanged P5-8 byte restore helper. A separate frozen
source proves old archive bytes; the current source supplies deletion evidence.
Old events with current markers rebuild as unavailable, with no searchable text.
They do not acquire later forget receipts. Replaying twice preserves rows,
checkpoints and markers; the normal rebuild generation increases.

Run `PG_TEST_URL=… nice -n 10 npx vitest run libs/projections/test/memory-restore.test.ts`.
It uses synthetic temporary keys, three disposable NATS servers and a disposable
PostgreSQL database. Guarded child processes count effects and refuse any database
connection on failed preflight. Late-refusal tests also forbid decryption, with a
live fact before a missing deletion marker or a mismatched key identity. They cover
next-revision markers and changes during folder/history validation. Matching empty,
missing and wrong surviving keys are tested in both folders.
Full P5-8, P4-13–17, company/rights recovery, browser
qualification and computer no-disk proof remain NOT RUN. This command cannot approve
reopening an installation. See the [receipt](../../docs/process/p5-12-pr1/receipt.md).

## Recorded connection during package operations

P5-4 PR 4 is split. This first part connects private preparation and browser
forwarding to the recorded package target. `packageConnectionArgs` checks the
current package owner and namespace UID against the owner captured at the start.
It then checks target ownership again before returning the context argument and
`KUBECONFIG` in the child environment. Each of the six Secret creations uses this
check. Preparation and forwarding pass that environment to Kubernetes commands.
Secret creation runs with the private temporary folder as its working directory and uses `--from-file=.`. The folder stays mode
0700 and its files stay mode 0600 until removal after creation. Route preparation
retains its existing target check before each Secret operation.

Helm compares the requested context with the currently checked target before
install, list and uninstall. Kubernetes calls carry the context checked at the start and compare it
with the current target before sending each request. Losing both ownership records
during cleanup also refuses before the next request. Losing a target record while its
package record remains refuses; it cannot switch to `k3d-ocn`. An ordinary R1
package recorded on `k3d-ocn` continues to use that cluster.

`forward.sh` runs `forward.ts`, which rechecks the package and target before
starting a loopback-only forward. The launcher forwards SIGINT and SIGTERM to
its child and waits for it to exit. Command output is withheld and failures use
fixed text, including when Kubernetes includes private values in an error.

R3 installation now checks prepared identities, eligible isolated nodes and an
explicit compatibility review for the server and web image pins. The shipped review
still refuses. The source uses one replica choice across preparation, bootstrap,
runtime and dispatcher. Image promotion and live qualification remain separate work.

The [receipt](../../docs/process/p5-4-pr4/receipt.md) records source checks.
Live placement, rotation and node failure remain NOT RUN.

## Fresh NATS placement observations

P5-4 live1 first part adds `nats-placement.ts` and a bounded Kubernetes collector.
The checker requires raw Node, Pod, PVC, namespace and release metadata, private
endpoints, EVENTS stream information and the existing `checkFresh` input.
Expected ownership comes from the checked claim and target, not the observations.
It checks three distinct node UIDs and hostnames, peer names, bound claims and
volumes, reviewed NATS image references, R3 file storage and two current replicas.
It requires the container's writable `data` claim at `/data`, the explicit
`NATS_STORE_DIR=/data` setting and the reviewed startup command. It compares the
projected `cluster.conf` and selected Secret `nats.conf` with the repository's
reviewed files. Other commands, CLI overrides, changed files and mounts that hide
the store refuse. It checks only these two configuration keys, never a whole Secret.
The EVENTS limits must be `max_msgs=-1`, `max_bytes=-1`, `max_age=0` and
`max_msgs_per_subject=-1`. The summary keeps those four values and each peer's
store directory.
It also applies the inherited empty-data check. It does not prove route handshakes,
conditional writes, replay, sign-in, chat or outside-tailnet refusal.

After a supported fresh R3 install, the collector accepts the original fresh-state
and JetStream stream-info JSON files, then a new output filename. These supplied
files must come from that install; this command does not collect or authenticate
their origin. It checks the recorded target and package before and after reading
Kubernetes. It refuses the shared cluster and owner slot, bounds commands and the
whole run to 60 seconds, and writes only selected checked identifiers with mode 0600.
Every local input read has a 1 MiB byte ceiling before parsing, including target,
package and stack ownership records, image review and the reviewed configuration.
Reads detect growth after the initial size check and refuse non-regular files.
Kubernetes child processes receive the private connection filename through
`KUBECONFIG`, including calls made by the ownership helpers.
It never saves raw Pod settings, Secret data or supplied JSON. Existing output refuses.

```sh
DEV_STACK_ID=1 nice -n 10 node --experimental-strip-types \
  infra/package/nats-placement-collect.ts fresh.json stream.json placement.json
nice -n 10 node --experimental-strip-types --test infra/package/nats-placement.test.ts \
  infra/package/nats-placement-collect.test.ts infra/package/fresh-twice.test.ts
```

The installer still refuses R3. Bootstrap source supports R1 and R3, but the shipped
image has not been qualified with this source. These source checks
do not qualify a live install. See the [receipt](../../docs/process/p5-4-live1/receipt.md) for blockers and remaining work.

## Local operator guide

The [local operator guide and index](../../docs/process/p5-14-pr1/operator.md)
link existing commands and distinguish source checks from live qualification.

## Bound package journeys

`journey-entry.ts PRIVATE_VALUES_FILE` requires a claimed, checked dedicated k3d
cluster. It uses that cluster for two fresh namespaces and fresh storage sets.
It calls `fresh-twice.ts` twice with the fixed `capture.mjs` collector,
while each package and loopback forward still run. At 1280/390 the collector
checks owner sign-in, stub chat and an unauthenticated history request with only
public refusal bytes. It checks ownership before opening the browser.
Results bind the runner revision and Deployment-checked server image to context,
namespace/release UIDs, install time and id, PVCs, PVs and OpenFGA store.
Fresh identities must
not repeat. Screenshots and `package-journey.json` stay in the private claimed slot.
The runner sends the private values filename to preparation and installation through
`PACKAGE_VALUES_FILE` in each child environment. Preparation accepts either that
setting with no positional arguments or one positional filename without the setting.
Missing filenames and extra arguments refuse before preflight. Preparation and the
installer run preflight from the values file's folder, passing only its basename.
Helm template and install use the same folder and basename. Preparation and browser
forwarding send the private kubeconfig filename to kubectl through `KUBECONFIG`.

`chart.test.mjs` runs preparation's real main function and preflight using the journey
environment setting. `cnpg-install.test.mjs` runs the real installer, preflight and
Helm template with synthetic cluster replies. Both inspect every child argument and
refuse the private directory. The journey ordering fixture still replaces preparation
and installation; these separate tests check their descendants.
The receipt says PARTIAL. Collector or cleanup failure prevents the next install.
The [receipt](../../docs/process/p5-11-pr1/receipt.md) gives the later claim-based
command, source checks and live blockers. Fixtures and Stage B captures cannot
replace live packaged checks. Full inherited product acceptance remains NOT RUN.

## Company acceptance checklist

The [company checklist](../../docs/process/p5-13-pr1/checklist.md) maps every
P4-28 acceptance/refusal set to `company-qualification.ts`. It reads existing
private records; it starts no services and writes no qualification receipt.

```sh
nice -n 10 node --experimental-strip-types infra/package/company-qualification.ts "$PRIVATE_MANIFEST" "$SOURCE_SHA" "$SERVER_IMAGE"
nice -n 10 node --experimental-strip-types --test infra/package/company-qualification.test.ts
```

Each assertion links every required subcondition to a `company-results` JSON file.
The fixed list in `company-conditions.ts` includes each screen state, feature receipt,
child crash boundary and native memory location during execution, kill/resume and replay.
Each result records its own outcome and links non-empty supporting files. Its file
must match the source, image, install and width. The [input contract](../../docs/process/p5-13-pr1/checklist.md#input-and-result)
names the fields and limits. Missing or refused proof names the untested subcondition.

Binding and freshness checks apply separately to each install. Rejected freshness
leaves that install's dependent conditions NOT RUN. Valid results from the other
install remain visible. Binding errors name the field without its supplied value;
reused identities have a separate shared blocker.

Exit zero means submitted records cover the checklist, including synthetic test
records. The output still says PARTIAL; it does not establish live qualification.
Exit one lists missing/refused evidence. The [source receipt](../../docs/process/p5-13-pr1/receipt.md)
records checks and outstanding native-memory, company-credential and routine proof.

## Mounted NATS inputs before installation

`check-nats-inputs.ts` checks the actual NATS and runtime-files Secrets collected
by the installer, for both R1 and R3, before Helm rendering or installation.
The server certificate must have subject `CN=nats`, exactly the DNS names `nats`
and `localhost` and IP address `127.0.0.1`, and only the server TLS usage.
Command, projection and dispatcher certificates must have their exact role as
common name, no extra alternative names and only the client TLS usage.
All four certificates must be current, must match their private key and must be
issued by the mounted client CA. The CA must be current and self-signed; runtime
and server trust bytes must agree. OpenSSL also checks each certificate's purpose.
R3 retains the comparison with the locally prepared client CA and separate route trust.

The mounted `nats.conf` must match `infra/nats/nats.conf` byte for byte. This is a
fixed package policy, including comments and whitespace; custom configuration is
refused. It protects the store directory variable, verified client TLS, accounts,
imports, exports and permissions, including against extra includes or duplicate
settings. The server must listen on `0.0.0.0:4222`, store data in `/data` and use
`/tls/ca.crt`, `/tls/server.crt` and `/tls/server.key`.
Runtime and dispatcher command connections must use `tls://nats:4222`, the command
certificate, key and seed under `/run/opencrane/files`, and `_INBOX.command`.
Optional bootstrap overrides must agree. All five public NKeys must be valid,
distinct user keys. Each mounted role seed must match its public key.

Only fixed public certificate filenames enter OpenSSL arguments. Temporary files
are private and removed afterwards. Credential values, errors and private host
paths are withheld from output. The installer tests use generated certificates,
real NKeys and the shipped configuration. Separate cases change each mounted
identity's key, dates, names, usages, CA status and issuer, then check refusal
before any Helm command. Expired and future fixtures use explicit ordered dates.

## Raw computer home restoration fixture

P5-9 PR 5a adds `computer-volume-restore.ts` and `upgrade-recovery-home.test.ts`.
`provisionComputerHomeTarget` creates and registers a new private temporary directory
for one complete home identity, silo and attempt. The caller owns its eventual cleanup.
Only that returned object can be used; copied objects and replaced or occupied
directories refuse. A newly created directory cannot be an existing source home.
The target identity includes its device, inode, timestamps, permissions and owner.

`restoreComputerVolumeBackup` takes the archived NATS source, home-check options,
registered targets in inventory order and the caller's original `captureBounds`.
Options also require stopped writers, disabled effects and the trusted current memory
source with both key directories. The helper consumes all targets before validation.
It has no CLI, mounts, extraction, replay or reopening operation.

The existing version-2 checker authenticates every home before invoking an optional
internal delivery callback. Without that callback it still discards each plaintext
chunk. With it, the checker owns at most 64 MiB of retained plaintext plus one chunk
and erases the buffers after delivery succeeds or refuses. Authentication failures,
cancellation and deadline expiry also erase them. The callback cannot outlive cleanup.

Delivery checks current key deletion records against the archived event history,
then rechecks the source history, private input identities, descriptor and original
deadline. Every target must still be empty and match its registered binding before
any file is opened for writing. The writer creates `home-image` exclusively with mode
0600, writes bounded chunks, flushes them and compares bytes read from the same file.
All readback buffers are erased too. Failures preserve saved files and consume the
whole attempt: there is no retry, erase, reopening or later home writer.

Only confirmed delivery returns `{ kind: 'home-image-bytes-only', homes, byteCount }`.
The result and fixed errors contain no private paths or contents. The helper starts
no process and creates no event or API field. It uses Node's existing standard library.
The existing combined event/object restore result remains unchanged.

The [receipt](../../docs/process/p5-9-pr5a/receipt.md) records this PARTIAL result.
Mounted filesystem restoration, CNPG/WAL, package upgrade, reopening and fresh-install
qualification remain NOT RUN. Existing image pins, preflight gates and chart settings
are unchanged. Synthetic home readers do not establish live volume ownership.
