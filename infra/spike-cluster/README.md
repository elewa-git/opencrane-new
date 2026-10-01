# GKE computer spike

Approved by the owner on 2026-10-01: “GKE yes, €25”. Only `weownai-proto`,
zone `europe-west1-b`. No changes to `opencrane-dev`, gcloud defaults or the
user's kubeconfig. Every cloud mutation is in a script here or in the image
spike. All gcloud calls pass the project through `gc` in `lib.sh`.

## Shape and evidence

GKE Standard **1.36.4-gke.1247000**, Regular channel, zonal. Managed Agent Sandbox
needs 1.36.3-gke.1767000 or later; the chosen version is available in this zone.
Pod Snapshots are enabled in `addonsConfig.podSnapshotConfig`. Workload Identity
and Dataplane V2 are enabled. There is no public application ingress.

| Pool | Machine | Initial / minimum / maximum | Why |
|---|---|---|---|
| `ocn-spike-default` | Spot `e2-medium`, 40 GiB balanced boot disk | 1 / 1 / 3 | Shared-core node for system Pods and the temporary port-forward relay; 4 GiB memory |
| `ocn-spike-sandbox` | Spot `n2-standard-2`, 50 GiB balanced boot disk | 0 / 0 / 3 | gVisor; supports whole-Pod snapshots with process memory |

Both pools disable upgrade surge, keeping the maximum at six nodes. GKE creates
its own `gke-ocn-spike-*` VMs, disks and firewall resources as children of our
cluster. The explicit resources we create have the `ocn-spike` prefix and
`owner=opencrane-new,purpose=spike` labels where supported.

The [EUR catalogue extract](evidence/pricing-eur.json), read on 2026-10-01 by
`research-prices.py`, puts an N2 Spot core at 7,131,642 euro nanos/hour and RAM at
955,176 euro nanos/GiB-hour. N2D and full-size E2 Spot are more expensive here.
N2 is the least expensive **compared full-core option** with 8 GiB memory and
whole-Pod snapshot support. E2 shared-core is cheaper for the default pool;
`e2-small` has only 2 GiB, leaving little memory for system Pods. The absolute
cheapest viable default pool has not been benchmarked across machine families.

E2 supports **rootfs-only** snapshots, but not whole-Pod snapshots. A file-only
spike could therefore use cheaper E2 throughout; that would not qualify the
planned process-memory suspend/resume. Snapshot capture and restore are a later
spike: enabling the feature alone does not prove restore correctness.

Gcloud has no initial pool-name option. `create.sh` uses `create-cluster.py` and
the GKE REST API to name the initial pool correctly; the remaining operations
use gcloud. A failed or interrupted creation is awaited on the next run.
Managed Agent Sandbox owns its CRDs/controllers; their version follows GKE.
The upstream fallback is pinned to v1.0.4, Apache-2.0, but `--oss` refuses to
apply it: its fixed CRD names violate this task's manual resource-name rule.
Managed mode is available, so no fallback installation is needed.

## Run

Prerequisites: authenticated gcloud, GKE auth plugin, kubectl, jq, Python 3,
Node/npm, bash and curl. The previous spike session created the labelled build
bucket and dedicated node identity with read access to the existing image repo.
Scripts verify that access rather than modifying the shared repository's IAM.
No project-level IAM grants or service enablement are made.

```sh
export KUBECONFIG=/Users/jenterosseel/Documents/GitHub/opencrane-new/infra/spike-cluster/.state/kubeconfig
infra/spike-cluster/create.sh cluster
infra/spike-cluster/install-agent-sandbox.sh
infra/spike-cluster/resume.sh --sandbox-nodes 1
spikes/computer-image/build.sh ocn-spike-example
spikes/computer-image/scripts/smoke.sh
infra/spike-cluster/verify.sh
infra/spike-cluster/pause.sh
infra/spike-cluster/verify.sh --paused
infra/spike-cluster/status.sh
infra/spike-cluster/cost.sh
```

Build first when possible. Creation is idempotent; a paused existing cluster is
resumed with `resume.sh`. The kubeconfig is private and ignored under `.state/`.
Smoke always removes its port-forwards and, by default, both temporary Pods.
`--keep` retains the Pods for inspection, but still stops local port-forwards.
Pause refuses if another spike has Pods running. It disables autoscaling and
scales both pools to zero; it destroys the smoke Pod's `emptyDir` scratch disk.

`teardown.sh --yes` deletes only the recorded, labelled cluster. It is **not run**
as part of this task. The pre-existing shared repo, node identity and build
bucket are retained. Deleting those requires a separate scoped task because
other spikes can reuse them. Teardown without `--yes` refuses immediately.

See [COST.md](COST.md): pausing is not free. The conservative allowance is
10 cents/hour when paused, including storage. Check the ledger before each
session and arrange reuse or teardown before the remaining budget expires.
No background watchdog or scheduled deletion has been installed.

## Official sources

- [Managed Agent Sandbox installation and requirements](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox)
- [GKE Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods)
- [Pod Snapshots, scopes and restrictions](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots)
- [Snapshot setup](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox-pod-snapshots)
- [Upstream Agent Sandbox installation](https://agent-sandbox.sigs.k8s.io/docs/getting_started/install_prerequisites/)
- [Pinned upstream v1.0.4](https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v1.0.4)
- [GKE cluster creation API](https://docs.cloud.google.com/kubernetes-engine/docs/reference/rest/v1/projects.locations.clusters/create)
- [Shared-core E2](https://docs.cloud.google.com/compute/docs/general-purpose-machines#e2_shared-core)
- [Spot pricing](https://cloud.google.com/spot-vms/pricing)
- [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)

Final live results are recorded in `evidence/` and in the computer image README.
