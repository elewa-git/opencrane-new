import type { z } from 'zod';
import type { EventEnvelope, memberJoinedDataSchema } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { appendEvent } from '@opencrane/event-store/testing';
import type { memberAuthorisation } from '@opencrane/authz';
import type { Query } from '@opencrane/projections';

type MemberData = z.infer<typeof memberJoinedDataSchema>;
export type TestMember = Pick<MemberData, 'memberId' | 'role'> &
  Partial<Pick<MemberData, 'email' | 'displayName'>>;

export interface JoinMembersOptions {
  store: EventStore;
  silo: string;
  auth?: ReturnType<typeof memberAuthorisation>;
  db?: Query;
  project?: (event: EventEnvelope, sequence: number) => Promise<void>;
}

export async function joinMembers(options: JoinMembersOptions, people: TestMember[]) {
  if (options.auth && !options.db) {
    throw new Error('Member authorisation needs a test database');
  }
  const saved: StoredEvent[] = [];
  for (const person of people) {
    const data = { ...person, email: person.email ?? `${person.memberId}@example.test`,
      displayName: person.displayName ?? person.memberId };
    const row = await appendEvent(options.store, { silo: options.silo,
      subject: `member-${person.memberId}`, type: 'member.joined', data });
    if (options.auth && options.db) {
      await options.auth.handler.handle(row.event, options.db);
    }
    if (options.project) {
      await options.project(row.event, row.sequence);
    }
    saved.push(row);
  }
  return saved;
}
