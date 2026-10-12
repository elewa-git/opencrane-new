import { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { isToolCallText } from '@opencrane/events/tool-call';
import { mcpServerDiscoveredDataSchema, memoryTextSchema,
  memoryWrittenDataSchema } from '@opencrane/events';
import { history } from './actor.ts';
import { losslessJson, type JsonValue } from '@opencrane/events/lossless-json';
import { toolPolicyFromRows } from './tool-policy.ts';

const version = '2026-07-28';
const boundedText = z.string().max(200);
const clientInfoSchema = z.object({
  name: boundedText, version: boundedText, title: boundedText.optional(),
}).strict();
function boundedMetadataEntries(value: Record<string, unknown>) {
  return Object.keys(value).length <= 32;
}
function boundedCapabilities(value: Record<string, unknown>) {
  return boundedMetadataEntries(value) && JSON.stringify(value).length <= 16_384;
}
const metadataSchema = z.object({
  'io.modelcontextprotocol/protocolVersion': z.literal(version),
  'io.modelcontextprotocol/clientCapabilities':
    z.record(z.string(), z.unknown()).refine(boundedCapabilities),
  'io.modelcontextprotocol/clientInfo': clientInfoSchema.optional(),
  threadId: boundedText.min(1),
  callId: z.string().refine(isToolCallText),
  sessionId: boundedText.min(1).optional(),
  windowId: z.string().min(1).max(402).optional(),
  itemId: boundedText.min(1).optional(),
  progressToken: z.union([z.int(), boundedText]).optional(),
  'x-codex-turn-metadata': z.record(z.string().max(200),
    z.union([z.string().max(2000), z.number(), z.boolean()])).refine(boundedMetadataEntries).optional(),
}).strict();
const callSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([boundedText, z.int()]),
  method: z.literal('tools/call'),
  params: z.object({
    name: boundedText.min(1),
    arguments: z.record(z.string(), z.unknown()),
    _meta: metadataSchema,
  }).strict(),
}).strict();
export async function mcpPolicy(store: EventStore, silo: string, server: string,
  connection: string, parsed: ReturnType<typeof parseMcpCall>,
  headers: IncomingHttpHeaders, deadline = Infinity) {
  const { call, args } = parsed;
  if (headers['mcp-protocol-version'] !== version ||
      headers['mcp-method'] !== call.method || headers['mcp-name'] !== call.params.name) {
    throw new Error('MCP protocol refused');
  }
  // Use the same saved events for policy and review details. A second read spends
  // the short access deadline again and can describe a different registration.
  const rows = await history(store, `mcp-${server}`, silo, deadline);
  const policy = toolPolicyFromRows(rows);
  if (!policy.published || policy.connectionId !== connection || policy.accountMode !== 'none') {
    throw new Error('MCP context unavailable');
  }
  function hasRequestedName(tool: (typeof policy.tools)[number]) {
    return tool.name === call.params.name;
  }
  const tool = policy.tools.find(hasRequestedName);
  let decision = toolDecision(tool);
  const offeredMode = headers['x-opencrane-tool-mode'];
  requireOfferedMode(offeredMode);
  // Refuse changed Allow tools before creating an approval nobody can answer yet.
  if (offeredMode === 'allow' && decision.outcome === 'ask') {
    decision = { outcome: 'deny', reason: 'policy_block' };
  }
  const review = reviewMetadata(rows, call.params.name, policy.catalogue);
  const expectedApproval = expectedApprovalId(headers);
  return { ...decision, waitLimited: offeredMode === 'ask', expectedApproval,
    policy, revision: tool?.revision, name: call.params.name, args, ...review };
}
export function toolDecision(
  tool: ReturnType<typeof toolPolicyFromRows>['tools'][number] | undefined,
) {
  const mode = tool?.reviewed ? tool.mode : 'block';
  if (mode !== 'block' && tool?.costCents !== 0) return { outcome: 'deny', reason: 'unknown_cost' } as const;
  const outcome = mode === 'block' ? 'deny' : mode;
  const reason = mode === 'ask' ? 'approval_required' : mode === 'allow' ? 'policy_allow' : 'policy_block';
  return { outcome, reason } as const;
}
function reviewMetadata(rows: StoredEvent[], name: string,
  catalogue: ReturnType<typeof mcpServerDiscoveredDataSchema.parse> | null) {
  const discovery = mcpServerDiscoveredDataSchema.parse(catalogue);
  const review = discovery.tools?.find(t => t.name === name)?.review;
  const registered = rows.find(r => r.event.type === 'mcp.server_registered');
  const { kind, locator } = z.object({ kind: z.enum(['remote', 'hosted']), locator: z.string() }).parse(registered?.event.data);
  let destination = `Hosted: ${locator}`;
  if (kind === 'remote') {
    destination = new URL(locator).origin;
  }
  return { schemaDigest: discovery.schemaDigest, review, destination, serverKind: kind };
}

