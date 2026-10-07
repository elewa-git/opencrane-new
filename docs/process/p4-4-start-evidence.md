# Direct chat recipient checks

The recipient screen searches the authorised colleague directory. It shows loading,
failure and successful empty results separately. A replaced search cannot change
its rows, even when the old request finishes later. Selection creates no chat.

This is the first of two draft changes. Both must land together: the second adds
sending and the transcript. Choosing a colleague alone is not a complete journey.

| Check | Result | Evidence |
| --- | --- | --- |
| Rebase onto main | PASS | Rebase completed; `git merge-base --is-ancestor origin/main HEAD` returned 0. |
| Failing-first search specs | PASS | The 503, refused-read and out-of-order reply specs all failed before the fix. |
| Guard removal | PASS | All three new specs failed with the visible-state and current-request guards removed; restoring them passed all five focused specs. |
| Lint, typecheck, Angular build | PASS | Full lint and typecheck, event catalogue, and production build passed. The build retains existing warning budgets and the noVNC CommonJS warning. |
| Angular and browser tests | PASS | 423 Angular tests and 12 web tests passed. The first Angular run exposed stale navigation counts and one timeout; the corrected full run passed. |
| Direct-chat and chat server tests | PASS | Eight files: 75 of 77 passed on the first run. Two long-chat cases timed out; both files passed all 34 tests on rerun with one worker. Tests used a throwaway PostgreSQL database. |
| Fresh-install journey | NOT RUN | This screen only chooses a recipient. |
