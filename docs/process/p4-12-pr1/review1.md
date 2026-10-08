# Memory storage review fixes

8 October 2026. Tests run in the development worktree; no fresh installation.
Rebase onto `origin/main` completed and its ancestry check passed before these changes.

## Tests committed before fixes

Each entry names a test committed separately. A mutation changes one existing guard,
runs that test and restores the source before committing. Expected failures below
prove that the test detects the missing behaviour; they are not passing source checks.

- **a memory subject must match its scope**. Mutation: `libs/events/src/memory.ts`, replace `!identity.success || event.subject !== `scope-${data.scopeId}`` with `!identity.success`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "a memory subject must match its scope"`.

- **memory dependencies stay in their scope**. Mutation: `libs/events/src/memory.ts`, replace `if (entry.scopeId !== data.scopeId)` with `if (false)`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory dependencies stay in their scope"`.

- **memory event ids use the allowed format**. Mutation: `libs/events/src/memory.ts`, replace `!identifier.safeParse(value).success` with `false`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory event ids use the allowed format"`.

- **memory command ids use the allowed format**. Mutation: `libs/events/src/memory.ts`, replace `!identifier.safeParse(value).success` with `false`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory command ids use the allowed format"`.

- **memory principal ids use the allowed format**. Mutation: `libs/events/src/memory.ts`, replace `!identifier.safeParse(value).success` with `false`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory principal ids use the allowed format"`.

- **memory events require a principal**. Mutation: `libs/events/src/memory.ts`, replace `!identifier.safeParse(value).success` with `false`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory events require a principal"`.

- **memory ciphertext cannot exceed 5500 characters**. Mutation: `libs/events/src/memory.ts`, replace `.max(5500)` with `.max(5504)`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "memory ciphertext cannot exceed 5500 characters"`.

- **decrypt refuses a different key id**. Mutation: `libs/projections/src/memory-keys.ts`, replace `if (value.keyId !== `key:${reference(identity)}`)` with `if (false)`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "decrypt refuses a different key id"`.

- **a damaged key file stops provision**. Mutation: `libs/projections/src/memory-keys.ts`, replace `if (bytes.length !== 32)` with `if (false)`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "a damaged key file stops provision"`.

- **decrypt refuses a flipped ciphertext bit**. Mutation: `libs/projections/src/memory-keys.ts`, replace `decipher.final()` with `Buffer.alloc(0)`. Expected assertion failure.
  Run: `nice -n 10 npx vitest run libs/projections/test/memory-keys.test.ts --maxWorkers=1 -t "decrypt refuses a flipped ciphertext bit"`.
