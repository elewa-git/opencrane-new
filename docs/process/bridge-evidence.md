# P2-3 bridge qualification — 2 October 2026

Source: `work/bridge`, review-approved base
`8e6926bd6221b4e7575e82254d74eafd55337e06`, plus the fixes in this receipt's
commit. This supersedes the earlier live qualification on the pre-review image.
The [first review-fix receipt](bridge-fixes-evidence.md) and
[replay receipt](bridge-replay-evidence.md) retain their historical results.

Environment: developer box, Node 22.23.3, npm 12.2.0, existing `k3d-ocn`
cluster with gVisor and local-path PVCs. Fresh means disposable dev-stack
state and computer namespaces were recreated, not a new host or cluster.
The owner stack was stopped from `/home/jente/dev/opencrane-new` in **7.69 s**,
then the ownership marker was moved to this worktree. `npm ci` passed in
**20.15 s**. Zitadel files were retained; only org `393311211338337681` was
used. Application listeners remained on loopback/tailnet; the model listener
was firewalled to loopback, tailnet and private k3d.

## Required branch journeys

Both commands passed sign-in, owner bootstrap, joined-member computer Ready,
HTTP chat with a streamed Codex/stub reply stored in the conversation projection,
browser reconnect without duplicates, suspension followed by wake on another
message, and the second stored reply. They also passed Pod replacement with
retained disk, membership/administration refusals, session expiry, logout,
member/catalogue replay, tailnet HTTPS and listener checks.

| Command | Result | Total | Join → Ready | First reply | Wake + reply | Resume → Ready |
| --- | --- | --- | --- | --- | --- | --- |
| `infra/dev-stack/up.sh --fresh` | PASS | 200.11 s | 14.507 s | 3.012 s | 10.996 s | 11.019 s |
| `infra/dev-stack/up.sh` | PASS | 144.01 s | 0.148 s | 2.928 s | 17.262 s | 17.286 s |

The plain run reused the existing member computer. After these two runs,
PostgreSQL contained four completed turns, four completed assistant messages,
twelve streamed deltas and no failed turns. Both journeys used the stub
provider; model admission reserved and settled the routed `gpt-6.1-sol` calls.

## One authorised real chat turn

**PASS** at `2026-10-02T19:44:28.838Z`. A real Zitadel member session posted
`Reply with OK.` over tailnet HTTPS to a new conversation. Codex in the
computer selected `gpt-6.1-sol` for `chat_turn`; its private proxy, signed
grant, model admission and agentgateway forwarded the request to OpenAI.
The reply **`OK`** arrived as streamed deltas and was read back from the stored
conversation through the authenticated API. Turn time: **7.204 s**;
whole harness including sign-in/logout and stub restoration: **99.66 s**.

A temporary loopback relay after agentgateway forwarded at most one request,
using the gateway's provider authentication unchanged. It persisted an exclusive
attempt marker before forwarding. Count: **one provider request**, **zero extra
requests**, HTTP **200**. Codex and gateway retries remained disabled. The
model service was restored to its original stub configuration afterwards.

| Receipt field | Value |
| --- | --- |
| Model / task | `gpt-6.1-sol` / `chat_turn` |
| Input tokens | 9,933 |
| Cached input tokens | 0 |
| Cache-write tokens (within input) | 9,930 |
| Output tokens | 5 |
| Reasoning output tokens | 0 |
| Total tokens | 9,938 |
| Reserved euro cents | 499 |
| Observed / settled euro cents | **3 / 3** |
| Released reservation euro cents | 496 |
| Price table | `openai-2026-10-02-all-eur95` |
| Conversation | `055557a2-a29b-4040-868b-f24b6c5d5aa8` |
| Turn | `bc3a26a6-d8b0-4000-bde9-b9ce4ea76da1` |
| Reservation / effect permit | `0d386371-de4a-450f-beff-acc5de7da122` |

Provider usage matches the durable `effect.observed` usage. The corresponding
`budget.settled` event records 3 cents under the pinned EUR planning tariff;
this is the application ledger receipt, not a separate provider invoice.
No other real call was made.

## Fixes and regressions

| Failure reproduced | Minimal fix | Passing proof |
| --- | --- | --- |
| The pinned computer image contained the old bridge and routing. Its source comparison failed on `channel.ts`; the first fresh chat timed out. | Rebuild and pin the current computer image. | Build now compares every computer source file and the routing entrypoint against this checkout; old image fails, new image passes. Full fresh/resumed image qualification and both stack journeys pass. |
| Image licence gate rejected the newly bundled `@opencrane/models` entrypoint. | Record its existing repository AGPL-3.0-or-later grant and installed notice hash. | Licence regression accepts the exact grant and rejects changed text; real image gate accepts 384/384 components and collects all 91 notice files. |
| Native Sol chat returned admission HTTP 403 before reserving or calling the provider. | Strictly validate native `additional_tools` declarations, namespace/function/Lark tool definitions, `all_turns` reasoning context and text verbosity. | New real-gateway regression fails 403 before the fix, then succeeds and settles; malformed/unknown fields still return 403 without another reservation/provider request. Both live chat journeys pass. |
| After the completed reply, the journey used `computer.turn_closed` as lifecycle state and timed out waiting for suspension. | Select the latest non-turn lifecycle event. | Live journey now explicitly asserts `computer.suspended` before waiting for the suspended Pod; wake and stored reply pass. |
| Separate infra typecheck found the older direct stub helper missing the required grant model. | Name its existing request model, `gpt-6-luna`, in the grant. | Infra TypeScript check fails before the one-line fix and passes afterwards. This helper is not the native chat journey. |

