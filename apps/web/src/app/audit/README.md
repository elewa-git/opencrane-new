# Change history

This folder shows what OpenCrane decided and what happened afterwards. Admins see organisation Change history; people can also open Action history for a conversation they may read.

## What it is responsible for

- Shows decisions separately from observed results, including unknown outcomes.
- Filters by Allow, Ask or Deny, request reference and chat turn reference. A turn is one message and the assistant's reply.
- Loads older history and shows amounts set aside or charged in whole euro cents.
- Clears history when access is refused and offers refresh when a read fails.

## Main files

| File | What it does |
| --- | --- |
| `audit.ts` | Reads and checks history returned by the server. |
| `audit.html`, `audit.css` | Draw the filters, records and status messages. |

## How it connects

[Page selection](../README.md) opens `/org/history` or `/history/<conversation>`.
[The server](../../../../server/README.md) supplies the records, using the shared
[message rules](../../../../../libs/protocol/README.md).
This page reads history; it does not repeat an action whose result is unknown.
