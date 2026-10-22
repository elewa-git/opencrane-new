// Capture native requests with the packaged config and a local model only.
import assert from 'node:assert/strict';

process.argv.push('--on-request');
const { capture } = await import('./codex-mcp-resume.mjs');
const observations = [];
for (const check of capture.checks) {
  const outputs = [];
  for (const observation of capture.modelTools) {
    if (observation.stage !== check.name) continue;
    const input = JSON.parse(observation.input);
    for (const item of input) {
      if (item.call_id === `call_${check.name}` && item.type.endsWith('_output')) {
        outputs.push(item);
      }
    }
  }
  let result = check.result;
  if (check.requests === 0) result = 'NOT RUN';
  if (check.name === 'private_shell') {
    assert.equal(check.markerPresent, false);
    assert.match(JSON.stringify(outputs), /code-mode host is disabled/u);
    result = 'PASS';
  }
  let scope = 'production config';
  if (check.name.startsWith('fixture_')) scope = 'fixture-only: read-only, code_mode_host=false';
  if (check.name.endsWith('_accept')) scope = 'fixture-only: non-persistent accept';
  if (check.name === 'private_shell') scope = 'privateConfig, never';
  const observation = { ...check, result, scope, continuation: outputs };
  observations.push(observation);
}
const trimmed = { version: capture.version, model: capture.model,
  measuredAt: capture.measuredAt, nativeRequests: capture.nativeRequests,
  observations, rpc: capture.rpc, completedTurns: capture.completedTurns,
  loadedResumePolicy: capture.loadedResumePolicy, unload: capture.unload,
  gatewayAsk: capture.gatewayAsk, error: capture.error };
// Keep exact requests and continuations; omit repeated history and generated types.
console.log(JSON.stringify(trimmed));
