# Saved-thread native capture

20 October 2026. Part of #46. Capture only; PR 12b remains blocked.
Source: `af466e87a84b9eae164a478341c98b15b97aa16f`.
Codex: `0.159.2`; model metadata: `gpt-6.1-sol`; gateway: `v1.5.0`.
Reused image: `ocn-p3-5-pr12a`,
`sha256:61d515b0696116ab5a5106c3deb9940565cd7d4c77f787bd5983040077ec0d33`.
Gateway binary checksum is checked by the existing gateway fixture.
The source and test folders are mounted read-only over the existing image.
The container uses `--network none`. A Unix socket reaches only the disposable
gateway fixture. NATS, PostgreSQL and OpenFGA are normal test fixtures.
No paid model, dev stack or fresh product installation was used.

[Trimmed capture](../../../apps/computer/test/fixtures/codex-0.159.2-saved-thread.json)
keeps exact native requests, replies, continuations, RPCs and separate action markers.
It omits repeated history, tool descriptions, credentials and generated types.

| Condition | Result | Observation |
| --- | --- | --- |
| Production plain shell, escalated shell, shell write and patch execution | PASS | Each separate marker exists; no approval request |
| Production shell/file declines | NOT RUN | No emitted request; generated types cannot qualify these |
| MCP refusal | PASS | Actual request, one unsupported reply, same-turn continuation |
| Loaded saved thread; turn/start on-request | PASS | MCP consent emitted after loaded resume |
| Unloaded/reloaded saved thread; turn/start on-request | PASS | Unload confirmed; same thread emits consent |
| Fixture-only non-persistent accept, both saved-thread cases | PASS | Real proxy and gateway Ask; requester command rejects; upstream count stays zero |
| Fixture-only read-only sandbox, native host disabled: escalated shell and patch | PASS | Actual approval, one decline, rejected continuation, each marker absent |
| Same sandbox fixture: plain shell and shell write declines | NOT RUN | No approval; bubblewrap cannot create a namespace |
| Private tools-off/never | PASS | Native host disabled; marker absent |
| Private live request refusal, permissions and user-input replies | NOT RUN | No corresponding live request |
| Production enablement and fresh-install qualification | NOT RUN | Production policy and memory admission unchanged |

The fixture re-delivers actual requests locally to the production reply module.
This is a duplicate-delivery check, not a second live request. Unit checks replay
the captured declines and check canary absence in safe reports, journals, events
and output, including no-turn and private refusal cases.

Capture command (throwaway PostgreSQL was ready on port 51610):

```sh
PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:51610/postgres \
CODEX_CAPTURE_IMAGE=ocn-p3-5-pr12a nice -n 10 npx vitest run \
  libs/models/test/codex-native-capture.test.ts --maxWorkers=1
nice -n 10 node apps/computer/test/codex-on-request-proof.mjs
```

Failing-first commit: `0193876ed`. The strict command failed against the old
fixture and still exits 1 for the three absent production shell/file approvals.
This is a qualification FAIL, not a passing source check.
Own checks: PASS for lint (including Knip), typecheck, check:events and lint:changelog,
all under `nice -n 10`. Selected tests passed twice, 39 per run: this live capture,
computer native-requests/tool-reports and server tool-reports. Security rules passed
once, 438 tests, with the requested port 55432 URL. No full root suite was run.
The throwaway database and its volume were removed.
