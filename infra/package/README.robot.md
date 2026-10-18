# Local Helm package: operator notes

This chart was written here because the OpenCrane 1 source folder named in
`plan.md` is not present on this box. Its chart version is `0.1.0`. It has no
external chart dependencies. The chart's services are ClusterIP only. It creates
no Ingress or Gateway. `preflight.mjs` compares every image with
`reviewed-images.json` and requires the exact digest; the chart repeats the
digest and exposure checks at render time. The server and website share one
source image, pinned by the OCI index digest in the local registry. A missing
entry always refuses installation. The runtime licence review remains open.

Claim a secondary slot with `infra/dev-stack/claim.sh`. Set `DEV_STACK_ID` to the
returned id. `infra/dev-stack/run.sh package-prepare --id "$DEV_STACK_ID"` creates
only `opencrane-package-$DEV_STACK_ID` and records its Kubernetes UID, cluster,
release name, worktree and heartbeat in the slot's private directory. An operator
cannot prepare a package while that slot's Compose processes or containers run. The
slot lock keeps these checks and the following operation together. An operator
then creates the four named Kubernetes secrets in that namespace from existing
secret files. Never put values in Helm values, command arguments or receipts.

The `runtime` secret supplies the server's NATS, PostgreSQL, OpenFGA and sign-in
settings. The `postgres` secret holds
PostgreSQL startup settings. The `nats` secret holds `nats.conf` and its referenced
private certificate files. The `openfga` secret holds its database settings. The
installer checks that all four names and required fields exist before Helm
applies resources. NATS, PostgreSQL and OpenFGA URLs must use the private service
names in the chart.

Pass a JSON values file, which Helm accepts as YAML, with the reviewed images,
four secret names and all three exposure flags set to `false`:

```sh
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
is refused. Older records without an install ID cannot authorise release removal. If Kubernetes is unavailable during secondary
`down`, Compose stops while the package record stays in place for a retry.

The current chart does not yet provide all workers, object storage, scanner,
model gateway, computer controller integration or the event-backed owner
bootstrap. A core product journey, verified owner sign-in, outside-tailnet probe
and runtime licence inventory are NOT RUN. The current package must not be
described as a fresh qualified install. The licence inventory is deferred to
part b because the code and chart exceed the row's line target.
