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

## How events are delivered (KurrentDB)

- **Order comes from KurrentDB itself.** Each stream is strictly ordered by its revision (0, 1, 2…). The `$all` log gives every event one global position.
- **Use catch-up subscriptions, never persistent subscriptions, for anything that depends on order.** KurrentDB's persistent subscriptions are competing consumers: even the "Pinned" strategy doesn't guarantee order, and retries can redeliver out of order. OpenCrane 1's activation queue on a persistent subscription also suffered head-of-line blocking and parked messages that needed an operator to replay.
- **Projections:** one catch-up subscription per projection reads `$all` (filtered by stream prefix). **The projection row and its checkpoint are written in the same Postgres transaction**, so a restart never applies an event twice or skips one.
- **Reactions:** one dispatcher per silo reads `$all` in order and enqueues each event into pg-boss `key_strict_fifo`, keyed by stream id and deduplicated by event id. pg-boss then gives per-stream order with parallelism across streams, plus retries and dead-letter. The dispatcher's checkpoint is also kept in Postgres.

## How a command works

```
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
|---|---|---|
| `org-<silo>` | silo | settings, invitations |
| `member-<user>` | person | joined, role changed, removed |
| `team-<team>` | team | created, members |
| `assistant-<id>` | personal or team assistant | created, settings |
| `computer-<assistant>` | assistant's computer | claimed, ready, suspended, lost, takeover |
| `conversation-<id>` | conversation | participants, messages, agent activity |
| `approval-<id>` | approval request | requested, decided, used, expired |
| `effect-<permit>` | gateway-observed external call | observed, uncertain, resolved |
| `mcp-<server>` | MCP server in the catalogue | registered, discovered, tool modes, published |
| `connection-<user>-<server>-<profile>` | credential connection | created, refreshed, revoked |
| `grant-<resource>` | shared resource | given, revoked |
| `budget-<silo>` | silo budget (all ceilings) | ceiling set, reserved, settled, period started |
| `scope-<id>` | brain permission scope | memory written, corrected, forgotten, consolidated, promoted |
| `routine-<id>` | scheduled routine | created, due, paused, retired |
| `security-<silo>` | silo | alerts |

## Catalogue

### Organisation, members and teams
| Event | Emitted by | Projections (content) | Reactions (logic) |
|---|---|---|---|
| `org.created` | install | org | create the budget stream with defaults; generate gateway config |
| `member.invited` | admin command | invitations | send the invitation |
| `member.joined` | invitation accepted | members | OpenFGA `member`; emit `assistant.created` (personal) |
| `member.role_changed` | admin command | members | OpenFGA role tuples |
| `member.removed` | admin command | members | OpenFGA delete; emit `connection.revoked` for each connection; suspend the person's computer; audit |
| `team.created` / `team.member_added` / `team.member_removed` | admin command | teams | OpenFGA team tuples |

### Assistants and computers
| Event | Emitted by | Projections | Reactions |
|---|---|---|---|
| `assistant.created` | reaction or admin | assistants (owner, kind, scope) | OpenFGA `acts_for`; request a computer on first use |
| `assistant.settings_changed` | owner or admin | assistants (model, persona, tools) | update the computer's configuration on next wake |
| `computer.claimed` | server (claim & bind) | computers (Pod UID, generation) | — (the token is issued inside the claim command) |
| `computer.ready` | bridge | computers | deliver queued messages and decisions |
| `computer.suspended` / `computer.resumed` | server | computers | — |
| `computer.lost` | server (Pod gone) | computers | mark in-flight effects of this computer `effect.uncertain`; re-claim when needed |
| `computer.retired` | server | computers | delete snapshots after retention |
| `takeover.started` / `takeover.ended` | live-view proxy | computers, audit | pause / resume the agent |

### Conversations and agent activity
| Event | Emitted by | Projections | Reactions |
|---|---|---|---|
| `conversation.created` | command | conversations | OpenFGA participants |
| `participant.added` / `participant.removed` | command | conversations | OpenFGA participants; stream access updated |
| `message.posted` | person, or the system for routines | messages | deliver to the assistant's computer (wake it if suspended); browser stream |
| `agent.turn_started` / `agent.turn_completed` / `agent.turn_failed` | bridge (reported) | activity | browser stream; notify on failure |
| `agent.message_completed` | bridge (reported) | messages | browser stream. Streamed text deltas are sent live and not stored as events |
| `agent.reasoning_summarised` | bridge (reported) | activity | browser stream |
| `agent.command_ran` / `agent.file_changed` | bridge (reported) | activity | browser stream |
| `conversation.closed` | command | conversations | tell the computer to stop work for it |

### Tools, approvals and effects
| Event | Emitted by | Projections | Reactions |
|---|---|---|---|
| `tool.approval_requested` | decision service (mode Ask) | approvals | notify the requester; approval card |
| `approval.decided` | requester | approvals | deliver the decision to the computer (wake it) |
| `approval.expired` | timer | approvals | tell the computer |
| `approval.used` | decision service (single use) | approvals | — |
| `effect.observed` | gateway log ingest | audit, usage | settle the budget; with no matching permit → `security.alert_raised` |
| `effect.uncertain` | settle timeout or `computer.lost` | audit, effects | notify for manual resolution |
| `effect.resolved` | person | audit, effects | settle or release the reservation |

### MCP catalogue, grants and connections
| Event | Emitted by | Projections | Reactions |
|---|---|---|---|
| `mcp.server_registered` | admin | catalogue (draft) | validate (SSRF / image scan) → `mcp.server_discovered` or `mcp.server_rejected` |
| `mcp.server_discovered` | reaction | catalogue (tools, schema digests) | — |
| `mcp.tool_mode_set` | admin | tool modes (Allow / Ask / Block) | regenerate gateway config |
| `mcp.server_published` / `mcp.server_unpublished` | admin | catalogue | regenerate gateway config |
| `mcp.tool_list_changed` | drift check | catalogue | quarantine the server in gateway config until re-reviewed |
| `grant.given` / `grant.revoked` | admin or owner | grants | OpenFGA tuples |
| `connection.created` | person | connections (secret *reference* only) | — (the credential is written to the secret store inside the command, before the append; a clean-up job removes orphaned secrets) |
| `connection.refreshed` | reaction (OAuth refresh) | connections | — |
| `connection.revoked` | person, admin or reaction | connections | delete the secret |

### Budgets (single-writer actor per silo)
| Event | Emitted by | Projections | Reactions |
|---|---|---|---|
| `budget.ceiling_set` | admin | budgets | — |
| `budget.reserved` | budget actor (inside `ext_authz`) | budgets | — |
| `budget.settled` | budget actor (on `effect.observed`) | budgets, usage | — |
| `budget.period_started` | timer (00:00 UTC on the 1st) | budgets | — |
| `budget.exhausted` | budget actor | budgets | notify admins; stop affected work (hard stop cascades) |

### Company brain
| Event | Emitted by | Projections | Reactions |
|---|---|---|---|
| `memory.written` | brain MCP (remember) | Cognee dataset of that scope | schedule dreaming for that scope |
| `memory.corrected` / `memory.forgotten` | brain MCP | Cognee | forget: delete the payload key, then tombstone |
| `memory.consolidated` | dreaming job (per scope, as the scope's principal) | Cognee | — |
| `scope.promotion_requested` / `scope.promoted` | person / approver | scopes | OpenFGA viewer tuples; copy to the target dataset |

Cognee is a projection like any other, but rebuilding it re-runs extraction, which costs model calls. Treat a brain rebuild as an explicit, budgeted operation. `memory.consolidated` events preserve dreaming results, so they don't have to be recomputed.

### Routines and delegation
| Event | Emitted by | Projections | Reactions |
|---|---|---|---|
| `routine.created` / `routine.updated` / `routine.paused` / `routine.resumed` / `routine.retired` | person | routines | schedule the next firing |
| `routine.due` | scheduler | routines (last firing) | emit `message.posted` to the routine's assistant; one firing only |
| `delegation.started` / `delegation.completed` | parent or child computer | delegations | deliver the child's result to the parent |

### Security
| Event | Emitted by | Projections | Reactions |
|---|---|---|---|
| `security.alert_raised` | any reaction | alerts | notify admins |

## Rebuilding content

1. **Deploy the new projection code.** It writes to shadow tables with its own checkpoint.
2. **Replay from the beginning** in order per stream. Reactions stay off.
3. **When the shadow catches up to live, switch reads over** and drop the old tables.

The same procedure recovers from a corrupted projection, adds a new read model, or restores a silo from event-store backups. **Content tables never need their own backup to be correct**; they are backed up only to shorten restore time.
