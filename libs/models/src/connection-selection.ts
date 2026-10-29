import { createHash } from 'node:crypto';
import { z } from 'zod';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionSelectedDataSchema, type EventEnvelope } from '@opencrane/events';
import { envelope, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { foldConnection } from './bearer-connections.ts';
import { activeMember, readActiveMember, MemberAccessRefused } from './member-authority.ts';
import { connectionServer } from './connection-server.ts';
import { data } from './state.ts';
import { selectedOAuth, type OAuthConfigurationLoader } from './oauth-selection.ts';

export class SelectionInputInvalid extends Error {}
export class SelectionConflict extends Error {}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const fields = { serverId: id, connectionId: id, changeRef: id,
  expectedSequence: z.int().nonnegative() };
const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...fields, action: z.literal('select'), profileId: id,
    profileRevision: z.int().positive() }),
  z.strictObject({ ...fields, action: z.literal('clear') }),
]);
type Selection = z.infer<typeof connectionSelectedDataSchema>;
function digest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}
function selectionSubject(userId: string, serverId: string) {
  return `connection-selection-${userId}-${serverId}`;
}
export function validSelectionIdentity(row: StoredEvent, selected: Selection) {
  const event = row.event;
  const subject = selectionSubject(selected.userId, selected.serverId);
  return event.type === 'connection.selected' && event.subject === subject &&
    event.source === 'opencrane-server' &&
    event.principal?.kind === 'human' && event.principal.id === selected.userId &&
    event.id === digest([event.silo, subject, event.commandId]);
}

