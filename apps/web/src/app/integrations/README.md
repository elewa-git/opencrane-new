# Integrations

This folder shows the outside tool servers registered with OpenCrane. Admins can find a server, inspect its status, review changed tools and check why a person and assistant have access.

## What it is responsible for

- Searches and filters the register at `/org/integrations`, and opens each server's details.
- Separates installed, connected, allowed-for and assistant-availability facts. Missing information stays unavailable; a tool mode alone grants nobody access.
- Compares saved tool lists on the changes page, including field types, limits and full definitions. Missing comparisons block review; expired checks and changed tools keep calls paused.
- Sends reviewed settings to the AI gateway, the service that passes on AI calls. This is called publication. Calls wait for its acknowledgement; publication adds no grants and restores no old approvals.
- Keeps the original publication reference for checks after reopening. Older replies cannot replace a newer result or newer tool settings.
- Explains a named tool's person permission, assistant permission and account state. An incomplete check stays unknown and does not promise that a call can run.
- Keeps dated details during temporary read failures, but clears protected data when access is refused.

A later tool change can be reviewed even when an older publication still has a saved
reference in the browser. The page checks that original change first. A reply that
matches it can release the reference when it belongs to an older set of tool settings.
An uncertain publication for the current settings still needs Check status.

Refresh keeps the page and keyboard focus in place. A failed tool-policy read has a
visible notice; earlier comparison rows keep their last successful check time.
Publication and its result use a short status card, with Check status near the top
when the result is uncertain.

## Main files

| File | What it does |
| --- | --- |
| `integration-register.*`, `integration-detail.*` | Draw the list, details, tool comparison and publication status. |
| `integration-facts*`, `integration-status.ts`, `integrations-access-lost.*` | Present separate facts, progress and access messages. |
| `tool-changes.ts`, `review-command.ts`, `initial-review-confirmation.*` | Compare tools and confirm the current settings and audience. |
| `publication-reference.ts`, `publication-ready.ts` | Retain request references and check saved publication results. |
| `tool-access-explanation.*`, `add-flow-steps.*` | Explain access and show progress through setup. |

## How it connects

[Organisation](../organisation/README.md) supplies navigation.
[Add an integration](../mcp-install/README.md) registers servers; [Tools & access](../tool-policy/README.md)
sets tool rules and initial permissions. [Models](../models/README.md) reuses the fact cards.
[The server](../../../../server/README.md) supplies all saved facts and performs publication.
