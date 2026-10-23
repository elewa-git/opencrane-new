# Offline native child ancestry

23 October 2026. Part of #93. Capture only; wiring and enablement remain blocked.
Base: `9d99207f2`, including merged retry recovery #531. No production file changed.

[Saved capture](capture.json) records Codex 0.159.2 with its bundled `gpt-6.1-sol`
metadata. The fixture uses two concurrent roots and two descendant levels.
It reuses `ocn-p3-5-pr12a`, with current source and tests mounted read-only.
Docker networking is disabled. All model replies are deterministic and local.
No paid model, second stack or fresh product installation was used.

| Condition | Result | Observation |
| --- | --- | --- |
| Early local ancestry, both depths and concurrent parents | PASS | Four `subAgentActivity` starts and `thread/read.parentThreadId` replies precede first calls |
| Child first call before spawn-completion notification | FAIL | Not reproduced; all four completion notifications arrived first |
| Stable identity unique to each model call | FAIL | Separate calls within each turn repeat every observed candidate identity |
| Exact transport retry after a lost reply | PASS | Grandchild calls 39/50 and 40/49 have identical bytes and candidate identities |
| Authenticated bridge ancestry and call identity | NOT RUN | Local stdio observations do not prove production delivery |
| Reused/foreign threads, generation changes, ended roots, malformed ancestry | PASS | Synthetic acceptance tests only; no live admission claim |
| Fresh-install delegation | NOT RUN | Admission, signing, routing and multi-agent settings remain unchanged |

The native activity item carries the spawn id, sender, receiver and parent turn.
Its `item/completed` notification describes the activity item; a later activity
with `kind: completed` reports the child's completion. They are separate facts.
First-depth start/read/call orders are 11/14/25 and 13/18/23. Second-depth orders
are 27/31/39 and 28/33/40. Spawn-completion orders are 12, 16, 29 and 30.
All four read replies followed spawn completion, so complete ancestry before
spawn completion is also unproven. The required overtaking race remains unproven; parent continuations
cannot substitute for spawn-completion notifications. The fixture never delays or invents native notifications.

`x-client-request-id` and `thread-id` identify a thread. `session-id` identifies
its root. Turn metadata stays the same across separate calls in that turn.
Neither `x-request-id` nor `idempotency-key` was present. The HTTP parent field
and model-visible output cannot authenticate ancestry. The capture's `id-N`
values are anonymous equality labels, not proposed production call identifiers.
Raw values, prompts, replies and credential canaries are never written to the capture.
Only the labelled offline fixture enables multi-agent execution and one HTTP retry.

## Reproduction

From the worktree root, after `npm ci`:

```sh
nice -n 10 docker run --rm --network none -e OFFLINE_ANCESTRY_FIXTURE=1 \
  -v "$PWD/apps/computer/test:/app/test:ro" \
  -v "$PWD/apps/computer/src:/app/src:ro" --entrypoint nice ocn-p3-5-pr12a \
  -n 10 node --experimental-strip-types /app/test/codex-native-ancestry.mjs
nice -n 10 npx vitest run apps/computer/test/native-ancestry.test.ts --maxWorkers=1
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  nice -n 10 npx vitest run libs/events/test/security-rules.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=6144 nice -n 10 npm run lint
nice -n 10 npm run typecheck
nice -n 10 npm run check:events
nice -n 10 npm run lint:changelog
```

Image SHA-256: `61d515b0696116ab5a5106c3deb9940565cd7d4c77f787bd5983040077ec0d33`.
Fixture source SHA-256: `fdaf868c1c1c3944c98ab93cc7029889a569606a7f907a1ba55345d1d016be5a`.
Production config SHA-256: `f161d5ec719042f7e3c3ad522f5cadce8a8eda3074065249444d1c911e896b5c`.
Capture SHA-256: `a76bbe6bcdeedd38aba8a32cbc6198eddc09db39646cac511ff7d5e66b698f6e`.

Tests-first commit: `a684321cc`. Its initial run failed because the checker was
absent. After adding it, two additional behavioural tests failed because unknown
item kinds and completed-child activities were accepted; both now refuse.
The synthetic tests reject model ancestry, caller fields, generated types and late
completed spawns. They establish checker behaviour only. Early setup attempts with
wrong tool arguments were discarded and are not native qualification evidence.

Own source checks: PASS — 25 changed tests twice; 438 security tests once;
full lint (including Knip), typecheck, check:events and lint:changelog.
Lint passed with a 6 GiB heap after the first run was interrupted during ESLint.
Full root suite: NOT RUN.
