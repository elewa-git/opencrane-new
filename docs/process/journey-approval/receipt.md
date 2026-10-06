# Fresh-install approval journey

Date: 6 October 2026. Base source:
`8573afc90b75da9f4e33af097a87395e68bb2c16` from `origin/main`.
The changed journey is on `work/journey-approval`. Each new run records its
start and finish in UTC. The source hashes identify the journey file used.

The runs use secondary stack 1, claimed once for this worktree. Each
`infra/dev-stack/up.sh --fresh` removes that stack's local data and provisions
it again. Real Zitadel sessions open Chromium at 390px and 1280px. The model
and approval tool use the local stub. No paid model call is made.

## Cause and fix

The approval journey changed with the new chat cards in merge `9e20336`.
It waited for **Approved by you** followed by **not used yet**, with a
lower-case **n**. The new card displays **Not used yet**. The journey's
case-sensitive pattern could therefore never match a successful approval.

The saved first run timed out after Approve at 390px. Its
[server log](first-run/server.log) shows a 200 response to the approval POST.
Its [browser error](first-run/last-error.log) names the decision wait in
`approval-journey.ts`. This evidence was read before claiming a new stack.

The new failing run confirms the cause. Its
[browser snapshot](reproduced-browser/approval-failure-390.txt) contains
`Approved by you Update order note Not used yet`. The
[screenshot](reproduced-browser/approval-failure-390.png) shows the approved
card while the journey reports `Approval journey timeout`. The
[server log](reproduced-browser/server.log) records the successful approval
POST and subsequent status reads. The
[last-error log](reproduced-browser/last-error.log) records the failing wait.
These files were copied before another fresh start or teardown.

Both affected selectors now match **Not used yet**. The checks remain
case-sensitive. The journey also saves failed approval screenshots and
accessible card text before cleanup closes the test turn. Accessible text
contains the names that screen readers use for the card and its buttons.
No product or approval API change was needed. The direct evidence made a
git bisect unnecessary.

The journey still checks approval persistence, denial, unchanged tool request
bytes, exactly one upstream call, refusal of a second use and the recorded
permission decision. It also checks that all four card states survive reload
and that the requested card fits both viewport widths.

## Runs

| Run | Result | Observation |
| --- | --- | --- |
| Saved first run | FAIL | Timed out after Approve at 390px despite a 200 response. |
| First new start | FAIL | Startup could not lower the web process's nice level from 19 to 10. |
| New browser reproduction | FAIL | Approved card visible; lower-case selector timed out at 390px. |
| First corrected fresh run | PASS | Exit 0; both viewport journeys passed. |
| Second corrected fresh run | PASS | Exit 0; both viewport journeys passed again on the same claim. |

The [first passing log](pass-1/up-fresh.log) records one approval submission and
one denial submission at each width. Its approval screenshots show the
[390px approved card](pass-1/approved-390.png) and
[1280px approved card](pass-1/approved-1280.png). Requested, used and denied
screenshots are stored beside them.

The [second passing log](pass-2/up-fresh.log) records the same submission counts.
Its [390px approved card](pass-2/approved-390.png) and
[1280px approved card](pass-2/approved-1280.png) are from a separate fresh install.
Both runs use journey SHA-256
`62365fff383e926b13e453a8e8a684c4d2a4988e7d02767c49c01b940d338d6b`.

| Passing run | Started UTC | Finished UTC | Duration |
| --- | --- | --- | --- |
| First | 15:16:39 | 15:25:07 | 8 minutes 28 seconds |
| Second | 15:26:23 | 15:35:00 | 8 minutes 37 seconds |

Both commands exited zero in a row on the same slot. The full journey also
passed chat, uploads, live view, budgets, action history, replay and sign-out
checks. An EXIT trap calls `infra/dev-stack/down.sh --id 1` after the evidence
is copied. Teardown completed and removed the selected stack's directory.
The owner stack was not touched.

The task process already had nice level 10. Adding `nice -n 10` to its stack
runner produced level 19. Startup then failed when it tried to set the web
process to level 10. The [startup error](reproduced/failure.log) was retained.
The runner's inherited priority was corrected so each stack start ran at
level 10. The same stack claim was retained.

The daily ledger reports earlier `up.sh --fresh` failures without error logs.
Their individual causes cannot be established from that ledger alone.

## Checks

- PASS: `nice -n 10 npm ci`.
- PASS: [lint](checks/lint.log), [workspace typecheck](checks/typecheck.log),
  [dev-stack typecheck](checks/infra-typecheck.log) and
  [event catalogue check](checks/events.log).
- PASS: [nine dev-stack unit tests](checks/tests.log), run after teardown.
  They check stack claims and isolated sign-in setup.
- PASS: [documentation lint](checks/docs.log) and [link checks](checks/links.log).
- PARTIAL: the first dev-stack unit test attempt collided with the live
  stack's reserved port and was stopped. Its
  [output](checks/tests-occupied-port.log) was retained. The final run above
  completed with nine passes and no failures.
- NOT RUN: the full root suite and separate Angular unit tests. Only the
  journey and its failure capture changed; product code is unchanged.
- NOT RUN: hosted CI and an external tool's final outcome. The journey
  qualifies approval and admission to the local recording tool.
