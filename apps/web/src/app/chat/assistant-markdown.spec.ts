import { TestBed } from '@angular/core/testing';
import { AssistantMarkdown } from './assistant-markdown';

function mount(text: string) {
  const fixture = TestBed.createComponent(AssistantMarkdown);
  fixture.componentRef.setInput('text', text);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No reply element');
  return { fixture, root };
}

afterEach(function restoreMocks() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function rendersBlocks() {
  const { root } = mount('# Title\n\nParagraph\n\n3. Third\n4. Fourth\n\n- One\n- Two\n\n> Quote');
  expect(root.querySelector('h1')?.textContent).toBe('Title');
  expect(root.querySelector('p')?.textContent).toBe('Paragraph');
  expect(root.querySelector('ol')?.getAttribute('start')).toBe('3');
  expect(root.querySelectorAll('ol li')).toHaveLength(2);
  expect(root.querySelectorAll('ul li')).toHaveLength(2);
  expect(root.querySelector('blockquote')?.textContent).toBe('Quote');
  for (let level = 2; level <= 6; level++) {
    const heading = mount(`${'#'.repeat(level)} Heading`).root;
    expect(heading.querySelector(`h${level}`)?.textContent).toBe('Heading');
  }
}

function rendersInline() {
  const { root } = mount('`<code>` **bold** *italic* _also italic_ '
    + '[site](https://example.test/help) [mail](mailto:help@example.test)');
  expect(root.querySelector('code')?.textContent).toBe('<code>');
  expect(root.querySelector('strong')?.textContent).toBe('bold');
  expect(root.querySelectorAll('em')).toHaveLength(2);
  const links = root.querySelectorAll('a');
  expect(links).toHaveLength(2);
  expect(links[0]?.getAttribute('href')).toBe('https://example.test/help');
  expect(links[1]?.getAttribute('href')).toBe('mailto:help@example.test');
  for (const link of links) {
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  }
}

function keepsHostileText() {
  const hostile = '<img src=x onerror=alert(1)> <script>alert(1)</script> '
    + '[bad](javascript:alert) [data](data:text/html,hello) [web](http://example.test) '
    + '[relative](/settings) [file](file:///example) [encoded](java&#x73;cript:alert)';
  const { root } = mount(hostile);
  expect(root.querySelector('img, script, a')).toBeNull();
  expect(root.textContent).toBe(hostile);
}

function rendersMultilineBold() {
  const { root } = mount('**first\nsecond**');
  expect(root.querySelector('strong')?.textContent).toBe('first\nsecond');
  expect(root.textContent).toBe('first\nsecond');
}

async function copiesCode() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const code = '```html\n<img src=x>\n```';
  const { root, fixture } = mount(`\`\`\`\`text\n${code}\n\`\`\`\`\n\n\`\`\`mermaid\ngraph LR\n\`\`\``);
  expect(root.querySelector('pre code')?.textContent).toBe(code);
  expect(root.querySelectorAll('pre')).toHaveLength(2);
  expect(root.querySelector('img, iframe, svg')).toBeNull();
  root.querySelector('button')?.click();
  await fixture.whenStable();
  expect(writeText).toHaveBeenCalledWith(code);
  expect(root.textContent).toContain('Copied');
  vi.unstubAllGlobals();
}

async function handlesCopyRefusal() {
  const writeText = vi.fn().mockRejectedValue(new Error('Refused'));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const { root, fixture } = mount('```\nhello\n```');
  root.querySelector('button')?.click();
  await fixture.whenStable();
  expect(root.textContent).toContain('Could not copy. Try again.');
  expect(root.querySelector('button')?.disabled).toBe(false);
  vi.unstubAllGlobals();
}

function updatesStreamedReply() {
  const { root, fixture } = mount('```js\nconst value = 1;');
  expect(root.querySelector('code')?.textContent).toBe('const value = 1;');
  fixture.componentRef.setInput('text', '```js\nconst value = 1;\n```\n\n## Finished');
  fixture.detectChanges();
  expect(root.querySelector('h2')?.textContent).toBe('Finished');
}

function keepsLongReplies() {
  const longText = 'Long reply\n'.repeat(20000) + '['.repeat(20000) + '*'.repeat(20000);
  const { root } = mount(longText);
  expect(root.textContent).toBe(longText);
  expect(root.querySelectorAll('p')).toHaveLength(1);
}

function keepsExistingElements() {
  const { root } = mount('Source [1]\n\n```a2ui\n{}\n```');
  expect(root.querySelector('.citation')?.textContent?.trim()).toBe('1');
  expect(root.querySelector('.a2ui header .agent-badge')?.textContent).toBe('Ag');
  expect(root.textContent).toContain('This interface is not available yet.');
}

it('renders headings, paragraphs, ordered and unordered lists and block quotes', rendersBlocks);

it('renders inline code, bold, italic and permitted links', rendersInline);

it('keeps bold formatting across a line break', rendersMultilineBold);

it('keeps HTML and unsafe links as text', keepsHostileText);

it('keeps nested fences, HTML and Mermaid inside code, with exact copying', copiesCode);

it('offers another try when copying is refused', handlesCopyRefusal);

it('renders unfinished streamed code and updates when the reply grows', updatesStreamedReply);

it('keeps very long replies and unmatched markers without truncation', keepsLongReplies);

it('keeps citations and the existing interactive placeholder outside code', keepsExistingElements);
