import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { writeSessionSoul } from '../src/assistant-brief.ts';
import { computerSessionInstructions } from '../src/codex-config.ts';
import { threadLoads } from '../src/thread-loads.ts';
import { startPrivateThread } from '../src/routine-threads.ts';
import type { Turn } from '../src/turn-frame.ts';
import { record } from '../src/http.ts';

async function sendsMemoryFreeInstructions(kind: 'personal' | 'team') {
  const directory = mkdtempSync(`${tmpdir()}/assistant-session-`);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const input: Turn = { id: 'turn', conversationId: 'chat', assistantId: 'assistant',
    requesterId: 'alice', assistantKind: kind, executionMode: 'memory_free',
    approvedPersona: kind === 'personal' ? 'Your name is Willow.' : undefined,
    text: 'Introduce yourself', token: 'fixture', expiresAt: Date.now() + 60_000,
    taskKind: 'chat_turn', omittedAttachments: 0 };
  function rpc(method: string, params: Record<string, unknown>) {
    calls.push({ method, params });
    return Promise.resolve({ thread: { id: 'thread' } });
  }
  function instructions(turn: Turn) {
    const path = writeSessionSoul(turn.approvedPersona, directory);
    return computerSessionInstructions(turn, path);
  }
  const loads = threadLoads({ rpc, instructions });
  try {
    await loads.load(input, undefined, { cwd: '/workspace' });
    const config = record(calls[0]?.params['config']);
    expect(config['personality']).toBe('none');
    expect(config['project_doc_max_bytes']).toBe(0);
    const path = config['model_instructions_file'];
    expect(typeof path).toBe('string');
    const soul = readFileSync(String(path), 'utf8');
    if (kind === 'personal') expect(soul).toContain('Your name is Willow.');
    else expect(soul).not.toContain('Willow');
    const developer = String(config['developer_instructions']);
    expect(developer).toContain(kind === 'personal' ? 'personal assistant' : 'shared assistant');
    expect(developer).toContain('/workspace/artifacts');
    expect(developer).toContain('16 files and 20 MiB');
    expect(developer).toContain('Installing software');
    expect(developer).toContain('cannot open network sockets');
    expect(developer).toContain('gateway');
    expect(developer).toContain('missing tools');
    expect(developer).toContain('Admitted external tools: none');
  } finally {
    await loads.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}
it.each(['personal', 'team'] as const)(
  'sends the generated soul and actual %s instructions to Codex', sendsMemoryFreeInstructions);

async function sendsRestrictedInstructions(variant: 'shared' | 'routine') {
  const calls: Record<string, unknown>[] = [];
  function rpc(_method: string, params: Record<string, unknown>) {
    calls.push(params);
    return Promise.resolve({ thread: { id: 'private', ephemeral: true, path: null,
      environments: [] } });
  }
  function close() {}
  function keepOpen() {}
  const closed = new Promise<void>(keepOpen);
  const facts = variant === 'shared'
    ? { executionMode: 'restricted' as const, sharingClass: 'shared_only' as const }
    : { executionMode: 'restricted' as const, senderAttemptId: 'attempt' };
  await startPrivateThread({ rpc, close, closed }, 'chat_turn', facts);
  expect(calls[0]).toMatchObject({ sandbox: 'read-only', ephemeral: true, environments: [] });
  const config = record(calls[0]?.['config']);
  expect(config['model_instructions_file']).toBeTypeOf('string');
  expect(config['personality']).toBe('none');
  const developer = String(config['developer_instructions']);
  expect(developer).toContain(variant === 'shared' ? 'shared assistant' : 'Nobody is watching');
  expect(developer).toContain('Shell, file edits and browser tools are');
  expect(developer).not.toContain('Installing software in your sandbox is allowed');
  if (variant === 'routine') expect(developer).toContain('stop and notify');
}
it.each(['shared', 'routine'] as const)(
  'sends the %s brief without changing private restrictions', sendsRestrictedInstructions);

function keepsTeamRoutinesUnattended() {
  const facts = { executionMode: 'restricted' as const, assistantKind: 'team' as const,
    senderAttemptId: 'attempt' };
  const routine = computerSessionInstructions(facts);
  expect(routine.developer_instructions).toContain('Nobody is watching');
  const shared = computerSessionInstructions({ ...facts, sharingClass: 'shared_only' });
  expect(shared.developer_instructions).toContain('general shared assistant');
  expect(shared.developer_instructions).not.toContain('Nobody is watching');
}
it('keeps a team routine unattended and preserves shared-context restrictions',
  keepsTeamRoutinesUnattended);
