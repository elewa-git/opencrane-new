import { TestBed } from '@angular/core/testing';
import { ConversationFileCard } from './conversation-file-card';

it('does not offer Download for an assistant workspace file', () => {
  const fixture = TestBed.createComponent(ConversationFileCard);
  fixture.componentRef.setInput('conversationId', 'conversation / one');
  fixture.componentRef.setInput('path', 'notes/quarterly board.xlsx');
  fixture.componentRef.setInput('createdAt', '2026-10-04T10:00:00Z');
  fixture.componentRef.setInput('createdBy', 'assistant');
  fixture.componentRef.setInput('downloadAllowed', false);
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No conversation file card');
  expect(root.querySelector('a')).toBeNull();
  expect(root.querySelector('article')?.getAttribute('aria-labelledby'))
    .toBe(root.querySelector('.file-name')?.id);
  expect(root.querySelector('.agent-badge')?.getAttribute('aria-hidden')).toBe('true');
  expect(root.textContent).toContain('Created by assistant');
});

it('offers the encoded file route to a person who owns the upload', () => {
  const fixture = TestBed.createComponent(ConversationFileCard);
  fixture.componentRef.setInput('conversationId', 'conversation / one');
  fixture.componentRef.setInput('path', 'uploads/file id/quarterly board.pdf');
  fixture.componentRef.setInput('createdAt', '2026-10-04T10:00:00Z');
  fixture.componentRef.setInput('createdBy', 'you');
  fixture.componentRef.setInput('downloadAllowed', true);
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No conversation file card');
  const download = root.querySelector<HTMLAnchorElement>('a');
  expect(download?.getAttribute('href')).toBe(
    '/api/conversations/conversation%20%2F%20one/files/view?path=uploads%2Ffile%20id%2Fquarterly%20board.pdf',
  );
  expect(download?.getAttribute('aria-label')).toBe('Download quarterly board.pdf');
});

it('offers Download for a screenshot the viewer may read', () => {
  const fixture = TestBed.createComponent(ConversationFileCard);
  fixture.componentRef.setInput('conversationId', 'conversation');
  fixture.componentRef.setInput('path', 'uploads/conversation/screen/desktop.png');
  fixture.componentRef.setInput('createdAt', '2026-10-04T10:00:00Z');
  fixture.componentRef.setInput('createdBy', 'participant');
  fixture.componentRef.setInput('downloadAllowed', true);
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No conversation file card');
  expect(root.querySelector('a')?.textContent).toContain('Download');
});
