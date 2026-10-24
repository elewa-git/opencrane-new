# Local tools rehearsal

Part of #574. Run date: 24 October 2026. Current result: **PARTIAL**.

One fresh install used claimed secondary slot 1. Paid calls: **0**.
The launch kept the complete server and models entrypoints, including publication,
catalogue watch, dispatch and chat services. No browser response was intercepted.
The owner stack was unchanged. This is not a successful approval qualification.

## Source

| Prerequisite | Actual squash on main |
| --- | --- |
| Local TLS adapter and evidence checker, #618 | `256107993` |
| Saved integration facts, #627 | `f5dd85cb8` |
| Shared gateway configuration lock, #632 | `dd1d6ef15` |

The earlier `8507d8084` is the #618 branch head, not its squash commit.
The injected live run used `83c671527bce04ff7de1b335b1241e0f6fa1c277`.
Test-first commit: `56d288d0e`. Three launch checks failed because the entrypoint
and source injection were absent. The existing evidence refusal passed.
Full source references, image digests and evidence hashes are in [run.json](run.json).
The real computer ran Codex `0.159.2`; agentgateway was `1.5.0`, revision
`fe6732474a96a0363dfb9822859af4e9bab360fa`. Replies came from the free local model.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Fresh secondary baseline | PASS | Standard fresh journey completed before injection. |
| First injected launch | FAIL | Models lacked OpenSSL; `spawnSync openssl ENOENT`. |
| Corrected injected launch | PASS | Test-only OpenSSL image; both complete services ready. |
| Separate verified owner sign-in | PARTIAL | Real SSO signed in Admin `zitadel-owner`, not owner `jente-rosseel`. |
| Registration, exact zero costs, read Allow/write Ask | PASS | Browser review and original saved policy. |
| Person and assistant grants | PASS | Both original change receipts report content and IAM current. |
| Publication command and gateway acknowledgement | PASS | Original request and observed generation 1 match. |
| Published tools available to chat | FAIL | Policy still says `published: false`. |
| Real chat read | FAIL | Turn failed with `model_error`; tool dispatch count 0. |
| Waiting write, requester Approve, one effect and same-turn reply | NOT RUN | Read and publication blocker prevented this sequence. |
| Separate demo readback | PASS | Original before/after reads both report effect count 0. |
| Approval evidence check | FAIL | Refused: original approval and dispatch records are absent. |
| Spending and Change history | PARTIAL | Captured; no successful tool charge or approval history exists. |

[live-probe.json](live-probe.json) retains the original policy, grants, review,
publication, gateway, chat, model decision and budget records, plus both readbacks.
The member grant is sequence 374, assistant grant 376, review 378 and publication 379.
Gateway request 380, observation 381 and MCP observation 383 refer to generation 1.
The review digest is `51d3cf7b1be76c944cef472f37073c06abd87d0f22c47e509023df8019e1cb7d`.
The conversation is `8cd19b79-d42c-4f97-a406-8bda1b4a496b` and failed turn is
`22734b57-aab2-4547-8fce-4d118d3f60d4`. Approval requests, tool dispatches and effects
are all **0**. No direct demo write was used in this live run.

The publication API reports ready, but the saved policy remains unpublished despite
its matching observation and fresh catalogue. In `libs/projections/src/tool-policy.ts`,
`applyConfigurationObservation` restores publication only after a drift hold.
The chat bridge rejects an unavailable policy in `toolsForTurn`. These source checks
explain why a fresh publication cannot offer the reviewed tools on this run.
No saved flag or product access check was changed to get past the failure.

The failed model call reserved **16 euro cents**, with no settlement observed in the
captured records. The tool review declares **0 euro cents**. Spending also includes
baseline activity: its 11 cents today and 48 cents reserved are not this call's cost.
These are local model accounting records; no paid provider was contacted.

Earlier browser attempts also failed: a label intercepted a radio input click; a
response waiter used the wrong grant URL; a cost check ran before the page loaded;
and one attempt lacked its retained grant file. The final publication wait failed
on the real unpublished policy. Original attempt JSON files remain beside this receipt.
Successful grant commands were not repeated. The missing OpenSSL retry restored the
ordinary server, then replaced it again on the same install; it was not a second fresh run.

