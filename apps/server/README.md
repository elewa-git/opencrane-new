# apps/server

## What this is

The back end for OpenCrane sign-in, conversations and organisation settings.
It runs as a Node.js service. The website sends it requests to sign in, chat, upload
files and manage the organisation.
The server checks who is asking and what they may do, saves each change in the
[event log](../../GLOSSARY.md#event-log-event-store), and passes chat work to each
assistant's [computer](../../GLOSSARY.md#computer).
A second program here, the [models process](../../GLOSSARY.md#models-process), checks
AI calls against spending limits and tool rules.

Change history includes saved tool hand-offs and transport observations.
Control refusals recheck access before saving and appear in the requester’s
conversation history. Each control command can save only one outcome.
A hand-off without a saved outcome stays unknown, even when other evidence reports success. A response
does not prove a business change succeeded. Reading history never sends a tool call.

Refused control attempts in enabled test setups save a small audit record. They do not
change the current controller or interrupt work. Production control stays disabled.

Owners and admins can read safe removal, role and ownership change details. The server checks
receipts for the exact saved change before showing its progress, then checks current access.
It still checks access when loading fails, so errors do not reveal protected records.
Removal progress covers permissions and the member list. It does not report departure cleanup.

Approval decisions check ownership and current write access before saving a cancellation.
Approval polling saves cancellation when a saved takeover covers an unused approval.
It notices computer changes even when the chat and approval have not changed.
The computer receives its local work gate before an approval reply. Failed saves or
unavailable gate delivery keep the wait pending. Reconnection reads the same result.

## Where it fits

This package is the back-end layer. [apps/web](../web/README.md) is the website;
[apps/computer](../computer/README.md) runs one computer for each personal or group
assistant. [apps/ops](../ops/README.md) runs background workers that apply saved
changes to permissions and database tables. The server reads those tables, but the
event log remains the permanent record of what happened.

```mermaid
flowchart LR
  web["apps/web<br/>the website"] -->|requests, spending pages, resolution receipts, live updates, tool status and saved tool choices| server["apps/server<br/>the back end"]
  server -.->|checks access, handles child allowances and shares types| libs["libs/*<br/>shared code and chat keys"]
  server -->|records changes, owner pauses, takeover approval cancellations, access-checked control refusals, child activations and tool hand-offs| nats["NATS<br/>the event log"]
