import { z } from 'zod';

export const providerChoiceRefusalSchema = z.enum([
  'permission_denied', 'connection_not_ready', 'model_not_enabled',
]);
export type ProviderChoiceRefusal = z.infer<typeof providerChoiceRefusalSchema>;
