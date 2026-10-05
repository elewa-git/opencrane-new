import type { ChatRow } from '@opencrane/protocol';
import { transcript } from './chat-state';

it('keeps created and modified workspace files but omits deleted files', () => {
  const rows = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-04T10:00:00Z',
      data: { text: 'Update the report', authorId: 'me' } },
    { id: 'created', position: 2, type: 'agent.file_changed', time: '2026-10-04T10:01:00Z',
      data: { turnId: 'message', path: 'report.md', changeType: 'created' } },
    { id: 'deleted', position: 3, type: 'agent.file_changed', time: '2026-10-04T10:02:00Z',
      data: { turnId: 'message', path: 'old-report.md', changeType: 'deleted' } },
  ] as ChatRow[];

  const turns = transcript(rows, 'me');
  const agentTurn = turns.find(turn => turn.author === 'agent');

  expect(agentTurn?.files).toEqual(['report.md']);
});
