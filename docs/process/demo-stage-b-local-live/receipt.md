# Local tools rehearsal

Part of #574. Run date: 24 October 2026. Current result: **PARTIAL**.

The fresh install uses claimed secondary slot 1. No paid model is configured.
The owner stack is unchanged. The launch keeps the complete server and models
entrypoints, including publication, catalogue watch, dispatch and chat services.

## Source

| Prerequisite | Actual squash on main |
| --- | --- |
| Local TLS adapter and evidence checker, #618 | `256107993` |
| Saved integration facts, #627 | `f5dd85cb8` |
| Shared gateway configuration lock, #632 | `dd1d6ef15` |

The earlier `8507d8084` is the #618 branch head, not its squash commit.
Test-first commit: `56d288d0e`. Three launch checks failed because the entrypoint
and source injection were absent. The existing evidence refusal passed.

## Results

The run is still being collected. No live tools or approval PASS is claimed here.
The final receipt will retain the original references and state every untested step.

Native shell and file-edit consent is NOT RUN under the 23 October decision.
Public DNS and certificate deployment remains with the owner under #573.
Twice-fresh runs, expiry, reconnect, Pod loss and the full refusal matrix remain
NOT RUN. This work does not complete #45, #46 or #63.
