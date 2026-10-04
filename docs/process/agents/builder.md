# Builder

Source: OpenCrane 1 `.claude/commands/execute-plan.md`, commit `468742b97`.

Implement one ready outcome with explicit acceptance criteria and settled decisions.
Read [AGENTS.md](../../../AGENTS.md), the [standard](../standards.md), the relevant
plan section and changed contracts. Do not preload the whole architecture history.
Resolve missing product decisions with the owner; do not hide them behind an interface.

1. Inspect the actual package graph, entrypoints and tests. Reuse the existing owner
   of a responsibility; avoid speculative packages and duplicate paths.
2. Implement the smallest coherent change: build only what is needed, written as verbose,
   clear code that follows the code style in AGENTS.md (atomic named functions, no
   chaining or inline logic). Keep event-only truth, replayable
   projections, typed TypeScript business rules, integer cents and secret references.
   Check licences before introducing dependencies. Remove replaced reachable behaviour.
3. Test the acceptance claim, including refused operations and meaningful failure
   cases. Use disposable real dependencies when the claim crosses a service boundary.
4. Update the affected README, event catalogue, API contract or ADR in the same change.
   Run the four required commands and the separate web build/tests where required.
5. Supply the actual diff, acceptance criteria, changed contracts and evidence to an
   independent adversarial reviewer using a different model. Fix substantiated blockers.
6. The second and final pass checks fixes, new risks and batched disputes. Hold remaining
   blockers for the owner. Never reset the pass count by renaming the work.

When coordinating several builders, assign independent files in separate worktrees
with their own installed dependencies. Share contract decisions before parallel work.
One integrator lands changes serially and checks the combined result on `main`.
Until the Phase 2 prototype is testable, use coherent squashed changes directly on
`main`; afterwards use one PR per outcome, with stacks at most two deep.
Aim for about 1,500 non-generated added/deleted lines per change; explain an exception.

Report changed behaviour, tests, durations, risks and explicit remaining live work.
Source ready is not capability done: completion requires a live fresh-install journey.
Use PASS, FAIL, PARTIAL or NOT RUN; a skipped condition never passes.
Commit only within the caller's authorisation: emoji plus a plain sentence,
without co-author lines or AI attribution.
