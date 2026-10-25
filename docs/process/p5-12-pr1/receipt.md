# Memory restore preflight receipt

Date: 2026-10-25. Part of #15. Rebased base: `f85834091`.
Implementation: `ac9cdff50`; final source and clarity edits: `e740fedf9`.
Failing-first fix tests: `a62b04ae3` and `f793caef4`.
Environment: this worktree, disposable NATS and PostgreSQL 17.6-alpine, synthetic keys/facts.
These are fresh test services, not a fresh product installation.
Commands and results: [checks.txt](checks.txt).

PASS: live revisions require available keys in both folders. Matching empty,
missing or wrong keys refuse before PostgreSQL opens. Destroyed markers remain
valid for forgotten and superseded revisions and historical dependants.

PASS: all deletion, key-identity and folder/history stability checks finish before
surviving values are decrypted. A null authentication result refuses. Tests put a
live fact first and forbid decryption when a later check must refuse. They cover
missing current and next-revision markers, mismatched key identities and changed
source/target history or source/candidate folders.

PASS: the four focused recovery/key suites passed three times, with 77 cases per
run. The 438 security-rule cases passed once. The changed recovery file passed
twice more after the final clarity edits, with 26 cases per run. Repository lint,
typecheck, event catalogue, Knip and changelog checks passed. The disposable database
and its volume were removed.

PARTIAL: bounded preflight and isolated executable recovery. Two replays preserve
rows, checkpoints and markers. Alice's forgotten facts stay out of search while
Bob's separate scope remains readable. Guarded runs record no append, key mutation,
handler, token, sandbox or fetch effects. Refusals contain only fixed messages;
successful command output contains no fact canary. The frozen source verifies old
archive bytes; the stopped current source supplies deletion evidence. No keys are
imported, no destroyed text is reconstructed and no later forget receipt is invented.

NOT RUN: full P5-8, P4-13–17, company/rights recovery, computer no-disk proof,
browser qualification and a fresh product installation. No full root suite, product
stack or model calls ran. This proof does not permit reopening the installation.
No event names, dependencies, authority code or protected tests changed.
