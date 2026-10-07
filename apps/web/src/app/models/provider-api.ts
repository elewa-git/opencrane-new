import { z } from 'zod';

const id = z.string().min(1);
const factSchema = z.object({ changeId: id, time: z.string(), revision: z.number(),
  outcome: z.string(), attemptId: id.optional(), model: id.optional(),
  reservedCents: z.number().int().optional(), settledCents: z.number().int().optional() });
const providerSchema = z.object({ providerId: id, provider: z.enum(['openai', 'anthropic']),
  name: z.string(), revision: z.number().int(), position: z.number().int(),
  saved: factSchema.optional(), reachable: factSchema.optional(),
  modelAnswer: factSchema.optional(),
  enabledModels: z.array(id), status: z.string() });
const providersSchema = z.object({ rows: z.array(providerSchema), loadedAt: z.string(),
  access: z.object({ grantsAvailable: z.boolean(), reason: z.string() }) });
const registrySchema = z.object({
  models: z.array(z.object({ id, retired: z.boolean().optional() })),
  taskRouting: z.record(z.string(), z.object({ model: id, reason: z.string() })) });
const quoteSchema = z.object({ providerId: id, revision: z.number().int(), model: id,
  priceTableId: id, reservedCents: z.number().int(), consentRequired: z.literal(true) });
const receiptSchema = z.object({ status: z.literal('appended'), providerId: id.optional(),
  revision: z.number().int().optional(), operation: z.string().optional(),
  sequence: z.number().int().optional(), changeId: id.optional(), clearKey: z.boolean().optional(),
  projection: z.object({ content: z.string(), iam: z.string() }).optional(),
  currentRevision: z.number().int().optional(), verificationValid: z.boolean().optional(),
  outcome: z.string().optional() });
const responseSchema = z.object({ rows: z.array(providerSchema) });

export type ProviderRow = z.infer<typeof providerSchema>;
export type ModelQuote = z.infer<typeof quoteSchema>;
export type ProviderReceipt = z.infer<typeof receiptSchema>;
export type TaskRouting = z.infer<typeof registrySchema>['taskRouting'];
export type ApiResult<T> = { kind: 'ok'; value: T } | { kind: 'access' | 'forbidden' | 'unpriced' }
  | { kind: 'invalid' | 'conflict' | 'not_found' } | { kind: 'failed'; status?: number };

async function readJson<T>(
  url: string, schema: z.ZodType<T>, signal: AbortSignal,
): Promise<ApiResult<T>> {
  try {
    const headers = { accept: 'application/json' };
    const options = { headers, signal };
    const response = await fetch(url, options);
    const failure = await responseFailure(response);
    if (failure) {
      return failure;
    }
    const value: unknown = await response.json();
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return { kind: 'failed' };
    }
    return { kind: 'ok', value: parsed.data };
  } catch {
    return { kind: 'failed' };
  }
}

export function readProviders(signal: AbortSignal):
Promise<ApiResult<z.infer<typeof providersSchema>>> {
  return readJson('/api/org/providers', providersSchema, signal);
}

export async function readProvider(providerId: string, signal: AbortSignal):
Promise<ApiResult<ProviderRow>> {
  const url = `/api/org/providers/${encodeURIComponent(providerId)}`;
  const result = await readJson(url, responseSchema, signal);
  return singleProvider(result);
}

function singleProvider(result: ApiResult<z.infer<typeof responseSchema>>): ApiResult<ProviderRow> {
  if (result.kind !== 'ok') {
    return result;
  }
  const provider = result.value.rows[0];
  if (!provider) {
    return { kind: 'failed', status: 404 };
  }
  return { kind: 'ok', value: provider };
}

export async function readRegistry(signal: AbortSignal): Promise<ApiResult<{
  models: string[]; taskRouting: TaskRouting;
}>> {
  const result = await readJson('/api/org/models', registrySchema, signal);
  return activeModelIds(result);
}

function activeModelIds(result: ApiResult<z.infer<typeof registrySchema>>): ApiResult<{
  models: string[]; taskRouting: TaskRouting;
}> {
  if (result.kind !== 'ok') {
    return result;
  }
  const active = result.value.models.filter(isActiveModel);
  const models = active.map(modelId);
  const value = { models, taskRouting: result.value.taskRouting };
  return { kind: 'ok', value };
}

function isActiveModel(model: { retired?: boolean | undefined }): boolean {
  return !model.retired;
}
function modelId(model: { id: string }): string {
  return model.id;
}

export function readQuote(providerId: string, model: string, signal: AbortSignal):
Promise<ApiResult<ModelQuote>> {
  const query = new URLSearchParams({ model });
  return readJson(`/api/org/providers/${encodeURIComponent(providerId)}/verify?${query}`,
    quoteSchema, signal);
}

export async function sendProviderCommand(url: string, body: unknown, signal: AbortSignal):
Promise<ApiResult<ProviderReceipt>> {
  try {
    const headers = { 'content-type': 'application/json' };
    const requestBody = JSON.stringify(body);
    const options = { method: 'POST', headers, body: requestBody, signal };
    const response = await fetch(url, options);
    const failure = await responseFailure(response);
    if (failure) {
      return failure;
    }
    const value: unknown = await response.json();
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success) {
      return { kind: 'failed' };
    }
    return { kind: 'ok', value: parsed.data };
  } catch {
    return { kind: 'failed' };
  }
}

async function classifyForbidden(response: Response): Promise<ApiResult<never>> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'reason' in body
      && body.reason === 'unknown_price') {
      return { kind: 'unpriced' };
    }
  } catch {
    return { kind: 'forbidden' };
  }
  return { kind: 'forbidden' };
}

export function readProviderChange(providerId: string, commandId: string, signal: AbortSignal):
Promise<ApiResult<ProviderReceipt>> {
  return readJson(`/api/org/providers/${encodeURIComponent(providerId)}/changes/`
    + encodeURIComponent(commandId), receiptSchema, signal);
}

async function responseFailure(response: Response): Promise<ApiResult<never> | undefined> {
  if (response.status === 401) {
    return { kind: 'access' };
  }
  if (response.status === 403) {
    return classifyForbidden(response);
  }
  if (response.status === 400) {
    return { kind: 'invalid' };
  }
  if (response.status === 409) {
    return { kind: 'conflict' };
  }
  if (response.status === 404) {
    return { kind: 'not_found' };
  }
  if (response.status !== 200) {
    return { kind: 'failed', status: response.status };
  }
  return undefined;
}
