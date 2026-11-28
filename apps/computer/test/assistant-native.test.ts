import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { openComputerBridge, uploadComputer } from '../../server/test/support/upload-computer.ts';
import { record } from '../src/http.ts';
import { writeFile } from 'node:fs/promises';
import type { WebSocket } from 'ws';

function acknowledgeTurn(socket: WebSocket, frame: Record<string, unknown>) {
  if (frame['type'] !== 'agent.turn_started') {
    return;
  }
  const acknowledgement = { type: 'ack', sequence: frame['sequence'],
    token: 'fixture-turn', model: 'gpt-6.1-sol', expiresAt: Date.now() + 60_000 };
  socket.send(JSON.stringify(acknowledgement));
}

async function captureRequests(computer: Awaited<ReturnType<typeof uploadComputer>>, name: string) {
  const capture = await computer.requests();
  const directory = process.env['BRIEF_CAPTURE_DIRECTORY'];
  if (directory) {
    const options = { mode: 0o600 };
    await writeFile(`${directory}/${name}.jsonl`, capture, options);
  }
  return capture;
}

function lastRequest(capture: string) {
  const trimmed = capture.trim();
  const lines = trimmed.split('\n');
  const line = lines.at(-1)!;
  return parseRequest(line);
}

function parseRequest(line: string) {
  const parsed: unknown = JSON.parse(line);
  return record(parsed);
}

function expectBrief(request: Record<string, unknown>, persona: string) {
  expect(request['prompt_cache_key']).toBeTypeOf('string');
  const instructions = [request['instructions']];
  const input = request['input'];
  if (!Array.isArray(input)) {
    throw new Error('Expected model input items');
  }
  for (const value of input) {
    const item = record(value);
    if (item['role'] === 'developer' || item['role'] === 'system') {
      instructions.push(item['content']);
    }
  }
  const modelInstructions = JSON.stringify(instructions);
  expect(modelInstructions).toContain(persona);
  expect(modelInstructions).not.toContain('You are Codex');
  expect(modelInstructions).toContain('personal assistant');
  expect(modelInstructions).toContain('cannot reach the internet from your computer yet');
  expect(modelInstructions).toContain('/workspace/artifacts');
  expect(modelInstructions).toContain('server checks and shares new or changed files');
}

async function checkSavedThread(computer: Awaited<ReturnType<typeof uploadComputer>>,
  turn: Record<string, unknown>, since: number) {
  const before = await computer.requests();
  const trimmedBefore = before.trim();
  const beforeLines = trimmedBefore.split('\n');
  await computer.restart();
  const socket = await openComputerBridge(computer.url, computer.credential.value);
  let terminal: string | undefined;
  function receive(bytes: Buffer) {
    const line = bytes.toString();
    const frame = parseRequest(line);
    acknowledgeTurn(socket, frame);
    if (frame['type'] === 'agent.turn_completed' || frame['type'] === 'agent.turn_failed') {
      terminal = frame['type'];
    }
  }
  function finished() {
    return terminal !== undefined;
  }
  socket.on('message', receive);
  try {
    const resume = { type: 'resume', since };
    socket.send(JSON.stringify(resume));
    const nextTurn = { ...turn, id: 'brief-after-restart', expiresAt: Date.now() + 60_000 };
    socket.send(JSON.stringify(nextTurn));
    await until(finished, 30_000);
    expect(terminal).toBe('agent.turn_completed');
    const capture = await captureRequests(computer, 'saved-thread');
    const trimmed = capture.trim();
    const lines = trimmed.split('\n');
    const request = parseRequest(lines[beforeLines.length]!);
    expect(request['prompt_cache_key']).toBe(lastRequest(before)['prompt_cache_key']);
    expectBrief(request, 'Your name is Cedar.');
    expect(JSON.stringify(request)).not.toContain('Your name is Willow.');
  } finally {
    socket.terminate();
  }
}

async function usesToolsWithTheReplacementSoul() {
  // Exercise the installed bridge and templates; a source mount hides stale image pins.
  const fixtureOptions = { installedSource: true };
  const computer = await uploadComputer(true, '', fixtureOptions);
  const frames: Record<string, unknown>[] = [];
  let terminals = 0;
  let expectedTerminals = 1;
  const socket = await openComputerBridge(computer.url, computer.credential.value);
  function receive(bytes: Buffer) {
    const line = bytes.toString();
    const frame = parseRequest(line);
    frames.push(frame);
    if (isTerminal(frame)) {
      terminals++;
    }
    acknowledgeTurn(socket, frame);
  }
  function finished() {
    return terminals === expectedTerminals;
  }
  function isTerminal(frame: Record<string, unknown>) {
    return frame['type'] === 'agent.turn_completed' || frame['type'] === 'agent.turn_failed';
  }
  socket.on('message', receive);
  try {
    const version = await computer.exec('node', '/usr/local/bin/codex', '--version');
    expect(version).toBe('codex-cli 0.159.2');
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
    const firstRequest = parseRequest(lines[0]!);
    expectBrief(firstRequest, 'Your name is Willow.');
    expect(capture).toContain('custom_tool_call_output');
    expect(capture).toContain('Project code: Willow-47.');
    expect(JSON.stringify(frames)).toContain('The project code is Willow-47.');
    expectedTerminals = 2;
    const sameTurn = { ...turn, id: 'brief-same-persona' };
    socket.send(JSON.stringify(sameTurn));
    await until(finished, 30_000);
    expect(frames.at(-1)?.['type']).toBe('agent.turn_completed');
    const loadedCapture = await captureRequests(computer, 'loaded-thread');
    const loadedRequest = lastRequest(loadedCapture);
    expectBrief(loadedRequest, 'Your name is Willow.');
    expect(loadedRequest['prompt_cache_key']).toBe(firstRequest['prompt_cache_key']);
    expectedTerminals = 3;
    const nextTurn = { ...turn, id: 'brief-second', approvedPersona: 'Your name is Cedar.' };
    socket.send(JSON.stringify(nextTurn));
    await until(finished, 30_000);
    expect(frames.at(-1)?.['type']).toBe('agent.turn_completed');
    const nextCapture = await captureRequests(computer, 'resumed-thread');
    const trimmedNextCapture = nextCapture.trim();
    const nextLines = trimmedNextCapture.split('\n');
    const loadedLines = loadedCapture.trim();
    const loadedRequestLines = loadedLines.split('\n');
    const nextRequest = parseRequest(nextLines[loadedRequestLines.length]!);
    expectBrief(nextRequest, 'Your name is Cedar.');
    expect(nextRequest['prompt_cache_key']).toBe(firstRequest['prompt_cache_key']);
    expect(JSON.stringify(nextRequest)).not.toContain('Your name is Willow.');
    const sequence = Number(frames.at(-1)?.['sequence']);
    socket.terminate();
    await checkSavedThread(computer, nextTurn, sequence);
  } finally {
    socket.terminate();
    await computer.close();
  }
}
it('delivers the installed brief to new, loaded and resumed model turns',
  usesToolsWithTheReplacementSoul, 60_000);
