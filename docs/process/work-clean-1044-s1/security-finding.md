# Write-route probe security finding

STOPPED under the issue's security rule. No PR opened. No access behaviour changed.

Reproducer head: `4baef3a2ede903d8b4547f8c1fa9fe439475147d`.
The final receipt commit changes only this evidence.

## Observed failure

- Route: `POST /api/conversations/:conversationId/view`.
- Probe: no session cookie, `Origin: https://app.example.test`, JSON body `{}`.
- Path parameter: 64 lowercase `a` characters, a well-formed identifier.
- Real disposable NATS event store global head: **0 before, 1 after** this request.
- The assertion failed on event-log movement. No successful HTTP access is claimed.
- Original sanitised output: [security-probe.txt](security-probe.txt).

The existing handler in `apps/server/src/computers/view.ts` records
`computer.view_refused` through its refusal helper, including for an anonymous
admission attempt. Its ordinary refusal branch returns 403. The probe stopped on
head movement; it did not print the response body or status. This existing audit
append explains the observed movement without proving that access was granted.
The owner must decide how that existing behaviour relates to the required invariant.
The handler has not been changed.

## Own checks

- PASS: clean dependency installation and the requested local tool symlinks.
- PASS: unchanged baseline, 65 tests in `server.test.ts` and
  `member-guard-http.test.ts`, before and after extraction.
- PASS: first test failure observed and committed before product changes:
  `registerRoutes is not a function`.
- PASS: 251 ordered route declarations are identical before and after extraction.
  Temporary observation hooks were removed. Full captures:
  [before](routes-before.json) and [after](routes-after.json).
- FAIL: write-route probes, on the security assertion above.
- FAIL: changed-file ESLint reports `no-unsafe-assignment` on the refusal record's
  `status` assignment. No lint fix was attempted after the security stop.
- PARTIAL: typecheck was already running when the finding appeared; it was stopped.
- NOT RUN: second probe run, remaining gates and deliberate unguarded-route mutation.
- NOT RUN: fresh-stack CORE journey. No secondary slot was claimed.
- NOT RUN: independent review; the orchestrator owns it.

The initial baseline attempt could not start the member-guard fixture because the
pinned gateway binary was absent. Fetching the existing pinned fixture tool allowed
both unchanged baseline files to pass. No assertion or product code was changed.

## Scope and remaining work

The only product change extracts the existing registration calls into
`registerRoutes` in the same file, preserving their text, order and options.
The new test reuses `sessionCookie`, `permissionStore` and a real event store;
there is no stub store. Shipped-code diff: eight added lines and one deleted line.
No shared helper, dependency or access rule was copied or replaced.

The probe run stopped before printing or completing `refusedWithOtherStatus`,
`membershipNotProbed` and `otherCredential`. Their complete results are NOT RUN;
no lists have been posted to #121. The test retains its credential classifications
for review. No release note or PR was prepared after the stop.

## Work log

1. Checked current main, open PRs, the issue and repository instructions.
2. Installed dependencies and pinned the existing tests before changing structure.
3. Committed the failing discovery test, then extracted the registration calls.
4. Compared all route declarations and ran the unchanged baseline with the probes.
5. Stopped at the first event-log movement and preserved the failing test and output.

Slice 1 of 1. Builder time below one hour; no independent review or rework round.
