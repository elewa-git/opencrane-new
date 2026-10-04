# Qualification ledger

Results below retain the wording and qualification status in the cited evidence. Dates are UTC dates; where only a date is recorded, no time is implied. Review rows record the review verdict rather than treating source gates as review approval.

## Phase 1

| Date (UTC) | PR | Feature or issue | What was qualified | Result | Key numbers | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-01 | #4 | Event-store stream recreation | Retry stream re-creation config test | PASS | — | [realtime-evidence.md](realtime-evidence.md) |
| 2026-10-01 | #5 | Member invitations | Event-backed invitation acceptance | PASS | — | [realtime-evidence.md](realtime-evidence.md) |
| 2026-10-01 | #6 | Members realtime and shutdown | WebSocket replay/backpressure and graceful shutdown source suite | PASS | 42 files / 821 tests per run; 10 consecutive runs | [realtime-evidence.md](realtime-evidence.md) |
| 2026-10-01 | #16 | NATS authentication | Component-scoped NATS rights and encrypted connections | PASS | — | [nats-auth-evidence.md](nats-auth-evidence.md) |
| 2026-10-01 | #17 | Model proxy isolation spike | Only Codex can use the model proxy inside gVisor computer | PASS | — | [chat-computer-evidence.json](chat-computer-evidence.json) |
| 2026-10-01 | #20 | Organisation settings and MCP register | Shared states and MCP register | PASS | — | [p3-3-mcp-discover.md](p3-3-mcp-discover.md) |
| 2026-10-01 | #21 | Computer and live-view spikes | Resume from disk; view-only default | PASS | — | [live-view-evidence.md](live-view-evidence.md) |
| 2026-10-01 | #22 | Projection replay | Rebuild projections by replay and verify online | PASS | — | [dev-stack-evidence.md](dev-stack-evidence.md) |
| 2026-10-01 | #23 | Dev-box silo | Fresh install core dev-stack journey | PASS | — | [dev-stack-evidence.md](dev-stack-evidence.md) |
| 2026-10-01 | #11 | Zitadel sign-in | Real-service sign-in/out, refusal cases, repeat fresh journeys | PASS | 14 checks in each of two fresh journeys | [signin-evidence.md](signin-evidence.md) |
| 2026-10-01 | #11 | Sign-in independent review | Final review corrections and verification | PASS | 78 focused tests | [signin-evidence.md](signin-evidence.md) |

## Phase 2

