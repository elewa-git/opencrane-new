# Protocol

## What this is

Shared message shapes for the OpenCrane browser app and back end. Both sides use the same schemas, written rules for what each message must contain, to check messages before using them. The package also defines the shapes for chat, computers, integrations, budgets, held spend, approvals, model access and receipts for saved changes.

Control refusal history explains when someone was not the requester or their attempt
conflicted with saved control. It contains no private computer or turn details.

Removal, role and ownership history replies identify the affected person and saved operation.
Detail replies can also say whether read tables and permissions have applied that change.
These receipts do not say whether departure cleanup has finished.

Approval replies can name takeover as their cancellation cause and show the saved
end time. Used approvals retain their earlier use and dispatch evidence.

## Where it fits

This shared library is used by the browser app (`apps/web`), the back end (`apps/server`), the [read-table](../../GLOSSARY.md#read-table-projection) library (`libs/projections`) and the models library (`libs/models`). It depends on Zod, a library for checking data. It does not store [events](../../GLOSSARY.md#event) or decide who may act.

```mermaid
flowchart LR
  web["apps/web<br/>browser app"] -.-> protocol["libs/protocol<br/>messages, spending pages by month and choices, integration facts, history and tool holds"]
  server["apps/server<br/>back end"] -.->|image admission and attempt numbers, member roles and access replies, child requests and retries, origin replies, published answers, integration facts, publication facts, spending replies, live stop notices and approvals| protocol
  projections["libs/projections<br/>read tables"] -.->|directory, spending choices, removal, role and ownership facts, and control refusal reasons| protocol

web["apps/web<br/>browser app"] -.-> protocol["libs/protocol<br/>messages, spending pages and choices, integration facts, history and tool holds"]
  server["apps/server<br/>back end"] -.->|image admission and attempt numbers, member roles and access replies, child requests and retries, origin replies, published answers, integration facts, publication facts, spending replies, live stop notices, approvals and takeover cancellation| protocol
  projections["libs/projections<br/>read tables"] -.->|directory, spending choices, role and ownership facts, and control refusal reasons| protocol
