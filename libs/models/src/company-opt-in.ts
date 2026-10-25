import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { companyOptInSetDataSchema, type EventEnvelope } from '@opencrane/events';
import { envelope, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { activeMember, MemberAccessRefused } from './member-authority.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

export class CompanyOptInConflict extends Error {}
export class CompanyOptInInputInvalid extends Error {}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const inputFields = companyOptInSetDataSchema.omit({ changedBy: true });
const inputSchema = inputFields.extend({ changeRef: id });
type Choice = z.infer<typeof companyOptInSetDataSchema>;
type Installation = Pick<Choice, 'serverId' | 'connectionId' | 'registrationRevision'> & {
  silo: string;
};
function digest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}
function subjectFor(serverId: string) {
  return `connection-company-${serverId}`;
}
function validIdentity(event: EventEnvelope, choice: Choice) {
  return event.type === 'connection.company_opt_in_set' &&
    event.subject === subjectFor(choice.serverId) && event.source === 'opencrane-server' &&
    event.principal?.kind === 'human' && event.principal.id === choice.changedBy &&
    id.safeParse(event.commandId).success &&
    event.id === digest([event.silo, event.subject, event.commandId]);
}

/** Rebuild the choice for the current installation without starting any work. */
export function foldCompanyOptIn(rows: StoredEvent[], installation: Installation) {
  let sequence = 0;
  let enabled = false;
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.sequence <= sequence) {
      continue;
    }
    const parsed = companyOptInSetDataSchema.safeParse(row.event.data);
    enabled = parsed.success && validIdentity(row.event, parsed.data) &&
      row.event.silo === installation.silo && parsed.data.serverId === installation.serverId &&
      parsed.data.connectionId === installation.connectionId &&
      parsed.data.registrationRevision === installation.registrationRevision &&
      parsed.data.expectedSequence === sequence && !seen.has(row.event.id) && parsed.data.enabled;
    seen.add(row.event.id);
    sequence = row.sequence;
  }
  return { enabled, sequence };
}
function sameReceipt(row: StoredEvent, attempted: EventEnvelope) {
  const parsed = companyOptInSetDataSchema.safeParse(row.event.data);
  if (!parsed.success || !validIdentity(row.event, parsed.data) ||
      row.event.silo !== attempted.silo || row.event.id !== attempted.id ||
      row.event.subject !== attempted.subject || row.event.commandId !== attempted.commandId ||
      digest(parsed.data) !== digest(attempted.data)) {
    throw new CompanyOptInConflict('Company opt-in conflict');
  }
  return { enabled: parsed.data.enabled, sequence: row.sequence, changeRef: row.event.commandId };
}
function currentInstallation(rows: StoredEvent[], choice: Choice) {
  function registered(row: StoredEvent) {
    return row.event.type === 'mcp.server_registered';
  }
  const registration = rows.findLast(registered);
  const policy = toolPolicyFromRows(rows);
  return registration?.sequence === choice.registrationRevision &&
    policy.connectionId === choice.connectionId;
}

/** Take the actor from authenticated context and confirm their current admin membership. */
export async function changeCompanyOptIn(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  try {
    return await saveCompanyOptIn(store, binding, memberId, raw);
  } catch (error) {
    if (error instanceof CompanyOptInConflict || error instanceof CompanyOptInInputInvalid ||
        error instanceof MemberAccessRefused) {
      throw error;
    }
    // Keep dependency messages and private history out of replies and logs.
    // eslint-disable-next-line preserve-caught-error -- Dependency causes may contain credentials.
    throw new Error('Company opt-in unavailable');
  }
}
async function saveCompanyOptIn(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success || !id.safeParse(memberId).success) {
    throw new CompanyOptInInputInvalid('Company opt-in input invalid');
  }
  const { changeRef, ...input } = parsed.data;
  const payload = { ...input, changedBy: memberId };
  const choice = companyOptInSetDataSchema.parse(payload);
  const subject = subjectFor(choice.serverId);
  const serverSubject = `mcp-${choice.serverId}`;
  const operationId = digest([binding.silo, subject, changeRef]);
  const event = { ...envelope(binding.silo, subject, 'connection.company_opt_in_set',
    choice, operationId), commandId: changeRef, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: memberId } };
  function matches(row: StoredEvent) {
    return row.event.id === operationId || row.event.commandId === changeRef;
  }
  async function prepare() {
    try {
      const deadline = performance.now() + 10_000;
      const rows = await history(store, subject, binding.silo, deadline);
      const original = rows.find(matches);
      const serverRows = await history(store, serverSubject, binding.silo, deadline);
      const current = currentInstallation(serverRows, choice);
      return { rows, original, serverRows, current };
    } catch {
      return null;
    }
  }
  const prepared = await prepare();
  const fresh = await authorityFence(store, performance.now());
  await activeMember(store, binding, memberId, { requiredRole: 'admin', fresh });
  // Check membership before reporting even a failed history read or conflicting retry.
  if (!prepared) {
    throw new Error('Company opt-in unavailable');
  }
  const { rows, original, serverRows, current } = prepared;
  if (original) {
    await fresh();
    return sameReceipt(original, event);
  }
  if (choice.expectedSequence !== (rows.at(-1)?.sequence ?? 0) ||
      !current) {
    throw new CompanyOptInConflict('Company opt-in conflict');
  }
  const serverSequence = serverRows.at(-1)?.sequence ?? 0;
  async function checkAccess() {
    await fresh();
    if (await store.head(serverSubject, fresh.deadline) !== serverSequence) {
      throw new CompanyOptInConflict('Company opt-in conflict');
    }
  }
  const command = { event, expectedSequence: choice.expectedSequence, checkAccess,
    historyChecked: true as const, deadline: fresh.deadline };
  const result = await store.append(command);
  if (result.status === 'unavailable') {
    throw new Error('Company opt-in unavailable');
  }
  const saved = await history(store, subject, binding.silo, performance.now() + 10_000);
  const receipt = saved.find(matches);
  if (!receipt) {
    throw new CompanyOptInConflict('Company opt-in conflict');
  }
  return sameReceipt(receipt, event);
}
