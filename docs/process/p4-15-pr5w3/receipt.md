# Separate computer bridge check

8 November 2026. Part of #97. Branch: `work/p4-15-pr5w3`.
Environment: development worktree and disposable Docker containers. This was
not a fresh installation or a private memory journey. No paid call was made.
The starting source was `f607bea4c06aa8fec7ef818dbbbe5345fc258ef2`.
No deployment image digest was selected or qualified.

The collector can run a narrow bridge check in the computer container named
by its root-owned target file. The check uses the root entrypoint's launch
record and the live bridge process. It checks swap and dump protection before
and after the bridge exchange. The collector measures the computer container
before and after the check. It saves only a fixed refusal when the check fails.

| Check | Result | Observation |
| --- | --- | --- |
| Worktree update and dependencies | PASS | Rebased on `origin/main`; the existing dependencies and local tool links were available. |
| Failing-first commits | PASS | The bridge tests failed before the checker existed; the added data-mount test failed before the mount fix. |
| Separate bridge container | PASS | A disposable computer image ran its packaged root entrypoint and UID 1000 bridge, with a `<home>/agent` volume and no code mount. The collector's narrow check passed. |
| Refusal cases | PASS | Wrong container, stale record, changed process identity, denied process read, swap and dump allowance refused in focused tests. |
| Changed tests, both passes | PASS | 124 tests passed twice across five files, including the packaged bridge. |
| Other affected tests | PASS | 181 tests passed across seven files, including the changed tests before the final collector assertion. |
| Event security rules | PASS | 460 tests passed with a disposable PostgreSQL database. |
| Local lint and event catalogue | PASS | Scoped ESLint, Markdown, changelog and `check:events` passed after the fix. |
| Unused code check | PASS | Knip exited zero. |
| Full container process inventory | PARTIAL | The bridge check passed, but the other process groups still refuse. |
| Both complete qualifications | NOT RUN | No fresh installation or private memory journey ran. |
| Root suite | NOT RUN | CI owns the full suite. |

Memory admission remains disabled. The collector still refuses a complete
result while the supervisor, proxy, native wrapper, native child and canary
helper lack live proof. No owner stack or host Docker settings changed.
