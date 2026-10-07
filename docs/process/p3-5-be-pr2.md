# Codex tool request checks

This change covers only PR 2 of [the governed tools work](https://github.com/elewa-git/opencrane-new/issues/46).
It starts from `da1d25be919b11d64fa7e091df5cf9425f0c6eee` on `origin/main`.
PR 250 was confirmed merged at that commit before the branch was created.

## Captures

The [tool request fixture](../../libs/models/test/fixtures/codex-0.159.2-tools-call.json)
comes from the saved Codex 0.159.2 traffic. The bearer presence marker was removed.
The [full model follow-up](../../libs/models/test/fixtures/codex-0.159.2-follow-up.json)
was captured with local model and tool stubs in a disposable computer container.
The container used `--network none` and reported `codex-cli 0.159.2`.
Its image id was `sha256:5cfe0d46972df36f2a2b3d2a6b09b78c10944ba8f6233b687a9501ed1dc58e1c`.
The model test changes only the probe model name and adds the required output cap.
The saved fixture keeps the full request, including its instructions and tool definitions.
No paid model was called and neither fixture holds a credential.

## Tests that failed before the change

| Behaviour | Observed failure |
| --- | --- |
| Captured MCP call admitted | Main returned 403 instead of 200 |
| Old top-level metadata refused | Main returned 200 instead of 403 |
| Request thread checked against the signed turn | After accepting the wire shape, a different thread returned 200 |
| Nested Codex thread checked too | A different nested thread returned 200 |
| Call id saved on the decision | The allowed decision lacked `callId` |
| Real gateway forwards the new header and bytes | The captured request was refused |
| Captured model follow-up admitted | Returned 403 before namespace support and again before array-output support |
| Feed keeps the call id on replay | The feed dropped `callId` |

## Mutation checks

PASS: all 18 deliberate changes made their selected tests fail with assertions.
Each changed file was restored before the next check. The first runner had a
restoration error when it edited one file twice; that result set was discarded.
The corrected runner repeated all checks from the clean implementation.

| Removed or weakened check | Result |
| --- | --- |
| Request thread equality | PASS |
| Nested Codex thread equality | PASS |
| Required thread id and required call id, separately | PASS |
| Unknown metadata fields refused | PASS |
| Tool-name header equality | PASS |
| Metadata protocol version | PASS |
| 200-character call id limit | PASS |
| Signed turn, thread, conversation and computer, separately | PASS |
| History and access share the same two seconds | PASS |
| Disconnect checked before reservation | PASS |
| Refused conditional budget append stops the writer | PASS |
| Conflicting approval use cannot admit a second call | PASS |
| Decision saves the call id | PASS |
| Feed keeps the call id | PASS |

The checks ran `nice -n 10 npx vitest run <file> -t <test name> --maxWorkers=2`.
The budget check tried to restart the deadline after reading history. The two
conditional-write checks treated a conflicting append as success. The remaining
checks removed the named validation or field. They used disposable services.

## Repository checks

| Check | Result |
| --- | --- |
| `nice -n 10 npm ci` | PASS |
| `nice -n 10 npm run lint` | PASS after fixing complexity and a test tuple type; the affected files also passed alone |
| `nice -n 10 npm run typecheck` | PASS |
| `nice -n 10 npm run check:events` | PASS; 98 event types agree |
| Dev-stack TypeScript check | PASS |
| Documented upload test image build | PASS; rebuilt the stale local fixture image |
| Generated event examples and security rules | PASS; 506 tests |
| Required integration files, first run | PASS; 223 passed, 2 skipped across 10 files |
| Required integration files, second run | PASS; 223 passed, 2 skipped across 10 files |
| Full root suite, one run | FAIL; 2,139 passed, 2 failed, 15 skipped across 147 files |
| Upload file alone after root | FAIL; 6 passed, 1 failed with the same computer-ready timeout |
| Upload file alone after rebuilding its test image | PASS; all 7 tests |
| Gateway file alone after root | PASS; 81 passed, 1 skipped |
| Fresh-install live chat journey | NOT RUN; belongs to the later journey change |

The root run used `PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:44985/postgres`
and `env -u MODELS_REAL_CALL nice -n 10 npm test -- --maxWorkers=2`.
It ran on 6–7 October 2026. Its failures were:

- The installation-grants test in `libs/models/test/gateway.test.ts` received 503 instead of 200.
- The scan/replay test in `apps/server/test/upload.test.ts` timed out waiting for the
  disposable upload computer to become ready before sending its test credential.

The gateway file passed alone without a code change. The first upload rerun
repeated the computer-ready timeout. A read-only image check confirmed that the local `ocn-upload-computer:test` image lacked
`/app/libs/events/src/tool-call.ts`, which merged PR 1 added and the current
computer imports. The documented preparation is
`nice -n 10 sh scripts/build-test-computer.sh`; it builds only a disposable test
image and does not publish or start a stack. The rebuilt image contains the missing
file; its image id is
`sha256:8487036354b3ba501ce2497730a379b262b46708c77a2963c17b26a4c49129ee`.
The upload file then passed all seven tests alone with that image. Both failing
files were rerun with `env -u MODELS_REAL_CALL nice -n 10 npx vitest run <file>
--maxWorkers=2` and the same `PG_TEST_URL`. The full root suite was run once.

The two skipped integration checks are the paid provider test and the optional
browser approval check. PostgreSQL ran in the throwaway `pgtest-p3-5-be-pr2`
container. `PG_TEST_URL` was supplied for projection and root tests. The container
was removed afterwards with `docker rm -f -v pgtest-p3-5-be-pr2`. All test, lint,
typecheck and image-build commands ran under `nice -n 10`.
