# Egress

Egress means connections from OpenCrane to outside services. This folder lets owners and admins save which destinations are allowed, and check whether a particular change was saved after its reply was lost.

## What it is responsible for

- Records an allow or revoke choice for an exact host, port and the person, assistant or installation it applies to.
- Checks the installation and the caller's current admin rights.
- Rejects a change based on an old saved position.
- Keeps a request id tied to its original rule, arguments and caller.
- Returns the caller's original saved confirmation without sending the change again.

The server reads destination history before its short final write check. It saves one change only if the stored position still matches the history checked in the [event log](../../../../GLOSSARY.md#event-log-event-store), the permanent record of changes. A racing destination edit requires the caller to reload. An uncertain save remains unknown until the saved record can be checked.

## Main files

| File | What it does |
| --- | --- |
| [changes.ts](changes.ts) | Validates destination choices, saves them and reads original results. |

## How it connects

[Models](../models/README.md) registers these organisation requests. [Members](../members/README.md) and the [models library](../../../../libs/models/README.md) supply access checks. The separate models process prepares connection relays under its single-worker lock, restores saved closure records at startup and closes relays when stopping.

## Not done here

Saving a destination does not open a connection. Normal startup leaves gateway and command-worker outside networking switched off while outage and crash handling await live checks.