## Browser captures

| View | Desktop, 1280 pixels | Mobile, 390 pixels |
| --- | --- | --- |
| Modes | [1280](chosen-modes-1280.png) | [390](chosen-modes-390.png) |
| Granted audience | [1280](saved-audience-1280.png) | [390](saved-audience-390.png) |
| Exact costs | [1280](review-1280.png) | [390](review-390.png) |
| Publication blocked | [1280](publication-observed-1280.png) | [390](publication-observed-390.png) |
| Failed chat | [1280](read-chat-1280.png) | [390](read-chat-390.png) |
| Reloaded chat | [1280](read-chat-reloaded-1280.png) | [390](read-chat-reloaded-390.png) |
| Spending | [1280](spending-1280.png) | [390](spending-390.png) |
| Change history | [1280](change-history-1280.png) | [390](change-history-390.png) |

## Source checks and remaining work

PASS: `npm ci`, lint (including knip and changelog), typecheck and `check:events`.
PASS: all 28 changed/helper tests twice on the final source; security rules 438/438 once.
Checks ran under `nice -n 10`; tests used the requested `PG_TEST_URL`.
The three protected test files are unchanged. No full root suite ran.
Cleanup results are recorded in [run.json](run.json).

Native shell and file-edit consent is NOT RUN under the 23 October decision.
Public DNS and certificate deployment remains with the owner under #573.
Twice-fresh runs, expiry, reconnect, Pod loss and the full refusal matrix remain
NOT RUN. This work does not complete #45, #46 or #63.

## Rerun after the publication fix, 24 October 2026

Part of #574. This run rebased draft PR #641 onto `f13ea5d90` from `origin/main`.
The rebase completed without conflicts. That commit is the publication fix from #645.
The fresh install uses `dee80f52cc175ea884977dbb09e9a587a3f628ff`, in claimed
secondary slot 1. The earlier run above remains unchanged.

### CI regression

Run `40046177283` failed its packaged model-stub test. The printed
`FAIL 1280px 9 companyLimit` belongs to a passing negative test: it deliberately
makes both the limit check and restoration fail, then checks the saved failure and
remaining NOT RUN steps. The ordinary rehearsal tests in that same log pass both widths.
No Stage A step or assertion was weakened.

This branch added an unconditional import of `stage-b-model.ts` to `model-stub.ts`.
The wake Pod packages only the stub, so Node stopped before it could listen.
Commit `b0d85b29d` extends the existing packaged-file test to require a streamed
reply as well as startup. With dependencies installed, the unchanged stub failed
that test at startup, reproducing CI. The fix loads the helper only for the two
local tools rehearsal prompts. The packaged reply now passes.

An earlier local test attempt ran before `npm ci` finished and could not import
workspace packages. That attempt is a setup failure, not regression evidence.

PASS: packaged stub and both Stage A rehearsal files, 21 tests.
PASS: changed/helper tests twice, 35 tests per run.
PASS: security rules, 438 tests, with a disposable PostgreSQL URL configured.
All test processes ran under `nice -n 10`; the disposable database and its volume
were removed afterwards. Full root suite: NOT RUN, as required by the build prompt.

### Live result: PARTIAL

One fresh slot-1 install used the local demo server, Codex 0.159.2 and agentgateway
1.5.0. Paid calls: **0**. The owner stack was unchanged. The complete server and
models processes used the same guarded discovery, watch and dispatch transport.

