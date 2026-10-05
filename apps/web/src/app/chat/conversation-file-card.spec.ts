import { TestBed } from '@angular/core/testing';
import { ConversationFileCard } from './conversation-file-card';

const screenshotFacts = {
  computerId: 'kijani-sales-01', generation: 4,
  capturedAt: '2026-10-02T10:42:00Z', width: 1440, height: 900, size: 421888,
};

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

it('shows a caption, capture facts and the accessible preview action for screenshots', () => {
  const fixture = TestBed.createComponent(ConversationFileCard);
  fixture.componentRef.setInput('conversationId', 'conversation');
  fixture.componentRef.setInput('path', 'uploads/conversation/screen/desktop.png');
  fixture.componentRef.setInput('createdAt', screenshotFacts.capturedAt);
  fixture.componentRef.setInput('createdBy', 'you');
  fixture.componentRef.setInput('downloadAllowed', true);
  fixture.componentRef.setInput('thumbnailUrl', '/image.png');
  fixture.componentRef.setInput('screenshot', screenshotFacts);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No screenshot card');
  const image = root.querySelector('img');
  expect(image?.getAttribute('alt')).toBe('');
  expect(root.textContent).toContain(
    'Screenshot of kijani-sales-01. No description of its contents is generated.',
  );
  expect(root.textContent).toContain('Captured by you · 2 Oct 2026, 10:42 UTC · 1440 × 900');
  expect(root.querySelector('article')?.classList.contains('screenshot-card')).toBe(true);
  expect(root.querySelector('button')?.getAttribute('aria-label'))
    .toBe('Open preview of desktop.png');
  expect(root.querySelector('a')?.getAttribute('aria-label')).toBe('Download desktop.png');
});

it('keeps focus on one screenshot button while retrying its thumbnail', () => {
  const fixture = TestBed.createComponent(ConversationFileCard);
  fixture.componentRef.setInput('conversationId', 'conversation');
  fixture.componentRef.setInput('path', 'uploads/conversation/screen/desktop.png');
  fixture.componentRef.setInput('createdAt', screenshotFacts.capturedAt);
  fixture.componentRef.setInput('createdBy', 'participant');
  fixture.componentRef.setInput('downloadAllowed', false);
  fixture.componentRef.setInput('thumbnailUrl', '/image.png');
  fixture.componentRef.setInput('screenshot', screenshotFacts);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No screenshot card');
  expect(root.textContent).toContain('Captured by another participant');
  const image = root.querySelector<HTMLImageElement>('img');
  if (!image) throw new Error('Missing screenshot thumbnail');
  image.dispatchEvent(new Event('error'));
  fixture.detectChanges();
  const button = root.querySelector<HTMLButtonElement>('button');
  if (!button) throw new Error('Missing screenshot action');
  expect(root.textContent).toContain("Preview couldn't load");
  expect(button.textContent).toContain('Try preview again');
  expect(button.getAttribute('aria-label')).toBe('Try preview again for desktop.png');
  button.focus();
  button.click();
  fixture.detectChanges();
  expect(root.querySelector('button')).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(root.querySelector('img')?.getAttribute('src')).toContain('attempt=1');
  expect(root.querySelector('a')).toBeNull();
});
