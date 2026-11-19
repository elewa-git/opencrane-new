# Shared SHA-256 hex checks

Slice 2 of 2. Builder checks only; independent review belongs to the orchestrator.
The slice has an eight-agent-hour budget and two rework rounds. No independent
review or rework round was run by this builder.

## Compatibility

PASS: six new digest tests, twice. The first test-only commit `678f71a5b` failed
because the helper module did not exist. The tests pin the SHA-256 `abc` vector,
empty text, UTF-8 Unicode, byte arrays and subarrays, nested JSON with insertion
order, stringify failures and representative stored identifier inputs.

A native Node entrypoint test also failed before correcting a `.js` import to
`.ts`. Vitest resolved the former, but Node type stripping correctly refused it.
The [failing output](node-entrypoint-red.log) records the cause. The final native
entrypoint test passes without a bundler.

PASS: [fixed-input samples](digest-samples.json) compare the old inline hash with
four real migrated exports: provider secret references, dispatch body digests,
memory scope IDs and shortened routine references. Every old/new pair is identical.
The sample command was temporary; no extra script or test double is retained.

The existing computer runtime test also failed when the image copy list omitted
`digest.ts`; see the [regression output](computer-runtime-red.log). Added the one
missing copy, rebuilt the normal CI test image and passed the runtime test twice.
A direct network-disabled container probe loaded both the digest entrypoint and
the report module and verified the SHA-256 vector. No runtime fixture script or
test double was added.

## Import rule

PASS: a temporary source file importing `createHash` and repeating the ID pattern
failed scoped ESLint with both expected rules and no warnings. See the
[diagnostics](lint-probe.log). The scratch file was removed before final checks.
Local ESLint covers changed files only, with an 8 GB heap and zero warnings, as
required by the task's local lint scope. CI runs the complete `lint:code` command.

The base has 141 direct SHA-256 calls in 120 production files. The change replaces
136 calls and retains six calls in six files, including the new shared implementation.
Six production files retain `createHash`: the shared implementation, two raw-byte
comparisons, the OAuth base64url challenge and two multi-update hashes. Each has
one reason beside its exact path in the exception block. The Node digest module
is a separate public entrypoint and is absent from the browser-facing index.

## Make it right

Share byte/string hashing and exact JSON.stringify hashing in two small named
functions. Delete the private wrappers they replace. Keep existing local caller
names where an import alias avoids unrelated edits. Split long expressions into
named digest values. Keep existing input order, encodings, truncation, conditional
updates and error handling. Add no dependency, retry, timeout, limit exception,
event type, stored field or business rule.

## Source gates

| Check | Result |
| --- | --- |
| Typecheck: workspaces, package and dev-stack | PASS |
| Event catalogue: 174 types | PASS |
| Changed-file ESLint, 8 GB heap, zero warnings | PASS |
| Dependency rules and baseline | PASS |
| Knip | PASS; two existing configuration hints |
| Changelog | PASS |
| Markdown | PASS |
| README structure | PASS |
| Whole-stream reads and lint debt | PASS |

Every lint, typecheck and test command runs under `nice -n 10`. The full root
ESLint command and root test suite are NOT RUN under the supplied local scope.
Web source is unchanged; separate web tests and build are NOT RUN.

Shipped source: 298 added plus 563 deleted lines, 861 total. The computer
Dockerfile adds one copy instruction. Tests, documents and receipts are excluded.

## Work log

1. Fetched main and checked open PRs and the issue comments. Only slice 1 was merged.
2. Installed dependencies and linked the requested test tools.
3. Committed the failing compatibility tests, then added the Node-only entrypoint.
4. Migrated one package per commit and removed the replaced private wrappers.
5. Added the narrow import rule and proved both copy-prevention rules refuse a probe.
6. Ran source checks and each touched package's tests with niceness 10. Initial
   batches used two workers; complete resumed batches use three workers.

The first broad test attempt was interrupted after a focused failure established
that the pinned gateway binary was missing; the [focused failure](missing-test-tool.log)
records ENOENT. Fetched it through the existing pretest
script, then began fresh complete runs. No fixture or product change was needed.

## Routine fixture correction

The first valid broad batch was FAIL: 7,175 cases passed before one routine sender
case failed. The remaining files did not finish. The [batch result](routine-batch-failure.log)
is retained without treating cancelled cases as qualification.

The late payer change was never injected because the successful start publication
expired first. Commit `94e8d6f47` added a deterministic 2,100 ms publication delay
and [failed at the same injection assertion](routine-fixture-red.log). Reused the
existing scoped send-setup clock in `88e6863a0`; production deadlines are unchanged.
All eight existing late-change cases and the new regression passed. The regression
also checks that normal time resumes after the fixture operation. Extracted the
clock helpers into test support to keep the existing test-file limit unchanged.

First package pass: PASS for every runnable file in the [file manifest](test-files.json).
Retained 204 completed files from the original batch and 32 from the first remainder.
The final remainder passed 301 files and skipped six: 5,421 cases passed and 67 were
skipped. Together these batches cover all 543 selected files. Vitest starts an
isolated worker for each file. Cancelled cases do not count as PASS. Existing
opt-in skips remain NOT RUN.

The first remainder batch was also FAIL: 921 cases passed before the actor-clock
fixture expected an exact `2000` ms sleep but received `2000.000000000001` ms.
The process timestamp had a fractional millisecond. Commit `cb4c10661` pinned that
input and [failed at the same exact assertion](fractional-clock-red.log). The fix
starts this manual fixture at a whole millisecond and keeps the exact assertion.
All 19 access-clock cases passed twice. Production clock precision and deadlines
are unchanged.

The next remainder retains only files whose complete assertion lists passed.
It reruns the actor-clock file, the cancelled routine-session file, and every
unstarted file. No cancelled or skipped assertion is counted as PASS. The final
full selection uses the same default conditions and three workers under niceness 10.

## Second selection and quiet qualification

The second complete selection is FAIL: 535 files passed, two failed and six were
skipped. It ran all 543 files: 13,054 cases passed, two failed and 69 were skipped.
The [failure traces](second-batch-failures.log) remain part of the evidence.
The [skipped cases by file](skipped-tests.json) are NOT RUN under their existing
conditions; none is counted as PASS.

The long-chat WebSocket check took 1,615.55 ms against its unchanged 1,500 ms
limit. Load measured after the failure was 14.88. The other failure was in the
routine-session `beforeEach`: root allocation refused before the intended saved
prohibition test ran. Load measured after that failure was 7.42. No production
deadline, performance assertion or test code was changed for these failures.
The two complete files then passed alone with one worker: 454 cases, zero failures
and zero skips. The [starting sample](quiet-test-gate.json) records five continuous
minutes below load six, both secondary slots free and no package stack up.
The long-chat timings were history 161 ms, list 139 ms and WebSocket readiness
1,033 ms. The [quiet result](quiet-tests.log) retains these measurements.

Every runnable selected file has now passed twice across the isolated batches.
The second pass covers 13,056 passing cases and 69 NOT RUN conditions. The original
failed selections remain FAIL; isolated qualification does not erase their results.
Both files ran once in this controlled qualification. No assertion, deadline or
test code changed, and the loaded failures are retained above.
