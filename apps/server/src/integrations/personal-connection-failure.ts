import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

export type PersonalConnectionReason = 'no_session' | 'wrong_organisation' | 'wrong_origin' |
  'wrong_silo' | 'access_required' | 'invalid_input' | 'identity_unverified' | 'unavailable';

export interface PersonalConnectionRefusal {
  status: 'refused' | 'unavailable' | 'identity_unverified';
  reason: PersonalConnectionReason;
}

export function personalConnectionRefusal(reason: PersonalConnectionReason,
  status: PersonalConnectionRefusal['status'] = 'refused'): PersonalConnectionRefusal {
  return { status, reason };
}

type FailureCause = 'identity_unverified' | 'identity_invalid' | 'invalid_reply' |
  'custody_unavailable' | 'network_refused' | 'connection_required' | 'redirect_refused' |
  'protocol_refused' | 'response_limit' | 'discovery_timeout' | 'unsafe_address' |
  'tls_untrusted' | 'tls_hostname' | 'connection_reset' | 'connection_refused' |
  'dns_unavailable' | 'unclassified';

const messages = new Map<string, FailureCause>([
  ['Identity not verified', 'identity_unverified'], ['Identity check unavailable', 'identity_invalid'],
  ['Connection custody unavailable', 'custody_unavailable'], ['network_refused', 'network_refused'],
  ['connection_required', 'connection_required'], ['redirect_refused', 'redirect_refused'],
  ['protocol_refused', 'protocol_refused'], ['response_limit', 'response_limit'],
  ['discovery_timeout', 'discovery_timeout'], ['unsafe_address', 'unsafe_address'],
]);
const transportCodes = new Map<string, FailureCause>([
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_untrusted'], ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_untrusted'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_untrusted'], ['CERT_HAS_EXPIRED', 'tls_untrusted'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_hostname'], ['ECONNRESET', 'connection_reset'],
  ['ECONNREFUSED', 'connection_refused'], ['ENOTFOUND', 'dns_unavailable'],
  ['EAI_AGAIN', 'dns_unavailable'],
]);

function classifyCause(error: Error): FailureCause {
  const code: unknown = Reflect.get(error, 'code');
  if (typeof code === 'string') {
    const transport = transportCodes.get(code);
    if (transport) return transport;
  }
  if (error instanceof z.ZodError) return 'invalid_reply';
  return messages.get(error.message) ?? 'unclassified';
}

export function logPersonalConnectionFailure(request: FastifyRequest, error: unknown,
  operation: 'connection.save' | 'connection.needs') {
  const causes: FailureCause[] = [];
  const seen = new Set<Error>();
  let current = error;
  // Keep causal order using fixed labels only. Messages and adapter fields can contain keys.
  while (current instanceof Error && !seen.has(current) && causes.length < 8) {
    seen.add(current);
    causes.push(classifyCause(current));
    current = current.cause;
  }
  request.log.warn({ operation, causes }, 'Personal connection unavailable');
}
