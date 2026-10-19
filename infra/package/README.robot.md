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
`jente@elewa.ke` owner member in this install. It does not edit the existing
Zitadel user with that email.

The `runtime` secret supplies text settings to the server and workers. The
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
and installs the checked computer template and a zero-size warm pool. A computer
starts for each chat turn. The installer reads the server Service ClusterIP and
puts that IP in the computer ConfigMap. The computer policy permits only TCP
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