| Step | Result | What happened |
| --- | --- | --- |
| First fresh startup | PARTIAL | Startup received SIGTERM during the baseline journey. The signal's source is unknown. |
| Baseline after resuming the same install | FAIL | The live-view chat received a gateway 403 and recorded `model_error`; the browser then timed out waiting for the reply cursor. |
| Guarded local launch | PASS | Both complete services became ready. |
| Separate owner membership and access | PASS | The external owner stayed separate from the generated Admin; PostgreSQL and OpenFGA agree. |
| External owner browser sign-in | NOT RUN | No existing owner credential or session was available. The generated Admin signed in through real SSO. |
| Register and discover the local demo server | PASS | Browser registration and guarded TLS discovery found both tools. |
| Exact zero costs, read Allow and write Ask | PASS | The browser reviewed both definitions and saved those modes. |
| Person and assistant grants | PASS | Original receipts report both content and IAM current. Each grant was submitted once. |
| Publish the reviewed tools | FAIL | The browser rejected a successful review receipt and never sent publication. |
| Matching gateway acknowledgement and bridge acceptance | NOT RUN | No publication command or gateway generation exists for this attempt. |
| Read tool in a real chat | NOT RUN | Publication failed before chat qualification. |
| Waiting write, requester Approve, one effect and same-turn reply | NOT RUN | Publication failed before this sequence. |
| Separate demo-server readbacks | PASS | Both reads report the morning slot and effect count 0. No direct write was made. |
| Approval evidence checker | FAIL | It refused the missing publication, approval and dispatch records. |
| Spending and Change history | PARTIAL | Both screens were captured; there is no successful tool call or approval to show. |

The new product blocker is in
[`integration-detail.ts`](../../../apps/web/src/app/integrations/integration-detail.ts),
inside `reviewAndPublish`. It accepts a saved review only when the returned event
position equals `policy.sequence + 1`. Event positions are global, so events in
other streams can come between two events for this integration.

The [original review response](rerun-20261024/publication-attempt.json) is HTTP 200,
`status: appended`, position **248**, for expected position **244**. The person and
assistant grants occupy positions **245** and **247**. The UI expected **245**,
changed to “Outcome unknown”, and returned before calling `publish`.
Its later publication-response check makes the same adjacent-position assumption.
This is a browser defect before the merged publication fix can run. No publication
API call, edited saved flag, repeated review or direct fixture write bypassed it.

[Original records and readbacks](rerun-20261024/live-probe.json) contain discovery
positions 241–244, review 248 and a later catalogue check 249. There is no
`mcp.server_published`, gateway configuration request, approval or tool dispatch.
The [inspection](rerun-20261024/publication-inspection.json) shows publication
`disabled` and `published: false`. Counts are **0** dispatches, **0** approval
requests and **0** effects. The merged fix's successful live behaviour remains
NOT RUN on this attempt.

Two earlier collection attempts stopped on browser controls. The first waited on a
Check status button that became disabled and disappeared after the person grant.
The second tried Review access while the assistant grant was still shown as Applying.
Both original receipts were already current. Reopening the page showed the saved
audience; neither grant was repeated. Their original responses and failure captures
remain in `publication-attempt-1.json`, `publication-attempt-2.json` and the audience
capture pairs below. These collection failures are distinct from the product blocker.

The baseline failure is retained in [baseline-chat.json](rerun-20261024/baseline-chat.json).
The failed turn is `9678107b-3aac-4cec-8ba8-42248b3f72c5`; gateway request
`4071a197-6320-44da-8dab-57f14ee8e044` records `deny / request_refused` before
verified turn details were attached. The private Codex record confirms HTTP 403.
The exact failed access check is not exposed by that record, so the underlying
cause remains unresolved. High host load was observed but is not proved to be the cause.
The baseline was not retried again and is not a passing fresh qualification.

Spending shows **7 euro cents settled** and **32 euro cents reserved**, all from
baseline local-model activity. The reviewed tools declare **0 euro cents**, and
this blocked tool journey added no model or tool calls. These accounting values
are not paid-provider spending. A successful model/tool spending comparison remains
NOT RUN.

### Rerun captures

Every new capture was inspected by eye. The browser masks email addresses before
capture, and saved JSON removes email addresses. No email address is visible in
these captures. The baseline failure has only a 1280-pixel capture; its 390-pixel
capture is NOT RUN.

