# infra/dev-stack

## What this is

A set of scripts that starts a full local copy of OpenCrane for development and testing.
It brings the services and apps together on a developer machine. It can also run browser
checks from sign-in through chat, file upload and organisation features.

## Where it fits

This is part of the infrastructure layer. Docker Compose runs its services in containers.
The stack starts OpenCrane apps against them. It uses the
[Kubernetes cluster](../../GLOSSARY.md#kubernetes) prepared by [`infra/devbox`](../devbox/README.md).

```mermaid
flowchart LR
  infra["infra<br/>infrastructure"] --> stack["infra/dev-stack<br/>local OpenCrane"]
  stack -->|starts in Docker| services["Services<br/>PostgreSQL, NATS, OpenFGA, MinIO"]
  stack -->|sets up or checks test sign-in| zitadel["Zitadel<br/>development organisation"]
  stack -->|scans uploaded files| clamav["ClamAV<br/>file scanner"]
  stack -->|runs processes; memory needs configured keys| apps["apps/server, ops, web<br/>OpenCrane programs"]
  stack -->|owns Helm installs and sets the gateway IP| package["package<br/>local Helm install"]
  stack -->|seeds demos and checks real replies; owner starts need a terminal| apps
  infra --> devbox["infra/devbox<br/>machine setup and k3d cluster"]
  stack -->|checks computer and hosted tool rules in the cluster| devbox
```

## What it is responsible for

Separate admission rules check hosted tool images and container settings. Their tests
also check resource changes made through the Pod resize endpoint. Their tests
use temporary namespaces on a claimed spare stack. Startup does not install them yet.

- Start and stop the local services and OpenCrane processes.
  Memory reads need an existing private key directory configured at startup.
- Create private local credentials for the services.
- Set up four sign-in test users for each spare stack. Check that the sign-in apps
  include email claims in their signed tokens.
- Check existing test sign-in accounts without changing Zitadel during a fresh
  package run.
- Prepare the local Kubernetes cluster so that the server can start a sandboxed computer for each member.
- Run a local stand-in for the AI model, so checks cost nothing and give the same answer every time.
- Connect and test that provider as the Owner before a fresh stack starts its chat checks.
- Optionally use a real OpenAI provider on a spare stack, with a separate paid chat check.
- Allow an explicit owner real-provider start from an interactive terminal, while refusing fleet tasks.
- Run browser checks against real local services. The approval journey is currently skipped.
- Check group chats from the To line, participant access, direct chats, shared assistants and
  provider key saving in a fresh stack.
- Keep one extra computer place so a saved-data repeat can start a new shared assistant.
- Measure reply arrival, process memory and open files during live-view checks.
- Keep up to three separate development stacks on one machine.
- Seed two demo groups and a shared assistant through product APIs, keeping their ids on repeats.
- Put the package gateway Service IP in the computer settings before a chat turn starts.
- Run a fresh stub-based check each day in a secondary stack and save its result outside the repository.
  On failure, save the error and recent process logs before removing that stack.

## Processes it handles

A fresh stack with the development Owner connects the local model provider through the
product APIs. It saves a private credential, checks the provider, selects the chat models
and waits for the first default to be recorded. It then explicitly selects that default
and asks to switch on. When accepted, models restarts with that saved
credential before any chat check. A refusal stops startup. Free reachability checks
need no spending settlement. Paid tests and other sends still need confirmed outcomes.
Later starts read the recorded mode again. An explicit real-provider start reads a private
credential file only during setup and saves it through the same product API. Real mode
uses a separate check for streamed answers, Stop, a later member and a supplier PDF.
Changing an existing stack between real and local providers requires a fresh start.
Owner real starts require `--owner-run` and an interactive terminal. Fleet tasks are
refused before owner data is read. The [demo guide](../../docs/process/demo/README.md)
keeps the remaining live checks explicit.

The models process gets a separate control port for checking loaded configuration.
The stack never forwards it. The approval journey is skipped while publication
and call checks are being connected.

1. **A developer starts OpenCrane.** The scripts start the databases and services, then
   start the server, workers and website. The usual start also runs the core browser check.
   Computers update in place after their next pause and keep their home files.
   Admission checks allow only the checked image and settings.
2. **A developer checks a change.** A browser signs in, sends a chat message and checks
   that the reply remains after a reload. Other checks cover uploads, budgets
   and the computer screen. The organisation checks also cover groups, direct chats, shared
   assistants and saving a provider key. Group chat checks cover the mode before the first
   message, who can read each message, quiet ordinary sends, and access clearing after a
   person leaves. Audit checks follow older pages when newer grants fill the first page.
   Budget checks use a real group and shared assistant, and restore
   their test limits even if a browser step fails.
3. **A developer runs a separate stack.** `claim.sh` reserves one of two spare test stacks, numbered 1 and 2.
   Its services use separate data and ports, and `down.sh --id` removes that stack and
   releases its id. The demo launcher checks that the returned id matches the requested
   slot before startup or cleanup. A failed request for another id keeps the existing stack.
4. **The daily check runs.** A user timer updates a detached checkout of `main`, then starts
   `up.sh --fresh` in a claimed spare stack. The local model stub keeps it free of paid model
   calls. Saved failure logs have known secrets and credential patterns removed.
   A result line and any failure evidence go in the user's home directory.

## Secondary stack slots

`claim.sh` gives this worktree one of the two spare slots. Its private owner file records
the worktree, the claiming process id and the start time. A later claim reuses the same
slot for this worktree. A claim stays reserved for at least 15 minutes so the stack
has time to start. After that, another worktree can reclaim it if the claiming process
has ended and no stack processes, containers or package namespace are running.
Kubernetes errors keep a package slot busy. `status.sh` reports `free`
for an unused slot and does not create its owner file. `down.sh` also leaves an unused
slot alone.
The spare slot runs either the Compose stack or the local Helm package. Package
preparation refuses a running Compose stack. If Kubernetes is unavailable during
cleanup, `down.sh` stops Compose and keeps any package owner record for a later retry.
Without a package or computer setup record, teardown needs no Kubernetes connection.
A started Compose stack still removes its recorded computer resources.

## How to run or test it

The local machine needs Docker and Node 22. The owner's main stack is reached over Tailscale,
a private network between the owner's own devices, so it needs a signed-in Tailscale session.
The two numbered test stacks are reached only from the machine itself.
The [developer box](../devbox/README.md) sets up the local Kubernetes cluster.

```sh
infra/dev-stack/up.sh
infra/dev-stack/status.sh
infra/dev-stack/down.sh
```

`up.sh --fresh` replaces this stack's local data and credentials. For a spare stack,
it also clears this worktree's website build cache so changed packages are rebuilt.

The daily timer runs at 03:17 UTC. Before each run, its launcher updates the detached
`~/dev/daily-fresh` checkout to the latest `main` and installs packages only when the lock
file changes. It claims a spare stack, starts it fresh with the local model stub, and removes
that stack when the run ends. If both spare stacks are busy, it records that it skipped the
run. Saved logs have known secrets and credential patterns removed. Logs are withheld
if sanitisation fails. Results and saved failure files go in `~/.opencrane/daily-fresh/`, outside the repository.

Run `infra/dev-stack/install-daily-fresh-timer.sh` to install or update the user timer.

## Where to read more

- [README.robot.md](README.robot.md): exact settings, limits, credentials and test details.
- [Demo guide](../../docs/process/demo/README.md): secondary start and owner refresh prerequisites.
- [infra/devbox](../devbox/README.md): the local cluster used for computers.
- [infra/nats](../nats/README.md): the event log's connection rules.
- [infra/clamav](../clamav/README.md): the file scanner used by uploads.
- [Why NATS JetStream holds the event log](../../docs/adr/0001-event-store-nats-jetstream.md).
