# First computer start on a fresh package

## Fresh-install check on 26 November 2026

**FAIL at 1280 px. NOT RUN at 390 px.** The desktop member got a
reply, but Send to turn start took 20.339 seconds against the 20-second
limit. The mobile run made no claim. Its longest stretch with slot 1
free and the load below six was 4 minutes 30 seconds.

The package ran product commit `f08ac1f92bd32346e4eb863c0f88a62e05348161`.
[Hosted CI](https://github.com/elewa-git/opencrane-new/actions/runs/45880520903),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45880546506)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45880546557)
passed for that commit. Both image approvals still had their artifacts.

### Desktop steps and measurements

The packaged journey starts an empty Helm namespace with
`package-prepare` and `package-up`. The separate `up.sh --fresh` command
starts the Compose stack.

1. Waited for five minutes under six with slot 1 free. Claimed slot 1.
   Created an empty namespace with `package-prepare` and prepared its
   named secrets. Used the recorded `accepted-dev-box-366` host exception.
2. Checked that no running container used the approved computer image.
   Removed only the exact image reference from the slot's node and
   confirmed its absence. The digest was
   `sha256:40e715076ce0c19f0610b0fbe7872112c971d50a444487126f4465b3d8d4c3f0`.
3. Ran `package-up`. Kubernetes recorded a pull at 19:33:33 UTC.
   The Job finished at 19:33:37 UTC and the installer returned ready
   at 19:35:15 UTC. Kubelet reported 119 ms for the pull. Shared image
   layers could still be present on the node.
4. Invited and signed in a separate ordinary member at 1280 px. The
   first workspace read returned HTTP 200. The member sent their first
   message and got a reply from the free stand-in. Their computer used
   the local image. A signed-out history read returned HTTP 401.
5. Saved the logs and removed the package. `down.sh` released slot 1.

| Measurement at 1280 px | Result |
| --- | ---: |
| Send to turn start | 20.339 s |
| Send to first visible reply | 23.413 s |
| Package ready to turn start | 53.991 s |
| Claim to computer ready | 11.0 s |
| First computer image download | 0 s |
| One-minute host load during the run | 3.69–12.84 |

[Desktop reply](first-reply-after-pull-1280.png) and
[desktop measurements](timings-after-pull-1280.json). The private logs include
`cold-cache.log`, `run-load.log`, `package-up.log` and `events.log`.

### Mobile admission

Slot 1 was busy in 20 checks. The one-minute load ranged from 2.82 to
13.87. The five-minute requirement was unmet when the hour ended. The
load was already below six at that point. The check continued through
that stretch until the load rose again. The mobile run then ended
without a stack claim or new timing. Samples are in `admission-load.log`.

## Installer refusal and cleanup

**PASS in the installer tests.** Helm 3 and Helm 4 failure output reported
the checked Job name and reason. A real Helm render reported that no
node could run computers when all nodes were cordoned. The chart set
a two-minute limit for keeping finished Jobs. The failure fixture
stopped before readiness checks and kept the release identity for
cleanup.

**NOT RUN live.** The refusal missed its five-minute admission check
before the two-hour journey limit. Slot 1 became free at 21:02 UTC with
a one-minute load of 12.02. The last sample was 7.01. The refusal check
made no claim. Samples are in `admission-load.log`.

## Local checks

The tests in `f4413853b` reproduced the install failures and showed
that the bootstrap readiness test also created a replicated stream.
The fixed readiness test uses an existing replicated stream and still
checks dispatcher setup. A separate test checks fresh stream creation.

- **PASS twice** for 660 chart, installer and preflight tests, 39
  bootstrap tests, 83 licence tests and 109 package fixture tests.
- **PASS** for 17 focused Helm 4 checks. The wrong-role image tests
  failed when the corresponding pin comparisons were removed in a test
  copy.
- **PASS** for typecheck, the event catalogue, Knip, changelog and
  Markdown checks. ESLint's configuration excludes the changed
  infrastructure files.
- **FAIL** for three supplemental NATS route fixtures that reached
  their existing deadlines during a parallel local run. The product
  commit passed hosted CI.

## Earlier runs

The previous fresh installs used images already on the node. Send to
turn start took 18.4 seconds at 1280 px and 42.1 seconds at 390 px.
The first mobile attempt returned HTTP 403 immediately after joining.
A separate mobile attempt reached the reply. An earlier wait for a
quieter host produced no new measurements.

- [Earlier desktop reply](first-reply-1280.png) and
  [measurements](timings-1280.json).
- [Earlier mobile reply](first-reply-390.png) and
  [measurements](timings-390.json).
- [Earlier mobile workspace refusal](browser-failure-390.png).