| View | Desktop, 1280 pixels | Mobile, 390 pixels |
| --- | --- | --- |
| Discovered modes | [1280](rerun-20261024/tools-1280.png) | [390](rerun-20261024/tools-390.png) |
| Chosen modes | [1280](rerun-20261024/chosen-modes-1280.png) | [390](rerun-20261024/chosen-modes-390.png) |
| First audience attempt | [1280](rerun-20261024/audience-attempt-1-1280.png) | [390](rerun-20261024/audience-attempt-1-390.png) |
| Second audience attempt | [1280](rerun-20261024/audience-attempt-2-1280.png) | [390](rerun-20261024/audience-attempt-2-390.png) |
| Saved audience | [1280](rerun-20261024/saved-audience-1280.png) | [390](rerun-20261024/saved-audience-390.png) |
| Exact cost review | [1280](rerun-20261024/review-1280.png) | [390](rerun-20261024/review-390.png) |
| Review outcome unknown | [1280](rerun-20261024/publication-failed-1280.png) | [390](rerun-20261024/publication-failed-390.png) |
| Reopened integration | [1280](rerun-20261024/publication-blocked-1280.png) | [390](rerun-20261024/publication-blocked-390.png) |
| Spending | [1280](rerun-20261024/spending-1280.png) | [390](rerun-20261024/spending-390.png) |
| Change history | [1280](rerun-20261024/change-history-1280.png) | [390](rerun-20261024/change-history-390.png) |
| Baseline failure | [1280](rerun-20261024/baseline-failed-1280.png) | NOT RUN |

Native consent 12b stays excluded. Public deployment, twice-fresh runs, expiry,
reconnect, Pod loss and the full refusal matrix remain NOT RUN. This rerun does
not complete #45, #46 or #63.

### Rerun cleanup and records

PASS: final lint, typecheck, `check:events` (153 types), knip and
`npm run lint:changelog`. Lint reported zero errors and 25 existing warnings.
PASS: the exact CI job test group, all 250 tests. This includes the Stage A
rehearsal checks. The 35 changed/helper tests passed twice and security rules
passed 438 tests once, as recorded above. All checks ran under `nice -n 10`.

PASS: the owned launcher stopped, slot 1 shut down and its claim was released.
Its stack directory, containers and namespace are gone. The temporary models image
was removed. The disposable test database was removed with its volume.
The owner stack was not touched.

[run.json](rerun-20261024/run.json) records the tested source, runtime images,
results, original change references and hashes of every public capture and record.

## Rerun after both publication fixes, 24 October 2026

Part of #574, draft PR #641. Result: **PARTIAL**. Publication passes; the read
turn fails. Approval and write qualification remain **NOT RUN**.

`git fetch origin` and the rebase completed without conflicts. The new base is
`e3a97a8881e5dfd2d8f0f8701e751215f27a3b74`: review-position fix #648.
It includes publication fix #645, `f13ea5d902c3ee600122abc9b43eeaeaeb0fd9d5`.
The live source is `a294ebd1d0789c9639a0caaa4cfa84934044e16f`.
This rerun changes evidence only. Product code, the local reply fixture and the
three protected test files are unchanged.

One fresh install used slot 1, claimed through `infra/dev-stack/claim.sh`.
The full server and models processes used the guarded local demo transport for
discovery, catalogue checks and dispatch. Paid calls: **0**. The owner stack was
unchanged. [Runtime references](rerun3-20261024/runtime.json) identify the images.

### Fresh-run results

