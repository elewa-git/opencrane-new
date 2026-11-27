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
    if (kind === 'personal') {
      expect(soul).toContain('Your name is Willow.');
    } else {
      expect(soul).not.toContain('Willow');
    }
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

async function keepsInstructionsOutOfPrivateThreads() {
  const calls: Record<string, unknown>[] = [];
  function rpc(_method: string, params: Record<string, unknown>) {
    calls.push(params);
    return Promise.resolve({ thread: { id: 'private', ephemeral: true, path: null,
      environments: [] } });
  }
  function close() {}
  function keepOpen() {}
  const closed = new Promise<void>(keepOpen);
  await startPrivateThread({ rpc, close, closed }, 'chat_turn');
  expect(calls).toEqual([{ model: 'gpt-6.1-sol', approvalPolicy: 'never',
    sandbox: 'read-only', ephemeral: true, environments: [] }]);
}
it('keeps persona and instructions out of private threads', keepsInstructionsOutOfPrivateThreads);

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
