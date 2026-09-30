// The event-type registry: every event type named in
// docs/architecture/events.md, in code. This is the contract CI checks:
// scripts/check-event-catalogue.mjs fails the build if this list and the
// catalogue's tables ever disagree, in either direction.
//
// Each entry names the stream-type prefix the event belongs to (see the
// "Streams" table in the catalogue, e.g. `member-<user>`) and gives a
// one-line description. Data schemas are `z.unknown()` placeholders except
// for the four fully-typed examples from examples.ts.
import { z } from 'zod';
import {
  approvalDecidedDataSchema,
  effectObservedDataSchema,
  memberJoinedDataSchema,
  messagePostedDataSchema,
} from './examples.ts';

export interface EventDefinition<DataSchema extends z.ZodType = z.ZodType> {
  /** The event type, in past tense, e.g. "member.joined". */
  readonly type: string;
  /** The stream-type prefix this event is appended to, e.g. "member" for `member-<user>`. */
  readonly stream: string;
  /** One line describing what the event means. */
  readonly description: string;
  /** The zod schema for this event's `data` field. */
  readonly dataSchema: DataSchema;
}

function unknownEvent(type: string, stream: string, description: string): EventDefinition {
  return { type, stream, description, dataSchema: z.unknown() };
}

export const eventRegistry: readonly EventDefinition[] = [
  // Organisation, members and teams
  unknownEvent('org.created', 'org', 'A new silo (customer organisation) was installed.'),
  unknownEvent('member.invited', 'member', 'An admin invited someone to join.'),
  {
    type: 'member.joined',
    stream: 'member',
    description: 'An invitation was accepted and the person became a member.',
    dataSchema: memberJoinedDataSchema,
  },
  unknownEvent('member.role_changed', 'member', "An admin changed a member's role."),
  unknownEvent('member.removed', 'member', 'An admin removed a member from the silo.'),
  unknownEvent('team.created', 'team', 'An admin created a team.'),
  unknownEvent('team.member_added', 'team', 'An admin added a member to a team.'),
  unknownEvent('team.member_removed', 'team', 'An admin removed a member from a team.'),

  // Assistants and computers
  unknownEvent(
    'assistant.created',
    'assistant',
    'A personal or team assistant was created (usually reacting to member.joined).',
  ),
  unknownEvent('assistant.settings_changed', 'assistant', "An owner or admin changed an assistant's model, persona or tools."),
  unknownEvent('computer.claimed', 'computer', 'The server bound a warm Pod to an assistant and issued its token.'),
  unknownEvent('computer.ready', 'computer', 'The bridge reported the computer is ready to receive work.'),
  unknownEvent('computer.suspended', 'computer', 'The server suspended an idle computer to a snapshot.'),
  unknownEvent('computer.resumed', 'computer', 'The server resumed a computer from its snapshot.'),
  unknownEvent('computer.lost', 'computer', "The computer's Pod disappeared unexpectedly."),
  unknownEvent('computer.retired', 'computer', 'The computer was retired and its snapshots are due for deletion.'),
  unknownEvent('takeover.started', 'computer', 'A person started a live-view takeover of a computer.'),
  unknownEvent('takeover.ended', 'computer', 'A live-view takeover ended and control returned to the agent.'),

  // Conversations and agent activity
  unknownEvent('conversation.created', 'conversation', 'A new conversation was started.'),
  unknownEvent('participant.added', 'conversation', 'Someone was added to a conversation.'),
  unknownEvent('participant.removed', 'conversation', 'Someone was removed from a conversation.'),
  {
    type: 'message.posted',
    stream: 'conversation',
    description: 'A person, or the system for a routine, posted a message into a conversation.',
    dataSchema: messagePostedDataSchema,
  },
  unknownEvent('agent.turn_started', 'conversation', 'The bridge reported that the assistant started a turn.'),
  unknownEvent('agent.turn_completed', 'conversation', 'The bridge reported that a turn finished.'),
  unknownEvent('agent.turn_failed', 'conversation', 'The bridge reported that a turn failed.'),
  unknownEvent('agent.message_completed', 'conversation', 'The bridge reported a completed assistant message.'),
  unknownEvent('agent.reasoning_summarised', 'conversation', 'The bridge reported a reasoning summary for a turn.'),
  unknownEvent('agent.command_ran', 'conversation', 'The bridge reported a command the agent ran, with its exit status.'),
  unknownEvent('agent.file_changed', 'conversation', 'The bridge reported a file the agent changed in its workspace.'),
  unknownEvent('conversation.closed', 'conversation', 'A conversation was closed; the computer should stop work on it.'),

  // Tools, approvals and effects
  unknownEvent('tool.approval_requested', 'approval', 'The decision service refused a call in "Ask" mode and opened an approval.'),
  {
    type: 'approval.decided',
    stream: 'approval',
    description: 'A person approved or rejected a pending tool call.',
    dataSchema: approvalDecidedDataSchema,
  },
  unknownEvent('approval.expired', 'approval', 'An approval timed out before anyone decided it.'),
  unknownEvent('approval.used', 'approval', 'A single-use approval was consumed by its matching retry.'),
  {
    type: 'effect.observed',
    stream: 'effect',
    description: 'The gateway observed an external call (model, tool or web) complete.',
    dataSchema: effectObservedDataSchema,
  },
  unknownEvent('effect.uncertain', 'effect', "An effect's outcome is unknown after a settle timeout or a lost computer."),
  unknownEvent('effect.resolved', 'effect', 'A person resolved an uncertain effect.'),

  // MCP catalogue, grants and connections
  unknownEvent('mcp.server_registered', 'mcp', 'An admin registered a new MCP server in the catalogue (draft).'),
  unknownEvent('mcp.server_discovered', 'mcp', "Discovery read the server's tool list and schema digests."),
  unknownEvent('mcp.server_rejected', 'mcp', 'Validation (SSRF guard or image scan) failed, so the server was rejected.'),
  unknownEvent('mcp.tool_mode_set', 'mcp', 'An admin set a tool to Allow automatically, Ask, or Block.'),
  unknownEvent('mcp.server_published', 'mcp', 'An admin published an MCP server, generating its gateway route.'),
  unknownEvent('mcp.server_unpublished', 'mcp', 'An admin unpublished an MCP server, removing its gateway route.'),
  unknownEvent('mcp.tool_list_changed', 'mcp', "A drift check found the server's tool list or schema changed."),
  unknownEvent('grant.given', 'grant', 'A shared resource was granted to a person, team or assistant.'),
  unknownEvent('grant.revoked', 'grant', 'A grant on a shared resource was revoked.'),
  unknownEvent('connection.created', 'connection', 'A person completed a credential connection to an MCP server.'),
  unknownEvent('connection.refreshed', 'connection', "A reaction refreshed a connection's OAuth token."),
  unknownEvent('connection.revoked', 'connection', 'A connection was revoked and its secret deleted.'),

  // Budgets
  unknownEvent('budget.ceiling_set', 'budget', 'An admin set a EUR ceiling (global, paying group, or assistant).'),
  unknownEvent('budget.reserved', 'budget', 'The budget actor reserved the worst-case cost of a call.'),
  unknownEvent('budget.settled', 'budget', 'The budget actor settled a reservation against its observed effect.'),
  unknownEvent('budget.period_started', 'budget', 'A new monthly budget period started.'),
  unknownEvent('budget.exhausted', 'budget', 'A budget ceiling was reached; affected work stops.'),

  // Company brain
  unknownEvent('memory.written', 'scope', 'The brain MCP wrote a memory into a permission scope.'),
  unknownEvent('memory.corrected', 'scope', 'The brain MCP corrected an existing memory.'),
  unknownEvent('memory.forgotten', 'scope', "A memory's key was deleted and a tombstone appended."),
  unknownEvent('memory.consolidated', 'scope', 'A dreaming job consolidated memories for one scope.'),
  unknownEvent('scope.promotion_requested', 'scope', 'Someone asked to promote memory from one scope to a wider one.'),
  unknownEvent('scope.promoted', 'scope', 'An approver promoted memory to a wider scope.'),

  // Routines and delegation
  unknownEvent('routine.created', 'routine', 'A person created a scheduled routine.'),
  unknownEvent('routine.updated', 'routine', 'A person changed a scheduled routine.'),
  unknownEvent('routine.paused', 'routine', 'A person paused a scheduled routine.'),
  unknownEvent('routine.resumed', 'routine', 'A person resumed a paused routine.'),
  unknownEvent('routine.retired', 'routine', 'A person retired a scheduled routine.'),
  unknownEvent('routine.due', 'routine', "The scheduler fired a routine; exactly one firing is emitted."),
  unknownEvent('delegation.started', 'delegation', 'A parent computer delegated work to a child sub-agent.'),
  unknownEvent('delegation.completed', 'delegation', "A child computer's delegated work finished."),

  // Security
  unknownEvent('security.alert_raised', 'security', 'A reaction raised a security alert for admins to review.'),
];

const registryByType = new Map(eventRegistry.map((entry) => [entry.type, entry]));

export function getEventDefinition(type: string): EventDefinition | undefined {
  return registryByType.get(type);
}

export function listEventTypes(): string[] {
  return eventRegistry.map((entry) => entry.type);
}
