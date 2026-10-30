# Private memory evidence collector

## What this is

This developer tool collects private memory test results from a running deployment.
It reads the deployment identity itself and starts each check inside that image.
It also checks older evidence files, which cannot qualify a deployment.
Admission remains off. The runner checks host settings and saved memory invalidation.
It reports unfinished journeys without qualifying them.

## Where it fits

The collector belongs to the developer tools layer, beside the local qualification checker.
It uses Docker on the deployment host and reads the deployment's event store.

```mermaid
flowchart LR
  scripts["scripts<br/>developer tools"] -.-> collector["private-memory-qualification<br/>collects observed results"]
  scripts -.-> sibling["check-local-qualification<br/>checks local results"]
  server["apps/server<br/>disabled initial loading"] -->|reads and rechecks results| collector
  config["/etc/opencrane<br/>permitted deployment"] -->|sets target| collector
  collector -->|measures and starts checks| docker["Docker<br/>running image and host"]
  docker -->|runs supervised memory checks| deployment["deployment<br/>event store and journey runner"]
```

## What it is responsible for

- Read the permitted container and silo from deployment-owned configuration.
- Stop each journey and its children when it exceeds a limit or the collector exits.
- Measure the source revision, image, host, silo and installation before collecting results.
- Refuse an old or used event store, changed deployment, or missing check.
- Refuse swap, crash dumps, unsafe process limits and unreadable host settings.
- Accept results only from processes it starts in the measured image.
- Save its own result in a protected file and recheck the deployment whenever it is used.
- Refuse copied, edited, stale or foreign receipts.
- Keep failures free of private paths and child process output.

## Processes it handles

The deployment owner records the permitted container and silo in a protected file.
The collector reads that file, Docker and the event store, then starts each check with a new random
challenge. It checks the deployment again around every run. Each child must complete
within two minutes. A supervisor inside the container stops the journey and its
children on timeout, excessive output or collector exit. A retry cannot start until
the previous journey has stopped. Only complete, matching results can pass.

The fixed journey runner is copied into the deployment image by the existing image build.
It reads kernel settings and process core limits itself. Even safe host settings cannot
complete a journey. The runner reuses server tests to check correction, forgetting and
unrelated fact changes against the measured event store. It saves encrypted fixture facts
using the deployment's memory key store. It records these checks as PARTIAL and missing
journeys as NOT RUN. Native calls, process isolation and storage checks are still pending.
Tests use simulated observations and disposable containers to check refusal and cleanup.
They do not qualify a deployment or enable memory.

## How to run or test it

From the repository root, on the deployment host:

```sh
nice -n 10 node --experimental-strip-types scripts/private-memory-qualification/run.mjs
nice -n 10 npx vitest run --config scripts/private-memory-qualification/vitest.config.mjs
nice -n 10 npx tsc -p scripts/private-memory-qualification/tsconfig.json
```

The first command needs the protected deployment configuration described in the contract below.
It prints safe measurements and results, or one fixed failure reason.
It also saves its own result in a protected file. Initial loading reads that file
and checks the current deployment again. Callers cannot upload replacement evidence.

## Where to read more

- [Collector contract](README.robot.md): deployment requirements, limits and live journeys.
- [Server contract](../../apps/server/README.robot.md): existing recall checks.
