import { mkdir, open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { modelForTask } from '@opencrane/models';

type Options = { origin: string; cookie: string; directory: string; signal?: AbortSignal };
type Command = { path: string; receipt: string; data: Record<string, unknown> };

export function demoStackId(id: string | undefined, ownerRun = false): string {
  if (id === '1' || id === '2' || (id === 'owner' && ownerRun)) {
    return id;
  }
  throw new Error('Demo tasks require an explicit secondary id');
}

function commands(): Command[] {
  const result: Command[] = [];
  const groups = [
    { groupId: 'demo-acacia', name: 'Acacia Trading' },
    { groupId: 'demo-kijani', name: 'Kijani Logistics' },
  ];
  for (const group of groups) {
    const commandId = `${group.groupId}-create-v1`;
    const creation = { path: '/api/groups', data: { ...group, commandId },
      receipt: `/api/groups/${group.groupId}/changes/${commandId}` };
    result.push(creation);
  }
  for (const group of groups) {
    for (const memberId of ['jente-rosseel', 'zitadel-member']) {
      const commandId = `${group.groupId}-${memberId}-v1`;
      const membership = { path: `/api/groups/${group.groupId}`,
        data: { commandId, action: 'add', memberId },
        receipt: `/api/groups/${group.groupId}/changes/${commandId}` };
      result.push(membership);
    }
  }
  const assistantId = 'team-demo-acacia';
  const commandId = 'demo-acacia-assistant-v1';
  const grant = { resourceType: 'model', resourceId: modelForTask('chat_turn') };
  const assistant = { path: '/api/assistants',
    data: { commandId, assistantId, groupId: 'demo-acacia', payingGroupId: 'demo-acacia',
      name: 'Acacia supplier assistant', grants: [grant] },
    receipt: `/api/assistants/${assistantId}/changes/${commandId}` };
  result.push(assistant);
  return result;
}

export async function request(options: Options, path: string, data?: Record<string, unknown>) {
  options.signal?.throwIfAborted();
  const headers = { origin: options.origin, cookie: options.cookie,
    'content-type': 'application/json' };
  const init = { headers, method: data ? 'POST' : 'GET',
    body: data ? JSON.stringify(data) : null,
    signal: AbortSignal.any([AbortSignal.timeout(5000), ...(options.signal ? [options.signal] : [])]),
    redirect: 'error' as const };
  try {
    const response = await fetch(`${options.origin}${path}`, init);
    options.signal?.throwIfAborted();
    return response;
  } catch {
    throw new Error('Demo seed request unavailable');
  }
}

export async function reserveRequest(directory: string, commandId: string) {
  await mkdir(`${directory}/demo-requests`, { recursive: true, mode: 0o700 });
  try {
    // Keep an attempted request across restarts. A missing receipt never permits a new write.
    const file = await open(`${directory}/demo-requests/${commandId}`, 'wx', 0o600);
    await file.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new Error('Demo seed request record unavailable');
  }
}

async function applied(options: Options, path: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await request(options, path);
    if (!response.ok) throw new Error('Demo seed outcome unknown');
    let receipt: { projection?: { content: string; iam: string } };
    try {
      receipt = await response.json() as typeof receipt;
    } catch {
      throw new Error('Demo seed outcome unknown');
    }
    if (receipt?.projection?.content === 'current' && receipt.projection.iam === 'current') {
      return;
    }
    await delay(100);
  }
  throw new Error('Demo seed outcome unknown');
}

async function save(options: Options, command: Command) {
  const previous = await request(options, command.receipt);
  if (previous.status === 404) {
    const firstAttempt = await reserveRequest(options.directory, String(command.data['commandId']));
    if (firstAttempt) {
      try {
        await request(options, command.path, command.data);
      } catch {
        // Recover the original receipt after a lost reply, without resending the command.
      }
    }
  } else if (!previous.ok) {
    throw new Error('Demo seed request refused');
  }
  await applied(options, command.receipt);
}

export async function seedDemo(options: Options) {
  for (const memberId of ['jente-rosseel', 'zitadel-member']) {
    const response = await request(options, `/api/members/${memberId}`);
    if (!response.ok) throw new Error('Demo seed request refused');
  }
  for (const command of commands()) await save(options, command);
}
