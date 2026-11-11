# Integration implementation notes

Read [README.md](README.md) for the package's role.

## Hosted discovery boundary

`captureHostedThroughGateway` joins a trusted workload reader and a gateway
discovery request to `captureHostedStart`. The workload reader must use Kubernetes
ownership, not labels alone, to report the controller UID and Pod UID. The adapter
requires the same silo, server, owner UID, Kubernetes namespace, Pod name, Pod UID,
run generation, pinned image, platform and workload specification digest before each
gateway request. The capture
command checks the workload again after the last page and checks current image
admission before saving. The gateway callback receives only `server/discover` or
`tools/list`, an optional cursor, a fresh request ID and the exact run binding,
including the observed namespace, Pod name and owner UID. It must use that checked
gateway route and honour the abort signal. Its reply must contain the request ID
returned by the responder and the responder's namespace, Pod name, Pod UID and owner
UID obtained from the gateway connection. It must not copy those values from the
request. The adapter refuses a missing or mismatched reply binding and caps each
reply body at 4 MiB;
`inventory.ts` applies the smaller definition and snapshot limits.

No production caller supplies these two trusted callbacks yet. The gateway does not
yet publish a discovery route for a hosted start or return a checked responder
identity. The adapter therefore does not
qualify live hosted admission or allow hosted tool calls. The local test injects both
callbacks and checks the saved catalogue; replay never invokes them.
