import { providerVerificationSchema } from '@opencrane/models';
import { z } from 'zod';

export function acceptsProviderVerification(body: unknown, providerId: string): boolean {
  const parsed = z.record(z.string(), z.unknown()).safeParse(body);
  if (!parsed.success || 'providerId' in parsed.data) {
    return false;
  }
  // Match the route: take the provider id only from the URL, then check the strict schema.
  const command = { ...parsed.data, providerId };
  return providerVerificationSchema.safeParse(command).success;
}
