# Candidates not run

## Restate: EXCLUDED

The server's [licence](https://github.com/restatedev/restate/blob/main/LICENSE)
is Business Source License 1.1. The complete retrieved text, source URL and
blob identity are in [evidence/restate-LICENSE.txt](evidence/restate-LICENSE.txt).
It was checked before any Restate runtime was installed. Its four-year change
to Apache-2.0 does not make the currently reviewed server OSI-approved.
The MIT TypeScript SDK does not change the server's licence. No Restate code
was installed or executed. This is an OSI-policy exclusion, not legal advice
about its additional use grant.

## Hatchet: NOT_RUN

Hatchet v0.107.2 is MIT; see the saved
[licence](evidence/hatchet-LICENSE.txt). The published release archives contain
the CLI, whose local-server implementation calls Docker. The pinned source is
saved in [hatchet-docker-driver.go.txt](evidence/hatchet-docker-driver.go.txt);
[hatchet-feasibility.txt](evidence/hatchet-feasibility.txt) records the release
asset list and server entry points.

`command -v go` returned exit 1 in this environment. A source build is allowed,
but was not attempted within the remaining disk allowance: the existing spike
already occupied 789 MiB before compiler caching. Installing Go and building
its large dependency tree would need a separate footprint assessment. Docker
is forbidden. No Hatchet runtime was installed or run.

This does **not** establish that Hatchet cannot run without Docker. The earlier
claim that the task allowed only official release binaries was incorrect and
has been removed. Behaviour, performance and source-build feasibility remain
NOT_RUN.
