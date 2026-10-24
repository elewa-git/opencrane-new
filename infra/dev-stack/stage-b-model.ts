import { z } from 'zod';

const itemSchema = z.object({ type: z.string(), role: z.string().optional(),
  content: z.unknown().optional(), output: z.unknown().optional(),
  tools: z.array(z.unknown()).optional() });
const bodySchema = z.object({ input: z.array(itemSchema).default([]),
  tools: z.array(z.unknown()).default([]) });
const namespaceSchema = z.object({ type: z.literal('namespace'), name: z.string(),
  tools: z.array(z.object({ name: z.string() })) });

export function stageBModelCall(raw: unknown) {
  const body = bodySchema.parse(raw);
  function user(item: z.infer<typeof itemSchema>) {
    return item.type === 'message' && item.role === 'user';
  }
  const position = body.input.findLastIndex(user);
  const prompt = JSON.stringify(body.input[position]?.content ?? '');
  let toolName: string;
  if (prompt.includes('STAGE_B_READ')) toolName = 'read_fixture_quote';
  else if (prompt.includes('STAGE_B_WRITE')) toolName = 'change_delivery_slot';
  else return undefined;
  const later = body.input.slice(position + 1);
  for (const item of later) {
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      return undefined;
    }
  }
  const tools = [...body.tools];
  for (const item of body.input) {
    if (item.type === 'additional_tools') tools.push(...item.tools ?? []);
  }
  for (const rawTool of tools) {
    const namespace = namespaceSchema.safeParse(rawTool);
    if (!namespace.success || !namespace.data.name.startsWith('mcp__')) continue;
    for (const tool of namespace.data.tools) {
      if (tool.name !== toolName) continue;
      const args = { quoteId: 'DEMO-001',
        ...(toolName === 'change_delivery_slot' ? { slot: 'afternoon' } : {}) };
      return { type: 'function_call', id: `fc_${toolName}`, call_id: `call_${toolName}`,
        name: toolName, namespace: namespace.data.name, arguments: JSON.stringify(args) };
    }
  }
  throw new Error('Reviewed demo tool was not offered to the model');
}
