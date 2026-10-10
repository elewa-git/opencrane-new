import { beforeEach, expect, it, vi } from 'vitest';
import type { Binding } from '@opencrane/authz';
import { grantStream } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { memoryScopeId } from '@opencrane/projections';
import { memoryRights } from '../src/memory-context.ts';
import { parseMemoryRequest } from '../src/mcp.ts';
import { data } from '../src/state.ts';
import { randomUUID } from 'node:crypto';
import { authorityFence, currentAuthority } from '../src/authority.ts';
import { decisionActivity } from '../src/decision-activity.ts';
import { mcpPolicy } from '../src/mcp.ts';

function authorityModule() {
  return { authorityFence: vi.fn(), currentAuthority: vi.fn() };
}
function activityModule() {
  return { decisionActivity: vi.fn() };
}
async function mcpModule() {
  const actual = await vi.importActual<typeof import('../src/mcp.ts')>('../src/mcp.ts');
  return { ...actual, mcpPolicy: vi.fn() };
}
vi.mock('../src/authority.ts', authorityModule);
vi.mock('../src/decision-activity.ts', activityModule);
vi.mock('../src/mcp.ts', mcpModule);

const scopeId = memoryScopeId('test', 'person', 'alice');
const claims = { silo: 'test', requester: 'alice', assistant: 'assistant', computer: 'computer',
  generation: 1, conversation: 'conversation', turn: 'turn', thread: 'thread' };
const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
  'mcp-name': 'recall' };
const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall',
  arguments: { scopeId }, _meta: { threadId: 'thread', callId: 'call',
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} } } };
const parsed = parseMemoryRequest(JSON.stringify(body), headers);
const binding = { silo: 'test' } as Binding;
let rows: StoredEvent[];
let activity: Awaited<ReturnType<typeof decisionActivity>>;

function row(subject: string, type: string, data: object, sequence = 1, silo = 'test') {
  const id = randomUUID();
  const event = { id, commandId: id, silo, subject, type, data,
    source: 'opencrane-server', correlation: {}, time: new Date().toISOString() };
  return { sequence, event };
}
async function* readStream(subject: string) {
  for (const saved of rows) {
    if (saved.event.subject === subject) yield saved;
  }
}
const store = { readStream } as EventStore;
async function confirm() {
  return false;
}
async function confirmAccess() {}
function prepare() {
  vi.resetAllMocks();
  rows = [row('assistant-assistant', 'assistant.created', { assistantId: 'assistant',
    kind: 'personal', ownerId: 'alice' })];
  for (const resourceType of ['mcp_server', 'memory_read']) {
    const resourceId = resourceType === 'mcp_server' ? 'memory' : scopeId;
    for (const granteeKind of ['member', 'assistant']) {
      const granteeId = granteeKind === 'member' ? 'alice' : 'assistant';
      rows.push(row(grantStream(resourceType, resourceId), 'grant.given',
        { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' }));
    }
  }
  activity = { conversation: [], computer: { sequence: 1,
    lifecycle: row('computer-assistant', 'computer.ready',
      { computerId: 'computer', generation: 1 }),
    firstStart: row('computer-assistant', 'computer.turn_started', {
      requesterId: 'alice', conversationId: 'conversation', threadId: 'thread',
      executionMode: 'restricted' }), firstClose: undefined }, confirm };
  const fresh = Object.assign(confirmAccess, { head: 10, deadline: performance.now() + 2000,
    include: vi.fn() });
  vi.mocked(authorityFence).mockResolvedValue(fresh);
  vi.mocked(currentAuthority).mockResolvedValue('test-authority');
  vi.mocked(decisionActivity).mockResolvedValue(activity);
  const policy = { outcome: 'allow', reason: 'policy_allow' } as Awaited<ReturnType<typeof mcpPolicy>>;
  vi.mocked(mcpPolicy).mockResolvedValue(policy);
}
beforeEach(prepare);

async function allowed() {
  await expect(memoryRights(store, binding, claims, parsed, performance.now() + 2000))
    .resolves.toMatchObject({ scope: { scopeId, ownerId: 'alice' } });
}
it('accepts matching saved access records', allowed);
const assistantChanges = [
  { field: 'silo', value: 'other' }, { field: 'assistantId', value: 'other' },
  { field: 'ownerId', value: 'bob' }, { field: 'sequence', value: 11 },
];
async function refusesAssistant({ field, value }: { field: string; value: unknown }) {
  const saved = rows[0]!;
  if (field === 'silo') {
    saved.event.silo = String(value);
  } else if (field === 'sequence') {
    saved.sequence = Number(value);
  } else {
    saved.event.data = { ...data(saved.event), [field]: value };
  }
  await expect(memoryRights(store, binding, claims, parsed, performance.now() + 2000))
    .rejects.toThrow();
}
it.each(assistantChanges)('checks the assistant record independently: $field', refusesAssistant);

const grantChanges = ['silo', 'resourceType', 'resourceId', 'sequence'];
async function refusesGrant(field: string) {
  const saved = rows[3]!;
  if (field === 'silo') {
    saved.event.silo = 'other';
  } else if (field === 'sequence') {
    saved.sequence = 11;
  } else {
    saved.event.data = { ...data(saved.event), [field]: 'other' };
  }
  await expect(memoryRights(store, binding, claims, parsed, performance.now() + 2000))
    .rejects.toThrow('Recorded memory grant refused');
}
it.each(grantChanges)('checks the grant record independently: %s', refusesGrant);

const startChanges = ['requesterId', 'conversationId'];
async function refusesStart(field: string) {
  const start = activity.computer.firstStart!.event;
  start.data = { ...data(start), [field]: 'other' };
  await expect(memoryRights(store, binding, claims, parsed, performance.now() + 2000))
    .rejects.toThrow('Memory turn refused');
}
it.each(startChanges)('checks the recorded turn independently: %s', refusesStart);
async function sharedWrite() {
  const selectedId = memoryScopeId('test', 'assistant_notes', 'assistant');
  for (const granteeKind of ['member', 'assistant']) {
    const granteeId = granteeKind === 'member' ? 'alice' : 'assistant';
    rows.push(row(grantStream('memory_write', selectedId), 'grant.given', {
      resourceType: 'memory_write', resourceId: selectedId, granteeKind, granteeId }));
  }
  const argumentsValue = { scopeId: selectedId, commandId: 'shared', text: 'Shared fact',
    kind: 'fact', pinned: false, expiresAt: null, sources: [],
    dependsOn: [{ scopeId: selectedId, memoryId: 'fact', revision: 1 }], recallProof: 'proof' };
  const request = { ...body, params: { ...body.params, name: 'remember', arguments: argumentsValue } };
  const writeHeaders = { ...headers, 'mcp-name': 'remember' };
  const write = parseMemoryRequest(JSON.stringify(request), writeHeaders);
  await expect(memoryRights(store, binding, claims, write, performance.now() + 2000))
    .rejects.toThrow('agent_person_scope_only');
}
it('refuses assistant notes independently of proof and command checks', sharedWrite);

async function closed() {
  activity.conversation.push(row('conversation-conversation', 'conversation.closed', {}));
  await expect(memoryRights(store, binding, claims, parsed, performance.now() + 2000))
    .rejects.toThrow('Memory turn ended');
}
it('refuses a closed conversation with a live computer turn', closed);
