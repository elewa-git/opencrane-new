# Memory

This folder shows the Memory panel inside a chat session. People can search saved facts
they may read, inspect their sources, remember a fact, correct it and forget one of their
own facts.

## What it is responsible for

- Lists permitted memory scopes, meaning whose saved facts are shown, with search and more pages.
- Reads a fact and its source status separately, and links to a source conversation when permitted.
- Checks text before saving, offers preferences only in personal memory and confirms a saved fact with the server's result.
- Waits briefly for a saved correction to appear. Temporary read failures keep the detail controls
  and offer another refresh without repeating the correction.
- Reviews a forget request, hides the fact when confirmed and shows whether cleanup is pending, complete or unavailable.
- Keeps unresolved requests available for status checks, including when another fact is opened.
- Clears drafts and protected details when access, the selected scope or the person asking changes. Memory content is not kept in browser storage.

## Main files

| File | What it does |
| --- | --- |
| `memory-panel.*` | Draw the scope list, fact details, search and remember form. |
| `memory-panel-data.ts`, `memory-panel-reads.ts` | Check replies, read permitted facts and label sources. |
| `memory-panel-store-input.ts`, `memory-panel-store-reply.ts` | Check save input and interpret saved or uncertain results. |
| `memory-edit.*` | Save a correction and wait for its revision to become readable. |
| `memory-forget.*`, `memory-panel-forget.ts` | Review forgetting, follow cleanup and move focus after a fact disappears. |

## How it connects

[Chat](../chat/README.md) supplies the current session context.
[Shared dialogs](../ui/README.md) contain the forms.
[The server](../../../../server/README.md) decides which facts may be read or changed.
Undo and group or assistant-notes editing and forgetting have no controls here.
