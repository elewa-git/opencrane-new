import { TestBed } from '@angular/core/testing';
import { AssistantMarkdown } from './assistant-markdown';

function mount(text: string) {
  const fixture = TestBed.createComponent(AssistantMarkdown);
  fixture.componentRef.setInput('text', text);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No message element');
  return { fixture, root };
}

function linksBareAddresses(): void {
  const { root } = mount('Visit https://example.test/help., www.example.test/path)? '
    + 'or help@example.test!');
  const links = root.querySelectorAll('a');
  expect(links).toHaveLength(3);
  expect(links[0]?.getAttribute('href')).toBe('https://example.test/help');
  expect(links[1]?.getAttribute('href')).toBe('https://www.example.test/path');
  expect(links[2]?.getAttribute('href')).toBe('mailto:help@example.test');
  expect(root.textContent).toBe('Visit https://example.test/help., www.example.test/path)? '
    + 'or help@example.test!');
  for (const link of links) {
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.tabIndex).toBe(0);
  }
}
it('links bare web and email addresses without their trailing punctuation', linksBareAddresses);

function opensBareSharedFiles(): void {
  const destinations = ['/workspace/artifacts/report.pdf',
    'file:///workspace/artifacts/report.pdf'];
  for (const destination of destinations) {
    for (const text of [destination + '.', `[Report](${destination})`]) {
      const { fixture, root } = mount(text);
      fixture.componentRef.setInput('availableFiles', ['published/report.pdf']);
      fixture.detectChanges();
      const opened = vi.fn();
      fixture.componentInstance.fileOpened.subscribe(opened);
      const button = root.querySelector<HTMLButtonElement>('.workspace-file-link');
      expect(button).not.toBeNull();
      button?.click();
      expect(opened).toHaveBeenCalledExactlyOnceWith('published/report.pdf');
      expect(root.textContent).not.toContain('/workspace/artifacts/');
    }
  }
}
it('opens bare and Markdown shared-file paths through the same file viewer', opensBareSharedFiles);

function refusesUnsafeDestinations(): void {
  const values = ['javascript:alert', 'data:text/html,www.example.test',
    'http://www.example.test', 'unknown:https://example.test', '//www.example.test',
    'javascript:help@example.test'];
  for (const value of values) {
    const text = value + ` [Unsafe](${value})`;
    const { root } = mount(text);
    expect(root.querySelector('a, button')).toBeNull();
    expect(root.textContent).toBe(text);
  }
}
it('keeps unsafe schemes and their embedded addresses as text', refusesUnsafeDestinations);

function keepsCodeUnlinked(): void {
  const text = 'https://example.test help@example.test /workspace/artifacts/report.pdf';
  const { root } = mount('`' + text + '`\n\n```text\n' + text + '\n```');
  expect(root.querySelectorAll('code')).toHaveLength(2);
  expect(root.querySelector('a, .workspace-file-link')).toBeNull();
}
it('never links inline code or fenced code blocks', keepsCodeUnlinked);

function linksFormattedAddresses(): void {
  const { root } = mount('**https://example.test** *www.example.test*');
  expect(root.querySelector('strong a')?.getAttribute('href')).toBe('https://example.test');
  expect(root.querySelector('em a')?.getAttribute('href')).toBe('https://www.example.test');
}
it('links addresses inside bold and italic text', linksFormattedAddresses);

function opensSameOriginWithoutReload(): void {
  const path = '/org/people?tab=members#list';
  const { root } = mount(`[People](${path})`);
  const links = root.querySelectorAll('a');
  expect(links).toHaveLength(1);
  for (const link of links) {
    expect(link.target).toBe('');
    expect(link.getAttribute('href')).toBe(path);
  }
  const push = vi.spyOn(history, 'pushState').mockImplementation(function keepLocation() {});
  const changed = vi.fn();
  window.addEventListener('popstate', changed);
  try {
    links[0]?.click();
    expect(push).toHaveBeenCalledWith(null, '', path);
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener('popstate', changed);
    push.mockRestore();
  }
}
it('opens same-origin app links in the app without a page reload', opensSameOriginWithoutReload);
