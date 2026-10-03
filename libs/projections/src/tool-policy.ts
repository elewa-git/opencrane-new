import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';
import { z } from 'zod';

export function emptyToolPolicy(): ToolPolicy {
  return { connectionId: null, accountMode: null, published: false, sequence: 0, tools: [] };
}
/** Legacy name-only modes remain readable in the register, but never grant execution. */
export function applyToolPolicy(state: ToolPolicy, event: EventEnvelope, sequence: number): ToolPolicy {
  const d = z.record(z.string(), z.unknown()).parse(getEventDefinition(event.type)?.dataSchema.parse(event.data));
  let next = { ...state, sequence };
  if (event.type === 'mcp.server_registered') next = { ...emptyToolPolicy(), sequence };
  if (event.type === 'mcp.server_discovered') {
    const tools = z.array(z.object({ name: z.string(), revision: z.string(), reviewed: z.boolean(),
      readOnly: z.boolean().optional(), destructive: z.boolean().optional() })).parse(d['tools'] ?? []);
    if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error('Duplicate tool names');
    next = { ...next, published: false, connectionId: typeof d['connectionId'] === 'string' ? d['connectionId'] : null,
      accountMode: null, tools: tools.map(t => ({ name: t.name, revision: t.revision, reviewed: t.reviewed,
        readOnly: t.readOnly === true && t.destructive !== true, mode: 'block',
        suggestion: t.readOnly === true && t.destructive !== true ? 'allow' : 'ask' })) };
    next.accountMode = z.enum(['none', 'personal', 'company']).nullable().parse(d['accountMode'] ?? null);
  }
  if (event.type === 'mcp.server_published') next.published = true;
  if (['mcp.server_unpublished', 'mcp.server_rejected', 'mcp.tools_changed'].includes(event.type)) next.published = false;
  if (event.type === 'mcp.tools_changed') next.tools = state.tools.map(t => ({ ...t, reviewed: false, mode: 'block' }));
  if (event.type === 'mcp.tool_mode_set') next.tools = applyMode(state, d);
  return toolPolicySchema.parse(next);
}

function applyMode(state: ToolPolicy, d: Record<string, unknown>): ToolPolicy['tools'] {
  if (d['connectionId'] !== state.connectionId) return state.tools;
  const tool = new Map(state.tools.map(t => [t.name, t])).get(String(d['toolName']));
  if (!tool?.reviewed || tool.revision !== d['toolRevision']) return state.tools;
  return state.tools.map(t => t === tool ? { ...t, mode: z.enum(['allow', 'ask', 'block']).parse(d['mode']) } : t);
}
