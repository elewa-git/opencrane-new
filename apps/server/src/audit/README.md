# Audit

This folder lets people see why OpenCrane allowed, refused or charged for work. It serves organisation change history to owners and admins, and a smaller history for someone reading a conversation.

## What it is responsible for

- Returns filtered pages of saved decisions and changes.
- Returns details of one organisation history entry to a current owner or admin.
- Checks the exact read-table and permission receipts for role and ownership changes.
- Limits conversation history to the reader's own requests in a conversation they may read.
- Loads the history before checking current access, so a slow read cannot return private information to someone removed during loading.
- Tells browsers and shared caches not to store the replies.

These requests only read history. They save no changes and start no assistant work. Missing setup or an unavailable permission check returns an unavailable result rather than history.

## Main files

| File | What it does |
| --- | --- |
| [membership-progress.ts](membership-progress.ts) | Reads receipts for the saved role or ownership change. |
| [routes.ts](routes.ts) | Checks filters, reads history and checks access before returning it. |

## How it connects

The [server](../../README.md) registers the requests. [Members](../members/README.md) identifies the signed-in person. [Read tables](../../../../libs/projections/README.md) provide the history, and [permissions](../../../../libs/authz/README.md) decides who may see it. [Chat](../chat/README.md) serves the conversation's messages separately.
