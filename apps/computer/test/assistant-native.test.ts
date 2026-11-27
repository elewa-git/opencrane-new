import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { openComputerBridge, uploadComputer } from '../../server/test/support/upload-computer.ts';
import { record } from '../src/http.ts';
import { writeFile } from 'node:fs/promises';

async function captureRequests(computer: Awaited<ReturnType<typeof uploadComputer>>, name: string) {
  const capture = await computer.requests();
  const directory = process.env['BRIEF_CAPTURE_DIRECTORY'];
  if (directory) {
    await writeFile(`${directory}/${name}.jsonl`, capture, { mode: 0o600 });
  }
  return capture;
}

function expectBrief(request: Record<string, unknown>, persona: string) {
  const instructions = [request['instructions']];
  for (const item of request['input'] as Record<string, unknown>[]) {
    if (item['role'] === 'developer' || item['role'] === 'system') {
      instructions.push(item['content']);
    }
  }
  const modelInstructions = JSON.stringify(instructions);
  expect(modelInstructions).toContain(persona);
  expect(modelInstructions).not.toContain('You are Codex');
  expect(modelInstructions).toContain('personal assistant');
  expect(modelInstructions).toContain('cannot open network sockets');
  expect(modelInstructions).toContain('/workspace/artifacts');
  expect(modelInstructions).toContain('server checks and shares new or changed files');
}

async function usesToolsWithTheReplacementSoul() {
  // Exercise the installed bridge and templates; a source mount hides stale image pins.
  const computer = await uploadComputer(true, '', { installedSource: true });
  const frames: Record<string, unknown>[] = [];
  let terminals = 0;
  let expectedTerminals = 1;
  const socket = await openComputerBridge(computer.url, computer.credential.value);
  function receive(bytes: Buffer) {
    const frame = record(JSON.parse(bytes.toString()));
    frames.push(frame);
    if (isTerminal(frame)) {
      terminals++;
    }
    if (frame['type'] === 'agent.turn_started') {
      const acknowledgement = { type: 'ack', sequence: frame['sequence'],
        token: 'fixture-turn', model: 'gpt-6.1-sol', expiresAt: Date.now() + 60_000 };
      socket.send(JSON.stringify(acknowledgement));
    }
  }
  function finished() {
    return terminals === expectedTerminals;
  }
  function isTerminal(frame: Record<string, unknown>) {
    return frame['type'] === 'agent.turn_completed' || frame['type'] === 'agent.turn_failed';
  }
  socket.on('message', receive);
  try {
    const path = '/workspace/uploads/chat/file/project.pdf.md';
    await computer.write(path, 'Project code: Willow-47.');
    const resume = { type: 'resume', since: 0 };
    socket.send(JSON.stringify(resume));
    const turn = { type: 'turn', id: 'brief-turn', conversationId: 'chat',
      assistantId: 'assistant', requesterId: 'alice', assistantKind: 'personal',
      executionMode: 'memory_free', approvedPersona: 'Your name is Willow. Be warm and careful.',
      text: `UPLOAD_PDF_PROOF Read ${path} and tell me the project code.`,
      token: 'preparing', expiresAt: Date.now() + 60_000 };
    socket.send(JSON.stringify(turn));
    await until(finished, 30_000);
    expect(frames.at(-1)?.['type']).toBe('agent.turn_completed');
    const capture = await captureRequests(computer, 'new-thread');
    const trimmedCapture = capture.trim();
    const lines = trimmedCapture.split('\n');
    const firstRequest = record(JSON.parse(lines[0]!));
    expectBrief(firstRequest, 'Your name is Willow.');
    expect(capture).toContain('custom_tool_call_output');
    expect(capture).toContain('Project code: Willow-47.');
    expect(JSON.stringify(frames)).toContain('The project code is Willow-47.');
    expectedTerminals = 2;
    const nextTurn = { ...turn, id: 'brief-second', approvedPersona: 'Your name is Cedar.' };
    socket.send(JSON.stringify(nextTurn));
    await until(finished, 30_000);
    expect(frames.at(-1)?.['type']).toBe('agent.turn_completed');
    const nextCapture = await captureRequests(computer, 'resumed-thread');
    const trimmedNextCapture = nextCapture.trim();
    const nextLines = trimmedNextCapture.split('\n');
    const nextRequest = record(JSON.parse(nextLines[lines.length]!));
    expectBrief(nextRequest, 'Your name is Cedar.');
    expect(JSON.stringify(nextRequest)).not.toContain('Your name is Willow.');
  } finally {
    socket.terminate();
    await computer.close();
  }
}
it('runs a real shell tool with the persona soul and a stand-in model',
  usesToolsWithTheReplacementSoul, 60_000);
