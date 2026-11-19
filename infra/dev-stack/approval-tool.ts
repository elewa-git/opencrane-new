import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { tokenIssuer } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { messagePostedDataSchema, recordIdSchema, type EventEnvelope } from '@opencrane/events';
import { envelope, history, readToolPolicy } from '@opencrane/models';
import { integrationFactsSchema } from '@opencrane/protocol';
import { demoLocator } from './test/demo-remote.ts';
import { reviewSavedJourneyTools, type JourneyToolReview } from './journey-tool-policy.ts';

export type ApprovalToolSetup = Omit<JourneyToolReview, 'serverId'>;
export type ApprovalJourneyIdentity = {
  silo: string;
  origin: string;
  requesterId: string;
  assistantId: string;
  computerId: string;
  generation: number;
};
export type ApprovalToolRequest = {
  threadId: string;
  callId: string;
  slot: 'morning' | 'afternoon';
};

export function completedApprovalMessage(message: EventEnvelope): EventEnvelope[] {
  const data = messagePostedDataSchema.parse(message.data);
  const completed = { conversationId: data.conversationId, turnId: message.id };
  // Keep old fixture messages out of the bridge's waiting work.
  const completion = envelope(message.silo, message.subject, 'agent.turn_completed', completed);
  return [message, completion];
}

export function approvalToolBody(input: ApprovalToolRequest) {
  const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {}, threadId: input.threadId,
    callId: input.callId };
  const argumentsData = { quoteId: 'DEMO-001', slot: input.slot };
  const params = { name: 'change_delivery_slot', arguments: argumentsData, _meta: metadata };
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params };
  return JSON.stringify(request);
}

export async function issueApprovalComputer(store: EventStore,
  tokens: Awaited<ReturnType<typeof tokenIssuer>>, input: ApprovalJourneyIdentity) {
  const rows = await history(store, `computer-${input.assistantId}`, input.silo);
  function computerIdentity(row: typeof rows[number]) {
    return ['computer.claimed', 'computer.resumed'].includes(row.event.type);
  }
  const identity = z.object({ tokenId: z.string() }).parse(
    rows.findLast(computerIdentity)?.event.data);
  const claims = { ...input, ...identity };
  return tokens.computer(claims);
}

export async function waitForApprovalSetup(check: () => Promise<boolean>) {
  const deadline = performance.now() + 90_000;
  while (!await check()) {
    assert(performance.now() < deadline, 'Approval journey setup timeout');
    await delay(100);
  }
}

export async function prepareApprovalTool(input: ApprovalToolSetup) {
  const { ownerPage, store, silo, origin } = input;
  const registration = { headers: { origin }, data: { locator: demoLocator } };
  const registered = await ownerPage.request.post(`${origin}/api/org/integrations`, registration);
  assert.equal(registered.status(), 202, 'Owner registers the guarded TLS tool');
  const registrationSchema = z.object({ serverId: recordIdSchema });
  const { serverId } = registrationSchema.parse(await registered.json());
  async function discovered() {
    const policy = await readToolPolicy(store, silo, serverId);
    return policy.catalogue?.tools !== undefined;
  }
  await waitForApprovalSetup(discovered);
  const policy = await readToolPolicy(store, silo, serverId);
  assert(policy.catalogue?.tools);
  function chooseMode(tool: { name: string }): 'ask' | 'block' {
    if (tool.name === 'change_delivery_slot') return 'ask';
    return 'block';
  }
  const modes = policy.catalogue.tools.map(chooseMode);
  const review = { ...input, serverId };
  await reviewSavedJourneyTools(review, modes);
  async function publicationReady() {
    const response = await ownerPage.request.get(
      `${origin}/api/org/integrations/${serverId}/facts`);
    assert.equal(response.status(), 200);
    const facts = integrationFactsSchema.parse(await response.json());
    return facts.availability.publication.status === 'ready';
  }
  await waitForApprovalSetup(publicationReady);
  const ready = await readToolPolicy(store, silo, serverId);
  assert(ready.published, 'Gateway acknowledges the current reviewed publication');
  console.log('PASS guarded TLS discovery, exact review and acknowledged publication');
  return { serverId, revision: ready.catalogue!.schemaDigest };
}