| Step | Result | Observed evidence |
| --- | --- | --- |
| Stage A regression checks | PASS | Packaged stub and both rehearsal files: 21 tests, including step 9 at both widths. |
| Fresh baseline | PASS | [Original baseline output](rerun3-20261024/baseline.log): chat, uploads, live view and budget checks at both widths. The earlier gateway 403 did not recur. |
| Guarded local launch | PASS | Complete server and models services became ready. |
| Separate owner membership and access | PASS | [Owner record](rerun3-20261024/ownership.json): the external owner remains separate from the generated Admin; PostgreSQL and OpenFGA agree. |
| External owner browser sign-in | NOT RUN | No existing credential or browser session was available. Real SSO signed in the generated Admin. |
| Register and discover the local demo server | PASS | Both real demo tool definitions appeared in the browser. |
| Exact zero costs; read Allow, write Ask | PASS | Browser review showed both declarations at 0 euro cents and the selected modes. |
| Person and assistant grants | PASS | Original receipts at positions 373 and 374 report content and IAM current. Each grant was submitted once. |
| Review, publication and gateway acknowledgement | PASS | Review 375, publication 376 and observation 380 agree on generation 1; saved policy has `published: true`. |
| Bridge acceptance through to model tool availability | PARTIAL | Original Codex thread had the demo MCP server configured. Its first model request's tool list was not captured. |
| Read tool in a real chat | FAIL | The model request was allowed, then the stream disconnected and the turn failed with `model_error`. No tool dispatch was recorded. |
| Write waits with zero effects; requester Approve; one effect and same-turn reply | NOT RUN | The failed read stopped the qualification sequence. |
| Separate demo-server readbacks | PASS | Before and after the failed read: morning slot, effect count 0. Final diagnostic readback also reports 0. No direct write was made. |
| Approval evidence checker | FAIL | It refused the missing original approval and dispatch records. |
| Spending and Change history | PARTIAL | Both were captured; no successful tool charge, approval or dispatch exists. |

[Publication records](rerun3-20261024/publication.json) retain the original browser
commands, grant receipts, policy and gateway events. The review expected position
372 and returned **375**; the browser accepted the intervening grants and published
using 375. The publication command is `54b8b7e0-1a01-4a95-a3e3-825a8bf9a440`.
The gateway process is `499bcc6a-d4e5-4819-ba50-85dd2e1f9fd3`.

[The original chat records](rerun3-20261024/live-probe.json) identify conversation
`e03a1978-1b98-4864-875a-77fbf6a20fd9`, turn
`64e6cdd9-2500-4f60-8187-ac70214648b0` and model request
`0f7437e2-6fd7-4603-b6ec-2ab17c887a3a`. The saved policy was available before
this turn. The model reserved **17 euro cents**; no settlement was observed.
The initial Spending capture shows 11 cents settled and 49 cents reserved,
including baseline activity. The tool declarations remain **0 euro cents**.
These are local accounting amounts, not paid-provider costs.

### Diagnosis and its limits

The original Codex record says the response stream disconnected while decoding its
body. Its MCP runtime later closed the configured demo server `oc_817e192ca1`.
This confirms that the server reached Codex, but does not prove which tools reached
the first model request. [Failure details](rerun3-20261024/failure-analysis.json)
retain these original records. The exact cause of that first stream failure remains
**unresolved**; it is not being reported as a proved product or fixture defect.

One diagnostic models restart enabled the local stub's existing private request
capture. It did not change product code or the fixture's reply logic. A subsequent
read failed too. Its captured request had no demo tools; replaying those bytes
through `stageBModelCall` throws `Reviewed demo tool was not offered to the model`.
However, the restart had already held publication, so this does not prove the cause
of the first failure. The diagnostic also records a missing tool-executor Codex
home warning. Its role in the first failure is unproved.

The restart exposed a separate, concrete product recovery defect:

1. `newWatch` in `libs/models/src/mcp-catalogue-watch.ts` starts held. Its first
   refresh saves a failed catalogue check before reading the unchanged catalogue.
   Original positions **1105** and **1106** show this sequence.
2. `applyCheck` in `libs/projections/src/tool-policy.ts` clears the publication
   acknowledgement, sets `driftHeld: true` and makes the policy unpublished.
   A successful unchanged check refreshes the dates but leaves that hold in place.
3. The policy has no previous catalogue. `compareToolCatalogues` in
   `apps/web/src/app/integrations/tool-changes.ts` therefore returns no comparison.
   `canReviewChanges` requires a reviewable comparison, so the browser offers no
   “Review and publish” action. The initial “Review access” action is also absent
   because a publication request already exists.

