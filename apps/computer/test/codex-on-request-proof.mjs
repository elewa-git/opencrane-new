import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = process.argv[2] ??
  new URL('./fixtures/codex-0.159.2-on-request.json', import.meta.url);
const capture = JSON.parse(readFileSync(path, 'utf8'));
let failures = 0;

function requireCondition(name, method) {
  function matches(entry) {
    return entry.stage === name && entry.message.method === method;
  }
  function observed(entry) { return entry.name === name; }
  const requests = capture.nativeRequests.filter(matches);
  const observation = capture.observations.find(observed);
  assert.ok(requests.length > 0, `${name}: NOT RUN — no live request`);
  for (const entry of requests) {
    assert.equal(entry.repliesPerId, 1);
    if (method !== 'mcpServer/elicitation/request') {
      assert.deepEqual(entry.reply, { id: entry.message.id, result: { decision: 'decline' } });
      assert.equal(observation.markerPresent, false, `${name}: declined action ran`);
    }
  }
  assert.ok(observation.continuation?.length > 0, `${name}: missing continuation`);
}

const conditions = [
  ['plain_shell', 'item/commandExecution/requestApproval'],
  ['escalated_shell', 'item/commandExecution/requestApproval'],
  ['file_change', 'item/fileChange/requestApproval'],
  ['mcp', 'mcpServer/elicitation/request'],
  ['loaded_resume_mcp', 'mcpServer/elicitation/request'],
  ['reloaded_mcp', 'mcpServer/elicitation/request'],
  ['fixture_escalated_shell', 'item/commandExecution/requestApproval'],
  ['fixture_file_change', 'item/fileChange/requestApproval'],
  ['loaded_accept', 'mcpServer/elicitation/request'],
  ['reloaded_accept', 'mcpServer/elicitation/request'],
];
for (const [name, method] of conditions) {
  try {
    requireCondition(name, method);
    console.log(`${name}: PASS`);
  } catch (error) {
    failures += 1;
    console.error(String(error));
  }
}
try {
  assert.equal(capture.gatewayAsk?.result, 'PASS', 'Saved-thread gateway Ask: NOT RUN');
  assert.equal(capture.gatewayAsk.beforeDecision, 0);
  assert.equal(capture.gatewayAsk.afterDecision, 0);
} catch (error) {
  failures += 1;
  console.error(String(error));
}
process.exitCode = failures ? 1 : 0;
