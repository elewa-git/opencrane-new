import { gatewayConfigurationSchema } from '@opencrane/events';
import { wireSubject, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { envelope, history } from './actor.ts';
import { toolPolicyFromRows } from './tool-policy.ts';
import { publicationDigest, publicationEntry } from './publication.ts';

type Configuration = ReturnType<typeof gatewayConfigurationSchema.parse>;
type PreparationLimits = { signal: AbortSignal; deadline: number };
type ConfigurationStore = Pick<EventStore, 'append' | 'head' | 'readEvent' | 'readStream'>;

export class PublicationUnavailable extends Error {
  constructor() {
    super('Publication is unavailable');
    this.name = 'PublicationUnavailable';
  }
}

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

async function preparationHistory(store: ConfigurationStore, silo: string, subject: string,
  limits: PreparationLimits) {
  const { signal, deadline } = limits;
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  function abort() {
    cancelled.reject(new Error('Gateway preparation cancelled'));
  }
  async function read() {
    const rows: StoredEvent[] = [];
    for await (const row of store.readStream(subject, 1, deadline)) {
      // Stop a late read before it can request more history or reach an append.
      signal.throwIfAborted();
      if (row.event.silo !== silo) throw new Error('Wrong silo');
      rows.push(row);
    }
    signal.throwIfAborted();
    return rows;
  }
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([read(), cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function currentMember(store: ConfigurationStore, silo: string, serverId: string,
  changeRef: string, limits: PreparationLimits) {
  const subject = exactMcpSubject(serverId);
  const rows = await preparationHistory(store, silo, subject, limits);
  const state = toolPolicyFromRows(rows);
  const intent = state.publication;
  const entry = publicationEntry(state);
  if (!intent || intent.commandId !== changeRef || !entry ||
      intent.reviewRevision !== entry.reviewRevision ||
      intent.fragmentDigest !== publicationDigest(entry)) {
    throw new PublicationUnavailable();
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
  // Keep the publication binding when failed checks advance only the approval revision.
  return entry !== null && current.serverId === member.entry.serverId &&
    source.publicationRevision !== undefined &&
    source.publicationRevision === current.publicationRevision &&
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

async function currentCarriedMembers(store: ConfigurationStore, silo: string,
  previous: Configuration | undefined, serverId: string, limits: PreparationLimits) {
  const members: Configuration['members'] = [];
  for (const member of previous?.members ?? []) {
    if (member.entry.serverId === serverId) continue;
    const rows = await preparationHistory(store, silo, exactMcpSubject(member.entry.serverId), limits);
    if (gatewayMemberCurrent(rows, member)) {
      members.push(member);
    }
  }
  return members;
}

export async function prepareGatewayConfiguration(store: ConfigurationStore, silo: string,
  serverId: string, changeRef: string, attempt?: PreparationLimits): Promise<Configuration> {
  const deadline = attempt?.deadline ?? performance.now() + 60_000;
  const timeout = AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now())));
  const signal = attempt ? AbortSignal.any([attempt.signal, timeout]) : timeout;
  const limits = { signal, deadline };
  const subject = `gateway-config-${silo}`;
  wireSubject(subject);
  exactMcpSubject(serverId);
  // Retry a competing append from its saved record, preserving both separate changes.
  for (let retry = 0; retry < 20; retry++) {
    const rows = await preparationHistory(store, silo, subject, limits);
    const requests = rows.filter(requested);
    const records = requests.map(configurationFromRow);
    for (const record of records) {
      if (record.changeRef === changeRef) {
        function matchesIntent(member: Configuration['members'][number]) {
          return member.entry.serverId === serverId && member.changeRef === changeRef;
        }
        if (!record.members.some(matchesIntent)) {
          throw new PublicationUnavailable();
        }
        return record;
      }
    }
    const previous = records.at(-1);
    const members = await currentCarriedMembers(store, silo, previous, serverId, limits);
    const changed = await currentMember(store, silo, serverId, changeRef, limits);
    members.push(changed);
    const saved = { changeRef, generation: (previous?.generation ?? 0) + 1,
      rendererVersion: '1' as const, members };
    const record = { ...saved, recordDigest: publicationDigest(saved) };
    const event = envelope(silo, subject, 'gateway.configuration_requested', record);
    signal.throwIfAborted();
    const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0, signal, deadline };
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
