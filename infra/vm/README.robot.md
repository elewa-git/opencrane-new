# VM bootstrap contracts

## Scope and prerequisites

Run `bootstrap.sh` as root on a fresh x86-64 Ubuntu 22.04 or 24.04 LTS machine
with systemd and outbound HTTPS. It accepts only an optional `--dry-run`.
Other versions and architectures refuse. The script does not provision a VM,
configure an address, install Tailscale, open a public listener or enable Funnel.
Pilot access is tailnet-only; address and sign-in setup remain separate work.
Do not run it on the developer box, including as a bootstrap experiment.

The first real bootstrap, reboot, host preflight and package install on a VM
remain NOT RUN. Container fixtures cannot establish kernel, systemd, runtime,
network or disk correctness on an actual Ubuntu VM.

## Shared releases and licences

`../devbox/runtime.sh` owns the existing k3s, gVisor and Agent Sandbox release
versions, gVisor and controller-manifest checksums, controller image digest,
verified download helper and Kubernetes runtime/controller installation helpers.
The developer-box setup imports the same file. Do not run that setup on a VM.
All three upstream projects use Apache-2.0, as recorded in the
[existing developer-box review](../devbox/README.robot.md#pinned-versions).
No npm dependency or customer application image is added.
Ubuntu's standard packages supply curl, HTTPS trust, bzip2 and kexec-tools.

The additional k3s executable SHA-256 is
`39eed8f53f277497dfc2542f66eab0ed68a94dfc598946dbebfb50366916c7a2`, from the
[official pinned release checksum file](https://github.com/k3s-io/k3s/releases/download/v1.37.0%2Bk3s1/sha256sum-amd64.txt).
Downloads are verified before extraction or installation. A failed download or
checksum stops preparation. The shared helper retains its existing three bounded
transport retries; service readiness deadlines are unchanged.

## Existing-machine refusals and reruns

Checks run before downloads, package installation or file writes, even in dry run.
Docker binaries, data/configuration or its socket refuse. Kubernetes configuration,
microk8s, RKE2, kubelet data and standalone containerd configuration/data/socket or
binaries refuse. Existing k3s files require the script's protected ownership record
and the expected executable checksum. The root-owned record is not an adoption
option for an existing cluster. Never create it by hand.

The record is written before starting k3s, so an interrupted service start can
resume. An interruption before that record is written can leave unowned runtime
files and requires operator inspection; the script will not adopt them. Reruns
reapply identical configuration, reuse verified downloads and restart k3s. They
preserve Kubernetes data, but are not a zero-interruption upgrade mechanism.
The script does not delete workloads or offer uninstall.

## Node configuration

Disable all active swap, comment swap entries in fstab and mask swap.target.
Disable apport and kdump configuration, mask apport, whoopsie, kdump-tools and the
systemd core-dump socket. Disable systemd core storage and processing. Persist
empty `kernel.core_pattern`, zero `kernel.core_uses_pid` and `fs.suid_dumpable`,
and zero login/systemd core limits. Unload an armed crash kernel using kexec.
Reboot before package installation and rerun the package host checks. This covers
the F1/F2 settings requested by #366; it does not certify every existing process
or private-memory qualification condition.

k3s uses its embedded containerd. Disable Traefik and ServiceLB. Keep the kubeconfig
root-only. Set the containerd v3 runsc handler before service startup and create
RuntimeClass `gvisor` with handler `runsc`. Install the pinned Agent Sandbox CRDs
and controller. Wait for the local-path provisioner and check its `local-path`
storage class. Local-path storage is single-node persistent storage; it does not
add CSI volume snapshots or multi-node recovery support.

The runtime template follows the
[k3s containerd configuration contract](https://docs.k3s.io/advanced#configuring-containerd).
Keep the complete gVisor archive together, including its sidecar binaries, as
required by the [gVisor installation guide](https://gvisor.dev/docs/user_guide/install/).
The script installs no application package: its installer still owns image approval,
preflight, runtime secrets and Helm admission.

## Local tests and their limits

`bootstrap.test.mjs` runs ShellCheck and uses the existing Node Debian test image.
Each fixture has an isolated writable container filesystem, no network, no added
capabilities, no host network and only a read-only source mount. It changes the
container's distribution record to exercise the supported Ubuntu branch. It does
not claim an Ubuntu execution test. Apt, downloads, archive extraction, swap,
sysctl and systemd operations are stubbed for the configuration/rerun test.
Real hashes compare the configuration before and after that rerun. A separate
replacement-binary test restores real checksum verification and expects refusal.
No fixture starts k3s, containerd or dockerd. CI includes the same Node test file.

## Sizing procedure

Use a fresh claimed secondary package namespace, CI-approved application/scanner
images and the standard package-prepare/up/check/down steps. Do not replace image
approval with a local build. Before claiming, both secondary ids must report free,
no package namespace may exist and one-minute load must stay below 6 for five
minutes, sampled every 30 seconds. Wait at most two hours.

After install, record exact source and image digests, pod names and limits. Sample
idle for one person and then run sign-in, chat, upload, desktop viewing and budget
checks at 1280 and 390 pixels. Repeat with three separate people working concurrently,
with one assistant computer each. Record the number of simultaneous active computers.
Use the existing browser helpers rather than changing product admission.

Use `kubectl top pods --containers` for CPU and memory and the kubelet summary for
pod ephemeral storage and PVC bytes. If metrics are unavailable, node container
stats are an allowed aggregate fallback, but do not label them per-pod measurements.
Record sample timestamps, sample interval, idle window, whole-journey maxima and
node totals, including system pods and runtime overhead. Block I/O bytes are
traffic counters, not occupied disk space. Capture filesystem/PVC use and cached
image bytes separately. Do not count unrelated owner workloads as pilot use.

Derive a VM recommendation only after both journeys pass. State CPU/RAM spare
capacity and disk reserve for the OS, images, retained events/files and backups;
include sample duration and workload limits. A shared k3d result estimates VM demand,
not a proven smallest VM. Copy measurements, service/startup logs and masked
screenshots to the receipt before package-down and down remove slot data.
