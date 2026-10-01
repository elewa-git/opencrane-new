# OpenCrane architecture thread — consolidated brief for implementation review

Date: 30 September 2026. Source baseline: `origin/develop` at `10abd0ef6182f36bec13d8f1358e43b15ead7cd5` unless stated. Routines head: `fadaf5c2f`.

This brief consolidates one review thread (28–30 September), in this order:

1. Claude Code's multi-agent architecture and MVP review.
2. The Codex counter-report (OpenCrane 1 source: `2026-09-30-mvp-counter-report.md`).
3. Claude's follow-up brief (OpenCrane 1 source: `2026-09-30-architecture-brief-for-codex.md`).
4. Codex's follow-up review.
5. The owner's decisions and clarifications.

It is for review by the main implementation agent. Nothing here has been implemented, committed, merged or deployed. Evidence labels:

- **Verified** — checked in source, git, CI or render.
- **Codex-verified** — confirmed by the Codex follow-up.
- **Reasoned** — derived from code, not executed.
- **Estimate** — an agent estimate, not calibrated.
- **Owner** — a statement or decision by the owner.

## 1. Owner decisions and positions from this thread

| # | Decision or position | Status |
| --- | --- | --- |
| D1 | **The computer is the actor.** Runs execute inside the ConversationComputer so it acts as a logical actor on a secure corporate network (who acts, what it can reach, what a compromise exposes). | **Owner decision: option A** |
| D2 | **Agent Sandbox provides scalability:** warm Pods ready for use, ideally even across siloed tenants. | Owner intent; cross-silo design open (§7) |
| D3 | **As little hand-written SQL as possible.** Business rules belong in TypeScript. | Owner position; Codex refinement in §5 |
| D4 | **Keep KurrentDB, narrowed to history.** The owner considers it a sound choice. | Owner position |
| D5 | **Put budget control in front of LiteLLM** (a model gate), so the computer can be given model access safely. | Owner proposal; design in §8 |
| D6 | **October is the MVP target**, with the accepted scope preserved unless the owner changes it. | Owner target |

Accepted decisions that still bind (routines-head `plan.md` lines 17–59, and the develop delivery plan):

- recursive delegation with no fixed caps;
- hard monthly EUR budgets with reserve-before-dispatch;
- per-tool Allow automatically / Ask / Block;
- paying-group attribution;
- ongoing fresh testv6 qualification;
- a €5 total live-provider envelope.

## 2. Delivery state

- **No product qualification since 8 September.** The 13 September ledger entries are intentional suspension and DNS work. The current Absurd-driven turn path has never run live. **Verified.**
- **Develop CI is red:**
  - 25 style errors in 6 files;
  - a comparison base stuck at `d5007454a` (7 August);
  - the k3d smoke stops on a self-imposed CA-bundle preflight; with #912 it next fails on a missing `--kurrentdb-image-digest`;
  - 58 Storybook failures (38 missing baselines, 20 unreviewed diffs).

  Database authority proofs, KurrentDB proofs, the Cognee contract, API generation and six image smokes **pass** on the same commit. Only the aggregate build/test/lint, k3d and Storybook jobs fail. **Verified and Codex-verified.**
- **Branch protection** requires one review, no status checks, and does not enforce admins. **Verified.**
- **Module-growth exception** for `k8s-deploy.sh` expires 1 October (`docs/agents/module-growth-policy.json:36`). From 2 October 00:00 UTC every invocation of that gate fails, before the aggregate Nx job. Recommendation: a small explicit renewal with an owner and an extraction task; consider warning on unrelated expired entries. **Verified; urgent.**
- **PR numbers versus landed code.** #849 was closed unmerged; its head `b4f275b3f` landed through #888 (24 September). Cite commits or merging PRs, not closed PR numbers. **Verified.**
- **The stale local checkout** `feat/library-component-decomposition` is based on 9 September, 136 commits behind. A normal merge simulation shows conflicts, not automatic IAM loss. Move its uncommitted edits to a fresh worktree off develop. **Codex-verified.**

