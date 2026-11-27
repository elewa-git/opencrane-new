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

function keepsLongCodeSpansUnlinked(): void {
  const { root } = mount('``Example `code` https://example.test``');
  expect(root.querySelector('a')).toBeNull();
  expect(root.querySelector('code')?.textContent).toBe('Example `code` https://example.test');
}
it('keeps a code span containing backticks unlinked', keepsLongCodeSpansUnlinked);

function refusesUnknownSameOriginSchemes(): void {
  const { root } = mount(`[Blob](blob:${location.origin}/file)`);
  expect(root.querySelector('a')).toBeNull();
}
it('refuses an unknown scheme even when its URL reports the app origin',
  refusesUnknownSameOriginSchemes);

function checksSameOriginAndProtocol(): void {
  const appOrigin = 'https://app.example.test';
  vi.stubGlobal('location', new URL(appOrigin));
  try {
    const { root } = mount(`${appOrigin}/org/people `
      + '[Chat](./workspace?conversation=one) '
      + '[Plain HTTP](http://app.example.test/org/people) '
      + '[Other port](https://app.example.test:444/org/people)');
    const links = root.querySelectorAll('a');
    expect(links).toHaveLength(3);
    expect(links[0]?.getAttribute('href')).toBe('/org/people');
    expect(links[0]?.target).toBe('');
    expect(links[1]?.getAttribute('href')).toBe('/workspace?conversation=one');
    expect(links[2]?.target).toBe('_blank');
  } finally {
    vi.unstubAllGlobals();
  }
}
it('checks the complete origin and refuses HTTP on the same host', checksSameOriginAndProtocol);

function resolvesRelativeAppPaths(): void {
  vi.stubGlobal('location', new URL('https://app.example.test/org/chats/one'));
  try {
    const { root } = mount('[People](../people) [Chat](/workspace/direct/)');
    const links = root.querySelectorAll('a');
    expect(links[0]?.getAttribute('href')).toBe('/org/people');
    expect(links[1]?.getAttribute('href')).toBe('/workspace/direct/');
  } finally {
    vi.unstubAllGlobals();
  }
}
it('resolves relative app paths from the current page and accepts trailing slashes',
  resolvesRelativeAppPaths);

function keepsMemberBlockMarkers(): void {
  const text = '# Visit https://example.test\n\n- www.example.test\n\n> help@example.test';
  const { fixture, root } = mount(text);
  fixture.componentRef.setInput('inlineOnly', true);
  fixture.detectChanges();
  expect(root.querySelector('h1, ul, blockquote')).toBeNull();
  expect(root.querySelectorAll('a')).toHaveLength(3);
  expect(root.textContent).toContain('# Visit');
  expect(root.textContent).toContain('- www.example.test');
  expect(root.textContent).toContain('> help@example.test');
}
it('shares safe inline links while keeping member block markers as typed', keepsMemberBlockMarkers);

function respectsBlockedNavigation(): void {
  const { fixture, root } = mount('[People](/org/people)');
  fixture.componentRef.setInput('navigationBlocked', true);
  fixture.detectChanges();
  const push = vi.spyOn(history, 'pushState');
  try {
    const link = root.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('aria-disabled')).toBe('true');
    link?.click();
    expect(push).not.toHaveBeenCalled();
  } finally {
    push.mockRestore();
  }
}
it('keeps an unresolved colleague message from navigating to another app page',
  respectsBlockedNavigation);

function keepsMultilineCodeSpanUnlinked(): void {
  const { root } = mount('`Example\nhttps://example.test`');
  expect(root.querySelector('a')).toBeNull();
  expect(root.querySelector('code')?.textContent).toBe('Example\nhttps://example.test');
}
it('keeps an inline code span unlinked across a line break', keepsMultilineCodeSpanUnlinked);
