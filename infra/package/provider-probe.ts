import { qualificationUpstream } from './model-settings.ts';

export const wrongKeyStatusScript = `
let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
}
const key = JSON.parse(input);
const headers = { authorization: 'Bearer ' + key };
const response = await fetch('http://${qualificationUpstream}/v1/models', { headers });
const body = await response.text();
if (body.includes(key)) {
  throw new Error('Credential disclosed by upstream');
}
console.log(JSON.stringify({ status: response.status }));`;

export const qualificationRequestCountScript = `
const response = await fetch('http://${qualificationUpstream}/journey-counts');
if (!response.ok) throw new Error('Qualification request count unavailable');
const counts = await response.json();
if (!Number.isSafeInteger(counts.modelRequests) || counts.modelRequests < 0) {
  throw new Error('Invalid qualification request count');
}
console.log(JSON.stringify(counts.modelRequests));`;

export const providerEventDisclosureScript = `
import { connectEventStore } from '@opencrane/event-store';
import { readEvents } from '@opencrane/projections';
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const secrets = JSON.parse(input);
const events = await connectEventStore();
let count = 0;
try {
  const until = await events.store.head();
  if (until) {
    for await (const row of readEvents(events.store, 1, until)) {
      const text = JSON.stringify(row.event);
      for (const secret of secrets) {
        if (text.includes(secret)) throw new Error('Credential in event');
      }
      count++;
    }
  }
  console.log(JSON.stringify({ checkedEvents: count }));
} finally {
  await events.close();
}`;

const budgetQualificationScript = `
import { requirePackageProviderDestination } from './infra/package/model-settings.ts';
if (process.env.PACKAGE_PROVIDER_QUALIFICATION !== '1') {
  throw new Error('The running package has qualification disabled');
}
requirePackageProviderDestination(process.env);`;

export async function withBudgetQualification(
  kube: (args: string[]) => Promise<string>,
  readRequestCount: () => Promise<number>,
  start: () => Promise<void>,
): Promise<void> {
  const args = ['exec', 'deployment/server', '-c', 'models', '--', 'node',
    '--experimental-strip-types', '--input-type=module', '-e', budgetQualificationScript];
  await kube(args);
  await readRequestCount();
  await start();
}
