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
  const subject = `memberaudit-${memberId}`;
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(subject, 1, deadline)) {
    const data = memberCommandRefusedSchema.parse(row.event.data);
    if (row.event.silo !== silo || row.event.subject !== subject
      || row.event.type !== 'member.command_refused' || data.memberId !== memberId
      || rows.length >= 10_000) {
      throw new Error('Refusal history unavailable');
    }
    rows.push(row);
  }
  return rows;
}

export async function recordMemberRefusal(store: RefusalStore, silo: string, actor: string,
  operation: 'invite' | 'join', input: { memberId: string; commandId: string;
    invitationId?: string }, reason: string, time: Date): Promise<boolean> {
  const attempted = {
    memberId: input.memberId, originalCommandId: input.commandId,
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
    const rows = await refusalHistory(store, silo, input.memberId, deadline);
    function matches(row: StoredEvent) {
      return row.event.commandId === key && row.event.principal?.id === actor;
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
