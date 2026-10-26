# Programs in the local installation

This folder describes what the local OpenCrane installation runs and how its parts
reach each other. It includes the website, back end, background workers and the
services they need. Helm fills in the chosen settings before installation.
The database normally runs as one container. The optional primary and standby description needs CloudNativePG,
a PostgreSQL controller installed separately. Rendering checks this description;
a running standby has not yet been tested.

## What it is responsible for

- Starts the apps, database, saved event log and permissions service.
- Describes an optional database standby with its own storage on another node.
- Gives background workers the settings and access needed for their jobs.
- Prepares storage, database setup and the first owner.
- Describes assistant computers and limits their network connections.
- Refuses public network access, missing private setting names and unpinned images.

## Main files

| File | What it does |
| --- | --- |
| `apps.yaml` | Runs the website, server, AI access process and permissions service. |
| `workers.yaml` | Runs background jobs and connects gateway preparation to content storage. |
| `data.yaml` | Runs the database and event log, and requests saved storage. |
| `nats-cluster.yaml` | Renders three private event-log peers with separate storage and certificates. |
| `services.yaml` | Gives the programs private network addresses. |
| `bootstrap.yaml` | Sets up initial data and the access needed by setup and workers. |
| `computer.yaml` | Describes assistant computers, their settings and network limits. |
| `guard.yaml` | Rejects unsafe or incomplete installation settings. |

## How it connects

The [chart](../README.md) supplies these templates to
[Helm](../../../../GLOSSARY.md#helm), the Kubernetes package installer.
The [installation tools](../../README.md) prepare the private settings and reviewed
images first. The setup job runs [bootstrap.ts](../../bootstrap.ts); workers run
[worker.mjs](../../worker.mjs).

```mermaid
flowchart LR
  chart["Local installation chart"] --> templates["templates<br/>programs and optional database standby"]
  chart --> values["values.yaml<br/>installation settings"]
  values --> templates
```

The setup job and its private file mounts appear in both the default and three-peer render.
The optional three-peer render is for inspection only. The ordinary installer
refuses it. The [operator notes](../../README.robot.md#three-peer-nats-rendering)
explain its settings and the live checks still needed.
