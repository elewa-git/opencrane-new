/// <reference lib="dom" />
import { z } from 'zod';
import type { EventEnvelope } from './envelope.ts';
import { event } from './definition.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const internalSuffixes = new Set(['localhost', 'local', 'internal', 'lan', 'home', 'svc',
  'test', 'invalid', 'example', 'onion']);
function normaliseHost(host: string) {
  if (/[^\p{L}\p{N}.-]/u.test(host)) return '';
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return '';
  }
}
function isPublicHostname(host: string) {
  if (host.length > 253 || !/^[a-z0-9.-]+$/u.test(host)) return false;
  if (normaliseHost(host) !== host) return false;
  const labels = host.split('.');
  const suffix = labels.at(-1) ?? '';
  if (labels.length < 2 || !/[a-z]/u.test(suffix) || internalSuffixes.has(suffix)) return false;
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) return false;
  }
  return true;
}
const storedHost = z.string().refine(isPublicHostname);
export const egressDestinationSchema = z.object({
  host: z.string().transform(normaliseHost).pipe(storedHost),
  port: z.int().min(1).max(65535).default(443),
}).strict();
export const egressRuleSchema = egressDestinationSchema.extend({
  scope: z.enum(['silo', 'person', 'assistant']), subjectId: id,
});
export const egressCommandSchema = egressRuleSchema.extend({
  commandId: id, expectedSequence: z.int().nonnegative(), action: z.enum(['allow', 'revoke']),
});
export const egressDestinationDataSchema = egressRuleSchema.extend({
  host: storedHost, port: z.int().min(1).max(65535),
  expectedSequence: z.int().nonnegative(), changedBy: id,
});
export type EgressRule = z.infer<typeof egressRuleSchema>;
const example = { scope: 'person' as const, subjectId: 'alice', host: 'registry.npmjs.org',
  port: 443, expectedSequence: 0, changedBy: 'owner' };
export const egressEvents = [
  event('egress.destination_allowed', 'egress', 'An admin saved one exact HTTPS destination rule.',
    egressDestinationDataSchema, example),
  event('egress.destination_revoked', 'egress', 'An admin revoked one exact HTTPS destination rule.',
    egressDestinationDataSchema, example),
];

export function validEgressRuleEvent(record: EventEnvelope) {
  if (!['egress.destination_allowed', 'egress.destination_revoked'].includes(record.type)) {
    return true;
  }
  const parsed = egressDestinationDataSchema.safeParse(record.data);
  if (!parsed.success) return false;
  const data = parsed.data;
  return /^egress-grant-[a-f0-9]{64}-[a-f0-9]{64}$/u.test(record.subject) &&
    (data.scope !== 'silo' || data.subjectId === record.silo) &&
    record.principal?.kind === 'human' && record.principal.id === data.changedBy;
}
