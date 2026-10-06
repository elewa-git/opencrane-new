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
| PPL-63 private session | The selected shared assistant, private conversation and fixed payer id | `POST /api/conversations` records `assistantId`, `createdBy`, `mode: agent_session` and `payingGroupId`; the conversation list returns the same ids | The list does not return a payer name here, so the screen shows its group id. It does not show sample messages. |
| PPL-64 payer confirmation | Fixed paying group before session creation | Assistant row `payingGroupId`; conversation creation must repeat that id | Payer id is shown when no group name is supplied by the member route. |
| THR-07 assistant draft | One shared assistant recipient | `GET /api/assistants` returns rows the caller may read and `canStartSession` | People and an assistant are not combined in this picker. |
| THR-08 people plus assistant | Not offered by this screen | The conversation create schema accepts either `direct` with a colleague or `agent_session` with an assistant | The two modes cannot share one new conversation command. |
| THR-21 queued, starting and ready child | Not available yet | No child start API or child projection exists in P4-7 | Child work belongs to the later delegation feature. |
| THR-22 failed or unknown child start | Not available yet | No child start command or status route exists in P4-7 | The private session create status check reads only its original conversation command. |
| THR-23 no eligible child assistant | Not available yet | No child assistant eligibility route exists in P4-7 | The private session picker does show when it has no eligible shared assistants. |

## Check receipts

| Check | Result |
| --- | --- |
| Clean install | PASS — `nice -n 10 npm ci` |
| Typecheck | PASS — root workspace typecheck and Angular app, spec and browser-test checks |
| Web tests | PASS — 408 tests across 36 files |
| Visual captures | PASS — 66 captures at 1280, 390 and 320px with normal and reduced motion |
| F1–F5 checks | PASS — all five existing visual checks |
| Lint, event catalogue and Angular build | PASS — lint has existing length warnings and Knip hints |
| Assistant and private chat route tests | PASS — 28 tests across both server route files |
| Live two-member MCP check | NOT RUN — needs two live requesters and a recording MCP service. |
| Separate member disk and browser profiles | NOT BUILT — the backend shares these resources. |
