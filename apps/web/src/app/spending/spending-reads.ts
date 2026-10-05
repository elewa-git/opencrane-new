import {
  budgetSummarySchema, effectDetailResponseSchema, effectListResponseSchema,
  type BudgetSummary, type EffectDetail, type EffectStatus,
} from '@opencrane/protocol';
import { z } from 'zod';

export const budgetResponseSchema = z.object({ budget: budgetSummarySchema });

export type ReadResult<T> =
  | { state: 'ready'; value: T }
  | { state: 'failed' | 'unavailable' | 'access_changed' | 'not_found' };

export type SpendingReadState = 'loading' | 'ready' | 'failed' | 'unavailable';

export async function readBudget(signal: AbortSignal): Promise<ReadResult<BudgetSummary>> {
  const result = await readResponse('/api/org/models', budgetResponseSchema, signal);
  return extractBudget(result);
}

export async function readEffects(signal: AbortSignal): Promise<ReadResult<EffectStatus[]>> {
  const result = await readResponse('/api/org/effects', effectListResponseSchema, signal);
  return extractEffects(result);
}

export function readEffect(
  permitId: string,
  signal: AbortSignal,
): Promise<ReadResult<EffectDetail>> {
  const path = `/api/org/effects/${encodeURIComponent(permitId)}`;
  return readResponse(path, effectDetailResponseSchema, signal);
}

async function readResponse<T>(
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<ReadResult<T>> {
  try {
    const response = await fetch(path, { signal });
    if (response.status === 401 || response.status === 403) {
      return { state: 'access_changed' };
    }
    if (response.status === 503) return { state: 'unavailable' };
    if (response.status === 404) return { state: 'not_found' };
    if (!response.ok) return { state: 'failed' };
    const raw: unknown = await response.json();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { state: 'failed' };
    return { state: 'ready', value: parsed.data };
  } catch {
    return { state: 'failed' };
  }
}

function extractBudget(
  result: ReadResult<z.infer<typeof budgetResponseSchema>>,
): ReadResult<BudgetSummary> {
  if (result.state !== 'ready') return result;
  return { state: 'ready', value: result.value.budget };
}

function extractEffects(
  result: ReadResult<z.infer<typeof effectListResponseSchema>>,
): ReadResult<EffectStatus[]> {
  if (result.state !== 'ready') return result;
  return { state: 'ready', value: result.value.effects };
}
