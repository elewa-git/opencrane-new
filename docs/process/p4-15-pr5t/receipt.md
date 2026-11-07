# Native recall prerequisites

7 November 2026. Part of #97. Branch: `work/p4-15-pr5t`.
Starting main revision: `b5a2a2ba12074b693a26763a92bab488eba0759d`.

## Scope and result

PARTIAL. This is the first split permitted by the approximately 600-line limit.
The runner now checks its pinned native runtime and measured silo for native recall.
It refuses missing native files, foreign silos and changed protection. Successful
prerequisites still return NOT RUN. The container alternative starts no native work.
Every other incomplete row and both qualifications remain incomplete. Admission stays off.

The complete journey requires deployment session preparation, native model execution,
live grant checks and answer verification in addition to these prerequisites.
Reusing the existing 250-line backend fixture as production setup is not valid:
it supplies synthetic qualification, test credentials and a scripted native peer.
The existing native session test also supplies synthetic catalogue evidence.
Combining production setup, model execution and the requested refusal tests needs
another change. No test helper is imported by the shipped runner.

This split checks real stored recall in a disposable fixture. Its question contains
neither the stored own-person answer nor the foreign fact. The server records the
exact reference before delivering the reply through the bridge and gateway. A cold
event read keeps that reference. Another member's scope refuses. This does not prove
a generated answer, live caller isolation or a qualified deployment.

## Own checks

| Check | Result | Observation |
| --- | --- | --- |
| Update from main and dependency install | PASS | Fetch, fast-forward merge and npm ci completed. Lockfile unchanged. |
| Local tools | PASS | NATS and Lychee use the requested executable symlinks. |
| Failing-first tests | PASS | Before implementation, seven of nine runner assertions failed, including the missing native call. Test-only commit: `56dd3b805`. |
| Backend fixture setup | PARTIAL | The first attempt lacked the pinned gateway executable. The existing pretest command installed it; the next two-test run passed. |
| Changed runner and backend tests twice | PASS | 63 assertions passed in focused and repeated runs. The final two backend assertions passed twice after removing private text from failure diagnostics. |
| Collector, protected reader and cleanup | PASS | The broader focused run passed all 164 assertions. |
| Native image tests twice | PASS | All 42 assertions passed in both runs, including the new recall entry checks and cleanup. |
| Workspace and runner typechecking | PASS | Both commands exited zero. |
| Event catalogue and changelog | PASS | All 158 event types agree; changelog check passed. |
| Lint and Knip | PASS | Full lint, including Knip, passed with CI's 8 GiB Node heap limit. The first invocation was stopped near its default heap limit. |
| Unchanged event security rules | PASS | All 460 assertions passed. |
| Fresh-install native recall | NOT RUN | No deployment or model call. |
| Complete private-turn and memory qualification | NOT RUN | Incomplete; admission remains disabled. |
| Pushed-head ci-ok | NOT RUN | Checked after pushing; the final build report gives the GitHub result. |

## Remaining journey work

The next part must create a run-bound admitted personal session on the measured
installation and use the real personal memory client. It must check a generated
answer against the stored own-person fact and verify exact reference recording
before delivery. Current grants and access must be rechecked after awaited work.
Wrong requester, changed revision, revocation, stopped or replaced callers, stale
qualification, Ask/Block, late output, concurrent callers and lost append/reply
cases still need to exercise that whole runner path. Empty native threads and
scripted replies cannot provide complete PASS.

Paid calls cost 0 euro cents. No dev stack, owner service, host setting, Docker daemon
setting or protected authority/security test was changed. No Forget, Dockerfile,
dev-stack or enablement file was changed. No private text is written to receipts.
