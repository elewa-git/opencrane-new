import { gatewayConfigurationSchema } from '@opencrane/events';
import { wireSubject, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { envelope, history } from './actor.ts';
import { toolPolicyFromRows } from './tool-policy.ts';
import { publicationDigest, publicationEntry } from './publication.ts';

type Configuration = ReturnType<typeof gatewayConfigurationSchema.parse>;
type ConfigurationStore = Pick<EventStore, 'append' | 'head' | 'readEvent' | 'readStream'>;

function requested(row: StoredEvent) {
  return row.event.type === 'gateway.configuration_requested';
}

function configurationFromRow(row: StoredEvent): Configuration {
  if (row.event.type !== 'gateway.configuration_requested') {
    throw new Error('Unexpected gateway configuration event');
  }
  return gatewayConfigurationSchema.parse(row.event.data);
}

function exactMcpSubject(serverId: string) {
  const subject = `mcp-${serverId}`;
  wireSubject(subject);
  return subject;
}

async function currentMember(store: ConfigurationStore, silo: string, serverId: string,
  changeRef: string) {
  const subject = exactMcpSubject(serverId);
  const rows = await history(store, subject, silo);
  const state = toolPolicyFromRows(rows);
  const intent = state.publication;
  const entry = publicationEntry(state);
  if (!intent || intent.commandId !== changeRef || !entry ||
      intent.reviewRevision !== entry.reviewRevision ||
      intent.fragmentDigest !== publicationDigest(entry)) {
    throw new Error('Publication is unavailable');
  }
  return { entry, changeRef, sourceSequence: state.sequence, fragmentDigest: intent.fragmentDigest };
}

export function gatewayMemberCurrent(rows: StoredEvent[], member: Configuration['members'][number]) {
  function atSource(row: StoredEvent) {
    return row.sequence <= member.sourceSequence;
  }
  const sourceRows = rows.filter(atSource);
  if (sourceRows.at(-1)?.sequence !== member.sourceSequence) {
    return false;
  }
  const source = toolPolicyFromRows(sourceRows);
  const current = toolPolicyFromRows(rows);
  const entry = publicationEntry(current);
  return entry !== null && current.serverId === member.entry.serverId &&
    source.policyRevision === current.policyRevision &&
    source.publication?.commandId === member.changeRef &&
    current.publication?.commandId === member.changeRef &&
    current.publication.fragmentDigest === member.fragmentDigest &&
    publicationDigest(entry) === member.fragmentDigest &&
    publicationDigest(member.entry) === member.fragmentDigest;
}

export async function gatewayConfigurationCurrent(store: ConfigurationStore, silo: string,
  record: Configuration) {
  const configurationSubject = `gateway-config-${silo}`;
  wireSubject(configurationSubject);
  for (const member of record.members) {
    const subject = exactMcpSubject(member.entry.serverId);
    const rows = await history(store, subject, silo, performance.now() + 10_000);
    if (!gatewayMemberCurrent(rows, member)) {
      return false;
    }
  }
  const { recordDigest, ...saved } = record;
  const position = await store.head(configurationSubject);
  if (position === 0 || recordDigest !== publicationDigest(saved)) {
    return false;
  }
  const rows = await history(store, configurationSubject, silo);
  const requests = rows.filter(requested);
  const latest = requests.at(-1);
  return latest !== undefined && configurationFromRow(latest).recordDigest === recordDigest;
}

export async function prepareGatewayConfiguration(store: ConfigurationStore, silo: string,
  serverId: string, changeRef: string): Promise<Configuration> {
  const subject = `gateway-config-${silo}`;
  wireSubject(subject);
  exactMcpSubject(serverId);
  // Retry a competing append from its saved record, preserving both separate changes.
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await history(store, subject, silo);
    const requests = rows.filter(requested);
    const records = requests.map(configurationFromRow);
    for (const record of records) {
      if (record.changeRef === changeRef) {
        function matchesIntent(member: Configuration['members'][number]) {
          return member.entry.serverId === serverId && member.changeRef === changeRef;
        }
        if (!record.members.some(matchesIntent)) {
          throw new Error('Publication conflicts');
        }
        return record;
      }
    }
    const previous = records.at(-1);
    const members: Configuration['members'] = [];
    for (const member of previous?.members ?? []) {
      if (member.entry.serverId === serverId) {
        continue;
      }
      // Keep the review used by the last generation while another intent awaits preparation.
      members.push(member);
    }
    const changed = await currentMember(store, silo, serverId, changeRef);
    members.push(changed);
    const saved = { changeRef, generation: (previous?.generation ?? 0) + 1,
      rendererVersion: '1' as const, members };
    const record = { ...saved, recordDigest: publicationDigest(saved) };
    const event = envelope(silo, subject, 'gateway.configuration_requested', record);
    const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0 };
    const result = await store.append(command);
    if (result.status === 'appended') {
      return record;
    }
    if (result.status !== 'conflict') {
      throw new Error('Gateway preparation unavailable');
    }
  }
  throw new Error('Gateway preparation busy');
}
