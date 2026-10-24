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
