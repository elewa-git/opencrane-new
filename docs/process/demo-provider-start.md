# Provider setup after a fresh start

22 October 2026. Branch `work/demo-provider-start`. Part of #568 and #32.

## Cause and change

The server saves `ownership.seeded` before OpenFGA finishes applying it. Before
accepting a provider create, `activeMember` checks saved membership, admin permission
and an applied receipt for each relevant membership and ownership event. A missing
receipt throws `AuthorityApplying`. The provider route previously turned that into
503, even though the create had not reached its append. The result lookup then found
no create event. Repeating an uncertain write would have been wrong.

The route now reports HTTP 425 with `status: access_applying`. Setup waits 100 ms
and retries the exact input and command id within its original 30-second request
deadline. Membership and ownership checks still run on every attempt. A lost reply,
503, or an unclear 425 never permits setup to repeat the create.

## Failing-first proof

Commit `88963603d` adds the real NATS/PostgreSQL/OpenFGA regression before the fix.
It failed with expected 425, received 503 and `status: unavailable`. The Owner already
had admin permission; only the ownership receipt was withheld. With the fix, no create
is saved while ownership applies. After applying it, the lookup returns 404, then
repeating the create returns one original receipt without another event.

Commit `e8a2101f7` adds the caller regression before its fix. It failed because setup
stopped at 425. The fixed test checks that both create attempts use identical input,
including the command id, before the first result lookup.

## Checks

All tests, lint and typechecks used `nice -n 10`. Tests used a disposable PostgreSQL
17.6 database on port 54601. Its container was removed with `docker rm -f -v`.

| Check | Result |
| --- | --- |
| Startup regression | PASS twice after the fix |
| Provider setup tests | PASS twice; 9 tests each time |
| Event security rules | PASS once; unchanged |
| Event catalogue and changelog checks | PASS |
| Changed setup files typecheck | PASS |
| Workspace and package typecheck | PASS |
| Knip | PASS |
| Lint | PASS with a 6 GB Node heap; 0 errors |
| Broader provider suite | FAIL: 61 passed; one 30-second timeout |
| Additional typecheck of all dev-stack scripts | FAIL: eight diagnostics in unchanged scripts |
| Full root suite | NOT RUN, as requested |

The provider timeout was `a revision change during a model call cannot prevent
recording its settled result`. It is outside the supplied flake list and was not
rerun. The extra script diagnostics concern `mcp-journey.ts`, `wake-latency.ts` and
`zitadel-setup.test.ts`; none concern the changed setup files.

The first full lint run exhausted Node's default 4 GB heap. The retry sets
`NODE_OPTIONS=--max-old-space-size=6144`; repository settings are unchanged.

## Fresh secondary startup

`claim.sh` reserved slot 1. One `up.sh --id 1 --fresh` used the free local model.
Provider setup: PASS, including reachability, the model check, model selection,
the explicit default, drain and switch-on. Its product writes returned 200.
This run did not observe 425; the regression deliberately holds that startup window open.

Overall startup: FAIL at `Timed out waiting for web`. The website build took
208.291 seconds. Browser journeys: NOT RUN. Cleanup: PASS; `down.sh --id 1` exited
successfully, removed the slot directory and left no Compose containers for that slot.
No owner stack or owner port was used.
