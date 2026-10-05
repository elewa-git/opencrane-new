# OpenCrane developer box

For people, read [README.md](README.md) first.

`setup.sh` prepares the Ubuntu developer box for the local `ocn` test silo. It
creates an 8 GB swap file with swappiness 10, installs gVisor and the Kubernetes
tools, builds a k3s node image containing `runsc`, and creates a one-node k3d
cluster with the `gvisor` RuntimeClass. It also installs Agent Sandbox, a local
registry on `127.0.0.1:5001`, and a persistent MinIO deployment.

MinIO credentials are generated once in `~/.config/opencrane/minio.env` with
mode `0600`. The script does not print them. MinIO uses the Alpine community
image built from the AGPL-3.0 upstream source because MinIO no longer publishes
the final community release as an official image.

The runtime components have OSI-approved licences: k3d is MIT; Kubernetes,
Helm, k3s, gVisor, Agent Sandbox and the Registry are Apache-2.0; BusyBox is
GPL-2.0; and MinIO is AGPL-3.0.

## Prerequisites

- An x86-64 Ubuntu host
- Docker Engine running and usable by the current user without `sudo`
- Passwordless `sudo`
- `curl`, `sha256sum`, `stat`, `fallocate`, `blkid`, `mkswap`, `swapon`,
  `swapoff`, `grep`, `sed`, `tar` and `openssl`

Run or safely rerun the setup from the repository root:

```sh
./infra/devbox/setup.sh
```

When an `ocn` cluster already exists, the script checks every IPv4 and IPv6
host binding for its Kubernetes API. It continues only when the sole binding is
`127.0.0.1:6550`. If inspection fails or any binding differs, setup stops and
explains how to delete the cluster manually. The script never deletes a cluster;
manual deletion also removes its MinIO data.

The script proves the registry and gVisor paths with temporary Pods, then removes
them. It also waits for the four Agent Sandbox CRDs, its controller, and MinIO.
`tailscale serve` is now configured by [the dev stack](../dev-stack/README.md):
HTTPS on the tailnet proxies to a loopback-only web server. It never enables
Funnel. Tailnet access rules still determine which owner devices can reach it.

## Pinned versions

- k3d 5.9.0, kubectl 1.37.1, Helm 3.19.1 and k3s 1.37.0+k3s1
- gVisor `release-20260928.0`
- Agent Sandbox 1.0.4
- Docker Registry 2.8.3 and BusyBox 1.37.0 for the pull proof
- MinIO `RELEASE.2025-10-15T17-29-55Z`

## Tear down

Remove the disposable cluster and registry with:

```sh
k3d cluster delete ocn
k3d registry delete ocn-registry
```

This also removes the MinIO volume in the cluster. It deliberately keeps the
host tools, swap file, download cache, custom node image and credential file so
a later setup can reuse them. Remove those separately only when they are no
longer needed.
