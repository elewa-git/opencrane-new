# Long-conversation decisions: final fix round

Date: 20 November 2026 UTC. Branch: `work/bug-1148-s1`.
Builder's own checks only. The PR remains a draft.

Live qualification: FAIL. Rebased-source live qualification: NOT RUN.
Finding 4 remains blocking. No independent review result is claimed.

## Scope and retained findings

This is fix round three of three, under the owner's option A and twelve-agent-hour
limit. The task began at 22:44 UTC on 19 November, with 7.3 hours already recorded.
The four-hour reporting boundary is 02:44 UTC on 20 November.

| Finding | Work in this round |
| --- | --- |
| 1 — incomplete index | Retained the contiguous prefix, independent conversation coverage and saved-event checks. Missing Stop, terminal-turn and close facts still refuse. |
| 2 — offline replay | Retained shared index creation, old-install upgrade and repeated replay coverage. The stopped-reader upgrade instruction remains in the release note. |
| 3 — bounded lag and cost | Retained the 64-position limit and original decision deadlines. The many-models 503 remains unexplained; its assertions and deadlines were not changed. No new fix for it was started. |
| 4 — live journey | Reproduced the seed failure, bounded the fixture's event burst through a failing test, then attempted fresh qualification again. The complete browser outcome remains unqualified. |
| 5 — whole-stream reads | Retained the owning-module fallback and its baseline accounting. No product whole-stream read was added. |
| 6 — guard coverage | Retained the isolated creation, ownership, turn and source-id cases. Rebase compatibility changes retain their assertions. |
| 7 — reply batching | Retained shared inclusion and individual-versus-batched index comparison. Updated only its synthetic prose to match main's event schema. |

The earlier source fixes and their original red-test and mutation evidence remain in
[round one](rework1.md) and [round two](rework2.md).

## Seed diagnosis and test-first change

The first fresh attempt used `c14be241976200720b30bbd83eb8a0edf518dcd6`.
CORE passed at both widths. The first batch then failed with expected checkpoint
556 and observed checkpoint 516, at the unchanged thirty-second limit.

The retained worker log shows all fifty messages and fifty completion events being
processed successfully. Conversation creation completed at 00:01:20.562 UTC; the
last seed completion finished at 00:01:55.960. The probe observed checkpoint 556
by 00:02:00.552. The projection was progressing while the hundred-record burst
outlasted the fixture's wait. No handler failure explained a permanent stall.

Commit `60124fdd5` extracted the existing seeder without changing its batch size and
added a real-NATS regression. It failed with: “Seed at most 20 event records before
observing projection progress; received 100”. Commit `8e5056f7a` changed each burst
to ten messages and their ten completion events. The regression also requires all
6,000 records and observation of the final completion. Both final test repeats passed.
The rebase rewrote these commits as `6493a70a9` and `706b350e9`.

The seeder still uses conditional event appends. No projection state is written by
the live seeder. Each checkpoint wait retains thirty seconds; the launcher retains
its twenty-minute limit. No retry, extra sleep, catch or longer deadline was added.

## Fresh attempts and remaining proof

The [journey receipt](journey.md) records all three actual startups and the
[availability observations](availability-round3.csv). Every startup used a fresh
secondary claim after both slots were free, no package stack was running, and load
had stayed below six for five minutes. Earlier final preflight refusals did not
start services. Logs and screenshots were retained before every teardown.
Every used slot ultimately reported free.

The first rerun at `8e5056f7a` failed in CORE: the desktop uploaded-text reply
appeared but never reached Done within the existing 120-second assertion.
The [failure capture](core-upload-failure-1280.png) shows the failed partial reply.
Its cause remains unproved. No assertion or deadline was changed.

The final fresh attempt at the same source passed CORE at 390 and 1280 pixels,
then progressed through the smaller seed batches. The launcher stopped after about
twenty minutes during setup. The output-file interval was 00:49:22.448–01:09:32.518;
its saved error contains only the failed child command. The elapsed time is
consistent with the configured launcher deadline. No individual checkpoint assertion
was reported in that run.

At 01:10:16 the projection held 2,461 messages and 2,460 completions. Both checkpoints
settled at 5,380. The interrupted final message had no completion. This is incomplete
setup, not a qualified 3,000-message history. The demo recorder contained zero effects.
Discovery, browser approval, tool result, single use, reload and post-Stop refusal
were NOT RUN. Paid calls: zero.

The [five-second checkpoint trace](seed-checkpoints-round3.csv) records continued
progress. PostgreSQL's configured CPU quota was 50,000 microseconds per 100,000.
Across 849 scheduling periods it used 42,429,433 microseconds and was throttled in
848 periods. NATS used 36,103,039 microseconds across 848 periods and was throttled
in 308. These measurements establish a resource constraint during this seed.
Resource limits were not changed. They do not establish the cause of the separate
many-models 503, which remains unexplained.

No further stack attempt or source optimisation was started after this failure.
The original availability deadline was 00:44:57 UTC; the final claim preceded it.

## Rebase compatibility

Main moved during qualification. Fetched origin and completed the rebase onto
`c791103b365ced8fd56195ded9d0dcfabf202597`.
Main now stores conversation prose and approval reviews in plaintext fields and
supports read-only restored installations. Conflict resolution retains both the
bounded readers and deferred invalidation in read-only mode.

The committed fixture and replay regressions first failed for the old encrypted
synthetic payloads: three failures, eight passes. The initial typecheck also reported
the obsolete fixture key and missing `utterance`. Updated the synthetic payloads
and live seed to main's existing schema. No access, money, memory, count or response
assertion was loosened. The first corrected group passed all 26 cases.

Qualification of the rebased source remains NOT RUN. The earlier CORE and seed
observations above name the source actually tested.

## Own gates

| Check | Result |
| --- | --- |
| Changed regressions after rebase | PASS twice: 26 cases each; the second group also passed two read-only restore cases |
| Full approval and provider files | PASS: 142 passed, one existing real-provider skip |
| Full typecheck | PASS after the schema compatibility correction |
| Events | PASS, 174 types |
| Knip | PASS, two existing configuration hints |
| Changelog and whole-stream baseline | PASS; 308 known reads and five rebuild reads |
| Configured changed-file ESLint and typed journey drivers | PASS; one stale parameter-count suppression removed |
| TLS launcher, claim guard and recorder tests | PASS, eight cases; recorder passed twice again after its declaration cleanup |
| Markdown | PASS; repeated after the final receipt edit |
| Public privacy and secret scan | PASS on the staged receipt; repeated against the committed branch before pushing |
| Rebased-source live journey, local full root suite, paid qualification and independent review pass two | NOT RUN |

An extra typed-lint run over normally ignored infrastructure reported 33 errors:
32 pre-existing errors in untouched parts of `journey.ts` and `stack.ts`, plus one
unmarked promise in the recorder test declaration. Marked that declaration with
`void` and ran its unchanged test twice. The changed drivers pass typed lint.
The configured application/library checks pass. No rule was disabled and no
suppression was added for the remaining legacy infrastructure errors.

Reused the existing event-pair builder and extracted only the seeding responsibility.
The new helper has small named functions and no new dependency. Both development
stack READMEs describe batch pacing. No size limit, event field-name rule, access,
money or memory check was relaxed.
