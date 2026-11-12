# Builder

Source: OpenCrane 1 `.claude/commands/execute-plan.md`, commit `468742b97`. The three
steps follow Robert C. Martin's [ub-mode](https://github.com/unclebob/ub-mode) (MIT),
as fitted in the [standard](../standards.md#engineering-discipline-make-it-work-then-make-it-right).

Implement one listed slice of a ready ticket, with explicit acceptance criteria and settled decisions.
Read [AGENTS.md](../../../AGENTS.md), the [standard](../standards.md), the relevant
plan section and changed contracts. Do not preload the whole architecture history.
Resolve missing product decisions with the owner; do not hide them behind an interface.

## First make it work

1. Inspect the actual package graph, entrypoints and tests. Reuse the existing owner
   of a responsibility; avoid speculative packages and duplicate paths. Search for an
   existing schema, digest, comparison, envelope, guard or test builder before writing
   one. If you need the same decision a second time, move it to a shared home first
   (the standard names the homes). Code that only looks alike stays separate.
2. Name the data shapes before the logic. Parse outside data once, where it enters.
   Write the failing test first and see it fail for the reason you expect. If you are
   fixing a failure, reproduce it with a failing test and fix the cause; do not hide
   it behind a guard, retry, longer timeout or sleep.
3. Implement the smallest coherent change: build only what is needed, written as verbose,
   clear code that follows the code style in AGENTS.md (atomic named functions, no
   chaining or inline logic). Keep event-only truth, replayable
   projections, typed TypeScript business rules, integer cents and secret references.
   Check licences before introducing dependencies. Remove replaced reachable behaviour.
   For a new feature, make one real path work from start to finish, access checks
   and refusals included, before you build stopping, cleanup or recovery for it.
4. Test the acceptance claim, including refused operations and meaningful failure
   cases. Use disposable real dependencies when the claim crosses a service boundary.

## Then make it right

1. Clean the code you added or changed before anyone reviews it, against each row of
   the "Then make it right" table in the standard. Old code you touch must not get
   worse; fix an old breach only when the fix is small and inside the ticket's files.
   Run `nice -n 10 npx eslint` on the files you changed and fix every warning in a
   function you added or changed: `npm run lint` does not fail on warnings. `dryer`,
   `crapper` and `mutator` are not installed; do not install or run them until the
   standard says they are enabled. To restructure, pin the behaviour with tests,
   change the structure, then show nothing changed.
2. Update the affected README, event catalogue, API contract or ADR in the same change.
   Edit the sentences that are now wrong; do not append a note about this change.
   Run the four required commands and the separate web build/tests where required.
3. Supply the actual diff, acceptance criteria, changed contracts and evidence to an
   independent adversarial reviewer using a different model. Fix substantiated blockers.
4. The second and final pass checks fixes, new risks and batched disputes. Hold remaining
   blockers for the owner. Never reset the pass count by renaming the work. If two fixes
   that rest on the same assumption fail the same check, or a fix fails this second
   pass, stop: write that assumption in one sentence and take it to the owner. Name
   earlier PRs for the same issue in the evidence.

## Practice

When coordinating several builders, assign independent files in separate worktrees
with their own installed dependencies. Share contract decisions before parallel work.
One integrator lands changes serially and checks the combined result on `main`.
Use one PR per slice, with stacks at most two deep. A slice lets a person do one more
thing from start to finish on a fresh dev stack. Aim for about 800 changed lines of
shipped code per slice; tests and documents are not counted. Explain a larger slice first.

Report changed behaviour, tests, durations, risks and explicit remaining live work,
with a short log of what you did and why.
Source ready is not capability done: completion requires a live fresh-install journey.
Use PASS, FAIL, PARTIAL or NOT RUN; a skipped condition never passes.
Commit in small ordered steps and only within the caller's authorisation: emoji plus
a plain sentence, without co-author lines or AI attribution.
Release a dev stack you claimed when your journeys finish. Never remove the worktree
you run in: review, the gates and the push still need it.
