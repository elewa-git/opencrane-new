# Shared assistants in private sessions

The screens use the shared assistant and private conversation routes already
served by the app. They show only values returned by those routes. The
screenshots are from a browser with API replies supplied by the visual check;
they do not prove live access or computer provisioning.

## Frame bindings

| Frame | What the screen shows | API fact or event | Difference from the frame |
| --- | --- | --- | --- |
| PPL-60 | Name, owner group, payer, model and tool grants, then review | `POST /api/assistants` appends `assistant.created` with `ownerId`, `payingGroupId`, `name` and `grants` | The computer id is assigned after creation, so the draft says it will be assigned. Choices come from the model list and owner group grants. |
| PPL-60 review | Group-wide resource effect, payer and separate desktop access | Creation data and group grants; the server reaction grants each selected resource to the assistant and owner group | The payer can be another listed group. The review uses its returned name. |
| PPL-61 setup | Assistant lifecycle from `claiming` or `starting` | `GET /api/assistants` row `status` | No timer creates a ready state. |
| PPL-61 ready and busy | Ready or busy label | Row `status: ready` and `busy: true` | The route gives a busy flag, not a queued request count. Add-computer is omitted because no add-computer command exists. |
| PPL-62 provisioning failure | Not available yet | No failed provisioning status or retry command is returned | A lost computer is shown as lost; it does not prove that nothing was created. |
| PPL-62 removed | Removed lifecycle state | Row `status: retired` | No removal date is returned, so no date is shown. |
| PPL-62 permission revoked | Access changed and cleared details | A 401 or 403 from the assistant read | The refusal does not name which grant changed. |
| PPL-63 private session | A private team session and the saved paying group id | `POST /api/conversations` records `assistantId`, `createdBy`, `mode: agent_session` and `payingGroupId`; the conversation list returns the same ids | The list does not return the assistant or payer's display name here, so the workspace shows the payer id. It does not show sample messages. |
| PPL-64 payer confirmation | Fixed paying group before session creation | Assistant row `payingGroupId`; conversation creation must repeat that id | Payer id is shown when no group name is supplied by the member route. |
| THR-07 assistant draft | One shared assistant recipient | `GET /api/assistants` returns rows the caller may read and `canStartSession` | The picker is a separate page. Text in a draft is not carried to it. People and an assistant are not combined in this picker. |
| THR-08 people plus assistant | Not offered by this screen | The conversation create schema accepts either `direct` with a colleague or `agent_session` with an assistant | The two modes cannot share one new conversation command. |
| THR-21 queued, starting and ready child | Not available yet | No child start API or child projection exists in P4-7 | Child work belongs to the later delegation feature. |
| THR-22 removed shared assistant | Not available yet | The workspace has no event-backed banner naming a removed assistant | The picker filters assistants that the member cannot start. |
| THR-23 no eligible child assistant | Not available yet | No child assistant eligibility route exists in P4-7 | The private session picker does show when it has no eligible shared assistants. |

## Check receipts

| Check | Result |
| --- | --- |
| Rebase onto the fixed admin branch | PASS — conflicts kept main's private-turn rules, recovery states and memory-free mode. |
| Root typecheck | PASS — `nice -n 10 npm run typecheck` |
| Lint | PASS — 9 existing length warnings and 2 Knip hints; no errors. |
| Angular build | PASS — existing CSS budget and noVNC module warnings remain. |
| Web tests | PASS — 436 tests across 36 files. |
| Server route tests | PASS — 73 tests across shared assistant and chat route suites, with throwaway PostgreSQL. |
| Event catalogue | PASS — all 96 event types match. |
| P4-7 browser captures | PASS — 114 captures across 19 states at 1280, 390 and 320px, with both motion settings. |
| Chat browser check | PASS — keyboard, focus, touch targets, streaming, reload, offline retry, wake state and scoped frames. |
| F5 workspace | PASS — 18 captures at 1280, 390 and 320px, with reduced motion. |
| P4-14 chat | PASS — 24 captures. |
| 403 status guard spec | PASS — failed when the 403 case was removed, then passed when restored. |
| Eligibility and pending-choice guard specs | PASS — each failed with its guard removed, then passed when restored. |
| Live two-member MCP check | NOT RUN — needs two live requesters and a recording MCP service. |
| Separate member disk and browser profiles | NOT BUILT — the backend shares these resources. |
