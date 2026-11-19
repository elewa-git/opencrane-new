# JSON comparison audit

Baseline: `f316313f0265e5678c49fc1dcf2c03cbcc3d17d2`.

The issue's grep counts 64 sites on this baseline. An AST walk of production
TypeScript finds 73 direct equality comparisons because it also reads multiline
expressions and nested calls.
All 73 are listed below using their baseline line numbers. Nineteen migrate;
54 retain their exact existing comparison. No stored text or digest changes.

The owner's key-order decision applies to `sameJson`. The task separately requires
preserving sensitive checks that could accept a previously refused reordered value.
FLAG marks these retained checks, including conservative preservation of replay
verification gates. Each has a narrow lint exception with its reason. These are
explicit exceptions to the issue's literal zero-grep acceptance criterion; no
comparison is hidden behind a renamed text helper or indirect equality. The issue's
grep now reports 49; it misses five of the 54 retained AST comparisons.

Ten web sites describe differences; they grant no access and do not alter review
bindings. Stored revision and catalogue digests remain exact: a revision change
still produces a Details changed row even when only object key order differs.
The other nine migrated sites compare primitives or arrays of strings (including
ordered string pairs), so sorting object keys cannot change their results.

| # | Baseline site and function | Comparison decides | Action and reason |
| --- | --- | --- | --- |
| 1 | `apps/computer/src/bridge-gate.ts:22` (`close`) | Repeated bridge gate must bind the same signed stop authority. | FLAG: keep exact JSON text. Preserve exact stop authority binding. |
| 2 | `apps/computer/src/mcp-proxy.ts:496` (`bindCatalogue`) | Reused catalogue address must retain the same server definitions. | FLAG: keep exact JSON text. Preserve exact tool catalogue binding. |
| 3 | `apps/computer/src/supervisor-stop.ts:129` (`sameRequest`) | Repeated supervisor stop must match its saved request. | FLAG: keep exact JSON text. Preserve exact stop retry conflict detection. |
| 4 | `apps/computer/src/thread-loads.ts:74` (`privateTools`) | Private memory tools must match their approved tool list. | FLAG: keep exact JSON text. Preserve exact private tool grant binding. |
| 5 | `apps/computer/src/worker-request.ts:103` (`operation`) | Only the fixed npm argument vector selects the npm worker operation. | sameJson; values contain no object keys to reorder |
| 6 | `apps/ops/src/departure-cleanup.ts:39` (`savedDeparture`) | Departure cleanup requires the original saved removal payload. | FLAG: keep exact JSON text. Preserve exact saved departure proof before cleanup. |
| 7 | `apps/ops/src/memory-cleanup.ts:54` (`cleanupHistory`) | Memory cleanup requires the original saved deletion target. | FLAG: keep exact JSON text. Preserve exact saved deletion target proof. |
| 8 | `apps/server/src/assistants/commands.ts:31` (`previous`) | Assistant creation retry must match the original command, grants and payer. | FLAG: keep exact JSON text. Preserve exact assistant creation retry binding. |
| 9 | `apps/server/src/chat/bridge-control.ts:125` (`matchesReceipt`) | Bridge receipt must name exactly the sent affected turn IDs. | sameJson; values contain no object keys to reorder |
| 10 | `apps/server/src/chat/commands.ts:103` (`sameGroupCreation`) | Group creation retry must match the saved participant IDs. | sameJson; values contain no object keys to reorder |
| 11 | `apps/server/src/chat/groups.ts:123` (`reviewedGroup`) | Reviewed group membership must match the current participant IDs. | sameJson; values contain no object keys to reorder |
| 12 | `apps/server/src/chat/reports.ts:96` (`canCombineReports`) | Adjacent message deltas may combine only with matching report identities. | FLAG: keep exact JSON text. Preserve exact report identity binding. |
| 13 | `apps/server/src/chat/turns.ts:393` (`verifyBinding`) | Saved turn must match the requested input and budget binding. | FLAG: keep exact JSON text. Preserve exact turn input and budget binding. |
| 14 | `apps/server/src/computers/screenshots.ts:64` (`callback`) | Screenshot delivery must retain the originally checked computer access. | FLAG: keep exact JSON text. Preserve exact computer access binding. |
| 15 | `apps/server/src/computers/view-lease.ts:158` (`acceptSuccess`) | Live viewer success must still match the expected computer identity. | FLAG: keep exact JSON text. Preserve exact computer access binding. |
| 16 | `apps/server/src/egress/changes.ts:55` (`checkOriginal`) | Egress policy command retry must match the original saved payload. | FLAG: keep exact JSON text. Preserve exact egress command conflict detection. |
| 17 | `apps/server/src/files/commands.ts:153` (`fileCommand`) | Concurrent file append retry must have saved identical event data. | FLAG: keep exact JSON text. Preserve exact file command retry conflict detection. |
| 18 | `apps/server/src/files/commands.ts:173` (`verifyRetry`) | Existing file command ID must match payload, type and member. | FLAG: keep exact JSON text. Preserve exact file command retry conflict detection. |
| 19 | `apps/server/src/integrations/access-changes.ts:37` (`checkOriginal`) | Tool access change retry must match the original grant command. | FLAG: keep exact JSON text. Preserve exact grant command retry conflict detection. |
| 20 | `apps/server/src/integrations/hosted-capture.ts:26` (`sameRun`) | Hosted discovery must still observe the originally checked workload. | FLAG: keep exact JSON text. Preserve exact hosted workload binding. |
| 21 | `apps/server/src/memory/agent-lineage.ts:27` (`checkEvidence`) | Memory agent evidence must match current input lineage. | FLAG: keep exact JSON text. Preserve exact memory lineage evidence binding. |
| 22 | `apps/server/src/memory/commands.ts:388` (`finishRecovery`) | Recovery ignores a command journal changed by another server. | FLAG: keep exact JSON text. Preserve exact concurrent command recovery check. |
| 23 | `apps/server/src/memory/correct.ts:70` (`originalReceipt`) | Memory correction retry must match its saved dependencies. | FLAG: keep exact JSON text. Preserve exact memory correction retry binding. |
| 24 | `apps/server/src/memory/invalidation.ts:204` (`recordInvalidation`) | Memory invalidation requires unchanged current input context. | FLAG: keep exact JSON text. Preserve exact memory input conflict detection. |
| 25 | `apps/server/src/memory/invalidation.ts:205` (`recordInvalidation`) | Memory invalidation requires each event ID and its saved JSON text to match, in order. | sameJson; values contain no object keys to reorder |
| 26 | `apps/server/src/memory/recall-delivery.ts:83` (`recordRecall`) | Recall delivery requires the originally checked memory input. | FLAG: keep exact JSON text. Preserve exact recall input conflict detection. |
| 27 | `apps/server/src/models/access-changes.ts:128` (`checkOriginal`) | Model access change retry must match the original saved command. | FLAG: keep exact JSON text. Preserve exact model grant retry conflict detection. |
| 28 | `apps/server/src/onboarding/commands.ts:158` (`matchesSavedCommand`) | Survey save retry must match the original decrypted answers. | FLAG: keep exact JSON text. Preserve exact survey retry conflict detection. |
| 29 | `apps/server/src/routine-admin-pause.ts:63` (`requireSamePause`) | Admin routine pause retry must match the original control payload. | FLAG: keep exact JSON text. Preserve exact routine pause retry conflict detection. |
| 30 | `apps/server/src/routine-pause.ts:63` (`requireSamePause`) | Routine pause retry must match the original control payload. | FLAG: keep exact JSON text. Preserve exact routine pause retry conflict detection. |
| 31 | `apps/server/src/routine-retire.ts:65` (`requireSameRetirement`) | Routine retirement retry must match the original control payload. | FLAG: keep exact JSON text. Preserve exact routine retirement retry conflict detection. |
| 32 | `apps/web/src/app/integrations/tool-changes.ts:108` (`compareTool`) | Add the output-schema-changed description to the comparison row. | sameJson; ignore object key order in display only |
| 33 | `apps/web/src/app/integrations/tool-changes.ts:134` (`detailChanges`) | Add the annotations-changed description. | sameJson; ignore object key order in display only |
| 34 | `apps/web/src/app/integrations/tool-changes.ts:137` (`detailChanges`) | Add the metadata-changed description for metadata. | sameJson; ignore object key order in display only |
| 35 | `apps/web/src/app/integrations/tool-changes.ts:138` (`detailChanges`) | Add the metadata-changed description for _meta. | sameJson; ignore object key order in display only |
| 36 | `apps/web/src/app/integrations/tool-changes.ts:160` (`schemasDiffer`) | Classify the tool row as schema changed when its input schema differs. | sameJson; ignore object key order in display only |
| 37 | `apps/web/src/app/integrations/tool-changes.ts:161` (`schemasDiffer`) | Classify the tool row as schema changed when its output schema differs. | sameJson; ignore object key order in display only |
| 38 | `apps/web/src/app/integrations/tool-changes.ts:172` (`inputFieldChanges`) | List a changed input field by name. | sameJson; ignore object key order in display only |
| 39 | `apps/web/src/app/integrations/tool-changes.ts:225` (`appendOutputSchema`) | Skip output schema detail when unchanged. | sameJson; ignore object key order in display only |
| 40 | `apps/web/src/app/integrations/tool-changes.ts:246` (`appendInputFields`) | Skip input field detail when unchanged. | sameJson; ignore object key order in display only |
| 41 | `apps/web/src/app/integrations/tool-changes.ts:257` (`appendInputFields`) | Show complete input schema detail when no changed top-level field is visible. | sameJson; ignore object key order in display only |
| 42 | `libs/authz/src/rebuild.ts:67` (`rebuildMembers`) | Verify the rebuilt OpenFGA tuple snapshot against the live snapshot. | sameJson; values contain no object keys to reorder |
| 43 | `libs/event-store/src/jetstream.ts:114` (`verifyEventsConfig`) | Refuse incompatible EVENTS stream configuration. | sameJson; values contain no object keys to reorder |
| 44 | `libs/events/src/routine-fold.ts:46` (`saveRun`) | Routine run must match its saved active definition and spending input. | FLAG: keep exact JSON text. Preserve exact routine input and budget binding. |
| 45 | `libs/events/src/routine-fold.ts:51` (`saveRun`) | An already active routine run must be identical for idempotent acceptance. | FLAG: keep exact JSON text. Preserve exact active run idempotency. |
| 46 | `libs/handlers/src/registration.ts:37` (`checkHandlers`) | Registered handler subscriptions must match the event catalogue. | sameJson; values contain no object keys to reorder |
| 47 | `libs/models/src/egress-receipt.ts:58` (`saveEvidence`) | Existing durable egress evidence must match before accepting a file collision. | FLAG: keep exact JSON text. Preserve exact durable egress evidence conflict detection. |
| 48 | `libs/models/src/egress-receipt.ts:128` (`capture`) | Captured egress evidence must match an already pending observation. | FLAG: keep exact JSON text. Preserve exact pending egress evidence binding. |
| 49 | `libs/models/src/egress-receipt.ts:141` (`saved`) | Saved egress evidence must match the pending observation before reporting saved. | FLAG: keep exact JSON text. Preserve exact saved egress evidence binding. |
| 50 | `libs/models/src/mcp-dispatch.ts:365` (`requireCurrentRoute`) | Credential-bearing dispatch must still use the permitted backend route. | FLAG: keep exact JSON text. Preserve exact credential dispatch route binding. |
| 51 | `libs/models/src/mcp-instance-observation.ts:56` (`checkSavedObservation`) | Instance observation retry must match the original payload. | FLAG: keep exact JSON text. Preserve exact instance observation retry conflict detection. |
| 52 | `libs/models/src/mcp-instance.ts:103` (`reconcileStop`) | Instance stop receipt must match the attempted stop payload. | FLAG: keep exact JSON text. Preserve exact instance stop retry conflict detection. |
| 53 | `libs/models/src/mcp-instance.ts:151` (`mcpInstanceCommand`) | Instance stop retry must match the originally saved stop. | FLAG: keep exact JSON text. Preserve exact instance stop retry conflict detection. |
| 54 | `libs/models/src/memory-context.ts:62` (`verifyMemoryContext`) | Memory token scopes must match the requested scope IDs. | sameJson; values contain no object keys to reorder |
| 55 | `libs/models/src/provider-bindings.ts:168` (`reconcileBinding`) | Provider binding retry must match the original saved payload. | FLAG: keep exact JSON text. Preserve exact provider binding retry conflict detection. |
| 56 | `libs/models/src/provider-verification.ts:118` (`requestProviderVerification`) | Provider verification retry must match the original request payload. | FLAG: keep exact JSON text. Preserve exact provider verification retry conflict detection. |
| 57 | `libs/models/src/provider-verification.ts:154` (`admitProviderVerification`) | Provider verification admission must match the original saved request. | FLAG: keep exact JSON text. Preserve exact provider verification request binding. |
| 58 | `libs/models/src/providers.ts:174` (`reconcileProvider`) | Provider command reconciliation must match the original saved payload. | FLAG: keep exact JSON text. Preserve exact provider command retry conflict detection. |
| 59 | `libs/models/src/providers.ts:199` (`providerCommand`) | Provider command retry must match the original saved payload. | FLAG: keep exact JSON text. Preserve exact provider command retry conflict detection. |
| 60 | `libs/models/src/rebuild.ts:27` (`sameRows`) | Verify replayed money call, effect and permit rows against live rows. | FLAG: keep exact JSON text. Preserve exact budget replay verification. |
| 61 | `libs/models/src/rebuild.ts:42` (`rebuildLocked`) | Verify replayed silo budget rows against live rows. | FLAG: keep exact JSON text. Preserve exact budget replay verification. |
| 62 | `libs/models/src/reconciliation.ts:177` (`resolveEffect`) | Money effect resolution retry must match the saved resolution payload. | FLAG: keep exact JSON text. Preserve exact money effect resolution conflict detection. |
| 63 | `libs/models/src/tool-dispatch.ts:106` (`recordObservation`) | Tool dispatch receipt retry must match the original observation. | FLAG: keep exact JSON text. Preserve exact tool dispatch receipt retry binding. |
| 64 | `libs/models/src/tool-dispatch.ts:162` (`requireSameAdapter`) | Tool dispatch evidence must match the decision adapter binding. | FLAG: keep exact JSON text. Preserve exact tool dispatch adapter binding. |
| 65 | `libs/projections/src/audit-rebuild.ts:25` (`callback`) | Detect a difference between current and rebuilt audit rows. | FLAG: keep exact JSON text. Preserve exact audit replay verification. |
| 66 | `libs/projections/src/group-rebuild.ts:71` (`rebuild`) | Verify rebuilt group rows before replacement and report whether changed. | FLAG: keep exact JSON text. Preserve exact group replay verification. |
| 67 | `libs/projections/src/model-access-rebuild.ts:59` (`rebuild`) | Verify rebuilt model access rows before replacement and report whether changed. | FLAG: keep exact JSON text. Preserve exact model access replay verification. |
| 68 | `libs/projections/src/provider-rebuild.ts:59` (`rebuild`) | Verify rebuilt provider rows before replacement and report whether changed. | FLAG: keep exact JSON text. Preserve exact provider replay verification. |
| 69 | `libs/projections/src/rebuild.ts:54` (`callback`) | Verify rebuilt member rows before replacement and report whether changed. | FLAG: keep exact JSON text. Preserve exact member replay verification. |
| 70 | `libs/projections/src/rebuild.ts:170` (`callback`) | Verify rebuilt tool catalogue rows before replacement and report whether changed. | FLAG: keep exact JSON text. Preserve exact MCP catalogue replay verification. |
| 71 | `libs/projections/src/rebuild.ts:276` (`callback`) | Verify rebuilt computer rows before replacement and report whether changed. | FLAG: keep exact JSON text. Preserve exact computer replay verification. |
| 72 | `libs/projections/src/tool-policy.ts:237` (`applyCapture`) | Accept a catalogue capture only for the saved hosted workload. | FLAG: keep exact JSON text. Preserve exact approval catalogue workload binding. |
| 73 | `libs/projections/src/tool-policy.ts:310` (`applyCheck`) | Renew a catalogue check only for the saved hosted workload. | FLAG: keep exact JSON text. Preserve exact approval catalogue workload binding. |
