# Hosted discovery transport receipt

11 November 2026. Base: `85ead939e`, the merged local capture and review change.
The first commit adds failing tests for a missing checked transport. The implementation
passes an exact observed workload and Pod to the saved capture command. It uses the
existing bounded inventory parser and adds no dependency, event or public API field.

PASS — local tests confirm that a matching observation yields a captured catalogue
only after gateway discovery. A changed silo, server, owner UID, Pod UID, run
generation, pinned image, platform, workload specification or ready state refuses
before the gateway receives a request. A changed Pod during discovery leaves the
catalogue unsaved. The saved start leaves publication and tool calls closed.

PARTIAL — the test supplies an in-process workload reader and gateway request. No
production worker supplies those callbacks yet, and the gateway has no hosted
discovery route. These checks do not establish production admission. Hosted dispatch
and a fresh-install journey are NOT RUN.
