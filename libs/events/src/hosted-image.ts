import { z } from 'zod';
import { egressDestinationDataSchema } from './egress.ts';

// Keep the whole request together so older registrations cannot look newly queued.
export const hostedImageInstallationSchema = z.strictObject({
  attemptId: z.literal(1),
  platform: z.enum(['linux/amd64', 'linux/arm64']),
  upstream: egressDestinationDataSchema.pick({ host: true, port: true }),
});
