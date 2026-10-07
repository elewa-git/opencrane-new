import { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import type { EventStore } from '@opencrane/event-store';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { history } from './actor.ts';
import { losslessJson, type JsonValue } from './lossless-json.ts';
import { readToolPolicy } from './tool-policy.ts';

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
  callId: boundedText.min(1),
  sessionId: boundedText.optional(),
  windowId: z.string().max(402).optional(),
  itemId: boundedText.optional(),
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
  const policy = await readToolPolicy(store, silo, server, deadline);
  if (!policy.published || policy.connectionId !== connection || policy.accountMode !== 'none') {
    throw new Error('MCP context unavailable');
  }
  function hasRequestedName(tool: (typeof policy.tools)[number]) {
    return tool.name === call.params.name;
  }
  const tool = policy.tools.find(hasRequestedName);
  const decision = toolDecision(tool);
  const review = await reviewMetadata(store, silo, server, call.params.name, deadline);
  return { ...decision, policy, revision: tool?.revision, name: call.params.name, args, ...review };
}
function toolDecision(tool: Awaited<ReturnType<typeof readToolPolicy>>['tools'][number] | undefined) {
  const mode = tool?.reviewed ? tool.mode : 'block';
  if (mode !== 'block' && tool?.costCents !== 0) return { outcome: 'deny', reason: 'unknown_cost' } as const;
  const outcome = mode === 'block' ? 'deny' : mode;
  const reason = mode === 'ask' ? 'approval_required' : mode === 'allow' ? 'policy_allow' : 'policy_block';
  return { outcome, reason } as const;
}
async function reviewMetadata(store: EventStore, silo: string, server: string,
  name: string, deadline: number) {
  const rows = await history(store, `mcp-${server}`, silo, deadline);
  const discovered = rows.findLast(r => r.event.type === 'mcp.server_discovered');
  const discovery = mcpServerDiscoveredDataSchema.parse(discovered?.event.data);
  const review = discovery.tools?.find(t => t.name === name)?.review;
  const registered = rows.find(r => r.event.type === 'mcp.server_registered');
  const { kind, locator } = z.object({ kind: z.enum(['remote', 'hosted']), locator: z.string() }).parse(registered?.event.data);
  return { schemaDigest: discovery.schemaDigest, review, destination: kind === 'remote' ? new URL(locator).origin : `Hosted: ${locator}` };
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