The final [diagnostic records](rerun3-20261024/diagnostic-probe.json) show fresh
catalogue dates, `published: false`, `driftHeld: true`, no acknowledgement and
publication `applying / preparation / not_current`. The browser says the tools
changed even though the recorded check says unchanged. The diagnostic review
attempts sent no new review or publication command. No saved flag, direct API
publication or access-check bypass was used to get past this defect.

The diagnostic read reserved another **16 euro cents**, with no observed settlement.
Final Spending shows 11 cents settled and 65 cents reserved, including baseline
activity. Across both read attempts there are **0 tool dispatches**, **0 approval
requests** and **0 effects**. Successful model/tool spending reconciliation remains
NOT RUN. This diagnostic restart is not a passing reconnect qualification.

### Captures from this rerun

All 34 new captures were inspected by eye. Email addresses were masked in the
browser; saved JSON redacts addresses. The first publication captures caught loading
states, so they are retained as incomplete captures alongside the loaded views.
The diagnostic files named `saved-audience` show the unavailable audience screen;
they are not evidence of another successful grant. The full capture inventory and
hashes are in [run.json](rerun3-20261024/run.json).

| View | Desktop, 1280 pixels | Mobile, 390 pixels |
| --- | --- | --- |
| Discovered tools | [1280](rerun3-20261024/tools-1280.png) | [390](rerun3-20261024/tools-390.png) |
| Chosen modes | [1280](rerun3-20261024/chosen-modes-1280.png) | [390](rerun3-20261024/chosen-modes-390.png) |
| Saved audience | [1280](rerun3-20261024/saved-audience-1280.png) | [390](rerun3-20261024/saved-audience-390.png) |
| Exact cost review | [1280](rerun3-20261024/review-1280.png) | [390](rerun3-20261024/review-390.png) |
| Published integration, loaded | [1280](rerun3-20261024/publication-loaded-1280.png) | [390](rerun3-20261024/publication-loaded-390.png) |
| Failed read | [1280](rerun3-20261024/read-chat-1280.png) | [390](rerun3-20261024/read-chat-390.png) |
| Reloaded read | [1280](rerun3-20261024/read-chat-reloaded-1280.png) | [390](rerun3-20261024/read-chat-reloaded-390.png) |
| Spending after the first read | [1280](rerun3-20261024/spending-1280.png) | [390](rerun3-20261024/spending-390.png) |
| Change history after the first read | [1280](rerun3-20261024/change-history-1280.png) | [390](rerun3-20261024/change-history-390.png) |
| Publication recovery blocked | [1280](rerun3-20261024/renewal-blocked-1280.png) | [390](rerun3-20261024/renewal-blocked-390.png) |
| Final diagnostic Spending | [1280](rerun3-20261024/diagnostic-spending-1280.png) | [390](rerun3-20261024/diagnostic-spending-390.png) |
| Final diagnostic Change history | [1280](rerun3-20261024/diagnostic-history-1280.png) | [390](rerun3-20261024/diagnostic-history-390.png) |

Native consent 12b stays excluded. Public deployment, twice-fresh runs, approval
expiry, reconnect qualification, Pod loss and the full refusal matrix remain
NOT RUN. This work does not complete #45, #46 or #63.

### Source checks and cleanup for this rerun

PASS: Stage A regression checks, **21 tests**; changed/helper tests twice,
**35 tests per run**; security rules, **438 tests**. The Stage A test output includes
an intentional failing company-limit scenario; all 21 test assertions passed.
The test database was ready before the suites started and was supplied through
`PG_TEST_URL`. It was removed afterwards with its volume.

PASS: lint, typecheck, event catalogue (**153 types**), knip, Markdown and changelog.
Lint reported 25 existing warnings and no errors. All checks and tests ran under
`nice -n 10`.
The full root suite is NOT RUN, as required by the build prompt. The existing
branch changelog fragment remains in place; `CHANGELOG.md` is unchanged.

PASS: slot 1 was released through the dev-stack shutdown command. Its directory,
Compose containers and Kubernetes namespace are absent. The owned launcher stopped,
and the temporary models image was removed. The owner stack was untouched.
