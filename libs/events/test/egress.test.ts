import { expect, it } from 'vitest';
import { egressDestinationSchema, egressDestinationDataSchema } from '../src/index.ts';

const internalSuffixes = [
  'localhost', 'local', 'internal', 'lan', 'home', 'svc',
  'test', 'invalid', 'example', 'onion', 'home.arpa',
];
const internalHosts: string[] = [];
for (const suffix of internalSuffixes) {
  internalHosts.push(suffix, `router.${suffix}`, `child.router.${suffix}`);
}
function refusesInternalHost(host: string) {
  const destination = { host, port: 443 };
  expect(egressDestinationSchema.safeParse(destination).success, host).toBe(false);
  const uppercase = { ...destination, host: host.toUpperCase() };
  expect(egressDestinationSchema.safeParse(uppercase).success, host).toBe(false);
  const stored = { ...destination, scope: 'person', subjectId: 'alice',
    changedBy: 'owner', expectedSequence: 0 };
  expect(egressDestinationDataSchema.safeParse(stored).success, host).toBe(false);
}
it.each(internalHosts)('refuses the reserved internal hostname %s', refusesInternalHost);

const publicHosts = ['home.arpa.com', 'nothome.arpa', 'routerhome.arpa',
  'localhost.com', 'local.com', 'internal.com', 'lan.com', 'home.com', 'svc.com',
  'test.com', 'invalid.com', 'example.com', 'onion.com'];
function allowsOtherSuffixes(host: string) {
  const destination = { host, port: 443 };
  expect(egressDestinationSchema.parse(destination)).toEqual(destination);
}
it.each(publicHosts)('accepts %s when the reserved suffix is not a whole name',
  allowsOtherSuffixes);
