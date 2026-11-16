# Manual clean-code probe

Date: 16 November 2026. Base: `9e7579b504d702b0318ac9a93c006d8992789523`.
Implementation head: `ab137b6b3cfa0cf4c0bf7018a7d987252f5b3c4b`.
Measurements ran on that base plus this branch's tool and coverage changes.
Linux x86-64, Node 22, Python 3.12; every measured command ran under `nice -n 10`.

## Result

PASS: **3 of 3 tools worked** on `libs/events`. No fallback was needed or built.
No product source, npm check, CI job, baseline or runtime image changed.

Exact repeatable commands and reviewed licences are in
[the standard](../standards.md#manual-clean-code-probe). Each command below uses
`XDG_CACHE_HOME="$PWD/.tools/clean-code/cache"` and runs from the repository root.

| Command (after `nice -n 10`) | Observed output | Seconds |
| --- | --- | --- |
| `npx vitest run libs/events --maxWorkers=2` | 35 files, 1,234 tests passed; coverage off | 13.645 |
| `npx vitest run libs/events --maxWorkers=2 --coverage --coverage.reporter=lcov --coverage.reporter=text --coverage.include='libs/events/src/**'` | Same 1,234 tests passed; statements 82.82%, branches 65.2%, functions 79.2%, lines 83.91% | 16.773 |
| `.tools/clean-code/venv/bin/crapper --use-existing-coverage libs/events` | 109 TypeScript functions found; `checkedToolRevision`: CC 14, coverage 0%, CRAP 210.0; `permitsUnrunChecks`: CC 5, coverage 50%, CRAP 8.1 | 1.627 |
| `.tools/clean-code/venv/bin/dryer --threshold 0.8 libs/events` | Seven duplicate candidates; first pair shown below | 0.461 |
| `.tools/clean-code/venv/bin/dryer --threshold 0.8 apps/*/src libs/*/src` | 573 duplicate candidates | 240.727 |
| `.tools/clean-code/venv/bin/mutator --use-existing-coverage --mutate-all --max-workers 2 --verbose --test-command 'npx vitest run libs/events/test/provider-turn-validation.test.ts --maxWorkers=2' libs/events/src/turn-binding.ts` | Baseline passed; three killed, zero survived, zero uncovered; score 100% | 41.557 |

The CRAP run used the first parser download. The full duplication scan is about
four minutes on this host; these timings are observations, not performance promises.
The [benchmark log](../benchmarks.jsonl) records commands, elapsed wall time and exit codes.

## One function and one pair checked by hand

`libs/events/src/hosted-image.ts:33`, `permitsUnrunChecks`, has base complexity 1,
one `for`, two `if` statements and one `||`: **CC = 5**. Its LCOV branch records
are `37/0/0 = 0`, `37/0/1 = 8`, `38/1/0 = 0`, `38/1/1 = 8`,
`40/2/0 = 2`, `40/2/1 = 0`: **3 of 6 branches hit, coverage = 0.5**.
All its executable lines were hit; crapper correctly uses branch coverage here.

```text
Hand: 5² × (1 − 0.5)³ + 5 = 25 × 0.125 + 5 = 8.125
Crapper .metrics/crap.edn: :complexity 5, :coverage 50.0, :crap 8.125
Crapper console: permitsUnrunChecks hosted-image 5 50.0% 8.1
```

Dryer's first pair is structurally the same seven writer checks: event type,
subject, source, missing report, command id, human principal kind and principal id.
The event-type literals and final member field differ. Dryer deliberately normalises
those names and literals, so both fingerprint sets are identical and their Jaccard
similarity is **1.00**. Its output agrees:

```text
DUPLICATE score=1.00
  libs/events/src/child-activation.ts:20-26
  libs/events/src/child-request.ts:30-36
```

This is a candidate for review, not proof that these distinct rules should be shared.

## Mutation proof and installation checks

PASS: Mutator replaced each of the three `===` tokens on line 13 of
`libs/events/src/turn-binding.ts` with `!==`, in private worker copies.
The real source remained byte-identical to the base. A second run retained JSON
test reports to distinguish assertion failures from runner or compilation errors:

```sh
nice -n 10 .tools/clean-code/venv/bin/mutator --use-existing-coverage \
  --mutate-all --max-workers 2 --verbose \
  --test-command 'npx vitest run libs/events/test/provider-turn-validation.test.ts --maxWorkers=2 --reporter=json --outputFile=.tools/clean-code/evidence/mutator-tests-$$.json' \
  libs/events/src/turn-binding.ts
```

PASS in **50.178 seconds**: baseline eight passed, zero failed. Each of the three
mutants had four passed and four failed assertions, including rejection of incomplete
provider choices. Mutator reported three killed and zero survived again.
No product file was edited, and no replacement runner was built.

PASS: A disposable copy of the fetch script changed the first hex digit of crapper's
pinned checksum. It exited 1 with `crapper.tar.gz: FAILED` before extraction, even
with an existing installation. The unmodified script then installed all three tools;
`pip check` reported no broken requirements. The checksum probe was removed.

PASS: Clean `npm ci` ran in this worktree. NATS and Lychee use the requested local
symlinks. Tool licences were read at each pinned commit before installation;
Python wheel licence files and the installed coverage provider's MIT licence were read.
Only the final five pinned Python requirements are needed. An initial dependency
inspection found that language-pack 0.10.0 lacks the upstream tools' `download` API;
the final pin is 1.25.2. This was corrected before running the tools.

## Scope and remaining qualification

PASS: No changed lines under `apps/*/src` or `libs/*/src`. No new tool references
under `infra`, `apps` or `libs`; no package lists the Python tools. The unchanged
`check:package-licences` passed. Coverage remains opt-in, and Knip recognises the provider.

Full root suite, full root ESLint and separate web tests: NOT RUN by request.
The focused events tests passed unchanged, with and without coverage.
The fresh core journey and final gates are recorded in [journey.md](journey.md).
No independent-review result is claimed here.
