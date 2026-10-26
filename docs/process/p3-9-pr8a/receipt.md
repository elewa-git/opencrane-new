# Private OAuth attempt preparation

Part of #50. Date: 26 October 2026. Branch: `work/p3-9-pr8a`.
Base: `7fb730399`. The first commit, `2c31bc83d`, contains the failing test.
Implementation checked: `7eaccc6efb325d96c1eb76ba8a5b385fde12d9bf`.

This is the first part of the requested consent start, split to stay near 600 changed
lines. It prepares private PKCE material and checks its exact recovery. It does not
record a consent start or return a consent URL. No account is activated or selected.

## Environment and method

Existing development worktree, not a fresh installation. `npm ci` and the requested
NATS and Lychee symlinks prepared the worktree. Tests use disposable NATS, PostgreSQL
and local HTTP custody fixtures. PostgreSQL uses image `postgres:17.6-alpine`, a random
loopback port and `PG_TEST_URL`. Every check runs under `nice -n 10` with one test worker.
No development stack, provider, model call or host-network change was used.
The throwaway database and its volume were removed after testing.

## Own checks

- PASS: failing-first test could not load the unbuilt OAuth preparation module.
- PASS: the scope case failed before support for dotted tool names was added.
- PASS: full workspace, package and dev-stack typechecking; models checked again after fixes.
- PASS: full lint, including Knip, licence, documentation, link and changelog checks.
- PASS: 632 tests across custody, bearer commands and the unchanged security-rule suite.
- PASS: all 153 custody tests twice after the lint fixes, including 29 OAuth cases.
- PASS: catalogue agreement for all 154 event types, the 31 preparation field names
  against the unchanged risky-name matcher, and whitespace checks.

Initial lint found two errors in the custody changes. Both were fixed before the final
lint and repeated custody tests. [Command results](checks.txt) record the final checks.

Expected results: retries recover one private attempt without extending its expiry;
changed bindings, missing or replaced custody and unsafe URLs refuse; ambiguous
creation remains unknown; cleanup retains current bearer material and OAuth attempts.
Only enabled reviewed tools add scopes. State and verifier stay out of results and journals.

## Remaining work

PARTIAL: the requested internal consent start. Its conditional event append, strict
schema/registry/catalogue, current membership/admin-block/policy checks before append
and receipt, and approved consent URL return must be built together next. No new event
or public API contract is declared early. Metadata routes and memory assembly are unchanged.

NOT RUN: fresh-install/live consent, Kubernetes encryption and restore, provider
reachability, callback, confirmation, refresh, OAuth revoke, credential release and
account selection. Full root suite: NOT RUN, as requested. CI: NOT RUN locally;
the orchestrator follows the draft PR after push.
