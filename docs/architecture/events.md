# Event catalogue: which event triggers which logic

This file is the **contract** between the parts of OpenCrane 2. Every state change is an event. Every piece of logic is either:

- a **projection**, which turns events into content in PostgreSQL; or
- a **reaction**, which does something and may emit new events.

If it isn't in this catalogue, it doesn't happen. CI checks two things:

- every event type in code appears here, with at least one consumer or the label "audit only";
- every handler in code subscribes only to events listed here.

## Principles

1. **The event store is the only source of truth.** Commands validate and then do **one conditional append** to one stream. They write nowhere else.
2. **PostgreSQL holds content, not truth:** who owns what, installed MCP servers, conversations, budgets and so on. Every table is a **projection** with a checkpoint, and can be dropped and **rebuilt by replay**.
3. **Order is guaranteed within a stream, never across streams.** Each stream is handled by one writer at a time, so projections need no locks. Handlers recheck current state when they depend on another stream.
4. **Projections and reactions are separate.** A replay rebuilds projections only. Reactions (waking a computer, pushing gateway config, sending mail) keep their own checkpoints, are idempotent, and are switched off during a rebuild.
5. **No secrets and no plaintext history in events.** Events carry secret *references*. Message and memory text is encrypted with a per-conversation or per-scope key, so "forget" deletes the key (crypto-shredding) and appends a tombstone event.
6. **An event never grants anything.** Permissions come from the OpenFGA projection, which is rebuilt from events like any other.
7. **Idempotency is by event id, not by the event store's duplicate window.** Every projection and reaction records the event ids it has applied (in the same Postgres transaction as its checkpoint), and commands use expected-sequence appends. JetStream's `Nats-Msg-Id` de-duplication only lasts for its duplicate window, is lost on backup/restore, and is **stream-wide** (an id first used on another subject makes the append report a duplicate and store nothing), so it is an optimisation, never the guarantee (found in spike S0.7).
   - A retried **command** is recognised from the stream itself: the event carries the command id, and the command checks the entity history it already loads before appending. There is no separate command ledger: a ledger written after the publish leaves a gap, and a ledger restored to a different point than the stream re-runs commands.
   - Command ids are scoped to the principal and the entity's subject; a client-supplied idempotency key never becomes a global id.
   - An append whose acknowledgement says `duplicate` is accepted only if it points at the expected subject.
8. **Brief write pauses are normal.** When the JetStream stream leader fails, writes pause for roughly 5–8 seconds while a new leader is elected (measured in S0.7). Commands retry with backoff, and the UI shows the message as "saving" rather than failing.
9. **Money is integer euro cents.** Every amount in an event is a whole, non-negative number of euro cents, in a field whose name ends in `Cents` (`costCents`, `ceilingCents`), never a float in euros, so sums stay exact.

## How events are delivered (NATS JetStream)

- **Layout:** one JetStream stream per silo (`EVENTS`), replicated R3, with unlimited retention and regular backups. **Each entity stream is a subject:** `ev.<stream-type>.<id>`, for example `ev.conversation.123` or `ev.budget.acme`.
- **Conditional append:** a command publishes with `Nats-Expected-Last-Subject-Sequence` set to the sequence it read. If another write got there first, JetStream rejects the publish; the handler reloads and retries. Every message also carries `Nats-Msg-Id` (the event id) for deduplication.
- **Order:** within a subject, messages are strictly ordered. The stream as a whole has one sequence, which gives a global position.
- **Projections:** one **ordered consumer** per projection, filtered by subject (e.g. `ev.member.>`). The projection row and the consumer's last sequence are written **in the same Postgres transaction**, so a restart resumes exactly where it stopped.
- **Reactions:** one durable consumer per silo feeds the dispatcher, which enqueues each event into pg-boss `key_strict_fifo`, keyed by subject and deduplicated by event id. That gives order per stream, parallelism across streams, retries and dead-letter.
- **Reading one entity's history** (to validate a command): fetch the subject's messages, or better, read the entity's projection plus its last sequence and use that sequence as the expected value.

## How a command works

```text
 API / gateway decision / computer report
        │
        ▼
 command handler ── reads projections + OpenFGA (may be milliseconds stale)
        │
        ▼
 conditional append to ONE stream (expected version) ──▶ event store
        │                                                    │
        │ returns the new stream position                    ├─▶ projections (ordered per stream) ─▶ PostgreSQL content
        ▼                                                    ├─▶ OpenFGA projection
 UI waits until its projection reaches that position         └─▶ reactions (ordered per stream, retry, dead-letter) ─▶ new events
```

If a stale read slips past validation, the expected-version check rejects the append, and the handler reloads and tries again.

## Streams

