# Issue 113: model stream recovery

Date: 2026-10-04. Base: `089fa31` (`main`).

## Change

The models budget loop retries only errors recognised by
`isEventStoreUnavailable`, for at most 15 seconds of continuous outage
(`MAX_EVENT_STORE_OUTAGE_MS`, under the NATS client's ~22 s reconnect limit). After
that it exits with code 1 so the supervisor restarts it with a fresh connection,
instead of staying alive but idle. It logs once when an outage starts and once when
it ends, with the operation name and the error name only, never event content. A
long-outage test proves the exit. Lease query failures, a stopped gateway, fence
loss and invalid usage still fail the service at once. The computer proxy now pipelines the upstream response
to the client, so an upstream abort closes the client stream.

## Source evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Lint | PASS | `nice -n 10 npm run lint` |
| Typecheck | PASS | `nice -n 10 npm run typecheck` |
| Event catalogue | PASS | `nice -n 10 npm run check:events`; 86 event types agree |
| Issue regressions | PASS | Models process survives a 600 ms NATS pause, remains ready, ingests a later usage line; malformed usage exits non-zero. Proxy forwards an SSE delta, aborts within 2 s, and ends a normal `response.completed` stream. |
| Full root suite | PARTIAL | 1,494 passed, 15 skipped, 1 failed. The handler-runtime test's `afterEach` hook exceeded 10 s. That exact test passed alone with `PG_TEST_URL` set. |

The issue regressions use the real models process, NATS fixture and agentgateway
binary. The gateway and upload tests also passed in the full root run. A separate
gateway/upload batch had two 40 s timeouts under shared-host load; the affected
gateway cases passed when rerun alone.

## Fresh secondary qualification

Stack 2 was claimed through `infra/dev-stack/claim.sh` and started with
`up.sh --fresh`. The browser core journey completed `browserChatJourney` before
failing in the following `browserLiveViewJourney`, which timed out waiting for
“Viewing”. `browserChatJourney` awaits `browserUploadJourney`; that journey waits
for the PDF answer “The project code is Willow-47.” and its “Done” state. The
PDF upload subjourney therefore passed on the fresh stack. The full core journey
is PARTIAL because the later live-view step failed.

The slot-2 models container log was saved before teardown at
`/tmp/i113-models-compose.log`. It contains only the stub readiness line. Stack 2
was then stopped and its secondary resources released; the owner stack was not
touched.
