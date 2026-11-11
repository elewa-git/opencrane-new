# Hosted discovery transport receipt

11 November 2026. The test commits first showed that the transport was missing and
that it accepted a reply without a request or responder binding. The implementation
checks the observed workload and Pod before each gateway request. It also requires a
fresh request ID returned by the responder and the identity of the Pod that answered.
It uses the existing bounded inventory parser and adds no dependency, event or public
API field.

PASS — local tests confirm that a matching observation yields a captured catalogue
only after gateway discovery. A changed silo, server, owner UID, namespace, Pod name,
Pod UID, run generation, pinned image, platform, workload specification or ready state
refuses before the gateway receives a request. Each comparison is checked after a
valid first observation. A cached reply from another request, silo or Pod is refused.
A changed Pod during discovery leaves the catalogue unsaved. The saved start leaves
publication and tool calls closed.

PARTIAL — the test supplies an in-process workload reader and gateway request. No
production worker supplies those callbacks yet, and the gateway has no hosted
discovery route or checked responder identity. These checks do not establish production
admission. Hosted dispatch and a fresh-install journey are NOT RUN.
