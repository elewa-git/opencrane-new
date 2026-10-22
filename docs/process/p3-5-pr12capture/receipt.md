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

## Follow-up checks — 22 October 2026

Source: `aaa0205e2e0b15e635d81948251f1729cd3939c1`.
The rebase finished on `origin/main` at
`560c4fab27e085720a018c6e877b3729b933df19`; that commit is an ancestor.
This used the same existing image and digest listed above, with current source
mounted read-only. The environment was local test fixtures, not a fresh installation.

The saved check now requires exactly seven requests and one request per expected
case. It checks their methods, kinds and ids, matching replies, continuations and
turn starts. Both gateway decisions must match the native request and its thread
and turn. The two committed decision records include ids copied from their matching
saved requests. New captures record that association while each case runs.
The existing requests, replies and continuations have not been replaced.

Successful and failed capture output now goes to a mode-0600 file inside the run's
private temporary directory. Cleanup removes it. No external copy is retained.
The stale `/tmp/pr12capture.json` from earlier runs was removed. After the final
runs, that path was absent and no `native-capture-*` directory remained.

Failing-first commit: `7131a0d61`. Before the fix, deleting all requests or any one
of the seven requests still passed the assertion function. Both private-file tests
also failed at the attempted shared write, before writing any bytes there.
The full regression run had 18 expected failures, 10 passes and one skipped live
capture. The corrected checks also reject changed ids, methods, kinds, replies,
continuations and decision records.

Final changed-test command, run twice with one worker:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
CODEX_CAPTURE_IMAGE=ocn-p3-5-pr12a nice -n 10 npx vitest run \
  apps/computer/test/native-requests.test.ts \
  libs/models/test/codex-native-capture.test.ts --maxWorkers=1
```

| Check | Result | Observed result |
| --- | --- | --- |
| Changed tests, first final run | PASS | 29 tests; offline capture included |
| Changed tests, second final run | PASS | 29 tests; offline capture included |
| Capture without the image variable | PASS | 28 ordinary tests; live test skipped |
| Private output and cleanup | PASS | Both success and failure; mode 0600; files removed |
| Event catalogue | PASS | 149 event types agree |
| Knip | PASS | Two existing configuration hints |
| Changelog check | PASS | Branch fragment accepted |
| Full lint, default heap | FAIL | Node exhausted its 4 GiB heap during ESLint |
| Full lint, 6 GiB heap | PASS | All stages; zero errors, 24 warnings |
| Typecheck | PASS | All workspaces and packaging |
| Strict proof | FAIL | Exit 1; production plain-shell, escalated-shell and file-change requests absent |
| Production shell/file declines | NOT RUN | No corresponding production approval requests |
| Fresh-install qualification | NOT RUN | Local fixtures only |

The successful full lint command was
`NODE_OPTIONS=--max-old-space-size=6144 nice -n 10 npm run lint`.
No lint rule or repository setting changed.

All checks use `nice -n 10`. Each capture container uses `--network none` and local
model replies. No paid model call or full root test suite was run. Production source,
native replies, `never`, `privateConfig` and memory admission are unchanged.
The pull request stays in draft; production enablement remains blocked.