| Stream | One per | Examples |
| --- | --- | --- |
| `org-<silo>` | silo | settings, invitations |
| `member-<user>` | person | joined, role changed, removed |
| `team-<team>` | team | created, members |
| `assistant-<id>` | personal or team assistant | created, settings |
| `computer-<assistant>` | assistant's computer | claimed, ready, suspended, lost, takeover |
| `toolset-<profile>` | computer profile (an image plus Codex built-in tool settings) | changed |
| `conversation-<id>` | conversation | participants, messages, agent activity |
| `approval-<id>` | approval request | requested, decided, used, expired |
| `effect-<permit>` | gateway-observed external call | observed, uncertain, resolved |
| `mcp-<server>` | MCP server in the catalogue | registered, discovered, tool modes, published, tools changed |
| `connection-<user>-<server>-<profile>` | credential connection | created, refreshed, revoked |
| `grant-<resource>` | shared resource | given, revoked |
| `budget-<silo>` | silo budget (all ceilings) | ceiling set, reserved, settled, period started |
| `scope-<id>` | brain permission scope | memory written, corrected, forgotten, consolidated, promoted |
| `routine-<id>` | scheduled routine | created, due, paused, retired |
| `delegation-<id>` | delegated child task | started, completed |
| `security-<silo>` | silo | alerts |

## Catalogue

### Organisation, members and teams

| Event | Emitted by | Projections (content) | Reactions (logic) |
| --- | --- | --- | --- |
| `org.created` | install | org | create the budget stream with defaults; generate gateway config |
| `member.invited` | admin command | invitations | send the invitation |
| `member.joined` | invitation accepted | members | OpenFGA `member`; emit `assistant.created` (personal) |
| `member.role_changed` | admin command | members | OpenFGA role tuples |
| `member.removed` | admin command | members | OpenFGA delete; emit `connection.revoked` for each connection; suspend the person's computer; audit |
| `team.created` / `team.member_added` / `team.member_removed` | admin command | teams | OpenFGA team tuples |

### Assistants and computers

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `assistant.created` | reaction or admin | assistants (owner, kind, scope) | OpenFGA `acts_for`; request a computer on first use |
| `assistant.settings_changed` | owner or admin | assistants (model, persona, tools) | update the computer's configuration on next wake |
| `computer.claimed` | server (claim & bind) | computers (Pod UID, generation) | — (the token is issued inside the claim command) |
| `computer.ready` | bridge | computers | deliver queued messages and decisions |
| `computer.suspended` / `computer.resumed` | server | computers | — |
| `computer.lost` | server (Pod gone) | computers | mark in-flight effects of this computer `effect.uncertain`; re-claim when needed |
| `computer.retired` | server | computers | delete snapshots after retention |
| `takeover.started` / `takeover.ended` | live-view proxy | computers, audit | pause / resume the agent |
| `toolset.changed` | admin command (publishes a computer profile) | toolsets | notify admins for review; computers adopt it at their next claim or resume |

There are two kinds of tools, so two events. `mcp.tools_changed` is for a registered MCP server's tools. `toolset.changed` is for the computer's own tools: a new computer image (CLI programs, runtimes, local stdio MCP such as Playwright) or Codex built-in tool settings (`shell`, `apply_patch`, `web_search`, `view_image`, `spawn_agent`). It goes on the profile's own stream rather than on each computer's, because one admin command changes every computer that uses the profile and a command appends to one stream only. Hosted built-ins such as `web_search` are allowed or stripped by the gateway on the model request.

### Conversations and agent activity

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `conversation.created` | command | conversations | OpenFGA participants |
| `participant.added` / `participant.removed` | command | conversations | OpenFGA participants; stream access updated |
| `message.posted` | person, or the system for routines | messages | deliver to the assistant's computer (wake it if suspended); browser (WebSocket) |
| `agent.turn_started` / `agent.turn_completed` / `agent.turn_failed` | bridge (reported) | activity | browser (WebSocket); notify on failure |
| `agent.message_completed` | bridge (reported) | messages | browser (WebSocket). Streamed text deltas are sent live and not stored as events |
| `agent.reasoning_summarised` | bridge (reported) | activity | browser (WebSocket) |
| `agent.command_ran` / `agent.file_changed` | bridge (reported) | activity | browser (WebSocket) |
| `conversation.closed` | command | conversations | tell the computer to stop work for it |

### Tools, approvals and effects

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `tool.approval_requested` | decision service (mode Ask) | approvals | notify the requester; approval card |
| `approval.decided` | requester | approvals | deliver the decision to the computer (wake it) |
| `approval.expired` | timer | approvals | tell the computer |
| `approval.used` | decision service (single use) | approvals | — |
| `effect.observed` | gateway log ingest | audit, usage | settle the budget; with no matching permit → `security.alert_raised` |
| `effect.uncertain` | settle timeout or `computer.lost` | audit, effects | notify for manual resolution |
| `effect.resolved` | person | audit, effects | settle or release the reservation |

