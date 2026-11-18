# Review fixes and checks

Slice 2 of 2, fix round 1. Original reviewed head: `457c34759`.
Fetched `origin` and completed the rebase onto `cdb8b80bf` without conflicts.
That main change updates the root diagram only. Product extraction commit:
`49489f977bbb2b2755b8cec93ce787ac62487833`. Final source commit:
`59163c442bb03a1975aa23096eeb3500c69e9092`.

These are the builder's own checks. No independent review result is claimed.

## Findings and refusal proofs

| Finding | Fix and observed result |
| --- | --- |
| 1: late relay success | Give proof readings and watchdog sleeps separate manual clocks. Release the held successful reply after proof expiry, without delivering the watchdog. Deleting the late-success guard fails with zero refusal records instead of one: [PASS](review-round-1/relay-guard.txt). Restore the guard. |
| 2: final dispatch expiry | Save admission first, then advance time in the final route check after the preceding awaits. At 1,999 ms the call sends once; at 2,000 ms it returns 403 with zero sends. Deleting the monotonic condition returns 200: [PASS](review-round-1/dispatch-guard.txt). Restore the condition. |
| 3: fixture isolation | Give each default NATS fixture its own real-time clock object; its command and reader stores still share that selected clock. The original two-fixture test [fails](review-round-1/fixture-red.txt) because the second control replaces the first reading. The fixed test checks advances, the system adapter and restoration independently. |
| 4: approval readings | Request a real saved approval, start its decision with 2,000 ms remaining, then advance the manual clock during the awaited authority check. Assert the saved second event is `approval.decided` at 1,999 ms and `approval.expired` at 2,000 ms. Reverting the [start read](review-round-1/approval-start-read.txt) or [end read](review-round-1/approval-end-read.txt) fails its saved-event assertion. Deleting the [expiry guard](review-round-1/approval-guard.txt) also fails the expiry case. Restore all three probes. |
| 5: size and clarity | Move dispatch start and refusal evidence to `mcp-dispatch-receipts.ts`; extract egress directory checking. Name the memory preparation flag and clock options. Reuse the identical memory claims already prepared by the decision handler. Remove the obsolete egress function-size suppression and one dispatch parameter suppression. |

Test commits precede the fixture fix and production extraction. Proof-only findings
1, 2 and 4 need no production rule change. No existing assertion is removed or
loosened. The existing real-time approval decision-race test remains.

The size finding is a static rule breach, reproduced with ESLint's existing size
rules and an empty temporary suppression list. No extra size-test implementation
is added. The [before](review-round-1/size-before.txt) and
[after](review-round-1/size-after.txt) probes also set the file threshold to zero
only on the command line to report exact counts; no repository limit is raised.

| ESLint counted size | Before extraction | After extraction |
| --- | ---: | ---: |
| `startEgress` | 82 | 71 |
| `mcpDispatch` | 317 | 251 |
| `mcp-dispatch.ts` | 585 | 516 |
| `startDecision` | 292 | 290 |
| Decision request callback | 273 | 271 |
| New receipt module | — | 87 |

The existing dispatch function and file remain above the normal limits and shrink.
Every new function meets the normal limits. These are ESLint's counts in the
rebased tree, rather than the review's separate line-count method.

## Behaviour and journey

The [focused baseline](review-round-1/extraction-before.txt) and
[post-extraction run](review-round-1/extraction-after.txt) both pass **31 tests**.
They cover receipt recovery and refusal, joined retry batches, shutdown timers,
start-before-send ordering, failed start writes, unknown remote outcomes and
lost or changed evidence. The 195 filtered cases are NOT RUN by these focused
runs; they are not counted as passes.

The extraction preserves event payloads and ids, append conditions, awaited check
order, outcome handling, logging content and deadline arithmetic. The additional
clock-object change is test-only. No production access, money, memory, deadline
length or send rule changes. No dependency or event field is added.

The existing [fresh CORE PASS](journey.md) at 1280 px and 390 px remains the product
journey evidence for this behaviour-preserving change. **New live run: NOT RUN**;
no secondary stack is claimed. Live approval qualification remains **NOT RUN**.

## Earlier gate failures

An [initial typecheck](review-round-1/earlier-typecheck-failure.txt) rejected a
property read on the append command's `unknown` event. The test now calls the
shared `parseEventByType` parser before inspecting the event type.

An [earlier repeat](review-round-1/earlier-gateway-failure.txt) had 77 passes and
one failure in the existing gateway approval generation case. Its initial
response began `authentication` and could not be parsed as approval JSON. That
failure occurred before an approval id was available. Its cause is **NOT PROVED**;
no transport fix is claimed. The final repeats run serially, without another
test batch, and both pass all 78 tests. The test now asserts the status with the response
text before parsing, so another failure keeps the actual refusal diagnostic.
The [isolated diagnostic run](review-round-1/gateway-diagnostic.txt) passed that
case and both final-dispatch cases. No timeout or retry was added.

## Gates

| Gate | Result |
| --- | --- |
| Four changed test files, twice on the final code | [PASS: 78 tests, 109.26 s](review-round-1/changed-tests-first.txt) and [PASS: 78 tests, 121.03 s](review-round-1/changed-tests-second.txt) |
| Focused extraction tests before and after | PASS: 31 each; filtered cases NOT RUN |
| Decision clock and complete memory dispatch test files | [PASS: 100 tests](review-round-1/decision-memory.txt) |
| Workspace, package and dev-stack typecheck | [PASS](review-round-1/typecheck.txt) |
| Scoped `lint:code`, all 123 PR-changed code files | [PASS](review-round-1/eslint-pr.txt), 8 GB heap, zero warnings |
| Final edited test files after parsing and diagnostic cleanup | [PASS](review-round-1/eslint-changed-tests.txt), 8 GB heap, zero warnings |
| Final named memory options | [PASS: models typecheck](review-round-1/models-typecheck.txt) and [ESLint](review-round-1/eslint-memory-options.txt); the alias is erased at runtime |
| Event catalogue | [PASS: 174 types](review-round-1/events.txt) |
| Knip | [PASS](review-round-1/knip.txt); two existing configuration hints |
| Changelog | [PASS](review-round-1/changelog.txt) |
| Lint debt | [PASS](review-round-1/lint-debt.txt) |
| Whole-stream reads | [PASS](review-round-1/whole-stream-reads.txt): 310 known, 5 rebuild |
| Folder README contracts | [PASS](review-round-1/readmes.txt) |
| Markdownlint, no file arguments | [PASS](review-round-1/markdown.txt), all Markdown inputs |
| Public privacy and secret scan | [PASS](review-round-1/privacy.txt) and [PASS](review-round-1/secret-scan.txt), complete PR range |

Run every test and compiler under `nice -n 10`. Changed test repeats use one
worker and the shared disposable PostgreSQL database through `PG_TEST_URL`.
The focused extraction and memory checks use at most two workers. No full root
suite, fleet batch or live journey is started.

Apply `lint:code`'s `eslint --max-warnings 0` check only to the
[123 changed code files](review-round-1/eslint-files.txt), following the supplied
local scope restriction. Set `NODE_OPTIONS=--max-old-space-size=8192`.
Recheck the two test files and the memory options after their last edit.
The unrestricted `npm run lint:code` script is NOT RUN because local lint is
limited to changed files; the scoped check uses the same rules and warning gate.

Shipped code: **839 added plus deleted lines**. The requested extraction moves
existing code, so its deletion and addition are both counted. The slice stays
within its two listed slices; no third PR or new dependency is introduced.
