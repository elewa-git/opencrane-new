# Private memory storage scans

7 November 2026. Part of #97. Branch `work/p4-15-pr5u`.
Starting main: `2659e880a`. Environment: disposable filesystem fixtures in this
worktree, not a fresh deployment. No runtime image digest applies.

PARTIAL. This first split adds the storage reader and refusal tests within the
approximately 600-line budget. The full requested native turn, all eight tool
attempts and measured deployment inventory require a later part. The existing
scanner skipped absent files and symlinks and returned raw paths; this helper
reads every required entry or refuses with a fixed category. No deployment
caller is added. The runner remains NOT RUN for persistence; other rows and both
complete qualifications remain held. No fixture result enables memory.

The tests create a new random canary in RAM and deliberately write it only in
owned disposable folders. They remove those folders and clear buffers afterwards.
They check each storage category, hidden files, unreadable paths, redirects,
replacement, chunk boundaries, separate scan sessions and a write after simulated
Stop. This is not a native turn, real Stop, crash, reconnect or writable image test.
The helper records actual mount and directory identities but does not discover
the deployment's mounts, processes or logs. Phase labels cannot prove lifecycle
observations. It always returns complete=false, even after two clean scans.

## Own checks

| Check | Result | Observation |
| --- | --- | --- |
| Main update, dependencies and local tools | PASS | Fetch and fast-forward, npm ci and both requested tool symlinks completed. |
| Test-first commit | PASS | `72acc0e96` contains only tests. The initial run failed because the implementation was absent. |
| Changed tests twice | PASS | All 40 scanner assertions passed twice after the final code changes. |
| Existing collector and runner refusals | PASS | Focused runs passed 206 and 223 assertions; the latter includes the protected-result reader. |
| Lint, Knip and typecheck | PASS | Full lint (including Knip), workspace typecheck and runner typecheck exited zero. Final scanner ESLint also passed. |
| Events, changelog and unchanged security rules | PASS | All 158 catalogue entries agree, changelog is valid and all 460 security-rule assertions passed. |
| Pushed-head ci-ok | NOT RUN | The final report records the result after pushing. |
| Native tool attempts and actual storage inventory | NOT RUN | No deployment caller in this first split. |
| Fresh-install persistence and both qualifications | NOT RUN | Sole journey owner execution remains required. |

Validation used the explicit qualification Vitest config, the unchanged security
suite with the supplied PG_TEST_URL, workspace typecheck and the runner tsconfig.
All lint, typecheck and test commands ran under nice -n 10.

No root suite, dev stack or paid model call ran. No authority or security test,
Dockerfile, dev-stack, memory tool or enablement file changed. No dependency,
event or public API field was added. Receipts contain no canary or private hash.
