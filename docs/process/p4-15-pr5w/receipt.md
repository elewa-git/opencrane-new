# Private process inventory receipt

7 November 2026. Part of #97. Branch `work/p4-15-pr5w`.

The container path reads the runner's current process identity from Linux proc
files and checks it again around the native dumpability measurement. It names
all required private-text process groups. The other groups have no trusted live
dumpability proof, so the collector refuses before a container journey starts.
No process IDs, executable paths, cgroups, host settings or private values enter
the fixed refusal. The safe-host path keeps its previous checks. Memory admission
remains disabled.

| Check | Result | Observation |
| --- | --- | --- |
| Main update, dependencies and tool links | PASS | Fast-forward, `npm ci` and both links completed. |
| Failing-first test | PASS | The test import failed before the process module existed; commit `bedacd8de`. |
| Restricted-container process test | PASS | The image-owned runner read its live identity and refused unmeasured groups. |
| Other private-text process groups | NOT RUN | They lack trusted PID and dumpability proof. |
| Fresh-install container journeys | NOT RUN | The inventory refuses before starting one. |
| Complete qualifications | NOT RUN | Neither complete journey was run. |

The source, image and environment for a fresh installation were not measured in
this change. Disposable containers supplied only local test evidence. No stack,
model call, root test suite or deployment qualification ran.
