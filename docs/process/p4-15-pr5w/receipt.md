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
| Incomplete process refusal | PASS | The journey, supervisor and collector preserved `complete: false` and the fixed reason. |
| Failing-first contract tests | PASS | Seven focused assertions failed before the fix in commit `5023a18ce`. |
| Changed tests, first run | PASS | 205 tests passed across four files, including Docker cleanup. |
| Changed tests, second run | PASS | The same 205 tests passed again. |
| Static checks | PASS | Scoped ESLint and Markdown lint, typecheck, check:events, knip and lint:changelog passed. |
| Missing incomplete status, before fix | FAIL | The collector and Docker supervisor each accepted the three-field `private_process_missing` refusal. The failing tests were committed first in `b5e8bb019`. |
| Changed tests after the fix, first run | PASS | 165 collector, journey and Docker supervisor tests passed. |
| Changed tests after the fix, second run | PASS | The same 165 tests passed again. |

The source, image and environment for a fresh installation were not measured in
this change. Disposable containers supplied only local test evidence. No stack,
model call, root test suite or deployment qualification ran.
