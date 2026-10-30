import { memberAuthorisation } from '@opencrane/authz';
import { currentMembership, LoadedMemoryRefused, MemberAccessRefused,
  type memoryRights } from '@opencrane/models';
import type { MemoryOptions } from './access.ts';

type Permissions = NonNullable<Parameters<typeof memoryRights>[7]>;

async function savedMember(options: MemoryOptions, requester: string, deadline: number) {
  const membership = await currentMembership(options.store, options.silo, requester,
    undefined, deadline);
  if (!membership.role) throw new MemberAccessRefused('Active silo membership required');
  return membership;
}

function cached<Arguments extends unknown[], Result>(
  read: (...args: Arguments) => Promise<Result>,
) {
  const results = new Map<string, Promise<Result>>();
  function once(...args: Arguments) {
    const key = JSON.stringify(args);
    let result = results.get(key);
    if (!result) {
      result = read(...args);
      results.set(key, result);
    }
    return result;
  }
  return once;
}

export async function initialMemoryAccess(options: MemoryOptions, requester: string,
  deadline: number): Promise<Permissions> {
  // Establish saved membership before any catalogue, permission or qualification read.
  const membership = await savedMember(options, requester, deadline);
  const head = await options.store.head(undefined, deadline);
  const subjects = new Set<string>(membership.positions.keys());
  const auth = memberAuthorisation(options.binding);
  const check = cached(auth.check.bind(auth));
  const permission = await check(requester, 'member');
  if (permission.status === 'unavailable') throw new Error('Permissions unavailable');
  if (!permission.allowed) throw new MemberAccessRefused('Membership unavailable');
  for (const row of membership.facts) {
    if (!await auth.applied(row.event.id)) throw new Error('Membership still being applied');
  }
  function include(...added: string[]) {
    for (const subject of added) subjects.add(subject);
  }
  async function confirm() {
    if (performance.now() >= deadline) throw new LoadedMemoryRefused();
    // Preserve removal before another unavailable access stream can hide it.
    for (const [subject, position] of membership.positions) {
      const current = await options.store.head(subject, deadline);
      if (current !== position) {
        await savedMember(options, requester, deadline);
        throw new LoadedMemoryRefused();
      }
    }
    for (const subject of subjects) {
      if (membership.positions.has(subject)) continue;
      const position = await options.store.head(subject, deadline);
      if (position > head) throw new LoadedMemoryRefused();
    }
    if (performance.now() >= deadline) throw new LoadedMemoryRefused();
  }
  const actsFor = cached(auth.actsFor.bind(auth));
  const conversation = cached(auth.conversation.bind(auth));
  const use = cached(auth.use.bind(auth));
  await confirm();
  return { check, actsFor, conversation, use, include, confirm };
}

export async function refuseInitialMemory(options: MemoryOptions, requester: string,
  deadline: number, error: unknown): Promise<never> {
  if (error instanceof MemberAccessRefused) throw error;
  try {
    await savedMember(options, requester, deadline);
  } catch (membershipError) {
    if (membershipError instanceof MemberAccessRefused) throw membershipError;
  }
  throw new LoadedMemoryRefused();
}