| Date (UTC) | PR | Feature or issue | What was qualified | Result | Key numbers | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-02 | #34 | Computer image | Isolated reproducible licence-checked image | PASS | 384/384 licence components; 91 notice files | [chat-computer-evidence.json](chat-computer-evidence.json) |
| 2026-10-02 | #35 | Sign-in | Zitadel sign-in and out in dev stack | PASS | — | [signin-evidence.md](signin-evidence.md) |
| 2026-10-02 | #36 | Member computer lifecycle | Sleep, wake and Pod-loss persistence | PASS | — | [bridge-evidence.md](bridge-evidence.md) |
| 2026-10-02 | #37 | Model gateway | Model calls within silo spending cap | PASS | — | [models-evidence.md](models-evidence.md) |
| 2026-10-02 | #38 | Streamed Codex chat | Replies survive reconnect, sleep and Pod loss | PASS | — | [chat-final-evidence.md](chat-final-evidence.md) |
| 2026-10-02 | #39 | Chat journey | Fresh and repeat chat on development stack | PASS | — | [chat-stack-evidence.txt](chat-stack-evidence.txt) |
| 2026-10-02 | #35 | Sign-in physical-device/browser matrix | Safari and Firefox physical-device qualification | NOT RUN | — | [signin-evidence.md](signin-evidence.md) |
| 2026-10-02 | #36 | Computer lifecycle review fixes | Independent verification of bridge fixes | PARTIAL | Review pass 2 not run at this checkpoint | [bridge-fixes-evidence.md](bridge-fixes-evidence.md) |
| 2026-10-02 | #36 | Bridge replay follow-up review | Focused independent verification of third fix | FAIL | 2 findings passed; third expiry blocker remained | [bridge-replay-evidence.md](bridge-replay-evidence.md) |
| 2026-10-02 | #36 | Bridge full journey after fixes | Fresh full product, production image and paid-provider journey | NOT RUN | — | [bridge-replay-evidence.md](bridge-replay-evidence.md) |
| 2026-10-02 | #36 | Bridge final live journey | Fresh and repeat dev-stack journeys, real paid turn and image | PASS | Fresh 200.11 s; repeat 144.01 s; one real turn | [bridge-evidence.md](bridge-evidence.md) |
| 2026-10-02 | #36 | Real chat provider check | One authorised gpt-6.1-sol turn | PASS | 7.204 s; 3 cents settled | [bridge-evidence.md](bridge-evidence.md) |
| 2026-10-02 | #23 | Fresh/repeat stack journey | Fresh and repeat core journeys and restored owner stack | PASS | — | [chat-stack-evidence.txt](chat-stack-evidence.txt) |
| 2026-10-03 | #64 | Wake latency | Stub wake-to-first-token before/after optimisation | PASS | 11.462 s baseline; 8.944 s after; five runs | [wake-latency-evidence.md](wake-latency-evidence.md) |
| 2026-10-03 | #64 | Wake repair qualification | Missing Kubernetes object recovery and final repeated wake | PASS | 9.120 s median; range 8.981–10.597 s | [wake-latency-evidence.md](wake-latency-evidence.md) |
| 2026-10-03 | #64 | Real-provider wake latency | Real provider latency | NOT RUN | — | [wake-latency-evidence.md](wake-latency-evidence.md) |
| 2026-10-03 | #66 | Chat workspace | Desktop and phone browser journeys, streamed replies, Stop and reload | PASS | — | [chat-ui-evidence.md](chat-ui-evidence.md) |
| 2026-10-03 | #66 | Chat fresh/repeat final stack | Fresh, repeat and restored-main core journeys | PASS | Three stack journeys | [chat-final-stack-evidence.txt](chat-final-stack-evidence.txt) |
| 2026-10-03 | #65 | Odoo Community fixture | Disposable Odoo Community 19 with real user rights | PASS | — | [odoo-fixture-evidence.md](odoo-fixture-evidence.md) |
| 2026-10-03 | #69 | Parallel dev stacks | Two isolated stacks alongside stable owner stack | PASS | Maximum two secondary stacks | [parallel-stacks-evidence.md](parallel-stacks-evidence.md) |
| 2026-10-04 | #79 | File upload and assistant PDF reading | Scan, upload, preview, delivery, edit preservation and real model answer | PARTIAL | One paid turn; 3 cents settled; full suite later FAIL; fresh handback FAIL | [upload-evidence.md](upload-evidence.md) |
| 2026-10-04 | #79 | Paid PDF answer | One real gpt-6.1-sol turn answered Willow-47 | PASS | 1 turn; 3 cents actual; 502 cents reservation | [upload-evidence.md](upload-evidence.md) |
| 2026-10-03 | #79 | Paid PDF answer before custom-tool fix | One real turn, but no final answer because the custom tool history was refused | FAIL | 1 turn; 3 cents settled | [upload-evidence.md](upload-evidence.md) |
| 2026-10-04 | #79 | Paid PDF answer with two provider responses | One chat turn completed without the PDF answer | FAIL | 2 responses; 4 cents settled | [upload-evidence.md](upload-evidence.md) |
| 2026-10-04 | #79 | Upload paid-check aggregate | Four real turns recorded across upload qualification | PARTIAL | 13 cents combined; includes failed answers | [upload-evidence.md](upload-evidence.md) |
| 2026-10-04 | #79 | Upload fresh-install handback | Complete fresh main journey | FAIL | Readiness eventually passed; browser Stop assertion failed | [upload-evidence.md](upload-evidence.md) |
| 2026-10-04 | #79 | Rendered Office previews | Office document preview qualification | NOT RUN | — | [upload-evidence.md](upload-evidence.md) |
| 2026-10-04 | #79 | Upload full suite after final rebase | Latest full root suite | FAIL | 1,226 passed, 14 skipped, 3 failed | [upload-evidence.md](upload-evidence.md) |

