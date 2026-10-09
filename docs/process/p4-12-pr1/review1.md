# Memory storage review fixes

8 October 2026. Tests run on the local Linux/Node 22 development worktree; no fresh installation.
Original implementation after rebase: `a083c450`.
Rebase onto `origin/main` completed and its ancestry check passed before these changes.

## Tests committed before fixes

Each entry names a test committed separately. A mutation changes one existing guard,
runs that test and restores the source before committing. Expected failures below
prove that the test detects the missing behaviour; they are not passing source checks.

- **a memory subject must match its scope**. Mutation: `libs/events/src/memory.ts`, replace `` !identity.success || event.subject !== `scope-${data.scopeId}` `` with `!identity.success`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "a memory subject must match its scope"`.

- **memory dependencies stay in their scope**. Mutation: `libs/events/src/memory.ts`, replace `if (entry.scopeId !== data.scopeId)` with `if (false)`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory dependencies stay in their scope"`.

- **memory event ids use the allowed format**. Mutation: `libs/events/src/memory.ts`, replace `!identifier.safeParse(value).success` with `false`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory event ids use the allowed format"`.

- **memory command ids use the allowed format**. Mutation: `libs/events/src/memory.ts`, replace `!identifier.safeParse(value).success` with `false`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory command ids use the allowed format"`.

- **memory principal ids use the allowed format**. Mutation: `libs/events/src/memory.ts`, replace `!identifier.safeParse(value).success` with `false`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory principal ids use the allowed format"`.

- **memory events require a principal**. Mutation: `libs/events/src/memory.ts`, replace `!identifier.safeParse(value).success` with `false`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory events require a principal"`.

- **memory ciphertext cannot exceed 5500 characters**. Mutation: `libs/events/src/memory.ts`, replace `.max(5500)` with `.max(5504)`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory ciphertext cannot exceed 5500 characters"`.

- **decrypt refuses a different key id**. Mutation: `libs/projections/src/memory-keys.ts`, replace ``if (value.keyId !== `key:${reference(identity)}`)`` with `if (false)`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "decrypt refuses a different key id"`.

- **a damaged key file stops provision**. Mutation: `libs/projections/src/memory-keys.ts`, replace `if (bytes.length !== 32)` with `if (false)`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "a damaged key file stops provision"`.

- **decrypt refuses a flipped ciphertext bit**. Mutation: `libs/projections/src/memory-keys.ts`, replace `decipher.final()` with `Buffer.alloc(0)`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "decrypt refuses a flipped ciphertext bit"`.

- **decrypt refuses a flipped tag bit**. Mutation: `libs/projections/src/memory-keys.ts`, replace `decipher.final()` with `Buffer.alloc(0)`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "decrypt refuses a flipped tag bit"`.

- **changing only scopeKind refuses key operations**. Mutation: `libs/projections/src/memory-keys.ts`, replace `if (checked.scopeId !== memoryScopeId(checked.silo, checked.scopeKind, checked.ownerId))` with `if (false)`. Observed: FAIL at the refusal assertion, as expected.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "changing only scopeKind refuses key operations"`.

- **a never provisioned key is a store error**. Original source: expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "a never provisioned key is a store error"`.

- **a key store with the wrong mode is refused**. Original source: expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "a key store with the wrong mode is refused"`.

- **provision never creates a missing key store**. Original source: expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "provision never creates a missing key store"`.

- **an opened key store cannot recreate a lost volume**. Original source: expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "an opened key store cannot recreate a lost volume"`.

- **append refuses wrongly derived memory scopes**. Original source: expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "append refuses wrongly derived memory scopes"`.

- **decrypt checks the encrypted byte limits**. Original source: expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "decrypt checks the encrypted byte limits"`.

## What the failures showed

The mutated event checks accepted invalid input. Removing key checks allowed a
wrong key id, a damaged key file or altered ciphertext/tag to pass. Removing the
scope derivation check allowed a change of scope kind alone. Each test failed at
its refusal assertion, rather than during fixture setup. The source was restored
before its test commit.

The original implementation returned null for a never-provisioned key and accepted
a store with mode 0755. Provision created a missing directory, including after an
opened store lost its directory. The NATS append test stored Bob's ownership in
Alice's scope instead of rejecting it. The byte-size test reached authentication
instead of rejecting the encrypted length. All six failed before the fix.

## Final checks

8 October 2026. Source: `2553af887543b232a50397729f2bab83b3c6c075`.
Environment: local Linux development worktree, Node 22.23.3, disposable TLS/NATS
fixtures. No fresh installation. The two test runs were sequential.

| Result | Command or condition | Observed result |
| --- | --- | --- |
| PASS | Rebase onto `origin/main`, then `git merge-base --is-ancestor origin/main HEAD` | Completed; main is an ancestor. |
| PASS | `nice -n 10 npm run lint` | No errors; 12 existing function-length warnings. Includes dependency, docs, links, fixtures, changelog and unused-code checks. |
| PASS | `nice -n 10 npm run typecheck` | All workspace type checks passed. |
| PASS | `nice -n 10 npm run check:events` | 98 event types match the catalogue. |
| PASS | `nice -n 10 npx knip` | No unused-code findings; two configuration hints. |
| PASS | Changed tests, first run | 10 files, 668 tests; 51.79 seconds. |
| PASS | Changed tests, second run | 10 files, 668 tests; 53.37 seconds. |
| NOT RUN | Full root test suite | Excluded by the task. |
| NOT RUN | Memory projection, PostgreSQL rebuild/index equality and rollback | PR 1b adds these. |
| NOT RUN | Second independent review and hosted CI for this revision | Required before landing. |
| NOT RUN | Fresh-install memory journey, power-loss and customer key-store/backup/snapshot recovery | Still needs live qualification. |

Both changed-test runs used:

```sh
nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts libs/events/test libs/event-store/test/append.test.ts --maxWorkers=2
```

The draft lands together with PR 1b. It must not land on its own. The command PR
must reconcile unused revision keys and temporary key files after confirming the
original append outcome. Deletion removes live file names; it does not claim to
shred bytes in free blocks, journals or snapshots.
