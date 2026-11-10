# Held native persistence attempt

Date: 10 November 2026. Source: [implementation commit](https://github.com/elewa-git/opencrane-new/commit/eb849b9045c75b7c69a494aa8a8427b4ebfc6378).
Image digest and deployment identity: NOT RUN; no reviewed immutable image or fresh install
was measured. Secondary slot 1 was claimed and released without starting a stack.

The `work/p4-15-pr5x` branch tip was `3c0c752184b013cb3f1d8282ba4311a353734787`;
its native protection reached main as `aef7fc3030636d861d99d8d3f132e1bdbd02176d`.
The `work/p4-15-pr4n` branch tip was `ba0c6195201afdb9c2975a64b6ec51e8ec7ece9a`.
It was not merged into the synced main revision `e11aecedfcf5950f5533616cbdfa77eee4646132`.
The required native memory catalogue was therefore unavailable for a real attempt.
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

The failing-first test commit reproduced the missing attempt runner. The implementation
then passed the three focused test files twice: 163 tests on each run. The unchanged
event security rules passed once: 482 tests. Scoped ESLint, workspace typecheck,
event catalogue check, Knip, changelog lint and Markdown lint passed. These are local
source checks. They do not establish a native tool refusal or clean deployment storage.
The persistence journey remains `NOT RUN` and admission remains disabled.
