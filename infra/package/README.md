# Local Helm package

## What this is

This package defines a local Kubernetes install for the OpenCrane website,
server and core services. It uses one of the two spare development slots.
The application image is pinned in the local registry. A complete install still
needs its named secrets and the remaining background services.
Helm applies these Kubernetes resources as one named release.

## Where it fits

The package sits beside the development stack. Both use the developer box's local
Kubernetes cluster, but each package has its own namespace.

```mermaid
flowchart LR
  infra["infra<br/>local infrastructure"] -->|contains| package["package<br/>Helm install"]
  infra -->|contains| stack["dev-stack<br/>slot claims"]
  infra -->|contains| devbox["devbox<br/>local cluster"]
  stack -->|checks the slot| package
  package -->|starts| apps["apps<br/>website and server"]
  package -->|starts| services["services<br/>NATS, PostgreSQL, OpenFGA"]
  package -->|runs in| devbox
```

## What it is responsible for

- Keep the installed images and chart version fixed.
- Refuse missing secrets and public network settings before installation.
- Keep the package inside the slot owned by the current worktree.
- Remove only the package owned by that worktree.

## Processes it handles

1. **A worktree claims a spare slot.** The claim records its owner. Preparing the
   package creates a separate namespace in the local cluster.
2. **The package starts.** The website and server run in separate Pods. NATS,
   PostgreSQL and OpenFGA run in the same private namespace.
3. **A developer checks the website.** A loopback-only port forward makes the
   private website available to a browser on this machine.

## How to run or test it

The [operator notes](README.robot.md) describe the required image review, named
secrets and slot commands. The image pins and secret names must be ready before
installation.

## Where to read more

- [README.robot.md](README.robot.md): exact commands, settings and current limits.
- [infra/dev-stack](../dev-stack/README.md): how the spare slots are claimed.
