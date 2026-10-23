# Events

## What this is

The list of every kind of event OpenCrane records, and the exact data each one carries.
An [event](../../GLOSSARY.md#event) is a saved record of one thing that happened, such as a member joining or a message being sent. This package says which event types exist and what information each one carries. It checks event data, including new memory text, and still accepts older encrypted events for replay. It does not save events or decide whether a person may act. It also defines private turn records that contain memory reference ids, counts and fixed reasons, without saved fact text. Native spending holds can keep their original access expiry after a restart. The package can preview routine dates without starting work.

Control refusals record the attempt, the person who made it, its conversation, a
fingerprint of the checked request and a fixed reason. They contain no computer or private turn details.

Approval cancellation can record takeover as its fixed cause. It ends unused
consent for a matching saved control request and carries no private review details.

## Where it fits

This is one of the packages that build everything from the
[event log](../../GLOSSARY.md#event-log-event-store), the permanent record of changes.
[libs/event-store](../event-store/README.md) uses it to check events before saving
or returning them. [libs/projections](../projections/README.md) builds read tables,
and [libs/handlers](../handlers/README.md) queues background work using its definitions.
The server and the AI access library use the same definitions, including the saved
Allow, Ask or Block choice for a tool.

```mermaid
flowchart LR
  parent["libs/<br/>shared libraries"] --> events["libs/events<br/>event definitions"]
  server["apps/server<br/>back end"] -.->|checks routine pauses, conversation control refusals, child answers, requests, activations, retries and failures| events
  store["libs/event-store<br/>saved event log"] -.->|checks instances, starts, stops and report receipts| events
  projections["libs/projections<br/>read tables"] -.-> events
  workers["libs/handlers and apps/ops<br/>background workers"] -.->|checks worker records, private tool stops, publication and connection cleanup, nightly memory reviews, results and routine permissions| events
  models["libs/models, libs/auth and libs/authz<br/>AI rules and permissions"] -.->|checks takeover cancellation and saved event shapes, including native access expiry, retry records, personal and saved tool choices, and blocks| events