function plain(node: JsonValue): unknown {
  if (node.kind === 'number') {
    return Number(node.canonical);
  }
  if (node.value instanceof Map) {
    const entries = [...node.value];
    const values = entries.map(plainEntry);
    return Object.fromEntries(values);
  }
  if (Array.isArray(node.value)) {
    return node.value.map(plain);
  }
  return node.value;
}

function plainEntry([name, node]: [string, JsonValue]): [string, unknown] {
  return [name, plain(node)];
}

export function parseMcpCall(body: string) {
  const parsed = losslessJson(body);
  if (!(parsed.value instanceof Map) || parsed.value.get('jsonrpc')?.kind !== 'string') {
    throw new Error('JSON-RPC object required');
  }
  // Convert numbers for schema checks while keeping argument number text for approval binding.
  const call = callSchema.parse(plain(parsed));
  const params = parsed.value.get('params');
  const args = params?.value instanceof Map ? params.value.get('arguments') : undefined;
  if (!(params?.value instanceof Map) || params.value.get('name')?.kind !== 'string') {
    throw new Error('Tool name must be a string');
  }
  if (!args || !(args.value instanceof Map)) {
    throw new Error('Object arguments required');
  }
  return { call, args };
}

const memoryDiscovery = callSchema.extend({
  method: z.enum(['server/discover', 'tools/list']),
  params: z.strictObject({ _meta: metadataSchema }),
});
const recallInput = z.strictObject({ scopeId: z.string().regex(/^[a-f0-9]{64}$/u),
  query: z.string().default(''), cursor: z.string().max(2000).optional(),
  limit: z.int().min(1).max(20).default(20) });

const rememberInput = memoryWrittenDataSchema.pick({ kind: true, pinned: true,
  expiresAt: true, sources: true, dependsOn: true }).extend({
  scopeId: z.string().regex(/^[a-f0-9]{64}$/u), commandId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
  text: memoryTextSchema, recallProof: z.string().min(1).max(10000) }).strict();

export function parseMemoryRequest(raw: string, headers: IncomingHttpHeaders) {
  if (Buffer.byteLength(raw) > 16384 || headers['mcp-session-id'] !== undefined) {
    throw new Error('Memory request refused');
  }
  const parsed = losslessJson(raw);
  const discovery = memoryDiscovery.safeParse(plain(parsed));
  let request;
  let input;
  if (discovery.success) {
    request = discovery.data;
  } else {
    request = parseMcpCall(raw).call;
    if (request.params.name === 'recall') {
      input = { operation: 'recall' as const, ...recallInput.parse(request.params.arguments) };
    } else if (request.params.name === 'remember') {
      input = { operation: 'remember' as const, ...rememberInput.parse(request.params.arguments) };
    } else {
      throw new Error('Memory tool refused');
    }
  }
  const name = request.method === 'tools/call' ? request.params.name : '';
  if (headers['mcp-protocol-version'] !== version ||
      headers['mcp-method'] !== request.method || (headers['mcp-name'] ?? '') !== name) {
    throw new Error('Memory protocol refused');
  }
  return { request, input, bodyDigest: parsed.digest, headers };
}

function requireOfferedMode(mode: unknown) {
  if (mode !== undefined && mode !== '' && mode !== 'allow' && mode !== 'ask') {
    throw new Error('MCP turn mode refused');
  }
}
function expectedApprovalId(headers: IncomingHttpHeaders) {
  const value = headers['x-opencrane-approval-id'];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('MCP approval id refused');
  }
  return value;
}
