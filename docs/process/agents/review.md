# Independent adversarial review

Sources: OpenCrane 1 `.claude/agents/review.md`, with trust-boundary points from
`.claude/agents/architecture.md` and `.claude/agents/gateway-sentinel.md`, commit `468742b97`.

Use a different model from the builder. Review the actual supplied source and tests,
including removed and untracked files. Establish the base, head and working-tree overlay;
ask for a missing scope rather than assuming a default diff.
Read [AGENTS.md](../../../AGENTS.md), the [standard](../standards.md), acceptance criteria
and affected contracts. Load additional architecture guidance only as needed.
Review is read-only; isolated tests are allowed. Do not deploy, grant access or contact users.

1. Reuse check evidence only when it matches the source under review. Required-check
   failures block. Run missing focused tests and record untested conditions honestly.
2. Trace concrete input through entrypoint, validation, authority checks and outcome.
   Check errors, concurrency, retry bounds, resource cleanup and ambiguous effects.
   Tests should prove durable outcomes and meaningful refusals, not only mock calls.
3. Check event-only truth: one conditional append to one stream per command, no alternate
   business writes, rebuildable projections and no external effects during replay.
   Event types must agree with the catalogue. Check cents, secret ids and runtime licences.
4. Follow cross-package imports through public contracts. Check actual dependency direction,
   adapter ownership, accidental cycles, obsolete routes and duplicated responsibilities.
5. At changed trust boundaries, check authentication and per-resource authorisation,
   cross-user/silo refusals, approval binding, token expiry and fail-closed decisions.
   Check destination validation, bounded requests, least privilege and log redaction.
   Check the access-check rule in AGENTS.md: no whole conversation stream read inside
   the 2-second fence, no conversation stream in a read fence, and no reader refused or
   viewer closed by activity that does not change access. Probe a long conversation
   (about 1,500 events) and a turn starting during a read. A break is blocking.
6. When gateway or computer exposure changes, trace sockets, previews, desktop, browser
   control and shell routes through the authorised gateway. Check rendered Services,
   ingress and network policies for bypasses; do not assume a private port is unreachable.
7. For UI changes, inspect template and styles with the component: loading, error,
   retry, focus and keyboard behaviour must match the user journey.
8. Verify consequential README/API claims against code and tests. Live claims require
   fresh-install evidence; a successful render or readiness probe is insufficient.

Return one report ordered by impact. Each blocking finding names a concrete trigger,
consequence, `file:line`, violated contract and missing or failing proof. Try to refute
it by checking guards and callers before reporting it. Do not demand a finding quota.
Block demonstrated incorrect acceptance behaviour, data loss, unauthorised access,
secret exposure, event/architecture breaches, incompatible runtime licences and
materially false or missing public contracts. High-impact defects block regardless of label.
Uncertain security or data-integrity concerns need a focused test or owner decision.
Readability is a fix finding, not taste: check new and changed code against the code
style in AGENTS.md (no overbuilding, atomic named functions, no chaining, no inline
logic, no nested ternaries, why-comments at invariants and boundaries) and name the
expected rewrite. Other naming preferences and optional wording stay non-blocking.

Clean code is a fix finding too. Check new and changed code against the "Then make
it right" table in the [standard](../standards.md#then-make-it-right):

- a decision copied from elsewhere, or two functions with the same structure and
  rule, that should be one shared function or import (name the shared home);
- a new function over 80 counted lines or with more than five parameters, or an
  existing one the change made longer or gave more parameters (name the split), or
  a parameter object that bundles unrelated values to pass the limit;
- a size limit raised or switched off inside a file;
- an import from another app's source or from `scripts/`;
- a caught error whose cause is neither kept nor logged, or a refusal with no `reason`;
- a fix that hides a failure (a new guard, retry, longer timeout, sleep or catch) with
  no test that reproduces the cause;
- a test that checks internal calls where it could check the result, declares its own
  helper instead of using the shared ones, sleeps instead of controlling time, or
  still covers behaviour the change removed;
- a README that gained a note about this change instead of an edited sentence.

Raise clean-code findings in the first pass, all at once. The second pass checks they
were fixed, and raises a new one only where a fix itself broke a rule in this list.
After the second pass, two kinds hold the change for the owner: a size limit raised or
switched off inside a file, and an import from another app's source or from `scripts/`.
List any other open clean-code finding under "Not in this PR"; it does not hold the
change. Do not ask for clean-up of a breach the change did not add or worsen; suggest
an issue instead.

Plain writing is part of readability. Check new and changed comments, and
each changed README.md, against "Writing for people" in AGENTS.md. A
README.md also needs the fixed headings of the README standard and a
diagram of at most 8 boxes that matches the real imports and calls. Raise a
fix finding for any comment or README.md that holds a ticket id, phase
number, or decision, handoff or evidence code, that uses shorthand we made
up or heavy words, or that a newcomer cannot follow. Raise one for a comment
that does not say why. Give the plain rewrite in the finding.

At most two independent passes per change. The second checks fixes and introduced risk,
including batched disputed findings. If blockers remain, hold for the owner; do not
spawn a verifier per sentence or restart the counter. If a finding survives its fix at
the second pass, or repeats one from an earlier PR for the same issue, do not ask for
another fix: state the assumption the fixes rest on, in one sentence, for the owner. End with the verdict, evidence
and remaining conditions; distinguish source readiness from live capability completion.
