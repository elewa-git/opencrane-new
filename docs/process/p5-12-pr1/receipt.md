# Memory restore preflight receipt

Date: 2026-10-25. Part of #15. Base: `891d9d6b7` (event restore #711).
Failing-first commit: `6d7a23746`. Implementation source: this receipt's commit.
Environment: this worktree, disposable NATS and PostgreSQL 17.6-alpine, synthetic keys/facts.
The test-only run failed all 11 cases because the executable was absent.
Final commands and results: [checks.txt](checks.txt).

PARTIAL: bounded preflight and an isolated executable recovery test. Refused custody
never opens PostgreSQL. Two replays preserve rows/checkpoints/markers, keep erased
search data absent and another scope readable, and count zero guarded effects.
The frozen source verifies old archive bytes; the stopped current source supplies
deletion evidence. No keys are imported or deleted material reconstructed. Later
forget events are not invented; restored old records remain unavailable.

NOT RUN: full P5-8, P4-13–17, company/rights recovery and computer no-disk proof.
Browser qualification is separate and NOT RUN. No stack, model, browser or fresh
product install ran. This proof does not permit reopening the installation.
No event/API names, dependencies, authority code or protected tests changed.
