# Server event construction checks

## Scope

Slice 1 of #1049, part of the clean-code map #1031. Replace the 76 server event
wrappers with `serverEvent`; keep append-result checks for slice 2.
Base: `f316313f0265e5678c49fc1dcf2c03cbcc3d17d2`.

## Test first

Commit `0ab236cab` added four tests before the helper existed. All four failed
with `TypeError: serverEvent is not a function`. The helper then passed all four.
They cover UUID and ISO time defaults, empty correlation, absent optional fields,
each supplied optional field, fixed id and time, and append-owned validation.

## Field equivalence

PASS: extract each old envelope expression from the base and its replacement
from the working tree using the TypeScript parser. Evaluate both with the same
fixture values, a fixed UUID (`fixed-event-id`) and fixed date
(`2026-11-19T16:00:00.000Z`). Load the real helper into that same controlled clock
and UUID context. Compare structured clones with `assert.deepStrictEqual`.
No serialised-text comparisons are used.

Run the [comparison script](compare-envelopes.mjs) from the repository root:

```sh
node --experimental-strip-types docs/process/work-clean-1049-s1/compare-envelopes.mjs
```

For registration, use the real, unchanged models builder with its optional date
argument fixed. It still validates the fixture before the later overrides.
The routine samples compare the returned expressions with the same supplied id.
Their existing tests cover the occurrence-based id derivations.

| Replaced expression | Result |
| --- | --- |
| `apps/server/src/integrations/registration.ts` | PASS: every field identical |
| `apps/server/src/egress/changes.ts` | PASS: every field identical |
| `libs/models/src/providers.ts` | PASS: every field identical |
| `apps/ops/src/routine-due.ts` | PASS: every field identical |
| `apps/ops/src/routine-skip.ts` | PASS: every field identical |
| `apps/ops/src/routine-missed.ts` | PASS: every field identical |
| `apps/server/src/chat/child-activation.ts` | PASS: every field identical |

The final sample also includes a saved request correlation and report field.
Both survive the saved-event comparison. The routine samples pass their id and
stored time explicitly; their id derivations outside these expressions are unchanged.
`budget-migration.ts` is unchanged, including its `models` source and validation.

## Lint refusal

A temporary production file under `apps/server/src` contained these probes:

```ts
export const forbidden = { source: 'opencrane-server' };
export const quoted = { 'source': 'opencrane-server' };
```

Run changed-file ESLint with the same production configuration used by
`lint:code`, with `NODE_OPTIONS=--max-old-space-size=8192` and `nice -n 10`.
The probe is removed after checking the refusal.

Expected refusal, exit 1:

```text
1:28 error Use serverEvent from @opencrane/event-store to build server events no-restricted-syntax
2:25 error Use serverEvent from @opencrane/event-store to build server events no-restricted-syntax
2 problems (2 errors, 0 warnings)
```

## Migration audit

Compare the parsed old envelope properties and new helper inputs at all 76 sites.
Only the fixed server source and direct default expressions may disappear; every
other field and spread stays in order with the same expression. A default must
stay explicit when it overrides a spread.

This audit caught the random UUID override in remote registration. Commit
`ceaf94aa2` added a regression test that failed because the event id equalled the
shared command reference. Restore the explicit UUID override, then check the test
and all-site audit again. Remote registration also joins the field-equivalence
sample above. No other explicit default overrides a spread.

## Preparation correction

The first package test attempt failed because the gateway fixture binary was absent.
A focused rerun reproduced `ENOENT` in `startGateway` before any tested behaviour.
Run the repository's checksum-verified gateway fetch script, then restart both
package runs. No test wait or timeout was changed.

## Make it right

Share server source, UUID, current ISO time and empty correlation defaults in
one helper. Remove those repeated fields and unused UUID imports from callers.
Keep local principal, command id, correlation and fixed-time decisions with their
existing owners. Keep the existing models envelope validator for its callers.
No new dependency, error handler, access rule or append-result check is added.
The new helper takes one named object and remains below every size limit.

Shipped code: 309 added plus 263 deleted lines, 572 total. The root lint
configuration adds 21 lines and removes six lines outside that shipped-code count.
