# P2-3 bridge evidence

The later [review-fix receipt](bridge-fixes-evidence.md) records the six blockers,
corrected source, and qualification limits. The runs below describe the earlier source.

Qualified on 2 October 2026 in `work/bridge`, based on P2-4 commit
`d10e2c7`. Scope: issues #28 and #25. No paid OpenAI call was made.

## Architecture

Commands use the caller's event id as their idempotency key and make one
conditional append. Conversation keys are provisioned in the dev secret store;
AES-256-GCM ciphertext and key references are the only stored event text.
PostgreSQL holds a replayable conversation feed. OpenFGA requires participation
and live membership; administrator roles do not expose personal conversations.
The HTTP API supports creation, posting and authorised conversation/message
lists. Browser subscriptions carry event positions and projection generations.

The server opens an authenticated WebSocket into the computer through its
scoped Kubernetes proxy. Short-lived lifecycle credentials authenticate the
computer channel and conversation-scoped turn grants feed the per-thread
`/grant` socket. Native Codex text requests pass through model admission,
agentgateway and the stub Responses provider, including reservation settlement.

The bridge fsyncs a per-computer report sequence before sending it and waits
for a durable turn-start acknowledgement before invoking Codex. Threads run
independently. Text deltas, completed messages, reasoning summaries and command
activity become events. Server reconnects recover the recorded report sequence;
browser reconnects recover the authorised projection position. Generation
changes require a resync. A suspended computer follows P2-2 resume and waits
for Ready; clients see “starting your computer”. Busy turns prevent idle suspend.

An interrupted bridge process records an uncertain turn as failed rather than
repeating an external effect. Pod resume uses the saved Codex thread. The bridge
journal and Codex thread state live on the private computer PVC, outside the
server event log. Conversation keys are independently removable.

## Source gates

| Check | Result | Elapsed |
| --- | --- | --- |
| `npm run lint` | PASS (existing/style warnings, no errors) | 57.47 s |
| `npm run typecheck` | PASS | 82.41 s |
| `npm run check:events` | PASS, 71 event types | 0.68 s |
| `PG_TEST_URL=… npm test` | PASS, 960 passed / 3 skipped | 172.77 s |
| `npm run build -w apps/web` | PASS | 7.39 s |
| `npm run test -w apps/web` | PASS, 41 passed | 10.30 s |
| Independent source review | PASS, two passes, no remaining blockers | — |
| `BRIDGE_K3D=1 npx vitest run apps/server/test/bridge-k3d.test.ts` | PASS, 1 passed | 131.85 s |
| Final docs/link lint and staged secret scan | PASS | — |

Real-service tests use NATS, PostgreSQL, OpenFGA, agentgateway and a stub
Responses provider. Test-first regressions cover event-id retries (including
changed payloads), encrypted text, report gaps/duplicates, projection rebuild,
private conversation permissions and native Codex request admission. Browser
WebSocket tests cover offline messages, reconnect positions and generation
resync. A real NATS connector replacement recovers exactly reports 1–4. Two
simultaneously active conversations each emit output before either completes;
one turn does not await the other. That concurrency test stubs the Codex RPC
boundary; simultaneous real Codex turns are not separately qualified.

## Computer image

`apps/computer/build.sh`: PASS, including fresh and resumed PVC checks on k3d,
gVisor isolation, proxy grants, native exec isolation, desktop, document tools,
network denial and hostile PVC checks. Licence review: 383/383 components and
90 notice hashes. The only added runtime package is existing workspace `ws`
8.22.0 (MIT); its reviewed notice is included in the image.

Qualified image:

```text
k3d-ocn-registry:5000/opencrane/computer@sha256:09bc88153ccc6e72fee754dd171235f1aecf988e3b0df62bf7f278d6155df4ac
```

## Live dev-stack journey

The owner stack was stopped from `/home/jente/dev/opencrane-new` before the
ownership marker was pointed at this worktree. Every run retained the Zitadel
files and used only org `393311211338337681`. Listeners were checked as
loopback/tailnet, with the model port restricted to loopback, tailnet and k3d.
The joined member used a real Zitadel session and posted through the HTTP API;
Codex streamed the stub reply through the browser WebSocket and into PostgreSQL.
The same journey suspended the computer, posted another message, observed
“starting your computer” and a replacement Pod, then received the reply with
its saved disk intact. Browser reconnect, budget settlement, owner/member/admin
authorisation, other-org refusal, logout, expired sessions and replay also passed.

| Run | Result | Whole run | First reply | Wake and reply |
| --- | --- | --- | --- | --- |
| Final `up.sh --fresh` | PASS | 235.97 s | 4.381 s | 19.320 s |
| Plain `up.sh` | PASS | 140.09 s | 3.107 s | 16.483 s |

Final fresh join-to-Ready: 21.747 s; resume: 19.380 s. Event audit: 12 bridge
reports, two completed turns, zero failed turns, one resume. The separate opt-in
k3d test repeated the live joined-member reply and suspended wake successfully.
Plain startup
join-to-Ready: 0.179 s (existing computer); resume: 16.501 s.

Earlier qualification failures were retained as failures and fixed: Kubernetes
proxy authentication conflicted with the bridge bearer header (now a separate
bridge capability header); native Codex text request metadata was rejected by
model admission (now explicitly schema-validated). One OIDC re-login attempt
failed before chat and passed on a rerun without relaxing its checks. A temporary
gateway process restart also interrupted a diagnostic run. None used OpenAI.

## Owner-stack restoration

The worktree stack was stopped and the ownership marker returned to
`/home/jente/dev/opencrane-new` (main commit `3e5c899`, merged P2-4). Initial
startup failed because that checkout had not installed its newly merged
`@opencrane/models` workspace. `npm ci` fixed the local installation. A second
plain startup failed its journey: main’s lifecycle reader rejected the newer
bridge events left by qualification. Restoration therefore used main’s
`up.sh --fresh` to reset disposable test state, retaining all Zitadel files.
That final restoration passed in **198.02 s**: sign-in/logout, org/session
boundaries, lifecycle-to-stub model call, disk retention, projection replay and
listener checks all passed. Join-to-Ready was 15.215 s; resume was 14.572 s.
The owner stack is running from main at
`https://ocn-dev.tail00285e.ts.net/org/integrations`; its checkout has no changes.
The marker remains on `/home/jente/dev/opencrane-new`.

## Limits and NOT RUN

- Paid OpenAI full-chat smoke: NOT RUN; zero paid calls, zero cents spent.
- Cloud deployment and prolonged/load qualification: NOT RUN.
- The ordinary suite skips the opt-in bridge/lifecycle k3d tests and paid model
  test. Live bridge qualification is recorded separately above.
- The dev secret-store adapter uses private files; deployment secret-store and
  key backup integration remain deployment work. Lost keys prevent decryption.
- The prototype keeps its bridge outbox and scans durable history. Large-volume
  compaction and multi-server scheduling are not qualified. Projection rebuild
  is an offline operation with readers stopped and a generation change.
- P2-5 owns the chat UI; this change supplies its HTTP and realtime contracts.
