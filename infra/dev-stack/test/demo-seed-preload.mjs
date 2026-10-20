import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

function record(line) {
  appendFileSync(process.env['DEMO_RECORD'], `${line}\n`);
}

function load(url, context, nextLoad) {
  if (url.endsWith('/infra/dev-stack/config.ts')) {
    record('configuration loaded');
  }
  return nextLoad(url, context);
}

const hooks = { load };
registerHooks(hooks);

// Replace the HTTP boundary so even a missing origin check cannot reach a real stack.
async function fetchFixture(url, options) {
  record(`${options.method} ${url}`);
  assert.equal(options.method, 'GET');
  const receipt = { projection: { content: 'current', iam: 'current' } };
  return Response.json(receipt);
}

globalThis.fetch = fetchFixture;
