# NATS process failure and rejoin

Date: 25 October 2026. Base: `7f16d209d`. Test-first commit: `729ccbb11`.
This is a disposable three-process fixture on one host, using pinned NATS 2.15.0,
TLS routes and separate storage directories. It is not a packaged installation.

The checker tests first failed because the checker did not exist. They require
changed history and changed subject positions to fail. Unresolved appends stay
separate from acknowledged writes whether or not their event is later observed.

The drill stops the actual EVENTS stream leader with SIGKILL while a conditional
append is pending. Two surviving peers must accept another write. A stale position
must be refused. A deliberately lost reply must recover the exact stored receipt.
The same peer restarts with its original files. Its current-replica flag, local
message count, retained range, event ids, order and subject positions are compared.
Repeating a command after rejoin must not save another event.

A passing run stopped `peer-1`. It retained acknowledged ids `before-loss`,
`other-subject`, `racing`, `after-loss` and `lost-reply` at global positions 1–5.
The last positions were 3 for `member-alice` and 5 for `member-bob`. The racing
append returned `appended`; unresolved and observed-unresolved lists were empty.
The checker also covers unresolved events both present and absent from history.

The Vitest annotation records only fixture ids, positions and outcomes. Process
output and disposable credentials stay private. Cleanup removes only owned
processes, connections, files and the throwaway PostgreSQL container and volume.

| Check | Result |
| --- | --- |
| Process tests and checker | PASS — 25 cases twice, including 15 preserved route tests |
| Security rules | PASS — 438 cases; no test changes |
| Typecheck, event catalogue, Knip and changelog | PASS |
| Full lint | PASS — 6 GiB Node heap; existing warnings only |
| Owned fixture cleanup | PASS — processes and storage removed; PostgreSQL removed with its volume |
| Packaged node/PVC loss, placement and rotation | NOT RUN — requires complete P5-4 and a claimed fresh install |
| Hosted failure domains and full product journeys | NOT RUN |

An earlier parallel run exposed the existing startup error “no suitable peers for
placement, peer offline”. The shared fixture now waits for all eight routes and
metadata health before provisioning. These checks alone were insufficient in a
later run. Provisioning also waits boundedly after the exact typed peer-offline
placement refusal. It never retries a timeout or another error. The separate
cluster-flake lane also owns this startup issue; its changes will need reconciling with the extracted helper.
Another run timed out while setting up the lost-reply helper's management client
after leader loss. The helper is now connected before the fault and reused during
recovery. Both final process runs passed after this change.
No adapter defect was observed. No adapter or Helm behaviour changes.
This receipt does not qualify packaged P5-5.

The first full lint run was stopped after more than 15 minutes. Node had its
default 4 GiB heap limit; the process used about 3.7 GiB of resident memory.
It passed with a 6 GiB heap limit and the same CPU priority.
