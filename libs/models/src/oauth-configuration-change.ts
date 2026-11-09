import { randomUUID } from 'node:crypto';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { mcpOAuthConfigurationDataSchema } from '@opencrane/events';
import { envelope } from './budget-migration.ts';
import { history } from './event-history.ts';
import { oauthConfigurationDigest, oauthConfigurationSchema } from './oauth-attempt.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';

type Change = { changeId: string; sequence: number };

/** Mark the tool server before a trusted editor changes its OAuth settings. */
export async function startOAuthConfigurationChange(store: EventStore, silo: string,
  serverId: string): Promise<Change> {
  const subject = `mcp-${serverId}`;
  const rows = await history(store, subject, silo);
  const lastChange = rows.findLast(isConfigurationChange);
  if (lastChange) {
    const previous = mcpOAuthConfigurationDataSchema.parse(lastChange.event.data);
    if (previous.status !== 'ready') {
      throw new Error('OAuth configuration change unavailable');
    }
  }
  const changeId = randomUUID();
  const expectedSequence = rows.at(-1)?.sequence ?? 0;
  const data = { serverId, changeId, status: 'changing' };
  const event = envelope(silo, subject, 'mcp.oauth_configuration_recorded', data);
  const command = { event, expectedSequence, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status !== 'appended' || result.outcome?.kind !== 'appended') {
    throw new Error('OAuth configuration change unavailable');
  }
  return { changeId, sequence: result.sequence };
}

/** Save the digest after the trusted editor has finished changing the settings. */
export async function finishOAuthConfigurationChange(store: EventStore, silo: string,
  serverId: string, change: Change, loadConfiguration: OAuthConfigurationLoader) {
  const subject = `mcp-${serverId}`;
  const started = await store.readEvent(change.sequence);
  if (started.event.silo !== silo || started.event.subject !== subject ||
      started.event.type !== 'mcp.oauth_configuration_recorded') {
    throw new Error('OAuth configuration change unavailable');
  }
  const startData = mcpOAuthConfigurationDataSchema.parse(started.event.data);
  if (startData.status !== 'changing' || startData.serverId !== serverId ||
      startData.changeId !== change.changeId) {
    throw new Error('OAuth configuration change unavailable');
  }
  // Leave the changing record in place if the edit or final save fails.
  const current = oauthConfigurationSchema.parse(await loadConfiguration(serverId));
  if (current.serverId !== serverId) {
    throw new Error('OAuth configuration change unavailable');
  }
  const configurationDigest = oauthConfigurationDigest(current);
  const data = { serverId, changeId: change.changeId, status: 'ready',
    configurationDigest };
  const event = envelope(silo, subject, 'mcp.oauth_configuration_recorded', data);
  const command = { event, expectedSequence: change.sequence,
    historyChecked: true as const };
  const result = await store.append(command);
  if (result.status !== 'appended' || result.outcome?.kind !== 'appended') {
    throw new Error('OAuth configuration change unavailable');
  }
}

function isConfigurationChange(row: StoredEvent) {
  return row.event.type === 'mcp.oauth_configuration_recorded';
}