## Phase 3

| Date (UTC) | PR | Feature or issue | What was qualified | Result | Key numbers | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-03 | #40 | Phase 3 plan | Governed work specification, tickets and defaults | PASS | 22 tickets | [p3-1-policy-evidence.md](p3-1-policy-evidence.md) |
| 2026-10-03 | #68 | Tool policy | Allow, Ask or Block per tool enforced at gateway | PASS | — | [p3-1-policy-evidence.md](p3-1-policy-evidence.md) |
| 2026-10-03 | #68 | Policy fresh/repeat qualification | Real gateway refusal, saved UI policy and durable deny audit | PASS | 403; zero upstream calls; 66 grant event IDs preserved | [p3-1-live/README.md](p3-1-live/README.md) |
| 2026-10-03 | #68 | Policy first repeat attempt | Provider-input step in browser | FAIL | — | [p3-1-live/repeat-attempt1.txt](p3-1-live/repeat-attempt1.txt) |
| 2026-10-03 | #72 | Approval card | One-time approval bound to viewed action | PASS | — | [p3-2-approvals.md](p3-2-approvals.md) |
| 2026-10-03 | #72 | Approval fresh/repeat browser journey | Approval request, approve/deny and refusal cases | PASS | Fresh and repeat journeys; rebased journey retained | [p3-2-live/fresh/journey.txt](p3-2-live/fresh/journey.txt) |
| 2026-10-03 | #72 | Approval independent review | Two-pass review of approval implementation | PASS | — | [p3-2-approvals.md](p3-2-approvals.md) |
| 2026-10-03 | #71 | Paying-group budgets | Monthly budgets in euro cents | PASS | — | [p3-13-budgets-evidence.md](p3-13-budgets-evidence.md) |
| 2026-10-03 | #71 | Budget fresh/repeat journeys | Assistant/group budget and refusal journeys | PASS | — | [p3-13-live/README.md](p3-13-live/README.md) |
| 2026-10-03 | #71 | Real provider tokenisation margin | Live provider tokenisation against planning allowance | NOT RUN | — | [p3-13-budgets-evidence.md](p3-13-budgets-evidence.md) |
| 2026-10-03 | #73 | Live computer view | Read-only viewer, grant revocation and audit | PASS | Revocation bound 2 s; pixels clear in 341 ms and 334 ms | [live-view-evidence.md](live-view-evidence.md) |
| 2026-10-03 | #73 | Live view independent review | Two-pass security and lifecycle review | PASS | Five initial blockers; all resolved in pass 2 | [live-view-review-fixes-evidence.md](live-view-review-fixes-evidence.md) |
| 2026-10-03 | #73 | Viewer revoke pixel-clear measurement | Fresh and repeat journeys | PASS | 341 ms; 334 ms | [live-view/receipt.json](live-view/receipt.json) |
| 2026-10-03 | #74 | Audit history | Requester action and admin change history | PASS | 576 hostile HTTP variants leaked no canary | [p3-19-audit-evidence.md](p3-19-audit-evidence.md) |
| 2026-10-03 | #74 | Audit fresh/repeat stack journeys | Action/change history, member refusal and log canaries | PASS | Fresh and repeat journeys | [p3-19-live/fresh.txt](p3-19-live/fresh.txt) |
| 2026-10-04 | #76 | Chat reservation bound | Budget hold reduced to request-sized estimate | PASS | 502 cents before; about 3 cents after | [upload-evidence.md](upload-evidence.md) |
| 2026-10-04 | #78 | MCP server registration and discovery | Fresh/repeat MCP discovery assertions | PASS | 2 tools; both blocked pending review | [p3-3-live/fresh/journey.txt](p3-3-live/fresh/journey.txt) |
| 2026-10-04 | #78 | Full MCP startup journey | Full fresh and repeat startup with live-view steps | PARTIAL | MCP journeys PASS; both complete startup journeys FAIL | [p3-3-mcp-discover.md](p3-3-mcp-discover.md) |
| 2026-10-04 | #78 | MCP independent review | Two-pass review of inventory fixes | PASS | — | [p3-3-mcp-discover.md](p3-3-mcp-discover.md) |
| 2026-10-04 | pending #70 | Exact authority reads | Model, MCP and destination decisions with 100,000 unrelated events | PASS | 30/30 per route per fixture; historical and final suite measurements | [authority-reads.md](../../../authority-reads/docs/process/authority-reads.md) |
| 2026-10-04 | pending #70 | Authority fixture revocation | Membership removal append through NATS, pg-boss and OpenFGA to denial | PASS | 460.1 ms in final suite; 495.5 ms initial evidence | [authority-reads.md](../../../authority-reads/docs/process/authority-reads.md) |
| 2026-10-04 | pending #70 | Authority-read independent review | Source review and focused probes | PASS | Four focused tests; rebased review also PASS | [authority-reads.md](../../../authority-reads/docs/process/authority-reads.md) |
| 2026-10-04 | pending #70 | Authority live/fresh-install qualification | Fresh installed silo and live qualification | NOT RUN | — | [authority-reads.md](../../../authority-reads/docs/process/authority-reads.md) |

