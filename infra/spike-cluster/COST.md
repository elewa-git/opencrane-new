# Spike cost ledger

Owner approval: “GKE yes, €25”, 2026-10-01. Project `weownai-proto` only.
All amounts in the scripts are integer euro cents. Stop when the next-day
projection reaches 2,000 cents; total authorisation is 2,500 cents across spikes.

Conservative rates: cluster 9 cents/hour, each N2 Spot node including boot disk
and IPv4 4 cents/hour, storage 1 cent/hour. No free credits assumed. Each build
reserves 60 cents before submission (including failures; 30-minute timeout).
The guard reserves 24 hours at all six nodes plus 110 cents for build/buffer.
These are estimates, not invoice totals. Pausing leaves the cluster fee running.
Other spike sessions must use this shared ledger and add their extra spend.

Sources: [GKE](https://cloud.google.com/kubernetes-engine/pricing),
[Spot VMs](https://cloud.google.com/spot-vms/pricing),
[Cloud Build](https://cloud.google.com/build/pricing),
[Artifact Registry](https://cloud.google.com/artifact-registry/pricing),
[Storage](https://cloud.google.com/storage/pricing).

| Session (UTC) | Estimate / reservation | Note |
|---|---|---|
| 2026-10-01 continuation start | 10 cents for earlier failed build; no spike cluster existed | Previous build 428461f6-eb0d-44b1-8f24-3d63dda74ead ran 07:41–07:45; continuing its labelled bucket and node identity. |
