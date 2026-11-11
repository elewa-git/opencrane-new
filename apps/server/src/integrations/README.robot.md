# Integration implementation notes

Read [README.md](README.md) for the package's role.

## Hosted discovery boundary

`captureHostedThroughGateway` joins a trusted workload reader and a gateway
discovery request to `captureHostedStart`. The workload reader must use Kubernetes
ownership, not labels alone, to report the controller UID and Pod UID. The adapter
requires the same silo, server, owner UID, Pod UID, run generation, pinned image,
platform and workload specification digest before each gateway request. The capture
command checks the workload again after the last page and checks current image
admission before saving. The gateway callback receives only `server/discover` or
`tools/list`, an optional cursor and the exact run binding. It must use the checked
gateway route and honour the abort signal. The adapter caps each reply at 4 MiB;
`inventory.ts` applies the smaller definition and snapshot limits.

No production caller supplies these two trusted callbacks yet. The gateway does not
yet publish a discovery route for a hosted start. The adapter therefore does not
qualify live hosted admission or allow hosted tool calls. The local test injects both
callbacks and checks the saved catalogue; replay never invokes them.
