import assert from 'node:assert/strict';
import { until } from '@opencrane/authz/testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openComputerBridge, uploadComputer } from '../../server/test/support/upload-computer.ts';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const templatePath = new URL('../sandbox-template.json', import.meta.url);
const template = JSON.parse(readFileSync(templatePath, 'utf8'));
const container = template.spec.podTemplate.spec.containers[0];
const capabilities = container.securityContext.capabilities;
assert.deepEqual(capabilities.drop, ['ALL']);
assert.deepEqual(capabilities.add, ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE']);
const image = process.env.COMPUTER_TEST_IMAGE ?? 'ocn-computer-runtime';
const computer = await uploadComputer(true, '', { image });
let socket;
const reports = [];
function receiveReport(raw) {
  const report = JSON.parse(raw.toString());
  reports.push(report);
  const acknowledgement = { type: 'ack', sequence: report.sequence,
    token: 'fixture-turn', expiresAt: Date.now() + 120_000,
    context: { exchanges: [], omittedExchanges: 0 } };
  socket.send(JSON.stringify(acknowledgement));
}
function terminal(report) {
  return report.type === 'agent.turn_completed' || report.type === 'agent.turn_failed';
}
function finished() {
  return reports.some(terminal);
}
function completedMessage(report) {
  return report.type === 'agent.message_completed';
}
try {
  socket = await openComputerBridge(computer.url, computer.credential.value);
  socket.on('message', receiveReport);
  socket.send(JSON.stringify({ type: 'resume', since: 0 }));
  const frame = { type: 'turn', id: 'capabilities', conversationId: 'capabilities',
    assistantId: 'assistant', requesterId: 'alice', executionMode: 'restricted',
    text: 'Reply using the local fixture.', token: 'preparing',
    expiresAt: Date.now() + 120_000 };
  socket.send(JSON.stringify(frame));
  await until(finished, 20_000);
  assert.equal(reports.find(terminal).type, 'agent.turn_completed');
  assert.equal(reports.find(completedMessage).text, 'Hello from your computer.');
  const requests = (await computer.requests()).trim().split('\n');
  assert.equal(requests.length, 1);
  const request = JSON.parse(requests[0]);
  assert.deepEqual(request.tools ?? [], []);
  process.stdout.write('PASS private turn with template capabilities\n');
} finally {
  socket?.terminate();
  await computer.close();
}