## Infrastructure

| Date (UTC) | PR | Feature or issue | What was qualified | Result | Key numbers | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-02 | #23 | Dev-stack full journeys | Fresh, reused and restored owner journeys | PASS | — | [dev-stack-evidence.md](dev-stack-evidence.md) |
| 2026-10-03 | #64 | Busy dev-stack wake | Wake-to-first-token on busy shared dev host | PASS | 16.631 s; host load not controlled | [p3-1-live/repeat-stack.txt](p3-1-live/repeat-stack.txt) |
| 2026-10-03 | #64 | Member join to Ready | Fresh/repeat lifecycle observations | PASS | 310 ms fresh-stack run | [p3-1-live/repeat-stack.txt](p3-1-live/repeat-stack.txt) |
| 2026-10-03 | #64 | Message to first reply | Joined member HTTP message, streamed Codex/stub reply | PASS | 6,273 ms total; first token 4,521 ms | [p3-1-live/repeat-stack.txt](p3-1-live/repeat-stack.txt) |
| 2026-10-04 | #69 | Two isolated secondary stacks | Concurrent isolated dev-stack journeys and owner preservation | PASS | Two secondary stack limit | [parallel-stacks-evidence.md](parallel-stacks-evidence.md) |
| 2026-10-04 | #78 | MCP complete startup check on secondary stack | Fresh/repeat complete startup journeys including live-view | FAIL | Fresh live-view timeout; repeat decoded-pixels timeout | [p3-3-mcp-discover.md](p3-3-mcp-discover.md) |

## Still NOT RUN

The evidence does not qualify these conditions yet:

- Managed-cluster, HA, failover and disaster-recovery qualification.
- Real-phone and physical-device journeys; Safari is also NOT RUN in the sign-in evidence.
- Firefox and WebKit browser qualification.
- Real-provider wake latency and fresh full-install qualification for the wake repair.
- Real OpenAI/paid-provider coverage outside the explicitly recorded one-turn receipts; the opt-in paid suite remains skipped.
- Fresh-install live authority-reads qualification for pending #70.
- Approval-browser live qualification where receipts identify the opt-in approval journey as skipped.
- Rendered Office previews and upload's completed fresh handback journey.
- MCP live-view reliability across complete startup journeys; the isolated MCP assertions passed but complete runs failed.
