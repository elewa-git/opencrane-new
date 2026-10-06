import { z } from 'zod';
import { event } from './definition.ts';

const id = z.string().regex(/^[\w:.-]{1,300}$/u);
const call = { requestId: id, permitId: id };
export const auditEvents = [
  // Keep these events beside the audit events they describe. The registry examples provide
  // valid fixture data for each event.
  event('credential.released', 'credential', 'A request-bound credential lease was recorded before forwarding.',
    z.object({ ...call, connectionId: id, profileId: id, leaseId: id, generation: z.int().nonnegative() }).strict(),
    { requestId: 'request', permitId: 'permit', connectionId: 'connection', profileId: 'default', leaseId: 'lease', generation: 1 }),
  event('egress.observed', 'egress', 'The gateway observed a permitted command or desktop destination call.',
    z.object({ ...call, channel: z.enum(['command', 'desktop']), destinationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      outcome: z.enum(['success', 'error', 'unknown']) }).strict(),
    { requestId: 'request', permitId: 'permit', channel: 'command', destinationDigest: '0'.repeat(64), outcome: 'success' }),
  event('gateway.observation_recorded', 'gateway', 'Safe gateway evidence retained even when JWT or persistence refused dispatch.',
    z.object({ requestId: z.uuid(), outcome: z.enum(['error', 'unknown']),
      reason: z.enum(['jwt_failed', 'dispatch_denied', 'observation_missing']) }).strict(),
    { requestId: '00000000-0000-4000-8000-000000000001', outcome: 'error', reason: 'jwt_failed' }),
];
