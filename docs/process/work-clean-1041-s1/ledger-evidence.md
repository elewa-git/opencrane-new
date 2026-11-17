# First capability-ledger fill

Checked on 17 November 2026 against `origin/main` at `044e1ba49`.
The issue states, all 861 merged PRs and each issue-number PR search were read.
Numeric searches also find timings, other PR numbers and commit fragments. The
source column uses PR titles or bodies that explicitly name `#<issue number>`.
The newest such merge supplies its UTC date and squash commit. Closed issues are
Yes; open issues with such a merge are Part; the other open issues are No.
No issue state changed. This is a historical snapshot, with no GitHub call in lint.

## Every PASS has a committed fresh-install receipt

Line numbers below refer to the committed files as read for this fill. Freshness,
source and date are recorded in those files too. These are historical journeys;
this document does not claim that this task ran them or performed an independent review.

| Capability | Receipt and lines recording the capability journey |
| --- | --- |
| #10 Local dev stack | [CORE receipt](../work-clean-255-s1/journey.md), lines 12–16 and 31–35: fresh startup, live services, replay and listeners. |
| #11 Zitadel sign-in | [CORE receipt](../work-clean-255-s1/journey.md), lines 18 and 31–35: sign-in, sign-out, reauthentication and token boundaries. |
| P2-2 Computer lifecycle | [CORE receipt](../work-clean-255-s1/journey.md), lines 18 and 31–35: assistant readiness, computer wake and replacement. |
| P2-3 Bridge and conversation | [CORE receipt](../work-clean-255-s1/journey.md), lines 19–20 and 35: streamed reply, Stop and retained reply after reload. |
| P2-4 Model gateway | [CORE receipt](../work-clean-255-s1/journey.md), lines 14–15 and 29–35: managed stand-in calls and over-ceiling refusals. |
| P2-5 Chat workspace | [CORE receipt](../work-clean-255-s1/journey.md), lines 16 and 19–20: chat at both widths, Stop and reload. |
| P2-6 File upload | [CORE receipt](../work-clean-255-s1/journey.md), lines 21–23 and 35: upload, preview, reload, virus, type and size refusals. |
| P3-1 Tool policy | [Policy receipt](../p3-1-live/README.md), lines 19–20; [assertions](../p3-1-live/fresh.txt), lines 2–4: saved Block at both widths and real gateway refusal with zero upstream calls. |
| P3-2 Bound approvals | [Tools receipt](../demo-stage-b-local-live/receipt.md#fresh-run-with-complete-approval-proof-25-october-2026), lines 1053–1056 and 1081–1087: fresh launch, requester approval, exactly one write, retained reply and non-reusable approval. |
| P3-13 Monthly budgets | [CORE receipt](../work-clean-255-s1/journey.md), lines 29–30 and 35: paying-group and assistant ceiling saves, refusals and reload. |
| P3-16 Computer viewer | [CORE receipt](../work-clean-255-s1/journey.md), lines 24–26 and 35: no-grant refusal, real desktop and revoked pixels at both widths. |
| P3-19 Audit history | [CORE receipt](../work-clean-255-s1/journey.md), lines 27–28 and 35: private action history and other-member, owner and organisation refusals. |
| P4-1 Groups | [Organisation receipt](../p4-journey/runs-2026-10-23/fresh-2/receipt.json), lines 45–55 and 218–229: create and remove; [freshness](../p4-journey/README.robot.md#second-fresh-installation), lines 79–85. |
| P4-2 Ownership | [Organisation receipt](../p4-journey/runs-2026-10-23/fresh-2/receipt.json), lines 448–464: complete handover, member access and last-owner refusals. |
| P4-4 Direct chats | [Organisation receipt](../p4-journey/runs-2026-10-23/fresh-2/receipt.json), lines 266–278: two people exchange messages without agent activity. |
| P4-5 Group chats | [Organisation receipt](../p4-journey/runs-2026-10-23/fresh-2/receipt.json), lines 485–501 and 582–596: messages without AI activity and replay; preceding assertions cover creation, joining, removal and leaving. |

The CORE receipt records `641f4ef3c`, 17 November 2026, at lines 5–6. Its
stand-in model proves the recorded gateway path; paid providers remain NOT RUN.
The policy receipt records `b63234c` plus journey/login harness adjustments at
lines 3–7. Its text says those adjustments change no application code. The cell
uses the recorded application source, not a later squash commit.
The tools receipt records `f801d5b6b`, 25 October, at lines 1035 and 1045–1047.
The organisation JSON records `610f345ab`, 23 October, at lines 2 and 9–10.
The later successful fresh group-chat check does not erase earlier failed attempts.

## Limited live coverage

- P3-3: [MCP receipt](../p3-3-mcp-discover.md#secondary-live-qualification-4-october-2026)
  records passing MCP operations on fresh services, with failed complete startup journeys.
  Keep PARTIAL, using its recorded source `d172909`.
- P3-4 and P3-5: the tools receipt above proves the local demo path. Its separate
  owner sign-in, public deployment, long approval waits, expiry, reconnect, Pod loss
  and full refusal matrix remain untested. Keep PARTIAL for the wider capabilities.
- P3-8: [personal-key consent](../work-main-personal-tool-reads/journey.md#personal-key-consent-journey)
  proves saving, verifying, selecting, refusing and restoring one person's key on
  fresh services at both widths. It does not qualify every bearer lifecycle operation
  or two different people's live upstream identities. Keep PARTIAL.
- P3-18: [screenshot qualification](../p3-18-live/qualification.json) records source
  `bd938b53f` and the incomplete fresh capture journey. Retained capture and reload
  passed, but do not upgrade the fresh-install PARTIAL.
- P4-7 and P4-21: the organisation receipt records shared private chats and provider
  saving. Separate member disks are NOT PROVEN; paid provider answers are NOT RUN.
  Neither capability receives a complete PASS.
- P4-12 and P4-13: [personal memory](../memory-fresh-personal/receipt.md), lines 3–10
  and 17–18, records PARTIAL at `9ddb2b47e` on 25 October. Save, search, correction,
  forgetting, isolation and rebuild pass; governed MCP recall and other scopes remain NOT RUN.
- P4-22: [managed-provider receipt](../p4-22-managed-dev-stack/receipt.md), source
  `12e2b1794` on 18 October, proves one fresh switch-on, managed calls and credential
  exclusion. Twice-fresh and complete retirement qualification remain unproved.

## Receipts considered without a qualifying fresh run

The remaining cells stay NOT RUN. Source-only and intercepted browser checks never
become a fresh-install verdict. The following receipts were inspected; their earlier
failures and partial results remain intact at their original paths.

| Capabilities | Receipts inspected and limits |
| --- | --- |
| P2-1 | [Image evidence](../../../apps/computer/evidence.json): image and isolated-container checks, not a fresh product journey for that capability. |
| P2-7 | [Daily timer](../p2-7-timer.md): external run logs and failed hand runs; no committed attributed successful daily journey. |
| P3-6, P3-7, P3-9, P3-10, P3-12, P3-14, P3-15, P3-17, P3-20, P3-21, P3-22 | Old tables at [4ac3e85ea](https://github.com/elewa-git/opencrane-new/blob/4ac3e85ea/docs/process/ledger.md), merged PR evidence, [reconciliation](../p3-15-reconcile.md) and [tools rehearsal](../demo-stage-b-local-live/receipt.md). Source, fixture and incomplete subpaths do not qualify these complete capabilities. |
| P3-11 | [Odoo fixture](../odoo-fixture-evidence.md), lines 3–6 explicitly distinguish a disposable Odoo fixture from a fresh OpenCrane silo. |
| P4-3 | [Invitation choices](../p4-3-pr3b-evidence.md): fresh-install invitation journey explicitly NOT RUN. |
| P4-6, P4-8–P4-11 | [Old ledger](https://github.com/elewa-git/opencrane-new/blob/4ac3e85ea/docs/process/ledger.md) and merged capability PRs: no committed attributed fresh-install capability receipt found. |
| P4-14 | [Private turns](../p4-14-private-turns-evidence.md): isolated process/image checks; private gVisor journeys and fresh-install qualification explicitly NOT RUN. |
| P4-15 | [Proxy qualification](../p4-15-pr4a/receipt.md): enforcement fixtures, with launch delivery and product wiring still outside that receipt. |
| P4-16–P4-20, P4-23–P4-28 | Merged capability PRs, old tables and [organisation journey](../p4-journey/README.robot.md): no committed attributed fresh-install journey for these wider capabilities found. |

The old upload receipt's failed handback and paid-PDF attempts remain unchanged.
P2-6 uses the newer committed CORE upload journey, rather than turning those older
failures into passes. The Still NOT RUN list remains unchanged for the same reason.

## Measurements retained

Every addition to the ledger after `4ac3e85ea` is retained under Measurements:
size-debt counts and probes, and the complete approval-listing observations. The
approval-listing subsection and its anchor remain unchanged below the new heading.
PR #1149 should add a `### Long-conversation tool decisions` subsection under
Measurements, retaining its before/after table, limits and measurement-receipt link.
It should not restore the replaced dated tables or alter live cells from source tests.
