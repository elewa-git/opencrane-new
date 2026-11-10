# Held native persistence attempt

Date: 10 November 2026. Source: this branch's held persistence attempt helper.
Image digest and deployment identity: NOT RUN; no reviewed immutable image or fresh install
was measured.

The `work/p4-15-pr5x` branch tip was `3c0c752184b013cb3f1d8282ba4311a353734787`;
its native protection reached main as `aef7fc3030636d861d99d8d3f132e1bdbd02176d`.
The native memory catalogue from #888 reached main as `4ae99f3d0` and is an ancestor
of this branch. It does not block the next step. A reviewed image, a deployment caller
and a held live native turn are still needed before a real attempt.
Expected for a live attempt: every forbidden tool is blocked, all named storage is
readable and clean during the turn and after Stop, and both process reads match.
Observed: the live attempt was NOT RUN.

| Fixed category | Result | Observation |
| --- | --- | --- |
| First process inventory | NOT RUN | No live native turn was started. |
| Second process inventory | NOT RUN | No live native turn was started. |
| Shell, file and browser writes | NOT RUN | No live native call was made. |
| Code host and external MCP writes | NOT RUN | No live native call was made. |
| Skills, plugins and spawning | NOT RUN | No live native call was made. |
| Computer PVC | NOT RUN | No live scan was made. |
| Sessions and reload state | NOT RUN | No live scan was made. |
| Cache | NOT RUN | No live scan was made. |
| Outbox | NOT RUN | No live scan was made. |
| Logs | NOT RUN | No live scan was made. |
| Dumps | NOT RUN | No live scan was made. |
| After Stop scan | NOT RUN | No live Stop was issued. |
| Complete fresh-install qualifications | NOT RUN | Two installations and full journeys remain outstanding. |

The new failing-first tests exposed five cases where a known tool write was lost.
After the fix, the focused attempt tests passed twice: 51 tests on each run.
The whole private-memory-qualification directory passed with one worker: 34 files
and 803 tests. Scoped ESLint, Markdown lint, workspace and helper typechecks,
event catalogue check, Knip, changelog lint and public privacy check passed.
These are local source checks. They do not establish a native tool refusal or clean
deployment storage. The root suite and live qualifications were NOT RUN.
The persistence journey remains `NOT RUN` and admission remains disabled.
