import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { modelForTask } from '@opencrane/models';

export async function prepareBudgetAssistant(owner: Page, members: Page[],
  origin: string, memberId: string) {
  const groupId = 'budget-journey';
  const assistantId = 'team-budget-journey';
  // Reuse these commands on plain startup so saved ceilings keep the same subjects.
  const group = { commandId: 'budget-journey-group', groupId, name: 'Budget journey' };
  await save(owner, origin, '/api/groups', group);
  const membership = { commandId: 'budget-journey-member', action: 'add', memberId };
  await save(owner, origin, `/api/groups/${groupId}`, membership);
  await waitForChange(owner, origin, `/api/groups/${groupId}/changes/${membership.commandId}`);
  const model = { resourceType: 'model', resourceId: modelForTask('chat_turn') };
  const assistant = { commandId: 'budget-journey-assistant', assistantId, groupId,
    payingGroupId: groupId, name: 'Budget journey assistant', grants: [model] };
  await save(owner, origin, '/api/assistants', assistant);
  const assistantChange = `/api/assistants/${assistantId}/changes/${assistant.commandId}`;
  await waitForChange(owner, origin, assistantChange);
  for (const member of members) {
    await waitForAssistant(member, origin, assistantId);
    const conversationId = randomUUID();
    const session = { id: randomUUID(), conversationId, assistantId, payingGroupId: groupId };
    await save(member, origin, '/api/conversations', session);
    await member.goto(`${origin}/workspace?conversation=${conversationId}`);
    await member.getByRole('textbox', { name: 'Message your agent' }).waitFor();
  }
  return { groupId, assistantId };
}

async function save(page: Page, origin: string, path: string, data: unknown) {
  const options = { headers: { origin }, data };
  const response = await page.request.post(`${origin}${path}`, options);
  assert.equal(response.status(), 200, `Prepare budget journey through ${path}`);
}

async function waitForChange(owner: Page, origin: string, path: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await owner.request.get(`${origin}${path}`);
    assert.equal(response.status(), 200);
    const body = await response.json() as { projection: { content: string; iam: string } };
    if (body.projection.content === 'current' && body.projection.iam === 'current') return;
    await delay(100);
  }
  assert.fail(`Budget journey change reaches its read table and access records: ${path}`);
}

async function waitForAssistant(member: Page, origin: string, assistantId: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await member.request.get(`${origin}/api/assistants/${assistantId}`);
    assert.equal(response.status(), 200);
    const body = await response.json() as {
      rows: Array<{ assistantId: string; status: string; canStartSession: boolean }>;
    };
    function isReady(row: typeof body.rows[number]) {
      return row.assistantId === assistantId && row.status === 'ready' && row.canStartSession;
    }
    if (body.rows.some(isReady)) return;
    await delay(100);
  }
  assert.fail('Budget journey shared assistant is ready and available to the member');
}