### MCP catalogue, grants and connections

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `mcp.server_registered` | admin | catalogue (draft) | validate (SSRF / image scan) → `mcp.server_discovered` or `mcp.server_rejected` |
| `mcp.server_discovered` | reaction | catalogue (tools, schema digests) | — |
| `mcp.server_rejected` | reaction (validation failed) | catalogue (rejected, with reason) | notify the admin |
| `mcp.tool_mode_set` | admin | tool modes (Allow / Ask / Block) | regenerate gateway config |
| `mcp.server_published` / `mcp.server_unpublished` | admin | catalogue | regenerate gateway config |
| `mcp.tools_changed` | drift check | catalogue | quarantine the server in gateway config until re-reviewed |
| `grant.given` / `grant.revoked` | admin or owner | grants | OpenFGA tuples |
| `connection.created` | person | connections (secret *reference* only) | — (the credential is written to the secret store inside the command, before the append; a clean-up job removes orphaned secrets) |
| `connection.refreshed` | reaction (OAuth refresh) | connections | — |
| `connection.revoked` | person, admin or reaction | connections | delete the secret |

### Budgets (single-writer actor per silo)

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `budget.ceiling_set` | admin | budgets | — |
| `budget.reserved` | budget actor (inside `ext_authz`) | budgets | — |
| `budget.settled` | budget actor (on `effect.observed`) | budgets, usage | — |
| `budget.period_started` | timer (00:00 UTC on the 1st) | budgets | — |
| `budget.exhausted` | budget actor | budgets | notify admins; stop affected work (hard stop cascades) |

### Memory

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `memory.written` | OpenCrane memory MCP (remember) | Postgres memory projection for that scope | mark that scope for nightly dreaming |
| `memory.corrected` / `memory.forgotten` | OpenCrane memory MCP (correct/forget); nightly per-scope dreaming job (corrected only) | Postgres memory projection for that scope | forget: delete the payload key, then tombstone |
| `memory.consolidated` | Reserved for later use; not emitted by MVP dreaming | Postgres memory projection for that scope | — |
| `scope.promotion_requested` / `scope.promoted` | person / approver | scopes | OpenFGA viewer tuples; copy to the target dataset |

For the MVP, `memory.*` events in NATS JetStream are the truth; the Postgres memory projection holds facts per scope and uses full-text search. Replay applies recorded changes without model calls. Scopes are person, assistant notes and flat group only, with no organisation or department memory. Any group member may write group memory without approval. Each member works in their own thread or sub-agent of the group assistant, with personal memory plus group memory; preferences stay personal and shared knowledge goes to the group.

Codex reaches the OpenCrane memory MCP through the local forwarding proxy and agentgateway. `ext_authz` passes allowed scopes from IAM context (assistant grants ∩ requester rights); per-thread turn tokens keep each member's personal memory out of other threads. Memory is never written to the shared computer's disk. Preferences and pinned facts enter the thread's instructions at turn start with a size cap; the rest is fetched with `recall`.

Nightly dreaming runs per scope in the handler runtime, using a cheap model through the gateway with a budget. It merges duplicates, flags contradictions and expires stale facts through `memory.corrected`; it never crosses scopes. `memory.consolidated` and the existing scope-promotion rows are retained for contract compatibility, with no MVP emitters or promotion reactions enabled. The stream table's older scope description includes these deferred operations. Sharing data across groups is a later design topic.

Cognee is deferred until after the MVP; it may become another projection fed by replaying the same memory events plus document ingestion, without changing the agent's tools.

### Routines and delegation

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `routine.created` / `routine.updated` / `routine.paused` / `routine.resumed` / `routine.retired` | person | routines | schedule the next firing |
| `routine.due` | scheduler | routines (last firing) | emit `message.posted` to the routine's assistant; one firing only |
| `delegation.started` / `delegation.completed` | parent or child computer | delegations | deliver the child's result to the parent |

### Security

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `security.alert_raised` | any reaction | alerts | notify admins |

## Rebuilding content

1. **Deploy the new projection code.** It writes to shadow tables with its own checkpoint.
2. **Replay from the beginning** in order per stream. Reactions stay off.
3. **When the shadow catches up to live, switch reads over** and drop the old tables.

The same procedure recovers from a corrupted projection, adds a new read model, or restores a silo from event-store backups. **Content tables never need their own backup to be correct**; they are backed up only to shorten restore time.