## 3. Confirmed defects to fix now

| Defect | Evidence | Status |
| --- | --- | --- |
| **Stop blocks the conversation.** The active-run query excludes Completed and Failed but not Cancelled. | `libs/backend/agents/execution/inputs/main/src/sources/prisma-conversation-context-repository.ts:56` | Verified by both reviews |
| **Uploaded-file removal violates `artifacts_deletion_check`.** It sets `DeletionPending` together with `deletedAt`. | `prisma-conversation-asset-repository.ts:102` vs `target-baseline.sql:7681` | Codex-verified by source; database run was blocked by the host |
| **Clock mismatch.** App `command.now` is checked against `clock_timestamp()` on elicitation create and expiry. | `prisma-elicitation-unit-of-work.ts:70-128` vs `target-baseline.sql:7839-7875` | Conditional defect; skew not measured |
| **M1 cannot start.** Run authority freezes memory as None, and Remember needs an active dataset that nothing creates. | `prisma-run-authority-source.ts:58-59`, `prisma-personal-memory-command-unit-of-work.ts:93-95` | Verified |
| **Model-turn timing.** The 25-second window starts before key issuance; one key with a 300-second lifetime covers the whole turn, including approval waits. | `conversation-computer-model-flow.ts` | Verified; effects not measured |

## 4. Architecture findings

### 4.1 The architecture tax (Reasoned)

These fixed costs attach to every capability:

1. **Workflow state in three stores:** AgentRun in Postgres, Absurd checkpoints, and KurrentDB turn streams and receipts. They cannot commit together.
2. **Business rules duplicated** in TypeScript and plpgsql.
3. **A compute gate** that acquires a Pod the turn doesn't use.
4. **Recheck by full recompile.**
5. **Heavy per-change tooling.**

Size of #916, **Verified / Codex-verified**:

