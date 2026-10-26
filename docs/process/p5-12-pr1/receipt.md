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

## No-decryption test coverage

Date: 2026-10-26. Test source: `903c0765f`. Rebased base: `955cfedca`.
Environment: this worktree with fresh disposable NATS and PostgreSQL 17.6-alpine,
synthetic facts and temporary key folders. This is not a fresh product installation.

PASS: all four strengthened cases detect a removed live-key status check. The
matching-empty and matching-missing cases forbid decryption. Two further cases
put a healthy fact before the fact with an empty or missing key in both folders.
With the temporary mutation, each case records one forbidden decryption attempt
and fails its zero-effects assertion. The production file was then restored.
The matching-wrong-key case stays separate because authentication needs decryption.
Only test behaviour changed; no product defect was exposed.

PASS: memory restore, memory keys, memory replay and event restore passed three
consecutive runs, with 79 tests per run, one worker and `nice -n 10`.
The changed recovery file ran in each pass. The disposable PostgreSQL container
and its volume were removed. Event catalogue and changelog checks passed.

PASS: the final changed memory-restore file passed twice more, with 28 tests per
run, after replacing an unused test constant with an explicit parameter type.
The second disposable PostgreSQL container and its volume were removed.

PASS: typecheck and every lint component. Full lint first found an unused test
constant, then a missing blank line between README sections combined during rebase.
Both are corrected. ESLint, dependency checks and Knip passed on the final tests.
After the blank-line correction, documentation, README, links, fixture, licence and
changelog checks passed. The full lint command stopped at that documentation error;
its passing earlier components were retained and all later components were run.
No production TypeScript changed in this follow-up.

NOT RUN: full root suite, product stack, browser and fresh-install qualification.
CI is not awaited after push.
