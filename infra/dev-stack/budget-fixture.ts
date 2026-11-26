import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { modelForTask } from '@opencrane/models';
import { postJourneyCommand, readJourneyApi } from './browser-api.ts';
import type { BeforePageNavigation } from './browser-signin.ts';

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
    await openBudgetConversation(member, origin, { groupId, assistantId });
  }
  return { groupId, assistantId };
}

export type BudgetAssistant = { groupId: string; assistantId: string };

export async function openBudgetConversation(member: Page, origin: string,
  { groupId, assistantId }: BudgetAssistant, beforeNavigate?: BeforePageNavigation) {
  await waitForAssistant(member, origin, assistantId);
  const conversationId = randomUUID();
  const session = { id: randomUUID(), conversationId, assistantId, payingGroupId: groupId };
  await save(member, origin, '/api/conversations', session);
  const change = `/api/conversations/${conversationId}/changes/${session.id}`;
  // The workspace can only open the session after its read table and access are ready.
  await waitForChange(member, origin, change);
  await beforeNavigate?.(member);
  await member.goto(`${origin}/workspace?conversation=${conversationId}`);
  await member.getByRole('textbox', { name: 'Message your agent' }).waitFor();
}

async function save(page: Page, origin: string, path: string, data: unknown) {
  const response = await postJourneyCommand(page, origin, path, data);
  assert.equal(response.status(), 200, `Prepare budget journey through ${path}`);
}

async function waitForChange(page: Page, origin: string, path: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await readJourneyApi(page, `${origin}${path}`);
    // An accepted command can be absent until its read table first sees the receipt.
    if (response.status() !== 404) {
      assert.equal(response.status(), 200);
      const body = await response.json() as { projection: BudgetProjection };
      if (budgetChangeIsReady(body.projection)) {
        return;
      }
    }
    await delay(100);
  }
  assert.fail(`Budget journey change reaches its read table and access records: ${path}`);
}

async function waitForAssistant(member: Page, origin: string, assistantId: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await readJourneyApi(member, `${origin}/api/assistants/${assistantId}`);
    assert.equal(response.status(), 200);
    const body = await response.json() as {
      rows: BudgetAssistantStatus[];
    };
    function isReady(row: BudgetAssistantStatus) {
      return budgetAssistantIsReady(row, assistantId);
    }
    if (body.rows.some(isReady)) {
      return;
    }
    await delay(100);
  }
  assert.fail('Budget journey shared assistant is ready and available to the member');
}

type BudgetProjection = { content: string; iam: string };

export function budgetChangeIsReady(projection: BudgetProjection): boolean {
  return projection.content === 'current' && projection.iam === 'current';
}

type BudgetAssistantStatus = { assistantId: string; status: string; canStartSession: boolean };

export function budgetAssistantIsReady(row: BudgetAssistantStatus, assistantId: string): boolean {
  return row.assistantId === assistantId && row.status === 'ready' && row.canStartSession;
}