- #916 alone: +34,094 / −970 lines, 571 files.
- The stack against develop: +40,754 / −1,226 lines, 710 files.
- Production TypeScript: **14,891 incremental** (#916) and 17,403 cumulative.
- Largest area: `agents/scheduling/main` 4,932 lines.

**Codex correction:** location is not overhead. Admission, revocation, overlap and recovery are required behaviour. The "tax" share is unmeasured and needs a file-by-file argument.

### 4.2 Where the turn runs

**Timeline (Codex-corrected):**

| Commit | Change |
| --- | --- |
| `5068fd93f` (5 Sep) | Added a health/readiness Pod shell |
| `4ac41c212` | Model execution in the Pod |
| `378a755b6` (9 Sep) | Model call moved back to the server; the Pod polled `/bootstrap` and requested `/model-step` |
| `b4f275b3f` (10 Sep) | Progression moved into the Absurd task `CONVERSATION_COMPUTER_TURN_TASK` |

Server-owned execution is recorded in `docs/agents/architecture.md:29-35`. ADR 0016 and ADR 0010 are stale.

**The server's privileges (Codex-verified):**

- Database owner credential (not proven superuser).
- The LiteLLM master key.
- MCP material and conversation-payload encryption keys, artifact-lease and invitation signing keys, history and identity credentials.

Kubernetes RBAC:

| Scope | Permission |
| --- | --- |
| Cluster | TokenReview create; `clustertenants` get/list/watch |
| Release namespace | get/update on six named provider Secrets |
| Sandbox namespace | SandboxClaim create/get/patch/delete; Sandbox get; Pod get |
| MCP credential namespace | Secret create/get/delete for any name (zero-Pod quota) |

**The Pod today:** no turn work. It serves the review surface and checkpoints, yet every turn requires a claim and Pod, and a missing Pod ends the turn. **Verified.**

**Audit:** record both dimensions, the business actor (principal and computer) and the executing workload. Whether today's stored fields misattribute is a hypothesis until the fields are traced. **Codex correction.**

### 4.3 Warm capacity (Verified by render)

- The agent-sandbox values schema and template reject `warmReplicas ≠ 0` (`apps/_infra/agent-sandbox/helm/templates/_resources.tpl:23-24`).
- Profiles are silo-scoped.
- ADR 0014 (claimed warm pool) is superseded.
- Plain NetworkPolicies give workload-class isolation (DNS, release server, review path). They have no per-computer destination rules, and no CiliumNetworkPolicy is rendered.

### 4.4 KurrentDB (Owner: keep)

Keep KurrentDB for participant history. Its extra roles should move to Absurd and AgentRun:

- the activation queue (a persistent subscription: sequential, up to about 9 minutes of retries, then an operator replay);
- the turn protocol and active-turn pointer;
- Stop arbitration and receipts.

The message post is already correct: a Postgres commit, then an idempotent append keyed by the browser idempotency key.

Replace full-history rereads with "freeze input once, then check `readHead == expectedRevision` plus current-authority fences". Those fences are membership, grants, model/tool revisions, budget and lease, which can change without the stream advancing. Measure read counts and transaction time rather than assuming a multiplier.

Running-cost items:

- snapshot backups, or turn off the unused secondary index;
- a joint Postgres/KurrentDB restore;
- a licence record;
- a startup retry;
- a port-owned error type in place of the SDK error leaking into 7+ domain files.

Postgres and KurrentDB still cannot commit together, so history publication keeps idempotent recovery under any executor design.

### 4.5 MCP and memory (Verified)

- Remote MCP supports only protocol 2026-07-28, a static bearer token and public HTTPS.
- An unauthenticated registration probe rejects servers that answer 401.
- No OAuth; no end-to-end remote harness.
- Hosted MCP is credential-free by database CHECK and NetworkPolicy, and runs only OpenCrane-built HTTP images.
- The realistic first T1 target is an Elewa-hosted Odoo adapter.
- Cognee stays; a Postgres fact store was judged slower to M1. Its contract CI uses a stub configuration different from the deployed one.

## 5. SQL ownership

**Inventory (Codex-scoped):**

| Scope | Functions | plpgsql | Triggers | RAISE | ERRCODE |
| --- | ---: | ---: | ---: | ---: | ---: |
| Entire baseline | 134 | 128 | 104 | 552 | 5 |
| Outside the embedded Absurd copy | 95 | 95 | 104 | 472 | 4 |

The 94 product-rule functions exclude the `fail_absurd_task_terminal` adapter.

**Claude's classification:**

- **Why each exists:** 62 defence in depth only, 14 guard write-dead tables, 12 close a race, 4 guard against a non-app writer, 2 unclear.
- **Against the TypeScript:** 27 same rule, 26 no TypeScript check, 18 stricter than TypeScript, 10 weaker, 13 different.
- The named per-function inventory still needs publishing for review.

**Documented real catches since 1 August:** CHECK constraints `fe32ba138`, `5681f1cae` and `6edded27a`, and one immutability trigger (`e5a9a3a35` / `031449ef7`). No transition-graph trigger has a documented catch.

**Rule (owner D3, with Codex refinement):**

| Layer | Allowed |
| --- | --- |
| TypeScript | Business rules, transitions, validation, with a named owner |
| Prisma schema | Tables, relations, foreign keys, unique keys |
| Declarative SQL | CHECKs and partial unique indexes that Prisma 6 cannot express |
| plpgsql (allowlisted) | Guarantees TypeScript cannot give |

**Keep until a proven replacement exists (Codex list):**

- database-clock leases and fencing;
- `protect_org_membership_last_owner` and `enforce_group_hierarchy`;
- append-only guards, until a non-owner runtime role actually denies UPDATE, DELETE and TRUNCATE;
- immutable-field and one-way guards that table privileges cannot express;
- `enforce_agent_run_tree_reservation`, which debits allowance and bumps the account revision;
- `enforce_highest_membership_revision`, whose advisory-lock ordering protects against replay;
- the pinned Absurd implementation and its adapter, as an explicit vendor boundary.

**How to move a rule to TypeScript:** only with a named owner, a complete writer inventory and concurrent-writer tests. Retained triggers get stable SQLSTATE codes mapped to typed errors.

**A non-owner runtime role is feasible,** but needs:

- separate owner and runtime credentials;
- explicit CONNECT, schema, table, sequence and function grants;
- no owner membership and no schema CREATE;
- Absurd execution rights;
- a change to the privileges hook, which currently grants CONNECT only to owner/admin.

Validate it with a fresh CNPG bootstrap and restore. Prisma TypedSQL types raw queries but proves no invariants and needs a database connection to generate.

## 6. Option A: the computer executes steps; the server keeps the books

**Shape (Owner D1, Codex-refined):** the server owns durable state, exactly-once bookkeeping, budget reservation and approval waits through Absurd and Postgres. The Pod executes **one admitted step at a time**; it is not an autonomous polling loop. Restoring `b4f275b3f^` is **not** option A, because it keeps server-side model execution.

**Minimal step contract:**

| Part | Binding |
| --- | --- |
| Identity | Silo, computer, run/attempt, lease/generation and exact Pod UID, derived authoritatively |
| Work | Versioned step id, immutable input digest, model/tool revision, allowed destination and operation, argument digest |
| Admission | Current permission and approval evidence, cancellation fence, shared budget reservation, absolute deadline, output and size bounds |
| Credential | A short-lived capability for that step only: no database login, no provider master key, no unrestricted integration secret |
| Result | Same step/input identity, bounded result or artifact reference plus digest, usage/provider receipt, explicit outcome |

The server authorises and reserves atomically before a step is executable. Repeated delivery returns the saved result or status and never authorises a second send.

**Failure handling:**

| Pod dies… | Response |
| --- | --- |
| Before forwarding, with durable proof | Reassign under the same logical effect and allowance |
| After possible forwarding, no durable outcome | **Uncertain:** keep the reservation; reconcile or use provider idempotency |
| After a durable result, before acknowledgement | Return the saved result; no repeat call |
| After cancellation or lease replacement | Deny new sends; keep historical evidence |

**Open design choice:** should the Pod call existing hosted-MCP executor Jobs through a governed call, or run tools itself? Running them itself changes the current executor isolation boundary.

**Code size:** "much less code" is **not established**. Transport moves rather than disappears; admission, approvals, budgets, custody, cancellation, uncertainty and history remain. Removing KurrentDB turn-state ownership is a separate change with its own gains. Codex's measured examples:

| Module | Lines | Under A |
| --- | ---: | --- |
| `conversation-model.ts`, validator, parser | 376 | Moves |
| `conversation-computer-model-flow.ts` | 324 | Splits |
| Candidate resolver | 112 | Simplifies |

**Estimate:** 3–5 weeks. Unvalidated.

**Accepted decisions must survive:**

- Allow/Ask/Block, including explicitly selected automatic first writes;
- current revocation;
- paying-group attribution;
- hard EUR reservations;
- recursive Stop;
- the €5 envelope.

A Pod replacement must never mint another allowance or detach descendants from their root budget.

## 7. Warm pools

- **Start with warm pools per silo**, with the correct namespace and ServiceAccount from Pod creation. **Codex recommendation.**
- **Cross-silo neutral pools need a separate trust contract.** A Pod's `serviceAccountName` and namespace can't change after it starts; computer coordinates are startup environment variables; labels grant no authority. A safe design needs:
  - an immutable neutral bootstrap identity;
  - a single-use claim bound to the Pod UID;
  - controller-owned labels;
  - an explicit network-policy readiness barrier;
  - tenant/computer identity and step capabilities delivered only after binding.
- **A used Pod is destroyed**, never returned. "Single use" means one tenant/computer binding, not one call.
- **Strict tiers** need dedicated approved nodes. gVisor is not physical isolation.
- **Tests required before qualification:** concurrent claims, spoofed binding, policy-not-ready denial, stale results, revoke/dispatch races, terminal destruction and tier placement.

## 8. Model gate: budget control in front of LiteLLM (Owner D5)

**Why LiteLLM alone is insufficient:** its `max_budget` is a spent-so-far check, and spend is recorded after the response, so parallel calls (delegated children) overshoot. It has no worst-case reservation, uses USD, and resets by duration. Some team/organisation budget features may be enterprise-licensed; verify before relying on them. Today OpenCrane mints one key per attempt with `max_budget` and no `budget_duration` (`attempt-litellm-key.ts:125-126`). **Verified.**

**Proposed gate (Reasoned):**

```text
Pod ── single-use step permit ──▶ model gate
   1. verify + consume the permit
   2. worst case = (input tokens + max_tokens) × reviewed EUR price
   3. reserve atomically in Postgres against global/group/assistant ceilings (one charge)
   4. forward to LiteLLM with max_tokens enforced
   5. settle actual usage; release the rest; lost response → reservation stays "uncertain"
```

**What it gives:**

- The Pod never holds a LiteLLM key or master key; a compromised Pod can spend at most its current step's reservation.
- Parallel children cannot overshoot.
- A hard stop can refuse new permits and cut off live streams.
- A2 usage gets a real writer from settlement records.
- It is the "proxy consumes a permit" that Codex required for option A.

**What it may replace, once proven:**

- per-attempt key minting, custody and revocation (about 1.7k lines, estimate);
- the $0.10 per-turn key and the 300-second lifetime problem;
- the disabled pre-forward retry machinery (about 3k lines, estimate);
- eventually the run-tree reservation trigger, only after the gate's reservation is proven equivalent.

**Placement:** a separate typed TypeScript gate is recommended over extending the existing custom LiteLLM pre-forward hook image. That image pins hashes of LiteLLM internal files, so upgrades are fragile.

**Not covered:**

- paid tool/provider calls, which need the same permit pattern at a tool gate;
- a reviewed EUR price table with an exchange-rate policy; unpriced models are refused;
- counting input tokens before dispatch.

**Estimate:** 1–2 weeks for the core. Unvalidated.

## 9. Dead and stale code

**First retirement batch** (Codex-narrowed; remove exclusive tests, exports, Nx config, aliases and docs too):

1. `libs/frontend/state/conversation/render/.upstream/`: a 1,973-line vendored OpenClaw v2026.6.11 reference with no importers, producing 8 of the 25 style errors. Also add the missing `THIRD_PARTY_NOTICES.md`, which the adapted files reference.
2. `libs/backend/server/infra/workflows/scheduler/`: respawn-chain helpers with no callers. Scheduling continues through Absurd `sleepUntil`/`awaitEvent` and #916's own `agents/scheduling`. Edit ADR 0013's respawn-chain mention.
3. `libs/backend/server/infra/workflows/oauth-refresh/`: an unregistered scaffold.
4. The unused model-routing savings estimator (`_EstimateSavings` and its types).

**Not approved for deletion yet:**

- **knowledge/retrieval and ResourceShare** are mounted APIs; removing them retires a capability.
- **Personal configuration, memory consent, D1 accounting and budgets** intersect the MVP.
- **McpTask** depends on replacement-consumer checks.
- **Skill-authoring:** separate the chart dependency first (the agent-controller won't render without its digest).
- **Frontend components** need a per-component check.

Most dead code is "built ahead of its workstream, which later took another route" (#741, #264, #318, #222/#243). Keep code only if its workstream is in the next release and matches the current design.

**Restart rule:** exempt verified-unreachable deletion from the 15k-line restart trigger.

## 10. Misleading signals found (drift, not intent)

- **Green without evidence:**
  - nightly skips when there are no recent commits;
  - "CI green" in plan.md refers to PR-branch runs;
  - Cognee contract CI tests a stub configuration;
  - unit tests mock Prisma and can't see triggers;
  - "independent review PASS" is AI self-review;
  - "required" checks aren't required.
- **UI that overstates:**
  - "Usage and budgets" shows an unwritten table and unenforced ceilings;
  - governance screens deny real admins;
  - My Tools is documented as mounted but has been unrouted since 27 July.
- **Stale documents and comments:**
  - ADR 0010 is still "Accepted"; ADRs 0005/0008 describe RunEvent; ADR 0017 cites Cognee 1.2.1;
  - `docs/ci-and-deploy.md` has stale claims;
  - `mvp-delivery-plan.md` lists a closed review stack;
  - memory READMEs are stale in both directions;
  - a "minted at boot" Cognee key comment refers to a deleted minter;
  - the `require-review.sh` header is wrong;
  - agent mirrors are not byte-identical.

Cheap fixes:

- an evidence ladder: a track is done only with a linked develop CI run or testv6 ledger PASS;
- nightly that runs or reports skipped;
- relabel usage/budget screens until they are real;
- one documentation sweep;
- grep checks for route and "mounted" claims.

## 11. Process recommendations

- **Limit work in progress:** at most 1 feature PR and 1 fix PR open, each ≤1.5k lines, merged within about 2 days of green. No absorbing or consolidating PRs; freeze #916 growth until a live PASS.
- **Checks:** keep one integrated review, the database and history proofs, build/test, image smoke and the dependency-boundary lint. Reduce routine ceremony, but keep trust-boundary, component-removal and ancestry checks where they apply (Codex).
- **plan.md:** cut to ≤300 lines. Decisions become issues with needed-by dates, reviewed weekly.
- **Required status checks** once develop is green.

## 12. Recommended sequence

1. **Now:**
   - renew the module-growth exception;
   - fix Stop, uploaded-file deletion and the authoritative clock;
   - clear the 25 style errors and the k3d preflight/digest drift;
   - review the 20 visual diffs;
   - carry the 27 September decision record onto develop;
   - retire the four-item batch.
2. **First current-path testv6 PASS:** a governed tool action with reload/restart and cancellation evidence, recording the immutable source and images. This does **not** qualify the new executor boundary.
3. **ADR work in parallel:**
   - amend ADR 0016 and `docs/agents/architecture.md` for option A;
   - revive claim-time binding from ADR 0014 for **per-silo** pools;
   - define the step contract and the model-gate permit;
   - amend ADR 0015 with the SQL ownership rule;
   - mark ADR 0010 superseded.
4. **First architecture slice:**
   - a per-silo warm pool;
   - a single-step executor in the Pod;
   - the model gate with reserve-before-call;
   - the failure table in §6;
   - per-computer egress policy.

   Leave cross-silo pools, broad SQL removal and code-savings claims out of this slice.
5. **Re-qualify on testv6** for the new boundary: executor, workload credentials, network isolation, crash recovery, cancellation.
6. **Reforecast from measured results.** Publish the first-PASS date, repair effort and remaining accepted journeys. If October cannot contain the accepted scope, present the trade-off explicitly.

## 13. Questions for the implementation reviewer

1. Is the §6 step contract complete enough to start an ADR? What is missing for tool steps against hosted-MCP executor Jobs?
2. Can the model gate (§8) be the single reservation authority for both model and paid tool calls, or should tools have their own gate?
3. What is the smallest per-silo warm-pool binding that satisfies the Codex requirements in §7 without cross-silo sharing?
4. Which of the §5 "keep" triggers does the model gate's reservation replace, and what proof would show equivalence?
5. Does option A plus the model gate conflict with any accepted decision in `fadaf5c2f` plan.md lines 17–59?
6. What must the first current-path testv6 PASS include so that most of its evidence survives the switch to option A?
