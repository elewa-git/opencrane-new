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

## Storage result correction — 7 November 2026

Source: `b14adc2a5` plus the implementation and documentation recorded with this
section. Base remains `2659e880a`; fetch and rebase reported the branch up to date.
The environment is this worktree with disposable local folders, not a fresh install.
No runtime image applies. The added regression tests take the full scanner change
above its original approximately 600-line split, while keeping it below 1,500 lines.

An unavailable or unreadable required folder now returns NOT RUN, with
"Storage inspection could not be completed." Detected private text returns FAIL,
including text in file names. Both retain complete=false. Reading earlier clean
files cannot make an unfinished inspection complete. Retrying keeps the first
status and category. No access, spending or memory check was removed.

The redirect cases put private text in real target files and require zero bytes
read through a final or intermediate symlink. Exact result assertions reject extra
fields. Output checks require no stdout or stderr writes for detected private text
and missing paths. Additional cases cover base64 offsets 1 and 2, directory execute
permission, stored names, and closure after two clean scans. These are filesystem
fixtures; they do not establish deployment coverage or native tool refusal.

| Own check | Result | Observation |
| --- | --- | --- |
| Failing-first test commit | PASS | `b14adc2a5` contains tests only; the old implementation failed 31 of 49 tests before the fix. |
| Final changed tests twice | PASS | All 49 scanner tests passed twice after the final assertion change. |
| Collector, runner and evidence refusals | PASS | Focused runs passed 198 tests across four files and 83 across two files; 49 scanner tests appear in both. |
| Full lint, including Knip | PASS | All stages exited zero; ESLint reported zero errors and 37 warnings in unchanged files. |
| Workspace and scanner typecheck | PASS | Workspace, package, dev-stack and scanner TypeScript checks exited zero. |
| Event catalogue and changelog | PASS | All 158 event types agree; changelog check exited zero. |
| Pushed-head CI | NOT RUN | Not observed for this correction. |
| Native attempts and fresh-install qualification | NOT RUN | No journey or dev stack ran; admission remains disabled. |

Commands used the explicit qualification Vitest config and named test files only,
with `--maxWorkers=1` and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Lint, typecheck and tests ran under `nice -n 10`. Full lint includes `lint:unused`
(Knip). The first lint attempt was stopped without a result after sustained
high memory use. Its retry passed with CI's `NODE_OPTIONS=--max-old-space-size=8192`;
repository and host settings are unchanged. Scanner types also use `scripts/private-memory-qualification/tsconfig.json`.
Local command logs are `/tmp/p4-15-pr5u-fix-*.log` on this builder host.
No root suite, owner-stack action, host-setting change or admission change ran.
