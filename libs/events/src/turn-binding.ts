import { z } from 'zod';

// Keep both fields together so a record cannot name a provider without its saved choice.
export const providerTurnBindingSchema = z.object({
  providerId: z.string().regex(/^[\w-]{1,200}$/u),
  bindingSequence: z.int().positive(),
}).strict();

function hasCompleteProviderBinding(data: {
  providerId?: string | undefined;
  bindingSequence?: number | undefined;
}) {
  return (data.providerId === undefined) === (data.bindingSequence === undefined);
}

const optionalProviderFieldsSchema = providerTurnBindingSchema.partial();
export const optionalProviderTurnBindingSchema = optionalProviderFieldsSchema
  .refine(hasCompleteProviderBinding, 'Provider and binding position must appear together');