/** Rebuild only the explicit choice. Current profile and access checks happen separately. */
export function foldConnectionSelection(rows: StoredEvent[]) {
  let sequence = 0;
  let selected: Selection | null = null;
  for (const row of rows) {
    const parsed = connectionSelectedDataSchema.safeParse(row.event.data);
    selected = null;
    if (parsed.success && validSelectionIdentity(row, parsed.data) &&
        row.event.silo === rows[0]?.event.silo && row.event.subject === rows[0]?.event.subject &&
        parsed.data.expectedSequence === sequence && row.sequence > sequence &&
        parsed.data.action === 'select') {
      selected = parsed.data;
    }
    sequence = Math.max(sequence, row.sequence);
  }
  return { sequence, selected };
}
async function facts(store: EventStore, silo: string, selection: Selection,
  loadConfiguration?: OAuthConfigurationLoader, toolName?: string) {
  const deadline = performance.now() + 10_000;
  const serverSubject = `mcp-${selection.serverId}`;
  const rows = await history(store, serverSubject, silo, deadline);
  const server = connectionServer(rows, selection.connectionId);
  const control = `connection-control-${selection.userId}-${selection.serverId}`;
  const controlSequence = await store.head(control, deadline);
  const positions = new Map([[serverSubject, server.sequence], [control, controlSequence]]);
  let available = false;
  let oauth: Awaited<ReturnType<typeof selectedOAuth>> = null;
  let expiresAt = server.expiresAt;
  if (selection.action === 'select') {
    const subject = `connection-${selection.userId}-${selection.serverId}-${selection.profileId}`;
    const profileRows = await history(store, subject, silo, deadline);
    const profile = foldConnection(profileRows);
    oauth = await selectedOAuth(profileRows, rows, selection, loadConfiguration, toolName);
    if (oauth) {
      expiresAt = Math.min(expiresAt, oauth.expiresAt);
    }
    positions.set(subject, profile.sequence);
    available = controlSequence === 0 && server.available &&
      (oauth !== null || (toolName === undefined && profileMatchesSelection(profile, selection))) &&
      profile.data?.activation.endpointDigest === server.endpointDigest;
  }
  return { available, positions, connectionId: server.connectionId, expiresAt, oauth };
}
function profileMatchesSelection(profile: ReturnType<typeof foldConnection>,
  selection: Extract<Selection, { action: 'select' }>) {
  const saved = profile.data;
  return profile.status === 'saved_unverified' && profile.sequence === selection.profileRevision &&
    saved?.userId === selection.userId && saved.serverId === selection.serverId &&
    saved.profile === selection.profileId &&
    saved.activation.connectionId === selection.connectionId;
}
async function grantFacts(store: EventStore, binding: Binding, userId: string, serverId: string) {
  const deadline = performance.now() + 10_000;
  const subject = grantStream('mcp_server', serverId);
  const grants = await history(store, subject, binding.silo, deadline);
  const positions = new Map([[subject, grants.at(-1)?.sequence ?? 0]]);
  const teams = new Set<string>();
  const receipts: StoredEvent[] = [];
  for (const row of grants) {
    const fields = data(row.event);
    if (fields['granteeKind'] === 'team') {
      teams.add(String(fields['granteeId']));
    }
    if (fields['granteeId'] === userId || fields['granteeKind'] === 'team' ||
        fields['granteeKind'] === undefined) {
      receipts.push(row);
    }
  }
  for (const team of teams) {
    const teamSubject = `team-${team}`;
    const rows = await history(store, teamSubject, binding.silo, deadline);
    positions.set(teamSubject, rows.at(-1)?.sequence ?? 0);
    for (const row of rows) {
      if (data(row.event)['memberId'] === userId) {
        receipts.push(row);
      }
    }
  }
  return { positions, receipts };
}
async function access(store: EventStore, binding: Binding, userId: string, serverId: string,
  writing = false) {
  const { positions, receipts } = await grantFacts(store, binding, userId, serverId);
  let fresh: Awaited<ReturnType<typeof authorityFence>> | undefined;
  if (writing) {
    fresh = await authorityFence(store, performance.now(), [...positions.keys()]);
    const options = { requiredRole: 'member' as const, fresh };
    await activeMember(store, binding, userId, options);
    await confirmPositions(store, positions, fresh.deadline);
  } else {
    await readActiveMember(store, binding, userId);
  }
  const auth = memberAuthorisation(binding);
  for (const row of receipts) {
    if (!await auth.applied(row.event.id)) {
      throw new Error('Selection access unavailable');
    }
  }
  const permission = await auth.use('person', userId, 'mcp_server', serverId);
  if (permission.status === 'unavailable') {
    throw new Error('Selection access unavailable');
  }
  if (!permission.allowed) {
    throw new MemberAccessRefused('Selection access unavailable');
  }
  return fresh;
}
async function confirmPositions(store: EventStore, positions: Map<string, number>, deadline: number) {
  for (const [subject, sequence] of positions) {
    if (await store.head(subject, deadline) !== sequence) {
      throw new SelectionConflict('Selection conflict');
    }
  }
}
function receipt(row: StoredEvent) {
  const selected = connectionSelectedDataSchema.parse(row.event.data);
  const status = selected.action === 'select' ? 'selected' as const : 'cleared' as const;
  return { status, sequence: row.sequence, changeRef: row.event.commandId };
}
function sameReceipt(row: StoredEvent, attempted: EventEnvelope) {
  const parsed = connectionSelectedDataSchema.safeParse(row.event.data);
  if (!parsed.success || !validSelectionIdentity(row, parsed.data) ||
      row.event.id !== attempted.id || row.event.silo !== attempted.silo ||
      row.event.subject !== attempted.subject || row.event.commandId !== attempted.commandId ||
      digest(parsed.data) !== digest(attempted.data)) {
    throw new SelectionConflict('Selection conflict');
  }
  return receipt(row);
}

function requireCurrentSelection(selection: Selection, rows: StoredEvent[],
  checked: Awaited<ReturnType<typeof facts>>) {
  let connectionId = checked.connectionId;
  if (selection.action === 'clear') {
    // Clear the saved binding even while a replacement installation has no discovery result.
    const state = foldConnectionSelection(rows);
    connectionId = state.selected?.connectionId ?? connectionId;
  }
  if (selection.expectedSequence !== (rows.at(-1)?.sequence ?? 0) ||
      selection.connectionId !== connectionId ||
      (selection.action === 'select' && (!checked.available ||
        (checked.oauth !== null && checked.oauth.profileRevision !== selection.profileRevision)))) {
    throw new SelectionConflict('Selection conflict');
  }
}

