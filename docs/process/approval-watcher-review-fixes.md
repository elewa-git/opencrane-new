# Approval watcher review fixes

Date: 9 October 2026. Branch: `work/p3-5-be-pr5`, draft PR #283.
Base: `origin/main` at `fb80d1ee`. The second rebase completed after main advanced.
Both README sections were kept. Code and tests were checked at `d7840645`.

`git merge-base --is-ancestor origin/main HEAD` returned success.

The local checks use this worktree, disposable NATS and PostgreSQL, and real
WebSockets. This is not a fresh installation. No paid model call is made.

## Tests before fixes

PASS: the tests were committed before the implementation changes. The rebased
test commit is `03f5cc2e`. The original failing-first run used main at `243238cf`.
Running `bridge-approvals.test.ts` against the old implementation failed six cases:
missing requests, capacity refusal, retry timing, repeated failure back-off,
quiet position checks and changed tool policies. Sixteen existing cases passed.

PASS: removing the approval poll from `watchBridges` made the new socket test
fail by timing out while waiting for the approval request to be read. Restoring
the poll made the test pass. The same test checks that only the correct computer
receives the decision and that a blocked approval read leaves another
conversation's saved reports and next turn free to continue.

The mutation removed this line from `apps/server/src/chat/bridge.ts`:

```ts
for (const link of links.values()) link.approvals.poll(head);
```

Command: `nice -n 10 npx vitest run apps/server/test/bridge-replay.test.ts -t 'wakes the right computer' --maxWorkers=2`.
Observed on 9 October: one failed test, 23 skipped; `Timed out waiting for service outcome`.
The original file was restored before the final checks.

## Final checks

| Check | Result |
| --- | --- |
| `nice -n 10 npm run lint` | PASS; zero errors, 13 warnings |
| `nice -n 10 npm run typecheck` | PASS across all workspaces |
| `npm run check:events` | PASS; 98 event types agree |
| Knip (`lint:unused` within lint) | PASS; two configuration hints |
| `npm run lint:changelog` (within lint and separately) | PASS |
| Both changed test files, first run | PASS; 46 tests, 159.27 seconds |
| Both changed test files, second run | PASS; 46 tests, 140.91 seconds |

Each test run used this command:

```sh
nice -n 10 npx vitest run apps/server/test/bridge-approvals.test.ts \
  apps/server/test/bridge-replay.test.ts --maxWorkers=2
```

Both final runs used the rebased code and tests at `d7840645`. This final record
changes documentation only. Markdown, local links and changelog checks are rerun
for the record before pushing. Hosted CI must check the final commit.

NOT RUN: the full root suite is left to hosted CI, as requested. A green CI gate
is required before landing. The held-call journey on a fresh installation and
the real proxy hold longer than five minutes remain follow-up work.
