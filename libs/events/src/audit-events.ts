import { z } from 'zod';
import { egressObservationSchema, legacyEgressObservationSchema } from './egress-observation.ts';
import { legacyCredentialReleaseSchema, toolCredentialReleaseSchema } from './credential-release.ts';
import { event } from './definition.ts';

export const auditEvents = [
  // Keep these events beside the audit events they describe. The registry examples provide
  // valid fixture data for each event.
  event('credential.released', 'credential', 'Release authorisation was audited; legacy records remain non-authorising evidence.',
    z.union([legacyCredentialReleaseSchema, toolCredentialReleaseSchema]),
    { requestId: 'request', permitId: 'permit', connectionId: 'connection',
      profileId: 'default', leaseId: 'lease', generation: 1 }),
  event('egress.observed', 'egress', 'A relay reported closure; earlier destination observations remain readable.',
    z.union([legacyEgressObservationSchema, egressObservationSchema]),
    { requestId: 'request', permitId: 'permit', channel: 'command', destinationDigest: '0'.repeat(64), outcome: 'success' }),
  event('gateway.observation_recorded', 'gateway', 'Safe gateway evidence retained even when JWT or persistence refused dispatch.',
    z.object({ requestId: z.uuid(), outcome: z.enum(['error', 'unknown']),
      reason: z.enum(['jwt_failed', 'dispatch_denied', 'observation_missing']) }).strict(),
    { requestId: '00000000-0000-4000-8000-000000000001', outcome: 'error', reason: 'jwt_failed' }),
];
