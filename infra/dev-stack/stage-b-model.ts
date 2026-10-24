import { z } from 'zod';

const itemSchema = z.object({ type: z.string(), role: z.string().optional(),
  content: z.unknown().optional(), output: z.unknown().optional(),
  call_id: z.string().optional(), tools: z.array(z.unknown()).optional() });
const bodySchema = z.object({ input: z.array(itemSchema).default([]),
  tools: z.array(z.unknown()).default([]) });
const namespaceSchema = z.object({ type: z.literal('namespace'), name: z.string(),
  tools: z.array(z.object({ name: z.string(), type: z.string().optional() })) });
const quoteSchema = z.object({ quoteId: z.literal('DEMO-001'), amountCents: z.int(),
  slot: z.enum(['morning', 'afternoon']), effectCount: z.int().nonnegative() });

function lastPrompt(body: z.infer<typeof bodySchema>) {
  function user(item: z.infer<typeof itemSchema>) {
    return item.type === 'message' && item.role === 'user';
  }
  const position = body.input.findLastIndex(user);
  const prompt = JSON.stringify(body.input[position]?.content ?? '');
  let toolName: string;
  if (prompt.includes('STAGE_B_READ')) toolName = 'read_fixture_quote';
  else if (prompt.includes('STAGE_B_WRITE')) toolName = 'change_delivery_slot';
  else return undefined;
  return { position, toolName, callId: `call_${toolName}` };
}

export function stageBModelCall(raw: unknown) {
  const body = bodySchema.parse(raw);
  const selected = lastPrompt(body);
  if (!selected) return undefined;
  const { position, toolName, callId } = selected;
  const later = body.input.slice(position + 1);
  for (const item of later) {
    if (item.call_id === callId &&
        ['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      return undefined;
    }
  }
  const tools = [...body.tools];
  for (const item of body.input) {
    if (item.type === 'additional_tools') tools.push(...item.tools ?? []);
  }
  const args: { quoteId: string; slot?: string } = { quoteId: 'DEMO-001' };
  if (toolName === 'change_delivery_slot') args.slot = 'afternoon';
  for (const rawTool of tools) {
    const namespace = namespaceSchema.safeParse(rawTool);
    if (!namespace.success) continue;
    for (const tool of namespace.data.tools) {
      if (namespace.data.name.startsWith('mcp__') && tool.name === toolName) {
        return { type: 'function_call', id: `fc_${toolName}`, call_id: callId,
          name: toolName, namespace: namespace.data.name, arguments: JSON.stringify(args) };
      }
      if (namespace.data.name === 'functions' && tool.name === 'exec' && tool.type === 'custom') {
        return deferredCall(toolName, callId, args);
      }
    }
  }
  throw new Error('Reviewed demo tool was not offered to the model');
}

function deferredCall(toolName: string, callId: string, args: unknown) {
  // Discover the published name at execution time; Codex can omit deferred tool definitions.
  const input = `
function matches(tool) {
  return tool.name.startsWith('mcp__') && tool.name.endsWith('__${toolName}');
}
const available = ALL_TOOLS.filter(matches);
if (available.length !== 1) throw new Error('Expected one published demo tool');
const selected = available[0];
text({ offeredTool: selected.name });
const result = await tools[selected.name](${JSON.stringify(args)});
text(result);
`;
  return { type: 'custom_tool_call', id: `ct_${toolName}`, call_id: callId,
    name: 'exec', namespace: 'functions', input };
}

export function stageBModelAnswer(raw: unknown) {
  const body = bodySchema.parse(raw);
  const selected = lastPrompt(body);
  if (!selected) return undefined;
  const later = body.input.slice(selected.position + 1);
  for (const item of later) {
    if (item.call_id !== selected.callId ||
        !['function_call_output', 'custom_tool_call_output'].includes(item.type)) continue;
    const quote = findQuote(item.output);
    if (!quote) return 'The demo tool did not return a quote.';
    return `Quote ${quote.quoteId}: ${quote.amountCents} euro cents, ${quote.slot} delivery. ` +
      `Recorded effects: ${quote.effectCount}.`;
  }
  return undefined;
}

function findQuote(value: unknown): z.infer<typeof quoteSchema> | undefined {
  const quote = quoteSchema.safeParse(value);
  if (quote.success) return quote.data;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return findQuote(parsed);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const child of Object.values(value)) {
    const found = findQuote(child);
    if (found) return found;
  }
  return undefined;
}