No dependency was added. No event contract, price or task-routing decision was
changed. Temporary admission diagnostics were removed before qualification.

Qualified computer image:

```text
k3d-ocn-registry:5000/opencrane/computer@sha256:afb9835f5ed42662307e4826f76efd47abb02a23d86180af877b8a11947b0597
```

`apps/computer/build.sh`: **PASS, 252.37 s**, 24 live image assertions covering
fresh/resumed PVCs, native Codex execution, proxy grants, gVisor/UID isolation,
desktop, document conversion, network denial and hostile PVCs. The first build
failed its missing-notice gate after 91.34 s; it was not promoted.

## Source checks

The final suite uses the separate PostgreSQL test instance on port 55432,
disposable NATS/OpenFGA fixtures and stub model providers. Paid-test flags were
removed from the test environment.

| Command | Result | Elapsed |
| --- | --- | --- |
| `npm run lint` | PASS | 77.37 s |
| `npm run typecheck` | PASS | 70.64 s |
| `npm run check:events` | PASS, 73 event types | 0.54 s |
| `PG_TEST_URL=… npm test` | PASS, 1,017 passed / 3 opt-in skipped | 189.81 s |
| `npm run build -w apps/web` | PASS | 7.66 s |
| `npm run test -w apps/web -- --watch=false` | PASS, 41 tests | 11.34 s |
| `npx tsc --noEmit -p infra/dev-stack/tsconfig.json` | PASS | — |
| `python3 apps/computer/test/licences.py` | PASS | — |

## Failed attempts retained

| Attempt | Result | Elapsed |
| --- | --- | --- |
| Initial fresh run, stale image | FAIL, chat timeout | 220.66 s |
| Fresh startup retries | FAIL, Angular port 44200 already in use | 127.29 s / 110.76 s |
| Plain diagnostic runs before admission fix | FAIL, native request refused | 178.43 s / 155.88 s |
| Fresh run after admission fix | FAIL, journey selected turn closure as lifecycle state | 203.07 s |
| Fresh startup during source tests | FAIL, server port 48000 already in use | 115.75 s |

The transient port conflicts were absent on the final serial fresh/plain runs.
No port defaults or listener restrictions were changed. Their exact origin was
not established; these attempts are failures, not discarded passing evidence.

Local command logs, timings and the real receipt are retained under
`.tools/bridge-qualification/` in this worktree. Passing journey logs are
`fresh-complete.log` and `plain.log`; image checks are also recorded in
`apps/computer/.state/checks.json`. Private request diagnostics are excluded
from committed evidence. No credential or token value is included here.

## Owner-stack restoration

The branch was committed, then `infra/dev-stack/down.sh` passed in **10.78 s**.
The ownership marker was returned to `/home/jente/dev/opencrane-new` at main
commit `3e5c899b53795c4c0e4b04786cf56da7120aee81`. Restoration used main's
`up.sh --fresh`, because its handler set cannot consume this branch's events.
The first attempt failed before bootstrap when the model gateway exited:
**FAIL, 99.72 s**. No model call ran in that attempt. A second fresh run passed:

| Main restoration check | Result | Timing |
| --- | --- | --- |
| `infra/dev-stack/up.sh --fresh` | PASS | 171.14 s |
| Joined member → Ready | PASS | 14.001 s |
| Resume → Ready | PASS | 6.368 s |
| Direct HTTPS GET `/` | PASS, HTTP 200 and application document | 0.069 s |

Main's journey passed real sign-in/logout, owner bootstrap, member lifecycle,
its direct stub-model path, disk retention after Pod replacement, session/org
refusals, replay and listener checks. It does not contain this branch's full
chat bridge journey. Logs: `main-fresh-final.log` in the local artefact directory.
The initial gateway-startup failure's exact cause was not established.

The stack is running from main at <https://ocn-dev.tail00285e.ts.net/>. Its
checkout is clean. The marker names `/home/jente/dev/opencrane-new`; all saved
Zitadel files match their pre-restoration hashes. Restoration results were added
to this evidence commit afterwards. Nothing was pushed.

## NOT RUN

- Merge, push, hosted CI and a new independent review of these qualification fixes.
- Separate opt-in `BRIDGE_K3D` and `LIFECYCLE_K3D` test commands; the same live
  bridge journey is exercised by both required startup commands above.
- The ordinary suite's multi-call paid-provider test; only the single authorised
  full chat turn is used for this qualification.
- Runtime qualification of the older direct `modelJourney` helper.
- Cloud/managed-cluster deployment, encrypted CSI storage, clean-host rebuild,
  prolonged load, full Phase 2 upload/chat UI and disaster recovery.
