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

When an old object omitted correlation, the unchanged event schema supplied
`{}` during append validation. The helper supplies that same value earlier;
append still stores the parsed event returned by `validateCommand`.

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

## Queued native-budget check

An initial broad run failed: the queued-revocation case in
`libs/models/test/native-budget.test.ts` reached its existing 30-second test limit.
The isolated case then passed. That pass does not prove the original cause.

Two coordination waits observed only a signal, leaving an early work rejection
unobserved while waiting for that signal. Race each signal against its work so
an early refusal reaches the test with its error. Keep every test and product
time limit unchanged. The exact early error in the original timeout is NOT PROVED.

After this diagnostic correction, the whole file passed twice: 46 tests each,
in 157.49 and 128.21 seconds. Models typecheck and changed-file ESLint passed.
The failed broad attempt is retained separately and does not count as a passing
gate. The complete twice-run package gate remains pending.

## Package gate attempts

The first broad attempt stopped after the native-budget timeout above. A later
attempt failed the long-chat read performance check: 1,940 ms against its
unchanged 1,500 ms limit. An isolated rerun also failed a socket timing check
at 2,525 ms. Host load was elevated during these runs; that observation does
not prove the cause. No access code or performance limit was changed.

A bulk attempt excluding those two timing-sensitive files failed the saved-reload
case in `mcp-dispatch.test.ts` while starting the catalogue replay command.
The original child-process failure remains NOT PROVED. A diagnostic rerun first
hit its existing test limit, and a later isolated rerun passed. Its non-zero
conversations replay check was an expected refusal, not the original catalogue
failure. Temporary diagnostics were removed without changing the replay helper.
None of these stopped or failed attempts counts as a passing package gate.

The first serial two-file run passed all 115 tests in 688.64 seconds. The second
passed 114 tests and failed the socket readiness assertion at 1,876 ms against
1,500 ms while another secondary stack was active. Native-budget passed in both.
Do not count the failed group as a passing package run.

After that stack stopped, a temporary event-loop diagnostic passed the isolated
case: history 251 ms, list 103 ms, socket readiness 1,185 ms, maximum event-loop
delay 67 ms. This does not prove the cause of the earlier failure. The first
instrumentation attempt was invalid because its histogram was out of scope;
correct it before collecting these measurements. Remove all instrumentation
and restore the original test before the complete file rerun.

The restored, unchanged chat-access file then failed socket readiness again at
1,583 ms; stop that attempt instead of counting its remaining cases as a gate.
For comparison, temporarily restore all migrated server and models callers to
the base revision, verify that source diff is empty, and run the isolated case
with the same limits. It passed at 1,088 ms for socket readiness (history 203 ms,
list 104 ms). Restore the slice and the unchanged test immediately afterwards.
Both isolated versions pass; the original full-file cause remains NOT PROVED.

A new broad attempt after `npm ci` reported 221 passing and one failing case in
`mcp-dispatch.test.ts`: the stored-credential header refusal. It was stopped
after that file because the package gate had already failed. The exact case
passed in isolation, then all 222 cases in the file passed together with one
worker. The broad failure's cause remains NOT PROVED; neither a timeout nor a
product rule was changed. The stopped attempt is not a passing package gate.

The complete `libs/event-store/test` and `apps/ops/test` scope passed twice with
two workers: 60 files and 846 tests passed per run, with three files and 65
optional tests skipped per run. Durations were 657.70 and 643.72 seconds. The
skipped conditions remain NOT RUN.

A later two-worker `libs/models/test` attempt reported two failures before it was
stopped: the decision-cost check received an unavailable decision audit, and
the numeric-credential reply check received a refusal instead of the expected
safe reply. Each exact case passed in isolation. The earlier complete
`mcp-dispatch.test.ts` run also passed its numeric-credential case. The reason
for either broad-run failure remains NOT PROVED. No deadline or refusal rule
was changed, and the stopped attempt is not a passing models package gate.

Nine focused server files covering chat, members, memory, integrations, files,
egress, routines and managed models passed twice: 546 tests per run, in 842.45
and 873.09 seconds. This is direct coverage of migrated callers. It does not
replace the complete `apps/server/test` package gate.

Run the two timing-sensitive files serially and the other 423 files with at most
two workers, twice each. Use the shared disposable test database and run all
commands under `nice -n 10`. Keep every existing wait and timeout unchanged.

## Source checks

| Check | Result |
| --- | --- |
| Workspace, package and dev-stack typecheck | PASS |
| Event catalogue | PASS: 174 event types |
| Knip | PASS: two existing configuration hints |
| ESLint on changed code, zero warnings, 8 GiB heap | PASS |
| Dependency boundaries | PASS: existing baseline unchanged |
| Lint debt, whole-stream reads and README checks | PASS |
| Changelog fragment | PASS |
| Markdownlint, without file arguments | PASS |
| Fixed-id and fixed-time envelope comparisons | PASS: seven samples |

Run tests, typecheck and lint under `nice -n 10`. The changed-file ESLint check
uses the `lint:code` configuration; the complete repository ESLint run belongs
to CI. No web source changed, so web tests and the web build are NOT RUN locally.
The helper and registration test files passed twice together: 57 tests per run.
The native-budget file also passed twice separately: 46 tests per run.

The final source checks after `npm ci` passed: full workspace, package and
dev-stack typecheck; event catalogue; knip; dependency boundaries; changelog;
changed-code ESLint with the 8 GiB heap and zero warnings; whole-stream reads;
markdownlint; and all seven fixed-id and fixed-time envelope comparisons.
The twice-run event-store and ops scope passed as recorded above. The complete
models package gate failed in a two-worker attempt, and the complete server
package gate was not run twice. The overall touched-package test gate is PARTIAL.

## Make it right

Share server source, UUID, current ISO time and empty correlation defaults in
one helper. Remove those repeated fields and unused UUID imports from callers.
Keep local principal, command id, correlation and fixed-time decisions with their
existing owners. Keep the existing models envelope validator for its callers.
No new dependency, error handler, access rule or append-result check is added.
The new helper takes one named object and remains below every size limit.
Reuse the installed Zod UUID validator in both new tests, removing the copied pattern.

Shipped code: 309 added plus 263 deleted lines, 572 total. The root lint
configuration adds 21 lines and removes six lines outside that shipped-code count.
