# Infrastructure components

The cluster uses managed GKE 1.36.4-gke.1247000 and its COS_CONTAINERD node
images. GKE supplies the managed Agent Sandbox controller and gVisor runtime;
those component versions follow the pinned GKE release and later automatic
Regular-channel upgrades. They cannot be independently pinned in managed mode.

| Component | Version | Licence |
|---|---|---|
| Kubernetes | 1.36.4 (GKE build 1247000) | Apache-2.0 |
| Agent Sandbox (upstream fallback, not installed) | v1.0.4 | Apache-2.0 |
| Agent Sandbox (managed) | bundled with GKE release | Apache-2.0 upstream |
| gVisor | bundled with the GKE node image | Apache-2.0 |
| containerd | bundled with the GKE node image | Apache-2.0 |

Sources: [Kubernetes](https://github.com/kubernetes/kubernetes/blob/master/LICENSE),
[Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.4/LICENSE),
[gVisor](https://github.com/google/gvisor/blob/master/LICENSE),
[containerd](https://github.com/containerd/containerd/blob/main/LICENSE).

No local CLI software was installed by this continuation. It uses the existing
gcloud, kubectl, Python, Node/npm, jq, curl and bash. The customer computer image
has its own [licence inventory](../../spikes/computer-image/LICENCES.md).
