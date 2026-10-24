import { z } from 'zod';
import { models } from './state.ts';

function isActive(model: (typeof models)[number]) {
  return !model.retired;
}
function modelId(model: (typeof models)[number]) {
  return model.id;
}
const activeModels = models.filter(isActive);
const activeModelIds = activeModels.map(modelId);

const textContent = z.object({ type: z.enum(['input_text', 'output_text']), text: z.string() }).strict();
const message = z.object({ type: z.literal('message').optional(), id: z.string().nullable().optional(), role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(textContent)]), phase: z.enum(['commentary', 'final_answer']).nullable().optional() }).strict();
const reasoningItem = z.object({ type: z.literal('reasoning'), id: z.string(),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() }).strict()),
  encrypted_content: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.literal('reasoning_text'), text: z.string() }).strict()).nullable().optional(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional() }).strict();
const functionTool = z.object({ type: z.literal('function'), name: z.string(), description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict();
const tool = z.union([functionTool, z.object({ type: z.literal('custom'), name: z.string(), description: z.string().optional(),
  format: z.object({ type: z.literal('grammar'), syntax: z.literal('lark'), definition: z.string() }).strict() }).strict()]);
const localTool = z.union([tool, z.object({ type: z.literal('namespace'), name: z.string(), description: z.string().optional(),
  tools: z.array(tool) }).strict()]);
const additionalTools = z.object({ type: z.literal('additional_tools'), id: z.string(), role: z.literal('developer'),
  tools: z.array(localTool) }).strict();
export const requestSchema = z.object({ model: z.enum(activeModelIds), stream: z.literal(true),
  input: z.union([z.string(), z.array(z.union([message, additionalTools, reasoningItem,
    z.object({ type: z.literal('custom_tool_call'), call_id: z.string(), name: z.string(),
      namespace: z.string().max(200).optional(), input: z.string(), id: z.string().optional(),
      status: z.enum(['in_progress', 'completed', 'incomplete']).optional() }).strict(),
    z.object({ type: z.literal('custom_tool_call_output'), call_id: z.string(), output: z.union([z.string(), z.array(textContent)]), id: z.string().optional() }).strict(),
    z.object({ type: z.literal('function_call_output'), call_id: z.string(),
      output: z.union([z.string(), z.array(textContent)]), id: z.string().optional() }).strict(),
    z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(),
      namespace: z.string().max(200).optional(), arguments: z.string(), id: z.string().optional() }).strict()]))]),
  instructions: z.string().optional(), max_output_tokens: z.int().min(16).max(2000), n: z.literal(1).optional(),
  tools: z.array(localTool).optional(),
  reasoning: z.object({ effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(), summary: z.enum(['auto', 'concise', 'detailed']).optional(),
    context: z.literal('all_turns').optional() }).strict().optional(),
  text: z.object({ verbosity: z.enum(['low', 'medium', 'high']) }).strict().optional(),
  tool_choice: z.literal('auto').optional(), parallel_tool_calls: z.boolean().optional(),
  include: z.array(z.literal('reasoning.encrypted_content')).max(1).optional(),
  prompt_cache_key: z.string().max(200).optional(), client_metadata: z.record(z.string(), z.string()).optional(),
  store: z.literal(false).optional(), service_tier: z.literal('default').optional(),
}).strict();
