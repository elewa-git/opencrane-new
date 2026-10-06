import type { ChatRow } from '@opencrane/protocol';
import { rejectedScreenshotIds, toolKind, transcript, uploadedFile } from './chat-state';

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

it('renders a rejected screenshot turn without exposing its file name', () => {
  const rows = [{ id: 'rejected', position: 1, type: 'file.rejected',
    time: '2026-10-02T10:42:01Z', data: {
      conversationId: 'chat', fileId: 'screen', uploadedBy: 'me', name: 'secret-name.png',
      size: 421888, sha256: 'hash', reason: 'infected',
      screenshot: { computerId: 'computer', generation: 4,
        capturedAt: '2026-10-02T10:42:00Z', width: 1440, height: 900 },
    } }] as ChatRow[];
  const turn = transcript(rows, 'me')[0];
  expect(turn?.screenshotRejected).toBe(true);
  expect(turn?.author).toBe('you');
  expect(turn?.files).toEqual([]);
  expect(JSON.stringify(turn)).not.toContain('secret-name.png');
  expect(rejectedScreenshotIds(rows)).toEqual(['screen']);
});

it('ignores rejected ordinary uploads and validates screenshot facts and size', () => {
  const rejected = [{ id: 'rejected-upload', position: 1, type: 'file.rejected',
    time: '2026-10-02T10:42:00Z', data: {
      conversationId: 'chat', fileId: 'upload', uploadedBy: 'me', name: 'brief.pdf',
      size: 100, sha256: 'hash', reason: 'infected',
    } }] as ChatRow[];
  expect(transcript(rejected, 'me')).toEqual([]);
  expect(rejectedScreenshotIds(rejected)).toEqual([]);
  const uploaded = { id: 'screen', position: 2, type: 'file.uploaded',
    time: '2026-10-02T10:42:00Z', data: {
      conversationId: 'chat', fileId: 'screen', uploadedBy: 'me', name: 'screen.png',
      size: 421888, mime: 'image/png',
      screenshot: { computerId: 'computer', generation: 4,
        capturedAt: '2026-10-02T10:42:00Z', width: 1440, height: 900 },
    } } as ChatRow;
  expect(uploadedFile(uploaded)).toMatchObject({ size: 421888,
    screenshot: { width: 1440, height: 900 } });
});

it('names transcript tool records without adding fields to them', () => {
  expect(toolKind({ id: 'failed', label: 'Reply failed', detail: 'Run interrupted',
    failed: true, time: '2026-10-04T10:00:00Z' })).toBe('Agent run');
  expect(toolKind({ id: 'command', label: 'Command completed', detail: 'Exit code 0',
    failed: false, time: '2026-10-04T10:00:00Z' })).toBe('Computer command');
});
