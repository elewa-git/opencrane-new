# Governed personal remember: rework evidence

Date: 10 October 2026. Source: `3d29b997` plus the documentation in this receipt.
Environment: Linux, Node 22.23.3, this development worktree. This is not a fresh silo.
The tests use real disposable NATS, PostgreSQL, OpenFGA and agentgateway services.
`PG_TEST_URL` was set for both final memory runs. Credentials are omitted from this receipt.
All checks ran under `nice -n 10`. No full root suite ran.

## Scope

An agent can save facts only in its requester's person scope. A group or assistant-notes
write returns `agent_person_scope_only`, including with valid shared recall references and
write grants. The command also refuses another person's scope. Shared-only execution and
shared agent writes are deferred to a later PR after #94. No part of that execution is built here.

## Failing-first checks

The new tests were committed in `40078fa4` before their fixes in `e5f69401`.
The shared-scope reason tests and decoded-proof-limit test failed first. The command test
also showed that another person's scope did not get the explicit agent refusal reason.
Tests of existing guards passed without production changes.

A same-length HMAC forgery changes one byte of a valid 32-byte keyed hash. The MCP test
asserts refusal, no memory append and an unchanged scope position. In a separate run,
removing HMAC equality made the new unit test fail. The original check was restored.
The mutation log is `/tmp/pr319-hmac-mutation.log`.

The existing model-registry test fixture made dialog methods read-only. Its regression
was committed in `7e5c848a` and failed before the fixture fix in `d007a19a`.
The change lets each overlay test replace its own methods. Browser behaviour is unchanged.

## Final results

| Check | Result | Evidence |
| --- | --- | --- |
| Full lint, including Knip and changelog | PASS | `/tmp/pr319-lint-green.log` |
| Typecheck, all workspaces and affected packages after lint fixes | PASS | `/tmp/pr319-typecheck-final.log`, `/tmp/pr319-ts-fix2.log` |
| Event catalogue, 99 types | PASS | `/tmp/pr319-events.log` |
| Seven-file memory set, PostgreSQL configured | PASS: 271 tests twice | `/tmp/pr319-targeted-green-1.log`, `/tmp/pr319-targeted-green-2.log` |
| Final changed memory files after lint fixes | PASS: 99 tests twice | `/tmp/pr319-changed-final-1.log`, `/tmp/pr319-changed-final-2.log` |
| Web build | PASS, existing warnings | `/tmp/pr319-web-build.log` |
| Web tests with one worker | PASS: 589 tests | `/tmp/pr319-web-tests-final.log` |
| Browser captures | PASS: 24 captures | `/tmp/pr319-captures/visual.json` |

The seven-file memory set covers MCP writes, signed recall proofs, access checks, capability
claims, human commands, recovery, worker replay and native tool exclusion. Negative tests
isolate proof bindings and bounds, unavailable references, dependency scope and revision,
saved assistant and grant records, turn identity and conversation closure. Preparation
races prove that key loss or a closed turn refuses the write and removes its temporary record.
Recovery tests cover saved replies, prepared crashes, definite failures and older records
without a principal kind.

The browser captures use the existing chat fixture and the production web build. They cover
private and memory-free choices, recovery and lost output at 1280, 390 and 320 pixels, with
normal and reduced motion. They do not qualify native memory or new memory screens.
Captures and their JSON receipt are in `/tmp/pr319-captures/`.

Initial parallel runs under host load had timeout failures. The first completed lint run
also found a complexity limit and unsafe test assertions. The guard was split into a
small named function, and the test fixtures now use full types and verified claims. The full lint attempt was
stopped to reduce load. Final checks above come from sequential reruns. The web runner
used a temporary configuration containing only `maxWorkers: 1`; deadlines were unchanged.
Build warnings about existing stylesheet budgets and the noVNC CommonJS import remain.

## Remaining qualification

Fresh-install remember and recall, backend network isolation, stale content-generation
rejection and native memory: **NOT RUN**. The draft awaits the orchestrator's next review.
