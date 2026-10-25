# OpenCrane 1 standards review

1 October 2026. Recommendation: keep independent adversarial review, typed checks, security tests and live installation evidence. Remove the duplicated instructions, global PR policing and custom style machinery. The [proposed standards](standards.md) describe the smaller replacement and its first implementation change.

## Evidence and limits

Read-only source snapshot: OpenCrane 1 at `<home>/Documents/GitHub/opencrane-2`, commit [`468742b97`](https://github.com/elewa-git/opencrane/commit/468742b97d6ce728a8d85d55e7fc3d1d69ca25e2). Its latest develop product merge is `10abd0ef6`; the two later commits preserve design/research. Unless labelled OC2, `file:line` references below belong to this OC1 snapshot. GitHub PR/run links identify the historical evidence separately.

Read all 14 agents, ten skills, four commands, review policy, hook, settings hooks/permissions, AGENTS/CLAUDE, all agent rule documents, five workflows and every scripts gate family, including helpers and negative fixtures. Skimmed the deploy ledger. Reviewed the documentation surfaces and the explicit ten-plus-ten sample below. Read all requested owner-memory files as background evidence, not as current executable instructions. No deployments, product tests, site builds or runtime claims were requalified during this review.

Read-only `gh` queries worked. PR sample: latest 200 PRs as retrieved on 1 October, #680–#918, created 19 August–30 September. CI window: **2 August–30 September inclusive**, 60 complete UTC days. Queried 399 develop-associated workflow runs; excluded the 1 October run, leaving 398. Retrieved failed-job/step metadata for all 90 failed validation/nightly runs, and inspected representative logs. CI counts describe runs, not unique bugs or developer time. Source inspection, history and measured records are distinguished from owner recollections and estimates.

## What slowed development

| Measure | Observed result | Meaning and limitation |
| --- | ---: | --- |
| PR outcomes | 72 merged, 108 closed unmerged, 20 open | **60% of terminal PRs** were closed unmerged (108/180); 54% of the whole sample. Absorbed PRs are not necessarily discarded work. |
| Time from creation to merge | Median **10.1 hours**; nearest-rank p90 **251.1 hours**; maximum **279.4 hours** | 72 merged PRs only. Includes overnight waiting; does not isolate review time, earlier branch work or open PRs. |
| PR size, additions + deletions | Median **587** lines; merged median **666.5**; **63/200** over 1,500; **17/200** over 10,000 | GitHub totals include generated files and cumulative stacked diffs; not directly comparable to OC2's non-generated budget. |
| Commits per PR | Median **2**; merged median **3**; 1,551 PR/commit associations | Deduplicating shared stack commits leaves **1,242 distinct SHAs**. #826 has 147 commits; #745 has 121. |
| Gate/review message proxy | **48/1,242 distinct commits (3.9%)**, or 56/1,551 associations | Case-insensitive `style`, `module[- ]growth`, `stack[- ]integrity`, `review`, `verifier`, `lint`, `baseline`, `digest`. This is not a count of wasted fixes. |
| Clear process/mechanical maintenance within that proxy | **9 distinct commits** | Six style/checker fixes, two digest refreshes and one review-order update; enumerated below. Other matches include product “computer review”, visual acceptance and real database repairs. |
| Stacking | **131/200** PRs have feature/tier bases rather than develop | Stored base/head names reconstruct a 45-PR chain ending #824; this is historical linkage, not proof all 45 were open simultaneously. |

The nine conservative maintenance examples are `7321d3fbe` (#909, private naming), `cbdb742d4` (#826, style), `f042c1906` (#756, style), `4c3e47513` (#707, indentation), `058681656` (#826, style diff-scope repair), `3b4b7133a` (#702, Prisma diff-scope repair), `8be8e5b3e` (#752, baseline digest), `205f44670` (#745, schema digest), and `1548b6869` (#908, review order). This lower bound excludes fixes whose purpose cannot be established from their title. No reliable hours-lost estimate follows from commit counts.

Stacking repeatedly ended in large consolidations. [#888](https://github.com/elewa-git/opencrane/pull/888) explicitly absorbed **35 predecessor PRs**, closing them, then merged **98,109 changed lines**. [#826](https://github.com/elewa-git/opencrane/pull/826) absorbed earlier conversation/runtime branches and merged **132,199 changed lines**. [#900](https://github.com/elewa-git/opencrane/pull/900) lists a ten-PR review chain; a documentation-only parent repair required another restack and a patch-id comparison. Small slices did not produce consistently small final review surfaces.

Some overhead is directly documented. [#753](https://github.com/elewa-git/opencrane/pull/753), commit `9715dedbb`, records a 20-minute CI run: about 11 minutes building six images serially, 4.5 minutes exporting their caches, and 2.6 minutes in the style scan. Its proposed 20→12-minute critical path is an **estimate**, not a measured result here. Commit `3a252ddcc` records an earlier style scan of 1,101 files taking about seven minutes, reduced to 36 seconds. Parallelisation subsequently needed the two diff-scope repairs above. These are author-recorded timings, not fresh benchmarks.

The instruction estate itself required maintenance: **2,009 agent lines + 1,588 skill lines + 352 command lines**; agent rule documents add **3,945 lines**, including a 1,383-line ledger. AGENTS/CLAUDE, review policy and hook bring this inspected prose/hook set to **8,396 lines**. Nine of ten skills are byte-identical agent copies; the observability copy has drifted. Five workflows add 1,272 lines; `scripts/` has 79 files / 8,832 lines including tests/fixtures; five JSON inventories add 3,957 lines. These are maintenance-surface counts, not token-cost estimates.

Concrete contradictions explain why fewer rules can be stricter:

- `AGENTS.md:112–126` requires three harness copies; `.agents/skills/observability/SKILL.md:108` retains manual style rules removed from the agent.
- `.claude/settings.json:19` still demands a final comments-agent pass; `review-loop.md:34` makes it conditional.
- `docs/agents/app-specific.md:8` and `monorepo.md:114` require app version stamps; `versioning.md:5` and `monorepo.md:118` remove them pre-MVP.
- `docs/agents/typescript.md:127` demands a nine-column per-file compliance table after mechanical checking; `:210` demands JSDoc on every field. The comments agent says to delete restatements, yet `comments.md:201` insists an empty ASK list on a large slice means guessing.
- `prisma.md:54` permits named raw adapters; `review.md:43` bans raw methods unconditionally.

The owner had already pushed back: memory `feedback_execute_plan.md:18` records repeated full-plan reads, investigation rounds and redundant validation; `project_pre_mvp_velocity_posture.md:14` records the decision to reduce overhead. Commit `218f9311c` removed 12,222 lines across 108 files of pre-MVP migration machinery. The lesson is to avoid rebuilding the same process in OC2.

## Why develop CI was red

The principal validation/publication workflow had **140 runs: 77 failed (55%), 47 succeeded, 16 cancelled**. The nightly workflow had **60 runs: 13 failed, 47 succeeded**. Nightly success can mean no validation: `nightly.yml:54–79` skips work if a branch has no commit in 24 hours. In the green [30 September run](https://github.com/elewa-git/opencrane/actions/runs/36661188435), all three branches skipped installation, database tests, guards and build/test/lint. The other 198 runs were CodeQL (148 successes), Dependabot (27 successes / 18 failures), dependency graph (three successes), and stack workflow (one success / one cancellation). A CodeQL workflow success is not proof it found no alerts.

Failed-job categories below are distinct runs within each category; rows overlap because one run can fail several jobs. They account for the 77 failed primary-workflow runs, not causal shares of elapsed time.

| Failed step/job family | Runs | Evidence |
| --- | ---: | --- |
| Mechanical style, including embedded Prisma guard | 31 | Latest [run 36121150081](https://github.com/elewa-git/opencrane/actions/runs/36121150081): 25 errors across six files; old Prisma ownership rules plus house style applied to vendored UI source. |
| k3d smoke/setup | 20 | Same latest run stops because rendered server support for the reviewed outbound CA bundle is absent; [#913](https://github.com/elewa-git/opencrane/pull/913) remains an explicitly unapproved trust change. One of these 20 failed during runner setup. |
| Storybook contracts/screenshots | 17 | Latest run reports **58 failures**; missing Linux reference images and screenshot differences, not evidence that all 58 are product bugs. |
| Other architecture guards | 13 | Workload/app composition, Prisma ownership and monorepo boundaries; see job metadata in the queried window. |
| Release versions / migrations / convergence | 10 | [Run 33300890573](https://github.com/elewa-git/opencrane/actions/runs/33300890573): group-hierarchy target digest did not match the clean baseline. |
| Database authority tests | 7 | Includes real remote-MCP baseline/test incompatibility, not just formatting. |
| Build/test/lint proper | 5 | Jobs reached project build/test/lint and failed there. |
| Generated API/client | 5 | Generated contract verification failed; retain the underlying drift check. |
| Module growth | 4 | [Run 30893117761](https://github.com/elewa-git/opencrane/actions/runs/30893117761): a shell gate grew **678→679 lines**, triggering the 500-line maximum. |
| Cognee provider contract | 1 | Failed pinned-provider contract job; this is behavioural evidence, not style overhead. |

Of the 13 failed nightlies, ten stopped in the combined guard step, two in full project build/test/lint, and one in PostgreSQL authority tests. [2 August's run](https://github.com/elewa-git/opencrane/actions/runs/30730761636) rejected two Prisma composition imports; [1 September's run](https://github.com/elewa-git/opencrane/actions/runs/33463272325) rejected same-line `if` bodies and Prisma ownership. [25 September's run](https://github.com/elewa-git/opencrane/actions/runs/36086971558) failed five remote-MCP SQL cases. Therefore “the whole 60 days were red only for gate reasons” would be false.

At the latest develop SHA, database authority, history-store, Cognee, API and image proofs succeeded while style, k3d and Storybook failed. Its style diff still used `d5007454a` from 7 August as `GUARD_BASE`, expanding the scope beyond the latest PR. This verifies the corrected owner-memory account; it does not support blaming the history store for the smoke failure.

Repository protection read on 1 October required one approving review but **no required status checks**, with admin enforcement off. That is a material enforcement gap: elaborate gates could remain red while changes merged. OC2 needs its four checks to determine whether a change can land, not more gate names. Its current `.github/workflows/ci.yml:21–31` already runs those four commands.

## What actually protected quality

| Evidence | Defect or invalid claim corrected | Keep |
| --- | --- | --- |
| [#745](https://github.com/elewa-git/opencrane/pull/745), CodeQL review comments dated 30 August; fixes `c13976855`, `775befdaa`; merged 31 August | Workload skill routes lacked rate limiting. The final fix puts rate limiting on the controller/worker routers. The same first fix replaces a backtracking image-reference expression and adds an adversarial-path regression. | Security analysis plus concrete negative tests. The timestamped route findings establish a pre-merge catch. |
| [#826](https://github.com/elewa-git/opencrane/pull/826), `232d55d5a` on 8 September; merged 9 September | Live qualification exposed the aggregate run budget being used as a single oversized response limit. A separate response cap repaired the real model path before merge. | Fresh-install/user-journey qualification and exact source evidence. |
| [#873](https://github.com/elewa-git/opencrane/pull/873), validation section; absorbed by #888 before its merge | Independent review corrected the delivery invariant for gateway refusal before dispatch, while keeping provider NotFound delivery ambiguous. PR report is the evidence of review causality; it is not an independently replayed test here. | One reviewer tracing failure semantics, rather than just checking happy paths. |
| [#898](https://github.com/elewa-git/opencrane/pull/898), `830243b76` | SQL tests counted in-memory spawn receipts as committed tasks despite rollback/retry. The repair asserts committed operation/task/audit state, forces `P2034`, and tests restart/idempotent replay on three fresh databases before merge. | Tests of durable outcomes and honest limits, rather than mock counts. |
| `docs/adr/0017-cognee-access-control-mode-and-gateway-service-user.md:19`, `7ea31714c`, linked #863/#873 | Real pinned Cognee testing found cross-dataset recall when access control was disabled. A single trusted network caller was not sufficient isolation. | Provider contract tests and ADRs that record changed conclusions. This row is discovery evidence, not a separately proved pre-merge chronology. |

The process also let defects escape. Owner memory records roughly six Cognee deployment iterations despite green local checks; #187/#188 failed live. Those are not catches to credit to review. Scope-specific live evidence protects quality better than a blanket claim that an agent “reviewed everything”.

## Documentation results

There are **193 READMEs under apps/libs, including grouping indexes**. A purposeful sample of ten packages across applications, infrastructure, IAM, history, memory, observability, storage, frontend and contracts totals **1,430 lines**, median **104.5**, range **52–327**. Five of nine samples with an applicable length profile exceed that profile; the contracts package has no matching profile. This is a qualitative sample, not a repository-wide failure rate.

| Ten README samples | Lines | Finding |
| --- | ---: | --- |
| `apps/opencrane/README.md:188` | 327 | Clearly distinguishes SQL evidence from deployed proof; operator detail at :262 could be linked out. |
| `apps/opencrane-ui/README.md:69` | 98 | Explains server authority and usage-data limits; repeated links at :95. |
| `apps/_infra/cognee/README.md:51` | 111 | Useful isolation and unsupported-scaling limits. |
| `libs/backend/server/iam/authorization/main/README.md:36` | 193 | Explains check/write races and external-effect limits; lengthy export catalogue follows. |
| `libs/backend/server/conversations/history/README.md:20` | 80 | Clear conflict/privacy contract; new exports appended after “See also” at :77. |
| `libs/backend/agents/personal/memory/main/README.md:90` | 152 | Explicit first-dataset and live-qualification gaps; repeated implementation detail. |
| `libs/backend/observability/README.md:30` | 65 | Strong privacy guarantees; API explanation appears twice at :13 and :39. |
| `libs/backend/artifacts/store/main/README.md:29` | 64 | Explains timing, limits and what a receipt proves. |
| `libs/frontend/elements/conversation/README.md:41` | 52 | Useful trust/import boundary; :52 links to absent `../a2ui/README.md`. |
| `libs/contracts/README.md:17` | 288 | Overclaims compile-time prevention of runtime 404s; :133–232 lists exports instead of directing readers to the API. |

Source sample: for each root represented below, take the lexicographically first non-index `.ts` under `src`, excluding generated and test files. This reproducible selection includes implementations and declarations; it does not choose only good or bad prose.

| Ten source files | Comment assessment |
| --- | --- |
| `apps/opencrane/src/bootstrap/configuration/config.ts:181` | Explains lease-renewal timing and why a floor exists; more useful than the obvious constant labels. |
| `apps/opencrane-ui/src/app/app.component.ts:4` | Proportionate one-line description of a small application shell. |
| `libs/backend/server/iam/authorization/main/src/approvals/deferred-tool-approval-batch.ts:5` | Says when the last approval resumes work. |
| `libs/backend/server/conversations/history/src/payloads/conversation-private-payload-cipher.ts:36` | Explains ownership authentication without an essay for each helper. |
| `libs/backend/agents/personal/memory/main/src/commands/personal-memory-command-context.types.ts:1` | Distinguishes stored/domain states and unfinished deletion at :16. |
| `libs/backend/observability/src/console-bind.ts:9` | Explains why interception does not recurse; numbered comments elsewhere narrate obvious steps. |
| `libs/backend/artifacts/store/main/src/artifact-promotion.ts:7` | Documents cleanup/deadlines and security-relevant ordering at :27. |
| `libs/frontend/elements/conversation/src/lib/conversation-composer/conversation-composer.component.ts:11` | Draft ownership is repeated at :27 and :65; 81 comment lines against 41 nonblank code lines. |
| `libs/contracts/src/agents/agent-capability-grant.types.ts:19` | Deny precedence is useful; :105 merely says the id identifies the record. |
| `libs/backend/server/iam/membership/main/src/ed25519-fleet-membership-signature-verifier.ts:12` | Good security rationale for recomputing the digest; meaningful return/error contract at :53. |

Comment counts recognise lines beginning `/**`, `*` or `//` after trimming; they are an inspection aid, never a recommended gate. Mandatory density is not clarity. The [proposal](standards.md) includes precise good/bad examples and shorter README/ADR/comment requirements.

Skimmed all 12 ADRs for decisions, evidence and supersession. ADR0017 usefully revises a security assumption; `docs/adr/0013-workflow-control-plane.md:8` links to a deleted ADR0009. `README.md:32` and `website/guide/status.md:72` honestly separate implemented and live-proven capabilities. `CHANGELOG.md:41` similarly qualifies proof. The site has dead-link checks (`website/.vitepress/config.ts:18`), but these do not protect repository README/ADR links. Its audience split is useful; mandatory diagrams and four separate writing agents are not needed to preserve it.

## Disposition: every agent and skill

“Keep” preserves the purpose, not an unchanged copy. “Simplify” keeps a smaller role or contract. “Replace with a tool” removes routine model/prose enforcement. “Drop” means do not transplant into OC2. Each named skill is assessed separately even when it duplicates an agent.

| Agent in `.claude/agents/` | Lines | Decision | Evidence |
| --- | ---: | --- | --- |
| `architecture.md` | 201 | Simplify | :11–14 scopes changed boundaries; :66 asks for mechanical dependency enforcement. Fold into reviewer. |
| `changelog.md` | 70 | Simplify | :15–27, :44 preserve user outcomes and honest qualification; merge into one docs helper. |
| `comments.md` | 202 | Simplify | :21–51 grounds explanations; :201 manufactures ASK pressure. |
| `component-manager.md` | 287 | Simplify | :190–238 has real state/accessibility proof; :52–79 adds pre/post catalogue ceremony. |
| `deploy.md` | 132 | Keep, slim | :20–43 uses reproducible scripts; :89–97 verifies after script exit. |
| `gateway-sentinel.md` | 69 | Simplify | :25–55 contains useful trust questions; render/network tests replace recurring model scans. |
| `memory-engineer.md` | 132 | Drop | :25–79 hard-codes Cognee/Prisma/Absurd; OC2 memory has a different owner and event model. |
| `observability.md` | 128 | Replace with a tool | :38–71 logging/redaction work becomes lint and telemetry tests; semantic review stays integrated. |
| `readme.md` | 84 | Simplify | :17–24 asks useful newcomer questions; :75–82 makes regex matches editorial vetoes. |
| `reaper.md` | 155 | Replace with a tool | :78–96 unused exports suit Knip; reachable obsolete routes at :98 still need review. |
| `release-manager.md` | 122 | Drop | :32–47 exceptional release orchestration is premature; preserve artefact identity in deploy runbook. |
| `review-verifier.md` | 63 | Simplify | :20–63 refutes unsupported findings; use only batched disputed claims. |
| `review.md` | 279 | Keep, slim | :241–256 demands concrete evidence; remove OC1 architecture and mechanical duplication. |
| `website.md` | 85 | Simplify | :55–79 grounds claims and links; merge with docs helper. |

| Skill in `.agents/skills/` | Decision | Evidence |
| --- | --- | --- |
| `architecture/SKILL.md` | Drop duplicate | Byte-identical 201-line agent copy; :66 repeats boundary policy. |
| `changelog/SKILL.md` | Drop duplicate | Byte-identical 70-line copy; retain :15 once. |
| `comments/SKILL.md` | Drop duplicate | Byte-identical 202-line copy; correction `e353e48e1` had to update three harness copies. |
| `component-manager/SKILL.md` | Drop duplicate | Byte-identical 287-line pre/post review protocol (:52). |
| `memory-engineer/SKILL.md` | Drop | Byte-identical 132-line OC1 memory policy (:25). |
| `observability/SKILL.md` | Drop duplicate | 126 lines; :108–116 already drifts from agent's tool-first policy. |
| `readme/SKILL.md` | Drop duplicate | Byte-identical 84-line writer (:17). |
| `release-manager/SKILL.md` | Drop | Byte-identical 122-line release protocol (:32). |
| `review/SKILL.md` | Drop duplicate | Byte-identical 279-line reviewer (:241); keep one prompt source. |
| `website/SKILL.md` | Drop duplicate | Byte-identical 85-line accuracy/link protocol (:55). |

## Commands, controls and rule documents

| File or control | Decision | One-line evidence |
| --- | --- | --- |
| `.claude/commands/review-loop.md` | Simplify | :21–41 already avoids repeated checks; add a two-pass ceiling and main scope. |
| `.claude/commands/execute-plan.md` | Simplify | Keep acceptance/file ownership (:149); remove stack checkpoints (:126) and OC1 branch restrictions. |
| `.claude/commands/deploy-loop.md` | Simplify | Keep preflight/evidence; :39–65 requires another PR/issue destination per failure. |
| `.claude/commands/release-manager.md` | Drop | :9–20 delegates to another release orchestrator. |
| `.claude/review-policy.md` | Simplify | :80–87 records the ubiquitous gate as drag; replace keyword/line judging with deliberate per-change review. |
| `.claude/hooks/require-review.sh` | Drop | 233 lines; :70–155 recomputes stacks/overlays; :5–17 describes concurrent producer/consumer hooks. |
| `.claude/settings.json` hooks | Drop | :6–19 runs two Stop hooks; judge retains a stale compulsory comments pass. |
| `.claude/settings.json` permissions | Keep absence of extra policy | No `permissions` property exists; nothing repository-specific to copy. Only hooks/permissions were inspected. |
| `AGENTS.md` | Simplify | :32–126 routes 14 agents and maintains three harness mirrors. OC2 already has a short entrypoint. |
| `CLAUDE.md` | Simplify | :3–4 pointer suffices; :7–30 repeats tool instructions. |
| `docs/agents/angular.md` | Simplify | Keep async state/purity tests (:131); remove compulsory specialist pre/post steps (:50). |
| `docs/agents/app-specific.md` | Replace with a tool | Workspace metadata replaces map upkeep (:147); :8 still has obsolete version stamps. |
| `docs/agents/architecture.md` | Simplify | Keep identity/denial requirements (:47); replace mixed business authorities (:24) with event-only truth. |
| `docs/agents/cluster-architecture.md` | Simplify | One current topology/trust diagram; :73 and :142 describe OC1-specific ownership. |
| `docs/agents/deploy-ledger.md` | Simplify | Receipt fields at :9 are useful; :3 requests reading a now 1,383-line ledger before each run. |
| `docs/agents/infra.md` | Simplify | Retain relevant checks and immutable evidence (:16, :43); update topology references. |
| `docs/agents/k8s.md` | Keep | Least privilege/default-deny (:8–35) and allow/deny tests (:79–90). |
| `docs/agents/maintainability.md` | Simplify | Keep ownership criteria (:41); fixed State/Strategy form (:78) over-prescribes implementation. |
| `docs/agents/monorepo.md` | Replace with a tool | Direction/cycles/public entrypoints (:91) belong in dependency checks; version rules contradict at :114–120. |
| `docs/agents/package-docs.md` | Simplify | Keep same-change contract updates (:198); remove fixed section/diagram curriculum (:48, :85, :185). |
| `docs/agents/README-TEMPLATE.md` | Simplify | 64-line template becomes four useful questions plus optional operating details. |
| `docs/agents/prisma.md` | Drop | SQL authority/raw-call inventories (:26–78) do not transfer to rebuildable projections. |
| `docs/agents/repository-context.md` | Drop as mandatory | Index/runtime setup (:10–28, :55) is optional search tooling, not code quality. |
| `docs/agents/typescript.md` | Replace with a tool | 664-line manual duplicates mechanics/compliance tables (:121), every-field JSDoc (:210), underscore taxonomy (:554). |
| `docs/agents/versioning.md` | Simplify | Keep artefact identity/fresh install; :18–28 baseline digest machinery is OC1-specific. |
| `docs/agents/workflow.md` | Simplify | Retain one review/evidence (:136); remove hourly graph checks (:55) and emoji taxonomy (:79). |
| `docs/agents/apps/opencrane.md` | Drop duplicate | App README owns the contract; :24–28 makes the app a Prisma baseline owner. |
| `docs/agents/libs/contracts.md` | Drop duplicate | Repeats generated package instructions (:9) and a static enum map (:25). |
| `docs/agents/module-growth-policy.json` | Replace with a tool | :3–5 limits physical lines; :33 has an expiring global exception. |
| `docs/agents/prisma-boundary-policy.json` | Drop | 3,001 lines of exact class/import/path ownership (:3–22), for the old persistence model. |
| `docs/agents/authorization-enforcement-inventory.json` | Replace with behavioural tests | 62 literal source anchors prove presence, not correct enforcement. |
| `docs/agents/app-source-allowlist.json` | Drop | :3, :11 register 104 implementation files individually; routine file moves become policy edits. |
| `docs/agents/workload-ownership.json` | Simplify | 18 workloads, three render profiles and four dynamic constructs; derive owners from manifests and test them. |
| `docs/adr/README.md`, `docs/adr/*.md` | Keep format/evidence | Index :26 separates durable decisions from investigations; ADR0017 corrects a tested assumption. Do not copy obsolete decisions. |
| `README.md` | Keep approach | :32–44 makes pre-MVP limits visible in an 89-line front door. |
| `CHANGELOG.md` | Simplify | :41–45 qualifies live evidence; keep concise release outcomes, link detail behind the 1,239-line history. |
| `website/` | Keep audience split, simplify workflow | `guide/getting-started.md:27` requires a real journey; `guide/status.md:72` separates proof from implementation. |

## Every scripts gate family and workflow

Rows include their corresponding `scripts/__tests__` tests/fixtures and all named helper modules. Keeping an invariant does not mean copying its OC1 implementation. Negative tests transfer only with a retained custom invariant.

| Gate, helper family or workflow | Decision | One-line evidence |
| --- | --- | --- |
| `scripts/agent-style-check.sh` | Replace with a tool | :60–66 launches per-file work; :170 duplicates Prisma checking also in CI. Use typed ESLint and formatter. |
| `scripts/if-body-newline-check.mjs` | Replace with a tool | Tests :39–121 implement changed-line/rename exceptions for brace layout; use formatter/braces. |
| `scripts/inline-conditional-check.mjs` | Replace with a tool | :8–25 counts ternaries on a physical line; use complexity and nested-ternary rules. |
| `scripts/relative-import-extensions.mjs` | Drop | :3–8 strips extensions for bundling; conflicts with OC2's explicit NodeNext runtime imports. |
| `scripts/module-growth-check.mjs`, `module-growth/{cli,core,git}.mjs`, `module-growth/README.md` | Replace with a tool | `core:154` measures lines, not function complexity; `cli:59` checks expiring exceptions before changed-file scope. |
| `scripts/pr-stack-integrity.mjs`, `pr-stack-integrity/{cli,evidence,git,github,inspection,policy,process,report,review-order,topology}.mjs` | Drop | `inspection:21–87` repeatedly samples a global graph; main-first OC2 has no stack to govern. |
| `scripts/config-docs-coverage.mjs`, `.core.mjs`, `.sh`, `config-docs-contract.json` | Simplify | `core:82–115` only verifies top-level keys/backticked mentions. Generate schema tables and test actual examples. |
| `scripts/prisma-boundary-check.mjs`, `prisma-boundary/{core,inspection,policy,prisma-bindings,raw-procedure-inspection,typescript-ownership}.mjs` | Replace with a tool and contract tests | Checker :48–100 inventories exact adapters; OC2 needs import boundaries plus event/projection behaviour tests. |
| `scripts/authorization-enforcement-check.mjs` | Simplify | :48–65 bans 17 legacy patterns; :315–325 checks anchors. Central authorisation and deny-path tests prove more. |
| `scripts/workflow-boundary-check.mjs` | Replace with a tool | :49–55 scans only the workflow subtree, so misses SDK imports elsewhere; inspect the full dependency graph. |
| `scripts/agent-domain-boundary.sh`, `agent-domain-boundary-negative-tests.sh` | Replace with a tool | :12–20 and :60–72 check eight fixed names/config text; use actual package dependencies. |
| `scripts/workload-ownership-app-composition-boundary.mjs`, `.sh`, `workload-ownership-app-composition-boundary-negative-tests.sh` | Simplify | Keep rendered ownership (:190); remove every-file app registration (:353). |
| `scripts/phase-b-topology-ast.mjs` | Drop helper | :34–42 identifies Secret Job owner references; retain an actual deployment invariant as a render test. |
| `scripts/release-versioning-check.mjs`, `release-versioning/{manifest-validation,version-utils}.mjs` | Simplify | :2–6 already narrows to version/baseline/image identity; defer upgrade trains until releases exist. |
| `scripts/develop-smoke-baseline.mjs`, `.core.mjs` | Drop | Core :4–33 builds successful-develop-run reuse policy; no develop branch or measured need in OC2. |
| `scripts/promotion-guard-base.mjs`, `.core.mjs` | Drop | Core :2–24 special-cases develop→main promotion; wrong work model. |
| `scripts/affected-deployables.mjs`, `.core.mjs`, `affected-deployables-base.mjs` | Simplify/defer | Base :24–34 correctly handles cumulative changes; begin with full checks, optimise only after timing them. |
| `scripts/rag-rat.mjs`, `rag-rat/{process,runtime,workflows}.mjs` | Drop mandatory setup | Runtime :120–168 installs a pinned indexer; workflows :3–8 install hooks/models. Optional search, not a delivery gate. |
| `scripts/run-postgres-authority-tests.sh`, `scripts/sql/authority-fixtures.sql` | Replace with OC2 integration tests | Shell :9–24 runs SQL business-authority suites; keep real database testing, change assertions to replay/projection contracts. |
| `.github/workflows/docker.yml` | Simplify | 930 lines; :249–312 serially runs guard families before affected project checks. Separate fast checks from capability qualification. |
| `.github/workflows/pr-stack-integrity.yml` | Drop | :59–75 puts one graph failure on every open PR head, including unrelated work. |
| `.github/workflows/nightly.yml` | Simplify | Three-branch matrix (:30) and skip-on-no-new-commit (:54) can report green without validation. Main integration evidence only. |
| `.github/workflows/docs.yml` | Keep, slim | :47–74 builds/publishes the site; retain when OC2 has one and extend local-link coverage. |
| `.github/workflows/release.yml` | Simplify/defer | :35–44 publishes generated API; predecessor flags at :32 are ignored by the simplified checker. |
| Nx dependency-boundary lint | Replace with dependency-cruiser | `docs/agents/monorepo.md:91–110` states useful direction rules; no need to copy Nx solely for this. |
| Generated API/client drift check | Keep | `docker.yml:510–516` requires generated outputs to match; OC2 already has the equivalent event-catalogue check. |
| Database/history/provider/image proofs | Keep behaviour, replace OC1 services | `docker.yml:380–383`, :462–481 acknowledges mocks cannot prove service support. Never copy non-OSI KurrentDB runtime. |
| Terraform/Helm validation | Keep when touched | `docker.yml:224–231` validates Terraform; workload guard renders real charts. |
| Storybook and screenshot contracts | Simplify scope | Latest CI has 58 screenshot failures; use reviewed Linux references for key states and behavioural UI assertions. |
| Site dead-link check | Keep and extend | `website/.vitepress/config.ts:18` protects site links, not the broken package/ADR links above. |
| Hosted CodeQL analysis | Keep security analysis | Actual #745 route findings preceded repairs; assess findings, not merely a green analysis run. |

The style script contains separate rules; none is hidden inside the family decision:

| Rule in `scripts/agent-style-check.sh` | Decision and evidence |
| --- | --- |
| `ARROW-FN` | Drop; :180–184 bans ordinary arrows without a correctness requirement. |
| `MULTILINE-IMPORT` | Drop; :186–189 forces long single-line imports. |
| `MIDFILE-IMPORT` | Replace with import-order tooling; :203–210. |
| `REL-IMPORT-EXT` | Drop old direction; :230–235 conflicts with NodeNext. |
| `PKG-IMPORT-EXT` | Replace with package exports/type resolution; :237–242. |
| `CONSOLE` | Keep via scoped ESLint `no-console`; :244–249 aims at structured logging. |
| `INLINE-CONDITIONAL` | Replace with ESLint readability rules; :113–118. |
| `IF-BODY-NEWLINE` | Replace with formatter/braces; :121–127. |
| `CATEGORICAL-LITERAL` | Drop enum mandate; :253–259 is a heuristic; typed unions/exhaustive switches cover the contract. |
| `TYPES-IN-IMPL` | Drop; :261–268 creates paired files irrespective of cohesion. |
| `JSDOC` | Simplify; :212–218 checks proximity, not whether a comment explains anything. |
| `BRACE` | Replace with formatter; :220–223 implements Allman layout. |
| `TEST-LOCATION` | Drop fixed-directory policy; root ESLint :23–46 also enforces it. Verify test discovery instead. |
| `MISSING-README` | Keep package README requirement; :145–149 is a useful presence check, not proof of quality. |
| `README-SECTIONS` | Simplify; :151–160 checks breadcrumb/headings rather than usable contract content. |
| `ROOT-CACHE` | Replace with shared test configuration; :272–277 searches a helper-name string. |

## Reproducing the measurements

Use `gh pr list -R elewa-git/opencrane --state all --limit 200 --search 'created:<=2026-09-30'` with JSON fields `number,state,createdAt,mergedAt,closedAt,additions,deletions,baseRefName,headRefName`. At the audit this selected #680–#918. Request each PR's `commits.totalCount` and commit SHA/message headline through GraphQL; paginate #826 and #745 beyond 100 using the REST pull-commits endpoint. Deduplicate by SHA before counting keyword matches. PR metadata and bodies can change; the sample boundaries and numbers above record this audit's observation.

Query `gh run list -R elewa-git/opencrane --branch develop --created '>=2026-08-02' --limit 1000` with workflow/conclusion/id/date fields, then retain `createdAt < 2026-10-01T00:00:00Z`. For failed validation/nightly runs, retrieve `/repos/elewa-git/opencrane/actions/runs/{id}/jobs?per_page=100` and count failed steps, deduplicating ids within categories. A workflow failure has multiple causes when several jobs fail. Run logs and PR links above provide inspectable examples; no secret values are needed for the analysis.

OC2 context read: `AGENTS.md`, `plan.md:11–20` and :317–340, `.github/workflows/ci.yml`, `eslint.config.mjs`, `tsconfig.base.json`. The explicit main-until-prototype instruction and owner memory `feedback_commit_main_until_prototype.md` override the plan's current PR wording. Only these two process documents were written. Proposed tools/prompts remain **NOT IMPLEMENTED**; product/live validation is **NOT RUN** in this review.
