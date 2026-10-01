# ADR 0006: computer disk recovery and live-view permissions

**Date:** 1 October 2026. **Status:** Proposed, from local S0.3/S0.5 evidence.
Issue #14, parent #7. This qualifies fresh spike resources on the existing k3d
box, not a fresh silo or the complete Phase 2/3 product journeys.

## Problem

Computers must keep files, browser logins and Codex threads across suspension,
without keeping Pods or credentials alive. Human participants need live view;
only the requester may take control, after the agent has paused.
[S0.1b](0003-harness-codex.md#s01b-computer-proof--1-october-2026) also requires
that helpers cannot use Codex's UID, tokens or authenticated model proxy.

## Decision

Use **disk suspension with a new Pod and the existing PVC**. Treat generic warm
claims and existing-volume resume as different paths in Agent Sandbox 1.0.4.
The literal plan requirement to attach an existing computer PVC to an already
running neutral warm Pod is **not supported**. Kubernetes refuses the volume
mutation. The real controller bypasses its ready pool when a claim supplies
`volumeClaimTemplates`; the spike asserts that the neutral Pod stays unclaimed.
The [1.0.4 claim contract](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.4/extensions/api/v1beta1/sandboxclaim_types.go)
explicitly documents this cold-start behaviour.

A warm Pod can be bound by claim metadata without replacement. Once bound it
must be destroyed, never returned to the pool. Adopt Agent Sandbox 1.0.4's
[native v1beta1 lifecycle](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.4/api/v1beta1/sandbox_types.go):
patch `operatingMode: Suspended`, wait for Pod absence, then patch `Running` to
resume. Ten measured cycles retain the same Sandbox and standalone PVC, create
new Pods, and recover files, browser login and the Codex thread. This replaces
the spike's delete/recreate lifecycle because the controller already owns Pod
suspension and retention. It still cold-starts a Pod; S0.3 remains **PARTIAL**
against the literal warm-Pod criterion. Use Ready to observe resume, since a
stale Suspended condition can remain. Production reactions must own PVC retention
and deletion policy.

Persist the workspace, Chromium profile and private Codex session directory in
separate UID-owned directories under `/home/agent`. Keep the proxy caller
capability, computer/turn grants and Kasm credentials in ephemeral storage.
Rotate both computer and turn grants before resume; revoke the previous grants
at the gateway. Resume the same Codex thread explicitly, then start its next turn.

Use **KasmVNC's server-side read/write permissions**, behind an authenticated
OpenCrane proxy with a bounded RFB display-message allowlist for viewers.
Kasm allocates binary clipboard payloads before its read-only permission check,
so the proxy rejects all clipboard/input/unknown messages before forwarding any
of their bytes. A 512 MiB container limit adds defence in depth. Participants always map to the read-only Kasm account. The
requester maps to a writer only during takeover. Pause the active Codex turn and
wait for interruption before granting control. On release close writer tunnels
before starting the next turn on the same thread. This is interruption and
continuation, not a frozen process or a transparent replay of an external effect.

Keep Codex UID 1000 and its unchanged S0.1b executor UID 1001/seccomp boundary.
KasmVNC and the browser use desktop UID 1002, with `no_new_privs`; they cannot
read the private Codex home. They can reach loopback and the gateway, not direct
external services. The model proxy additionally requires Codex's private caller
capability, and the model gateway requires both grants. The desktop's test-site
route requires a separate 60-second capability issued by the backend and stripped
by agentgateway. It is a fixed destination, not general web egress.
Kasm inbound traffic is allowed only from the gateway backend Pod; its UDP/STUN
path is disabled. No same-UID browser, MCP or package helper is added to Codex.

## Alternatives and costs

- **Warm Pod plus a dynamically attached PVC:** rejected by the live API and
  controller. CSI snapshots do not make a running Pod's volume list mutable.
- **One warm pool per existing disk:** would mount sensitive computer data before
  claim and retain a Pod while suspended; it defeats neutral pooling and scale-down.
- **Plain PVC reattach:** chosen for local recovery. It needs no CSI snapshot;
  the k3d local-path volume stays on the same node and is not portable or encrypted.
- **CSI snapshot/clone:** needed for snapshot-based copies, rollback or creating a
  new PVC from a saved disk image. Cross-node movement additionally requires a
  storage backend that supports it. Crash/application consistency needs quiescing.
- **gVisor checkpoints:** deferred. Open tabs, unsaved forms and running processes
  are deliberately not preserved by disk resume.
- **Client-only view-only mode:** rejected. The test sends real raw key/pointer
  packets from a viewer and proves the proxy refuses them, with a writer control.
- **Delete/recreate Sandbox on suspend:** replaced by native Suspended/Running;
  the same disk-only lifecycle keeps the Sandbox identity without custom deletion.

## Evidence and limits

[S0.3 results](../../spikes/s0-3-warm-pool/README.md) own the measured claim/resume
latencies and persistence/token receipts. [S0.5 results](../../spikes/s0-5-live-view/README.md)
own the gateway, framebuffer, input and takeover receipts. Their runners use real
Agent Sandbox, gVisor, Chromium, Codex, agentgateway and KasmVNC; only model replies
and identity issuance are scripted. No paid provider is used.

KasmVNC is GPL-2.0-or-later, an OSI licence. Its non-free recommended video driver
and bundled UI artwork are excluded; see the [licence inventory](../../spikes/s0-5-live-view/LICENCES.md).
The proxy and test client use the repository's existing MIT `ws` dependency,
outside the computer image.

Production event-backed lifecycle/takeover state, IAM, TLS termination, encrypted
CSI storage, snapshots, multi-node/cloud recovery, simultaneous active Codex threads,
quiescing running tools, disconnect recovery and a product browser viewer remain
unqualified. The spike's volatile issuer/proxy state is not business authority.
This ADR supplements ADR 0003's session-volume and helper findings; it does not
remove that ADR's other open qualifications or silently change `plan.md`'s contract.
