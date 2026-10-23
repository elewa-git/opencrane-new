# Local tool rehearsal: first part

Part of #45, P3-4/P3-5 PR 14a. This is the first split under the requested change-size
limit. It provides the local TLS fixture, slot guard and approval evidence checker.
It does not qualify the browser or chat journey. #45, #46 and #63 remain open.

## Source and ownership

- Base: `a5a8f5e2b7d961850f9ac91ce986f4db0862ce0a`.
- First commit: `b1054fc70` contains tests only. Its expected failure was the missing
  helper import; it did not yet exercise a behavioural refusal.
- `npm ci`: PASS. NATS and Lychee use the requested worktree symlinks.
- Secondary slot 1 was claimed through `claim.sh`, checked against this worktree,
  and released through `down.sh --id 1`. No stack services or fresh install started.
- Only local TLS and normal NATS/PostgreSQL/OpenFGA/gateway test fixtures ran.
  No owner resources, public DNS, paid provider or system network settings changed.

## Qualification

| Check | Status | Evidence and limit |
| --- | --- | --- |
| Local demo discovery | PASS | Real demo routes over TLS; two unreviewed tools declare exactly zero cents. |
| Local demo write | PASS | A separate read finds afternoon and exactly one effect after one direct call. This is not an approval-path proof. |
| Local network refusals | PASS | Private/mixed DNS, another host, wrong TLS hostname, redirects and altered pin/TLS settings are refused. |
| Slot guard | PASS | Wrong/owner ids and a foreign worktree fail before settings; real claimed slot ownership also passes. |
| Evidence checker | PASS | Supplied publication, saved definitions, current policy, original approval and dispatch records, IAM receipts, turn, readbacks and zero spending must agree. These are synthetic unit-test inputs. |
| Fresh browser registration, review, grants and publication | NOT RUN | Next split must collect original product receipts. |
| Demo tools through real Codex/gateway chat | NOT RUN | Next split must connect test-only transport injection at discovery, watch and dispatch in the separate server and models processes. |
| Spending, Change history, both widths and reload | NOT RUN | No browser evidence collected. |
| Native shell and file-edit consent | NOT RUN | Orchestrator decision of 23 October keeps 12b BLOCKED and outside this rehearsal. |
| Twice-fresh, long waits/expiry, reconnect/Pod loss, full refusal matrix | NOT RUN | Later qualification, outside this first rehearsal. |
| Public deployment | NOT RUN | Needs owner-provided DNS and a certificate. |

Live image digest, generation, publication/IAM receipts and chat dispatch counts are
NOT RUN. No synthetic value substitutes for those records. The local round-trip test
opens five TLS connections: discovery, tool listing, read, write, then readback.
The fixture confirms all five public pins before mapping them to its local listener.
The checker only validates supplied evidence; it does not collect or authenticate it.

## Earlier checks

All commands ran under `nice -n 10`. Full root suite: NOT RUN, as requested.

| Check | Status | Result |
| --- | --- | --- |
| Focused checks | PASS | Seven tests, twice on the final code. |
| Guard-removal probes | PASS | Removing publication, grant-reference, waiting-count, duplicate-effect or public-pin checks made its test fail; all restored. |
| Event security | PASS | 438 tests, once; protected tests unchanged. |
| Typecheck | PASS | All workspaces, package and dev-stack checks. |
| Event catalogue | PASS | 149 event types agree. |
| Lint | PASS | Includes Knip, docs, links, fixtures, licences and changelog. 24 existing warnings; no errors. |
| Shared fixture regressions | PASS | 280 cases covered: 248 initially, then all 32 setup cases after repair. |

The first regression attempt began before the gateway download finished. Its 32
setup failures reported a missing binary or a partial-file digest mismatch. The
completed binary matches the pinned SHA-256
`daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`.
Only those 32 cases were rerun, and all passed. The other 141 dispatch cases had
already passed; the filtered retry skips them. The four other files cover discovery,
catalogue watching, catalogue dispatch and the demo server.
No test condition or product check was weakened to repair that setup.
Regression tests used the disposable database on loopback port 56630. Focused and
security tests used the requested `PG_TEST_URL` on port 55432; neither needs a database.
The owned database was removed with its volume. No owned NATS process or stack claim remains.

## Next part

Keep the server and models processes separate. Connect this adapter through the
existing discovery, catalogue-watch and dispatch parameters, only in the test launcher.
Reuse the browser helpers for one fresh install with a deterministic local model and
the pinned real Codex/gateway. Collect original receipts and dated readbacks from that
run, capture both widths and reload, and reconcile model spending separately from tools.
Do not count the direct fixture calls or checker unit tests as live approval evidence.

## Evidence checker fixes, 23 October 2026

Source: `a8c51f6d95fba17a2600f33ae1d6e8714ce84a44`, rebased onto
`2cc0a179f5ce4746590eef9c479216b422b95e91`. The rebase finished and the base
is an ancestor of this branch. The README diagram keeps both descriptions of the
dev stack's work from the two branches.

Environment: the local worktree on the shared development machine. This was not a
fresh install. Tests used normal temporary directories and local TLS fixtures with
the requested `PG_TEST_URL` set. No stack was started or changed. These tests do
not use PostgreSQL, so no database container was needed.

The checker now requires the original approval request, human decision, approval use,
gateway decision and dispatch result. Their ids, tool, call, conversation, turn,
requester and assistant must agree. Global event-log positions and event times prove
that approval was saved before dispatch. The actual dispatch start must also follow
the saved decision. The saved definitions must match the reviewed tools, and the
product's `isToolPolicyAvailable` checks the policy at `rehearsedAt`.

Tests were committed before each fix. Before the policy fix, seven refusal tests
reported missing expected exceptions. Before record validation, a direct write with
only the old approval labels was accepted. After adding record parsing alone, the
ordering and unrelated-call tests still reported missing expected exceptions.

Logs are retained under `~/.fleet/demo-stage-b-local-fixes/` on this machine. They contain only
synthetic test records and local check output. The final check results follow below.

Live browser/chat run: **NOT RUN**. Full root suite: **NOT RUN**, as requested.
Native shell and file-edit consent: **NOT RUN**. This PR remains a draft.

| Check | Status | Observed result |
| --- | --- | --- |
| Changed tests, run 1 | PASS | All 21 tests passed. |
| Changed tests, run 2 | PASS | All 21 tests passed. |
| Slot guard removal checks | PASS | Each new test failed when its guard was removed; both guards were restored. |
| Lint | PASS | Repository lint passed, including Knip, Markdown, links, fixture rules, licences and changelog. |
| Typecheck | PASS | All workspaces, package and dev-stack checks passed. |
| Event catalogue | PASS | All 151 event types agree. |
| Changelog | PASS | The branch fragment passes validation. |

The changed-test command was
`nice -n 10 node --experimental-strip-types --test infra/dev-stack/stage-b-local.test.ts`.
Both runs had the requested `PG_TEST_URL` set. All checks ran under `nice -n 10`.
