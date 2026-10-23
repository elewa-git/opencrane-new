# Tools and access

This folder shows Tools & access for a registered tool server. Admins choose whether a tool runs automatically, asks the person first or stays blocked, then review who may use a new integration.

## What it is responsible for

- Opens `/org/integrations/<server>/tools` and shows current tool definitions and rules.
- Offers Allow automatically, Ask and Block, with cost and approval details needed for review.
- Saves individual rule changes and shows conflicts when saved settings changed elsewhere.
- Adds or removes initial access for one named person or assistant at a time. Both need a grant, meaning explicit permission, before tools can be used.
- Checks each saved permission and the current audience before offering review. Draft permissions give no access before publication, when reviewed settings are sent to the AI gateway.
- Checks that an assistant belongs with the selected person before offering an access-explanation link.
- Clears protected details on access refusal and retains original references for unresolved checks, including after reload.

If a tool-rule save reply is lost, Check status reads the saved modes before another
action is offered. It never sends that save again. Each initial permission change
waits for both its saved result and permission updates before it is shown as complete.

## Main files

| File | What it does |
| --- | --- |
| `tool-policy.*` | Draw tool rules and coordinate saving and review. |
| `tool-policy-choices.ts` | Keep choices tied to the current tool list. |
| `tool-audience.*` | Choose people and assistants, save access and link to explanations. |

## How it connects

[Add an integration](../mcp-install/README.md) leads here after remote discovery.
[Integrations](../integrations/README.md) supplies comparison, final review and publication.
[The server](../../../../server/README.md) saves settings and applies permission checks.
Published audience editing and group audience choices are unavailable in this editor.
