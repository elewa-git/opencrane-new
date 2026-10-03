# P3-19 — Permission-scoped audit trail

Receipt: 3 October 2026. Base `f5e30686c6a0fea1db0adef1acf58431185f6cf2`,
branch `work/p3-19-audit`, plus the feature changes committed with this receipt.
Linux, Node 22.23.3, clean `npm ci`, disposable NATS/OpenFGA/PostgreSQL databases
and a recording model upstream. PostgreSQL control URL:
`postgres://postgres:test@127.0.0.1:55432/postgres`.
No dev stack was changed or operated. No paid provider was called.

## Why

Issue [#60](https://github.com/elewa-git/opencrane-new/issues/60), parent
[#41](https://github.com/elewa-git/opencrane-new/issues/41) and
[D24](../specs/phase-3/decisions.md) require an explanation of permission and
observed work without an administrative route into private content.

## Functional outcome

Requesters read their actions within an authorised conversation; Owner/Admin reads
safe organisation changes. Both show decision and observed outcome separately,
fixed readable reasons, context digest, correlated ids and integer-cent reservation
and settlement. Missing observations remain unknown. JWT failures retain only safe
correlation, and persistence outage cannot admit a model call. Unmatched effects
raise one security alert. Raw gateway diagnostics, text, arguments, approval details
and credential material never enter audit metadata or UI rendering.

## Architecture

The existing model path reserves with `requestId`, records the decision before
admission, then joins gateway usage and settlement by permit. Gateway timestamps are
ignored. A transport-failure test found that the old `attempts: 1` retry policy made
two upstream attempts; removing that policy proves one attempt and an unknown outcome.
The audit projection stores only a typed metadata allowlist and indexed correlation
fields. Reads fetch 50 anchors and their relevant evidence. Fresh authority uses only
the current member and conversation streams plus OpenFGA receipts, never global history.
Turn-only evidence uses exact indexed conversation/turn pairs and checks its requester;
approval lifecycle evidence joins by approval id.
Rebuild is transactional, preserves table grants and never runs reactions or effects.
Forthcoming event families have typed fixtures; owning tickets emit them and add their
integration assertions. No new dependencies.

## Evidence

Safe command logs are `/tmp/p3-19-*.log` on the builder host. The committed tests and
screenshots below are the retained repeatable evidence.

Independent review used two passes with a different model. Pass 1 reproduced missing
conversation/turn-only takeover evidence. A failing regression proved the gap before
the indexed join fix. Pass 2 independently reproduced the fix and confirmed exclusion
of foreign requester, turn and silo evidence: code PASS. All final gates are green.
The log regression also covers caller-supplied conversation ids as well as filters.

| Required gate | Result | Evidence |
| --- | --- | --- |
| `npm run lint` | PASS | Code, dependency boundaries, unused exports, docs, links and fixture checks |
| `npm run typecheck` | PASS | All workspaces |
| `npm run check:events` | PASS | 78 registered and documented types agree |
| `npm test -- --maxWorkers=2` | PASS | Final source; 1,088 passed, 10 skipped across 70 files; PostgreSQL URL above |
| `npm run build -w apps/web` | PASS | Existing bundle/style size warnings remain |
| `npm run test -w apps/web` | PASS | 49 tests across nine files |

The earlier concurrent daily/monthly budget timing failure passed in isolation.
The existing chat-browser timing failure also passed when rerun alone. The unknown
outcome and private history-path regressions were fixed and passed before the final
full-suite run. No security freshness fence or test expectation was weakened.
Source readiness: PASS. Live capability qualification: PARTIAL, with the unrun
conditions below explicit.

| Check / journey | Result | Proof |
| --- | --- | --- |
| Real gateway → recording upstream → audit read → replay | PASS | One upstream call, one reservation/charge, allow separate from success, 25 reserved / 1 settled euro cents, request/permit/conversation/turn and digest |
| JWT failure before ext_authz | PASS | Safe UUID correlation; no requester asserted; bearer and text canaries absent from events, normalised log and audit response |
| Audit append outage; unmatched effects | PASS | 503, zero upstream dispatch; no audited success; stable security alert; reservation without an allowing decision also alerts |
| Lost upstream reply | PASS | One attempt; reservation held; effect uncertain; no settlement or reported success |
| Future-family fixtures and replay | PASS | Approval lifecycle, credential lease release, MCP publication/drift, egress, takeover; equal-time and out-of-order joins; private review/text canaries excluded |
| Indexed paging and duplicate delivery | PASS | 53 anchors in 50/3 pages, no duplicates; filters; unverified unknown stays unknown |
| Authenticated HTTP reads and logs | PASS | Cross-user/silo refusal, removed member refused before IAM catch-up, unknown filters rejected, no wildcard authority reads, private filter/bearer/dependency canaries absent from logs |
| Event contracts | PASS | Strict new-family schemas reject bearer, arguments, review and text canaries |
| Browser history | PASS | Both views, both widths, four states; keyboard submission and retained focus, ≥44px controls, no horizontal overflow |
| Fresh-install capability journey | NOT RUN | User explicitly prohibited operating any dev stack |
| Real provider and future-family emitters | NOT RUN | Recording upstream only; emitters belong to their owning feature tickets |

### Screenshots

| View / state | 1280px | 390px |
| --- | --- | --- |
| Action / Loading | [Desktop](evidence/p3-19/action-loading-1280.png) | [Mobile](evidence/p3-19/action-loading-390.png) |
| Action / Empty | [Desktop](evidence/p3-19/action-empty-1280.png) | [Mobile](evidence/p3-19/action-empty-390.png) |
| Action / Unavailable | [Desktop](evidence/p3-19/action-unavailable-1280.png) | [Mobile](evidence/p3-19/action-unavailable-390.png) |
| Action / Outcome unknown | [Desktop](evidence/p3-19/action-unknown-1280.png) | [Mobile](evidence/p3-19/action-unknown-390.png) |
| Change / Loading | [Desktop](evidence/p3-19/change-loading-1280.png) | [Mobile](evidence/p3-19/change-loading-390.png) |
| Change / Empty | [Desktop](evidence/p3-19/change-empty-1280.png) | [Mobile](evidence/p3-19/change-empty-390.png) |
| Change / Unavailable | [Desktop](evidence/p3-19/change-unavailable-1280.png) | [Mobile](evidence/p3-19/change-unavailable-390.png) |
| Change / Outcome unknown | [Desktop](evidence/p3-19/change-unknown-1280.png) | [Mobile](evidence/p3-19/change-unknown-390.png) |

Browser Loading is held at the HTTP read; Unavailable is an injected 503 response
with a secret error canary. Authority/persistence failure and log sanitisation are
proved separately through real dependency interfaces in the HTTP/gateway tests.

## Not in this PR

No approvals, credential broker, MCP installer, egress capability or takeover
implementation; their fixture contracts make later integration explicit. No SIEM,
export or retention engine. Existing model authority scans remain with their owning
issue; audit reads do not call them. No deployment or fresh-install claim. Source
readiness is separate from live capability completion.
