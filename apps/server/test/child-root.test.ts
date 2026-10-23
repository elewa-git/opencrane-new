import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { childRequestedDataSchema } from '@opencrane/events';
import { BudgetActor, history, rootTotals } from '@opencrane/models';
import { allocateChildRoot } from '../src/chat/child-root.ts';
import { activateRequestedChild } from '../src/chat/child-activation.ts';
import { addChildFirstInput, createRequestedChild, requestChild }
  from '../src/chat/child-requests.ts';
import { summonFixture } from './support/child-summon.ts';
import { shortDuplicateWindowFixture } from './support/duplicate-window.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
let actor: BudgetActor;
const selected = { threadId: 'selected-thread', computerId: 'selected-computer',
  generation: 1, model: 'gpt-6.1-sol' };
async function initialise() {
  const nats = await shortDuplicateWindowFixture();
  context = await summonFixture(nats);
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'helper']]) {
    await context.append(grantStream('model', selected.model), 'grant.given',
      { resourceType: 'model', resourceId: selected.model, granteeKind, granteeId,
        grantedBy: 'alice' });
  }
  actor = new BudgetActor(context.nats.store, 'test');
  await actor.start(10_000, 10_000, 'payer');
}
async function close() {
  await context?.close();
}
beforeAll(initialise, 60_000);
afterAll(close);
afterEach(vi.restoreAllMocks);
async function prepare(allowanceBoundCents = 1000, activate = true) {
  const input = { ...await context.parent(), payingGroupId: 'payer', allowanceBoundCents };
  const intent = await requestChild(context.options, 'alice', input);
  const data = childRequestedDataSchema.parse(intent.event.data);
  const creation = await createRequestedChild(context.options, 'alice', input);
  await context.auth.handler.handle(creation.event, context.db);
  await addChildFirstInput(context.options, 'alice', input);
  if (activate) await activateRequestedChild(context.options, 'alice', input, 1);
  return { input, intent, data };
}
async function allocatesOnce() {
  const saved = await prepare();
  const before = await context.nats.store.head();
  const root = await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  expect(root).toMatchObject({ requesterId: 'alice', assistantId: 'helper',
    conversationId: saved.data.childConversationId, turnId: saved.data.firstInputId,
    threadId: 'selected-thread', computerId: 'selected-computer', generation: 1,
    payingGroupId: 'payer', allowanceCents: 1000 });
  expect(rootTotals(actor.state, root.rootId)).toEqual({
    settledCents: 0, heldCents: 0, availableCents: 1000 });
  expect(await context.nats.store.head()).toBe(before + 1);
  const rows = await history(context.nats.store, 'budget-test', 'test');
  expect(rows.at(-1)?.event.type).toBe('budget.root_allowance_set');
  expect(await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected))
    .toEqual(root);
  expect(await context.nats.store.head()).toBe(before + 1);
}
it('allocates the reviewed child root once without holding or spending cents', allocatesOnce);
