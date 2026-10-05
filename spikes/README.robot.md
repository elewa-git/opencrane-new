# spikes index

For people, read [README.md](README.md) first.

## Areas

| Folder | What it tested | Still read by current code |
| --- | --- | --- |
| `s0-1-codex` | Running Codex as the assistant agent. | No. |
| `s0-1b-proxy-gvisor` | Isolating a computer and limiting its network access. | Yes. Computer tests read its probe, gateway settings and services. |
| `s0-1c-real-model-smoke` | Sending a capped request through the AI gateway. | Yes. Root tests and the dev stack fetch the gateway binary from here. |
| `s0-2-gateway` | Checking model and tool calls at the gateway. | No. |
| `s0-3-warm-pool` | Reusing computers while keeping their files. | Yes. Computer tests import its lab helpers. |
| `s0-5-live-view` | Building the live screen viewer computer image. | Yes. The warm-pool lab reads the saved image reference. |
| `s0-7-jetstream` | Using NATS JetStream as the event log. | No. |
| `s0-8-handler-runtime` | Choosing a job runner for background work. | No. |

Architecture decisions record the choices. Some files remain in use, so check the table
before removing an experiment folder.
