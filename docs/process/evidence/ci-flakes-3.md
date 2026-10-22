# Status-code tests under load

Date: 22 October 2026. Base: `4fb9a34b2a23316f29e0e34ee55ae91848b794f1`.
Environment: Node 22.23.3, Linux, this development worktree; not a fresh installation.

## Causes

| Test | Cause of 503 | Change |
| --- | --- | --- |
| Memory correction racing Forget | The second request can reach memory admission while the first request still holds the member/scope slot. `acquireMemoryWrite` throws `MemoryBusy`; the HTTP handler returns `memory_busy`. No deadline has to expire. | Capture old history, then wait for the first response before continuing the stale-revision check. |
| Decision cost with 3,000 grants | A warm-up can reach a saved Allow and then exceed the two-second admission deadline. Failure after an attempted audit returns `Decision audit unavailable`. Cold-history timing made the warm-up outcome vary. | Reuse the grant-history fixture fix from PR #582: require a controlled cold-history 403, finish history directly, then measure later admissions. |
| Child recovery status reads | Cleanup repeatedly added team membership even when no member had been removed. The extra receipt checks exhausted the two-second child review access deadline. | Already fixed by #563 on this branch's base: restore membership only after removal. |

The memory race previously released the first append after the second history read,
but did not wait for the first write to finish. Parallel test files can change
which request reaches admission first. The returned busy response is required by
[the existing memory limits](../../../apps/server/README.robot.md#memory-scope-and-search-reads).
The test now chooses the ordering needed to check a stale revision. It still
requires 200 for the first request, 409 for the second, one append and an available
new revision key. Production files and defaults are unchanged.

The one-second OpenFGA HTTP limit and the 100 ms database-lock and tail-read limits
remain unchanged. Neither starts the reproduced memory busy response. The two-second
write authority deadline is unchanged. No assertion accepts 503, no new retry loop
is added, and no authority test is edited.

## CI and failing-first evidence

- Main run [39819954120, attempt 1](https://github.com/elewa-git/opencrane-new/actions/runs/39819954120/attempts/1)
  reports the memory race at `memory.test.ts:342`: expected 409, received 503.
- PR #582 run [39808257688](https://github.com/elewa-git/opencrane-new/actions/runs/39808257688)
  reports the 3,000-grant warm-up assertion: expected 200 or 403, received 503.
  Its later 15,000-edit measurement passed at 53 ms. The grant warm-up fix is
  taken from that PR's later commit `898903b8615b581317eef09a91b978c2b7469dcb`.
- The existing child cleanup diagnosis is recorded in the server's
  [fixture notes](../../../apps/server/README.robot.md#recovery-fixture-cleanup).
- Expected FAIL: test-first commit `dd24c7023` holds the first correction until
  the second request asks for admission. Correction/Forget returns exactly
  503 `memory_busy`; correction/correction passes its conflict check.
- PASS: after waiting for the first response at the end of the second history
  read, both targeted races pass with their original 200/409 assertions.

Local logs are `/tmp/ci-flakes-3-main.log`, `/tmp/ci-flakes-3-pr582.log`,
`/tmp/ci-flakes-3-red.log` and `/tmp/ci-flakes-3-green-focused.log`.

## Validation

Validation is in progress. Results will be recorded before the final commit.
