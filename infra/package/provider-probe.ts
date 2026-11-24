export const wrongKeyStatusScript = `
let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
}
const key = JSON.parse(input);
const headers = { authorization: 'Bearer ' + key };
const response = await fetch('http://model-qualification:43003/v1/models', { headers });
const body = await response.text();
if (body.includes(key)) {
  throw new Error('Credential disclosed by upstream');
}
console.log(JSON.stringify({ status: response.status }));`;

export const providerEventDisclosureScript = `
import { connectEventStore, readEvents } from '@opencrane/event-store';
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
