import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { startDecision } from '../src/decision.ts';
import { fixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const checkSchema = z.object({
  tuple_key: z.object({ relation: z.string(), object: z.string(), user: z.string() }),
});
type Check = z.infer<typeof checkSchema>['tuple_key'];
type Intercept = (check: Check) => Promise<number | undefined>;

async function permissionProxy(setup: Fixture, intercept: Intercept) {
  async function forward(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes: unknown = chunk;
      if (!Buffer.isBuffer(bytes)) throw new Error('Invalid test proxy request');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    const body = bytes.toString('utf8');
    const check = checkSchema.parse(JSON.parse(body));
    const status = await intercept(check.tuple_key);
    if (status !== undefined) {
      res.writeHead(status);
      res.end('{}');
      return;
    }
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
    const reply = await fetch(`${setup.binding.apiUrl}${req.url}`, request);
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(await reply.text());
  }
  function receive(req: IncomingMessage, res: ServerResponse) {
    function failed() {
      res.writeHead(503);
      res.end();
    }
    void forward(req, res).catch(failed);
  }
  const proxy = createServer(receive);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No test permission proxy');
  async function close() {
    proxy.closeAllConnections();
    const closed = once(proxy, 'close');
    proxy.close();
    await closed;
  }
  return { apiUrl: `http://127.0.0.1:${address.port}`, close };
}

async function expectRefused(setup: Fixture, url: string) {
  const body = { model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true };
  const request = { method: 'POST', headers: setup.headers, body: JSON.stringify(body) };
  const response = await fetch(`${url}/authorize`, request);
  const text = await response.text();
  expect(response.status, text).toBe(403);
  expect(response.headers.get('x-opencrane-decision')).toBe('refused');
  expect(response.headers.get('x-reservation-id')).toBeNull();
  expect(response.headers.get('x-opencrane-mcp-permit')).toBeNull();
  expect(setup.actor.state.reservations).toHaveLength(0);
  expect(setup.received()).toBe(0);
}

const completionOrders = ['refusal first', 'outage first', 'refusal in a later batch'] as const;
async function preservesMissingReceipt(order: typeof completionOrders[number]) {
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  await setup.stopDispatch();
  if (order === 'refusal in a later batch') {
    for (let index = 0; index < 16; index++) {
      await setup.append('team-sales', 'team.member_added', {
        teamId: 'sales', memberId: 'alice', addedBy: 'alice',
      });
    }
  }
  // Leave IAM's old team membership in place to prove the missing receipt refuses access.
  const removed = await setup.append('team-sales', 'team.member_removed', {
    teamId: 'sales', memberId: 'alice', removedBy: 'alice',
  });
  const firstFinished = Promise.withResolvers<void>();
  const completed: string[] = [];
  let outageObject: string | undefined;
  async function intercept(check: Check) {
    if (check.relation !== 'applied') return undefined;
    const receiptId = Buffer.from(JSON.stringify(['test', removed.id])).toString('base64url');
    const missing = check.object === `projection_event:${receiptId}`;
    if (!missing && outageObject === undefined) outageObject = check.object;
    if (!missing && check.object !== outageObject) return undefined;
    const label = missing ? 'refusal' : 'outage';
    const refusalFirst = order === 'refusal first';
    const first = missing === refusalFirst;
    if (!first) {
      await firstFinished.promise;
      await delay(50);
    }
    if (missing) {
      const receipt = await setup.auth.checkApplied(removed.id);
      expect(receipt).toMatchObject({ status: 'ok', allowed: false });
    }
    completed.push(label);
    if (first) firstFinished.resolve();
    // Forward the missing receipt to the real permissions service.
    return missing ? undefined : 503;
  }
  const proxy = await permissionProxy(setup, intercept);
  const binding = { ...setup.binding, apiUrl: proxy.apiUrl };
  const decision = await startDecision(setup.actor, setup.identity, binding);
  try {
    await expectRefused(setup, decision.url);
    const expected = order === 'refusal first' ? ['refusal', 'outage'] : ['outage', 'refusal'];
    expect(completed).toEqual(expected);
  } finally {
    firstFinished.resolve();
    await decision.close();
    await proxy.close();
    await setup.close();
  }
}
it.each(completionOrders)('keeps a missing removal receipt refused with %s',
  preservesMissingReceipt, 40_000);

const refusalCases = ['silo mismatch', 'inactive assistant', 'permission denial'] as const;
async function preservesRefusalDuringOutage(refusal: typeof refusalCases[number]) {
  const setup = await fixture();
  let unavailable = false;
  let denied = false;
  function intercept(check: Check) {
    if (refusal === 'silo mismatch' && check.relation === 'member' ||
        refusal === 'inactive assistant' && check.relation === 'applied' ||
        refusal === 'permission denial' && check.relation === 'use' &&
        check.user.startsWith('assistant:')) {
      unavailable = true;
      return Promise.resolve(503);
    }
    if (refusal === 'permission denial' && check.relation === 'use') denied = true;
    return Promise.resolve(undefined);
  }
  const proxy = await permissionProxy(setup, intercept);
  const binding = { ...setup.binding, apiUrl: proxy.apiUrl };
  if (refusal === 'silo mismatch') binding.silo = 'other';
  const decision = await startDecision(setup.actor, setup.identity, binding);
  try {
    await setup.stopDispatch();
    if (refusal === 'inactive assistant') {
      await setup.append('assistant-assistant', 'assistant.settings_changed', {
        assistantId: 'assistant', active: false, changedBy: 'alice', changedFields: ['active'],
      });
    }
    if (refusal === 'permission denial') {
      const revoked = await setup.append(grantStream('model', 'gpt-6-luna'), 'grant.revoked', {
        resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice',
        granteeKind: 'member', revokedBy: 'alice',
      });
      await setup.auth.handler.handle(revoked, setup.db);
    }
    await expectRefused(setup, decision.url);
    expect(unavailable).toBe(refusal !== 'inactive assistant');
    if (refusal === 'permission denial') expect(denied).toBe(true);
  } finally {
    await decision.close();
    await proxy.close();
    await setup.close();
  }
}
it.each(refusalCases)('keeps %s refused during a permission service outage',
  preservesRefusalDuringOutage, 40_000);

async function preservesRemovedMemberAfterAuditFailure() {
  const setup = await fixture();
  const append = setup.nats.store.append.bind(setup.nats.store);
  let auditFailed = false;
  async function failAudit(command: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'decision.recorded') {
      auditFailed = true;
      throw new Error('Scripted audit outage');
    }
    return append(command);
  }
  try {
    await setup.stopDispatch();
    const removed = await setup.append('member-alice', 'member.removed', {
      memberId: 'alice', removedBy: 'alice',
    });
    await setup.auth.handler.handle(removed, setup.db);
    vi.spyOn(setup.nats.store, 'append').mockImplementation(failAudit);
    await expectRefused(setup, setup.options.decisionUrl);
    expect(auditFailed).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}
it('keeps a removed member refused when saving the deny audit fails',
  preservesRemovedMemberAfterAuditFailure, 40_000);
