# First demo read turn: offline diagnosis

Date: 24 October 2026. Part of #574.
Base: `e3a97a8881e5dfd2d8f0f8701e751215f27a3b74`.
The tested patch is the commit containing this receipt.

## What failed

The unchanged rehearsal reply code reproduced the original error with local services:
“stream disconnected before completion: Transport error: network error: error decoding
response body”. The first stream contained `response.created` only. No tool ran.

The original fixture searched the request for a direct `mcp__…` namespace.
Codex 0.159.2 instead offered `functions.exec`. Its description says deferred tools
are available in `ALL_TOOLS`. The stub threw `Reviewed demo tool was not offered to
the model` after opening the stream, so it closed the connection without a completion.
The first request has no direct demo definition. That is deferred discovery, not
proof that the published tool is unavailable. The original live request was not
retained, so its exact bytes cannot be compared. The unchanged fixture and matching
computer image reproduce its error offline.

The corrected fixture calls the offered code tool. It finds the exact published
read in `ALL_TOOLS`, calls it once and returns the actual quote. Missing or ambiguous
matches refuse. It does not hard-code a server key or dispatch outside Codex.

That correction exposed a second failure: the tool returned successfully, but the
next model request received HTTP 403. The model request schema rejected exactly
`input[7].namespace` on a `custom_tool_call`. The product fix accepts that optional
string with the same 200-character bound as function calls. The remaining strict
fields and all normal tool permission checks stay in place.

## Environment and method

Each case starts fresh disposable NATS, PostgreSQL, OpenFGA and gateway fixtures.
PostgreSQL 17.6 uses a loopback-only ephemeral port and `PG_TEST_URL`.
The real demo server provides the synthetic quote. The test saves discovery, review,
mode, publication and both grants through the existing models test fixture. It uses
the ordinary saved-policy fixture and operator route, not browser publication or
the generated gateway configuration path.

The production tool selection, thread loader, proxy and packaged Codex run together.
The computer image matches the live receipt's image digest:
`sha256:ddbd61e7b3efd8d78a46e53611e332a11cfe110d844a6bd5a277f9bd3a8b6e21`.
The repeat runs also use the CI image `ocn-upload-computer:test`, digest
`sha256:b551be5ba1ec82f412fe41f1c7671e677c60f00d50a74686a42ae616301c03e9`.
The container uses `--network none` and a Unix socket to the local services.
The rehearsal stub is the only model provider. Paid calls: **0**.
No secondary stack was launched and the owner stack was untouched.
The disposable PostgreSQL container and its volume were removed after the checks.

The failing-first integration used the unchanged `stage-b-model.ts` and its stub
hook from `work/demo-stage-b-local-live`. The focused deferred-tool test failed
with the same fixture exception. After correcting that fixture, both the real
continuation and the focused schema test failed on the namespace field before the
product fix. Early test-harness setup attempts are not counted as regressions.

## Checks

PASS: the changed Node tests passed twice, **22 tests per run**. These cover the
reply fixture, existing stub behaviour and CI file selection. After a type-only
clarity change, the five reply-helper tests passed twice again.
PASS: changed Vitest tests passed twice, **4 tests per run**, including both executor
home layouts. Event security rules passed **438 tests** once in the first batch.
All suites ran under `nice -n 10`. The changed Vitest tests used two workers;
the memory failure checks below used one.

PASS: full lint (zero errors, 25 existing warnings), full typecheck,
`check:events` (**153 event types**), knip, Markdown, README checks and
`lint:changelog`. The final focused read tests passed again after fixture cleanup
was tightened.

PARTIAL: the [full root run](root-test.txt), with two workers and a ready disposable
PostgreSQL database, was stopped after `memory-dispatch.test.ts` completed with
26 failures out of 92 tests. The remaining root files are not being reported as
passed. The first reported failure, “consumes the memory pass and captured backend
context once”, [passes by itself](memory-isolated.txt) with the same product code.
The [separate run of those 26 tests](memory-rerun.txt) passed 25 and failed one:
“serialises evidence for concurrent memory calls on the same tool”. Both requests
returned HTTP 403 where the test expects at least one HTTP 200. The full root suite
is not green. The same concurrent-recall failure also occurs with
[the original model-request schema](memory-original-schema.txt), with the optional
custom-call namespace change temporarily removed. The fixed schema was restored
after that check. The cause of these memory-test failures is not established here.

The retained extracts omit unrelated instructions and retain request-file hashes:

- [Original fixture failure](before.json): the first model tool list, incomplete
  stream, exact Codex error and zero dispatches.
- [Continuation failure before the product fix](continuation-before.json): the
  actual namespaced custom call, real quote result and HTTP 403.
- [Existing executor home](after-existing-home.json): the offered code tool, actual
  deferred tool name and result, both complete streams, one dispatch and same-turn answer.
- [Missing executor home](after-missing-home.json): the same assertions with that
  directory absent in the disposable computer.

The successful requests carry the offered code tool on the first model request.
The demo name is resolved inside that first response's code call. No extra model
request is needed to discover it. This is the actual Codex interface; the test does
not pretend that a direct demo namespace appeared in the first request.

The original private captures and check logs are under
`/tmp/stage-b-read-failure-checks/`, with failing-first captures under
`/tmp/stage-b-read-red-stream/` and `/tmp/stage-b-read-followup-red/`.
The regression can reproduce them with `STAGE_B_READ_EVIDENCE` set to a private
output directory. Full captures contain only synthetic test conversations, but
are deliberately not committed.

## Limits

Fresh browser rehearsal, write approval, restart/publication recovery, public
deployment and paid providers are **NOT RUN**. This offline read does not complete
card #574. The live branch must retain its launcher and use the corrected shared fixture
when it rebases.
