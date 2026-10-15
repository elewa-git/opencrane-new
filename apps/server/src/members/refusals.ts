import { createHash } from 'node:crypto';
import { memberCommandRefusedSchema } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
type RefusalStore = Pick<EventStore, 'readStream' | 'append' | 'head'>;

export function refusalDigest(value: unknown): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

export async function refusalHistory(store: RefusalStore, silo: string,
  memberId: string, deadline: number): Promise<StoredEvent[]> {
  const rows = await refusalAuditHistory(store, silo, memberId, deadline);
  return rows.filter(isRefusal);
}

function isRefusal(row: StoredEvent) {
  return row.event.type === 'member.command_refused';
}

async function refusalAuditHistory(store: RefusalStore, silo: string,
  memberId: string, deadline: number): Promise<StoredEvent[]> {
  const subject = `memberaudit-${memberId}`;
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo || row.event.subject !== subject
      || rows.length >= 10_000) {
      throw new Error('Refusal history unavailable');
    }
    if (isRefusal(row)) {
      const data = memberCommandRefusedSchema.parse(row.event.data);
      if (data.memberId !== memberId) throw new Error('Refusal history unavailable');
    }
    rows.push(row);
  }
  return rows;
}

export async function recordMemberRefusal(store: RefusalStore, silo: string, actor: string,
  operation: 'invite' | 'join', input: { memberId: string; commandId: string;
    invitationId?: string }, reason: string, time: Date): Promise<boolean> {
  if (!/^[\w-]{1,200}$/u.test(input.commandId)) {
    return false;
  }
  const attempted = {
    memberId: input.memberId, originalCommandDigest: refusalDigest(input.commandId),
    invitationId: input.invitationId, operation, reason, inputDigest: refusalDigest(input),
  };
  const data = memberCommandRefusedSchema.safeParse(attempted);
  if (!data.success) {
    return false;
  }
  const day = time.toISOString().slice(0, 10);
  const key = refusalDigest([silo, actor, operation, input.memberId, reason, day]);
  const deadline = performance.now() + 2_000;
  try {
    // Keep the last sequence from all audit types for the conditional append.
    const rows = await refusalAuditHistory(store, silo, input.memberId, deadline);
    function matches(row: StoredEvent) {
      return isRefusal(row) && row.event.commandId === key && row.event.principal?.id === actor;
    }
    if (rows.some(matches)) {
      return true;
    }
    const event = {
      id: key, commandId: key, silo, subject: `memberaudit-${input.memberId}`,
      type: 'member.command_refused', source: 'opencrane-server', time: time.toISOString(),
      principal: { kind: 'human' as const, id: actor }, data: data.data,
    };
    const command = {
      event, expectedSequence: rows.at(-1)?.sequence ?? 0, historyChecked: true as const, deadline,
    };
    const result = await store.append(command);
    if (result.status === 'appended') {
      return true;
    }
    const updated = await refusalHistory(store, silo, input.memberId, deadline);
    return updated.some(matches);
  } catch {
    // Preserve the real refusal when its separate audit record cannot be saved.
    return false;
  }
}
