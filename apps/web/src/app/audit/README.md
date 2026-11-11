# Change history

## What this is

This page shows saved organisation changes and their observed results.
People can also read the action history for a conversation they may open.

## Where it fits

The website asks the server for safe records. The server checks access before
each reply.

```mermaid
flowchart LR
  website[Website] --> history[Change history]
  website --> organisation[Organisation pages]
  history -->|family and reference| server[Server history read]
  server --> records[Saved event records]
```

## What it is responsible for

- Shows a decision beside what was later observed.
- Filters and loads older records without repeating a change.
- Groups related changes so each family shows all of its saved event types.
- Opens one record's evidence at a time.
- Keeps focus in the open detail and returns it to the selected row when closed.
- Shows membership, publication and delegation facts that the server permits.
- Shows memory work as metadata without fact text.
- Names each saved routine stage without showing instructions or output.
- Keeps loaded records during a temporary failure and clears them when access ends.

## Main files

| File | What it does |
| --- | --- |
| `audit.ts` | Reads the list and the selected record's evidence. |
| `audit.html`, `audit.css` | Draw the filters, list and detail panel. |

## How it connects

[Page selection](../README.md) opens Change history.
[The server](../../../../server/README.md) supplies safe records.

## Where to read more

[README.robot.md](README.robot.md) records the API, access and capture details.
