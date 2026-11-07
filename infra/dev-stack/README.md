# Development stack

## What this is

This package starts a full local copy of OpenCrane for development and testing.
It brings the apps and services together and checks product journeys such as
signing in, chatting, uploading files and changing organisation settings.

## Where it fits

This is infrastructure that connects the apps to their local services. Docker
Compose runs services in [containers](../../GLOSSARY.md#container-and-pod).
[infra/devbox](../devbox/README.md) prepares the local Kubernetes system where
assistant computers run.

```mermaid
flowchart LR
  infra["infra<br/>infrastructure"] --> stack["infra/dev-stack<br/>local OpenCrane"]
  infra --> devbox["infra/devbox<br/>machine setup"]
  stack -->|starts services; checks listeners; sets up sign-in| services["Local services<br/>jobs, content and access"]
  stack -->|starts the daemon and HTTPS service| clamav["infra/clamav<br/>virus scanner"]
  stack -->|checks subscriptions and shares dispatcher readiness with chat| apps["Server, workers, website and demo tools<br/>OpenCrane apps"]
  stack -->|checks ownership and nodes; refuses unproved backup access| package["infra/package<br/>Helm install"]
  stack -->|checks collection and reports host refusals| collector["scripts/private-memory-qualification<br/>deployment checks"]
  stack -->|uses local cluster; creates and removes owned test nodes| devbox
```

The services include [PostgreSQL](../../GLOSSARY.md#postgresql-database) for read
tables and a separate jobs database, [NATS](../../GLOSSARY.md#nats) for the event log,
[OpenFGA](../../GLOSSARY.md#openfga-permissions-service) for permissions and
[MinIO](../../GLOSSARY.md#minio-file-storage) for files.
[Zitadel](../../GLOSSARY.md#zitadel-sign-in-service) provides test sign-in.

The dispatcher uses the server's read-only content connection to coordinate gateway
configuration changes. Its background jobs keep their own database.
The routines worker keeps routine read tables current. Provider settings use those
tables to check whether an existing routine would be affected by a change.
Uploads use a separate authenticated scanner service. Each stack starts that service
with private certificates and the local ClamAV daemon. Startup makes a signed clean
scan before it starts the server. It also checks that the routines worker is running.

## What it is responsible for

The personal Memory browser helper records the first reply status before reading
its body. A body that does not finish fails after ten seconds, leaving that status
available for diagnosis.

- Starts and stops local services and apps with private local credentials.
- Stops every worker recorded by this stack before checking subscription changes.
- Starts the scanner for uploads and checks one signed scan before the server starts.
- Checks that stack listeners use loopback or this machine's Tailscale addresses.
- Waits for the website to answer before starting browser checks.
- Prepares Kubernetes so background workers can start one
  [computer](../../GLOSSARY.md#computer) per assistant, including shared group assistants.
- Sets up test sign-in and a free stand-in AI provider; real providers need an explicit choice.
  The stand-in also runs on its own for computer startup checks.
- Runs browser checks for chat, files, people, groups, shared assistants and spending.
  Checks money in admin Change history and keeps it out of member action history.
  Scrolls waiting approvals into view before saving desktop and phone pictures.
  Saves a private picture if the spending editor fails to load.
- Checks ownership handover and refuses a last owner’s departure in manual named journeys.
- Waits for each new rehearsal reply to finish, checks its facts and checks the saved
  text after a reload. Uses separate messages and invitations for each screen width and
  attempt, and saves step pictures before recording success. It records failed browser
  reads privately so the request can be checked after a stopped run.
- Refuses incomplete controller or credential settings for an optional PostgreSQL standby.
  Checks password format and conflicting database connections before installation.
  Checks backup Service ownership, named Secret entries and the endpoint certificate internally.
  Verifies the Service hostname against the named CA. Uses the referenced identity to
  create, read and remove one temporary marker in the named backup folder.
  Refuses backup approval because the installer cannot list other silos’ storage locations.
  A denied request to an invented location cannot prove that other silos are protected.
  Checks the allowed destination recorded on the credential Secret and refuses bucket-root listing.
  Refuses the check if the marker changes or cannot be removed.
  Stops the check on cancellation or timeout, then gives marker cleanup its own short deadline.
  Checks deletion permission before writing.
  Backup and recovery installation remain blocked.
  A separate local helper can issue a short-lived backup credential for a private
  silo bucket. It checks the policy signed into the credential before returning it.
  The installer does not use that helper yet.
  Requires runtime and setup replica settings to match the chart before Helm runs.
  Checks mounted event-log certificates and keys, connection settings and account rules.
  Checks three-node eligibility, prepared certificates and image compatibility for
  a three-peer event log. The shipped image review still refuses that mode.
- Keeps two spare test stacks separate from the owner's copy and from each other.
- Checks sign-in, personal memory reads, saves, correction and forgetting on an
  empty installation. Checks supplied memory receipts and records incomplete
  journeys honestly.
- Checks the claimed slot and protected deployment target before memory collection.
  Refuses incomplete results before the calling journey can continue.
  Reports failed host safety checks with a reminder to disable swap and core dumps.
- Keeps original receipts and separates browser checks from untested native
  memory.
- Lets a spare slot own a three-node Kubernetes test cluster. Saved ownership
  keeps the slot reserved until the cluster and its data are removed.
- Removes the nodes it created before reporting a failed start.
- Keeps package commands on their recorded cluster. A missing target stops the command
  before it can connect to the shared cluster. Ownership checks and forwarding keep the private
  connection filename in the child environment rather than its command arguments.
- Runs preflight and Helm from the private values file's folder so its path stays out
  of child command arguments.
- Provides demo preparation and screen measurements, while refusing automated coding
  jobs that try to run the owner's commands.
- Checks the demo tool server through local TLS. Requires saved tool definitions and
  linked approval and dispatch records in event-log order.
  A disposable computer also checks that the free model can call a published read
  tool and answer with its result in the same chat turn.
  A guarded test launch keeps the full server and models processes and connects both
  to one local demo server. It shares only the slot claim and demo socket with models;
  personal and memory keys stay outside that container.
  The collector saves each reply from the demo quote checks and each original event
  before continuing. Closing the browser keeps the saved evidence. The receipt states
  which browser steps were checked.

## Processes it handles

1. **A fresh stack connects the AI.** Startup connects a free stand-in provider as
   the owner would through the product's settings APIs. It checks the provider and
   switches it on before chat checks run. On a spare stack, it allows the background
   worker two minutes to record the first provider choice. Startup waits up to five minutes for the
   website to answer and stops if its process exits.
2. **A developer checks a change.** A browser signs in, sends a message and checks
   the saved reply after reloading. Other journeys cover files, spending, the screen
   and organisation settings; the approval journey remains skipped.
3. **A developer runs a separate stack.** A
   [claim](../../GLOSSARY.md#slot-spare-dev-stack) reserves one of two spare copies.
   Each has its own ports, data and separate private key directories for surveys and
   memory. Restart keeps those keys. Models and computers cannot read those directories;
   cleanup removes only that claimed copy.
4. **A journey prepares memory collection.** The launcher checks one claimed slot,
   then waits for the existing collector and its cleanup. It does not set up an owner;
   the collector’s runner may already have populated the installation.
5. **The daily check runs.** A timer updates a separate checkout of the main branch,
   starts a fresh spare stack with the free model and runs the browser journeys.
   It saves the result and private failure logs outside the repository, then removes
   that stack. If both spare stacks are busy, it records a skipped run.

## How to run or test it

The development owner email is configured in a private file outside the repository.
The [operator notes](README.robot.md#private-owner-email) explain that setting.

The machine needs Docker, Node 22 and the cluster prepared by
[infra/devbox](../devbox/README.md). These commands claim and use a spare stack:

`npm run typecheck` checks the TypeScript in this folder as well as the apps and libraries.
`npm run typecheck:dev-stack` checks this folder on its own.

```sh
DEV_STACK_ID=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID
infra/dev-stack/up.sh --fresh
infra/dev-stack/status.sh
infra/dev-stack/down.sh
```

A fresh start replaces that stack's local data and credentials. A new spare stack
prepares its survey and memory directories automatically. On repeat starts, the launcher
checks changes to background work before starting apps. It applies changes with no matching
events or only new event types while services are stopped. Changes that remove types with
history need a manual upgrade. The stack reports ready only after the dispatcher starts
reading events. Detailed recovery steps, real-provider choices and daily timer settings
are in the operator notes.
The server reads the same private readiness marker. Chat can explain a long wait
without showing members the operator's maintenance steps.

## Folders

| Folder | What it does |
| --- | --- |
| [systemd](systemd/README.md) | Schedules the daily check on a fresh spare stack. |

## Where to read more

- [Local operator guide](README.robot.md#local-operator-guide): commands, evidence and recovery limits.
- [README.robot.md](README.robot.md): settings, stack ownership, commands and detailed checks.
- [Demo guide](../../docs/process/demo/README.md): demo preparation and current limits.
- [infra/package](../package/README.md): the local Helm installation trial.
- [infra/nats](../nats/README.md): event log connection rules.
- [infra/clamav](../clamav/README.md): upload scanning.