/** Save one choice for the authenticated caller; never accept an owner from the request. */
export async function changeConnectionSelection(store: EventStore, binding: Binding,
  userId: string, raw: unknown, loadConfiguration?: OAuthConfigurationLoader) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success || !id.safeParse(userId).success) {
    throw new SelectionInputInvalid('Selection input invalid');
  }
  const { changeRef, ...input } = parsed.data;
  const payload = { ...input, userId };
  const selected = connectionSelectedDataSchema.parse(payload);
  const subject = selectionSubject(userId, input.serverId);
  const operationId = digest([binding.silo, subject, changeRef]);
  const event = { ...envelope(binding.silo, subject, 'connection.selected', selected, operationId),
    commandId: changeRef, source: 'opencrane-server', principal: { kind: 'human' as const, id: userId } };
  function matches(row: StoredEvent) {
    return row.event.id === operationId || row.event.commandId === changeRef;
  }
  async function loadSelectionHistory() {
    try {
      const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
      const original = rows.find(matches);
      if (original) {
        sameReceipt(original, event);
      }
      const checked = await facts(store, binding.silo, selected, loadConfiguration);
      return { status: 'loaded' as const, rows, original, checked };
    } catch (error) {
      let failure = new Error('Selection history unavailable', { cause: error });
      if (error instanceof Error) {
        failure = error;
      }
      return { status: 'failed' as const, failure };
    }
  }
  const loaded = await loadSelectionHistory();
  // Check current access before exposing history errors, even when a saved retry conflicts.
  const fresh = await access(store, binding, userId, input.serverId, true);
  if (!fresh) {
    throw new Error('Selection access unavailable');
  }
  await fresh();
  if (loaded.status === 'failed') {
    throw loaded.failure;
  }
  const { rows, original, checked } = loaded;
  if (original) {
    return sameReceipt(original, event);
  }
  requireCurrentSelection(selected, rows, checked);
  const confirmAuthority = fresh;
  async function checkAccess() {
    await confirmAuthority();
    if (checked.oauth && !await checked.oauth.configurationCurrent()) {
      throw new SelectionConflict('Selection conflict');
    }
    await confirmPositions(store, checked.positions, confirmAuthority.deadline);
    if (input.action === 'select' && Date.now() >= checked.expiresAt) {
      throw new Error('Selection unavailable');
    }
  }
  let deadline = fresh.deadline;
  if (input.action === 'select') {
    deadline = Math.min(deadline, performance.now() + checked.expiresAt - Date.now());
  }
  // Repeat exact checks inside the append; the store binds them to the atomic log position.
  const command = { event, expectedSequence: input.expectedSequence, checkAccess,
    historyChecked: true as const, deadline };
  const result = await store.append(command);
  if (result.status === 'unavailable') {
    throw new Error('Selection append unconfirmed');
  }
  // Read saved identity even for a broker duplicate or a concurrent identical command.
  const savedRows = await history(store, subject, binding.silo, performance.now() + 10_000);
  const saved = savedRows.find(matches);
  if (!saved) {
    throw new SelectionConflict('Selection conflict');
  }
  return sameReceipt(saved, event);
}

export async function readConnectionSelection(store: EventStore, binding: Binding,
  userId: string, serverId: string, loadConfiguration?: OAuthConfigurationLoader, toolName?: string) {
  if (!id.safeParse(userId).success || !id.safeParse(serverId).success) {
    throw new SelectionInputInvalid('Selection input invalid');
  }
  const subject = selectionSubject(userId, serverId);
  const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
  const state = foldConnectionSelection(rows);
  const unavailable = { status: 'unavailable' as const, sequence: state.sequence };
  if (!state.selected || state.selected.userId !== userId ||
      state.selected.serverId !== serverId) {
    await readActiveMember(store, binding, userId);
    return unavailable;
  }
  let checked;
  try {
    checked = await facts(store, binding.silo, state.selected, loadConfiguration, toolName);
  } finally {
    await access(store, binding, userId, serverId);
  }
  if (!checked.available) {
    return unavailable;
  }
  if (checked.oauth) {
    // Check data changes after the single permission decision, without a read authority fence.
    checked.positions.set(subject, state.sequence);
    if (!await checked.oauth.configurationCurrent()) {
      return unavailable;
    }
    try {
      await confirmPositions(store, checked.positions, performance.now() + 10_000);
    } catch (error) {
      if (error instanceof SelectionConflict) {
        return unavailable;
      }
      throw error;
    }
    if (Date.now() >= checked.expiresAt) {
      return unavailable;
    }
    return { status: 'verified' as const, sequence: state.sequence,
      profileId: state.selected.profileId, profileRevision: checked.oauth.profileRevision,
      generation: checked.oauth.generation };
  }
  return { status: 'saved_unverified' as const, sequence: state.sequence,
    profileId: state.selected.profileId, profileRevision: state.selected.profileRevision };
}
