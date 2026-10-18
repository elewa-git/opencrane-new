import { wireSubject, type EventStore } from '@opencrane/event-store';
import { assistantCreatedDataSchema, assistantSettingsChangedDataSchema,
  teamCreatedDataSchema } from '@opencrane/events';
import { budgetCommandSchema } from '@opencrane/protocol';
import { history } from './event-history.ts';
import { MemberAccessRefused } from './member-authority.ts';

export async function budgetScope(store: EventStore, silo: string, raw: unknown) {
  const command = budgetCommandSchema.parse(raw);
  const deadline = performance.now() + 10_000;
  const positions = new Map<string, number>();
  async function load(subject: string) {
    wireSubject(subject);
    const rows = await history(store, subject, silo, deadline);
    positions.set(subject, rows.at(-1)?.sequence ?? 0);
    for (const { event } of rows) {
      if (event.subject !== subject) {
        throw new MemberAccessRefused('Spending choice unavailable');
      }
    }
    return rows;
  }
  async function checkGroup(groupId: string) {
    const rows = await load(`team-${groupId}`);
    for (const { event } of rows) {
      if (event.type === 'team.created') {
        const group = teamCreatedDataSchema.parse(event.data);
        if (group.teamId === groupId) {
          return;
        }
      }
    }
    throw new MemberAccessRefused('Spending choice unavailable');
  }
  if (command.scope === 'paying_group') {
    await checkGroup(command.scopeId);
  }
  if (command.scope === 'assistant') {
    const assistantRows = await load(`assistant-${command.scopeId}`);
    const ownerId = sharedAssistantOwner(assistantRows, command.scopeId);
    const computerRows = await load(`computer-${command.scopeId}`);
    for (const { event } of computerRows) {
      if (event.type === 'computer.retired') {
        throw new MemberAccessRefused('Spending choice unavailable');
      }
    }
    await checkGroup(ownerId);
  }
  if (command.scope === 'global' && command.defaultPayingGroupId !== undefined) {
    await checkGroup(command.defaultPayingGroupId);
  }
  return positions;
}

function sharedAssistantOwner(rows: Awaited<ReturnType<typeof history>>, assistantId: string) {
  let ownerId: string | undefined;
  let active = true;
  for (const { event } of rows) {
    if (event.type === 'assistant.created') {
      const assistant = assistantCreatedDataSchema.parse(event.data);
      if (assistant.kind !== 'team' || assistant.assistantId !== assistantId) {
        throw new MemberAccessRefused('Spending choice unavailable');
      }
      ownerId = assistant.ownerId;
    }
    if (event.type === 'assistant.settings_changed') {
      const settings = assistantSettingsChangedDataSchema.parse(event.data);
      if (settings.assistantId !== assistantId) {
        throw new MemberAccessRefused('Spending choice unavailable');
      }
      if (settings.active !== undefined) {
        active = settings.active;
      }
    }
  }
  if (!ownerId || !active) {
    throw new MemberAccessRefused('Spending choice unavailable');
  }
  return ownerId;
}
