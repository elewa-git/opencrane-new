import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { AssistantMarkdown } from './assistant-markdown';
import { MERMAID_RENDERER } from './mermaid-diagram';

function render(code: string) {
  if (code === 'this is not a diagram') {
    return Promise.reject(new Error('Invalid diagram'));
  }
  const result = { svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };
  return Promise.resolve(result);
}

const renderMermaid = vi.fn(render);

function mount(text: string) {
  const fixture = TestBed.createComponent(AssistantMarkdown);
  fixture.componentRef.setInput('text', text);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No reply element');
  return { fixture, root };
}

function opensPublishedWorkspaceLink() {
  const { fixture, root } = mount('[Open drawing](/workspace/artifacts/drawing.svg)');
  fixture.componentRef.setInput('availableFiles', ['uploads/chat/file/drawing.svg']);
  fixture.detectChanges();
  const opened = vi.fn();
  fixture.componentInstance.fileOpened.subscribe(opened);
  const button = root.querySelector<HTMLButtonElement>('button.workspace-file-link');
  expect(button?.textContent?.trim()).toBe('Open drawing');
  expect(root.textContent).not.toContain('/workspace/artifacts');
  button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  button?.click();
  expect(opened).toHaveBeenCalledWith('uploads/chat/file/drawing.svg');
}

it('opens a published workspace link without exposing its path', opensPublishedWorkspaceLink);

function showsUnavailableWorkspaceFile() {
  const { root } = mount('[Private plan](/workspace/artifacts/private.svg)');
  expect(root.textContent).toContain('File not available');
  expect(root.textContent).not.toContain('/workspace/artifacts');
  expect(root.querySelector('a, button')).toBeNull();
}

it('shows a plain note for a workspace file the viewer cannot open',
  showsUnavailableWorkspaceFile);

function hidesUnpublishedLocalFileLinks() {
  const destinations = ['../drawing.svg', '/tmp/drawing.svg', 'file:///tmp/drawing.svg'];
  for (const destination of destinations) {
    const { fixture, root } = mount(`[Open file](${destination})`);
    fixture.componentRef.setInput('availableFiles', ['uploads/chat/file/drawing.svg']);
    fixture.detectChanges();
    expect(root.textContent).toBe('File not available');
    expect(root.textContent).not.toContain(destination);
    expect(root.querySelector('a, button')).toBeNull();
  }
}

it('hides local file destinations that do not name a published file',
  hidesUnpublishedLocalFileLinks);

function replacesRawWorkspacePath() {
  const { fixture, root } = mount(
    '[/workspace/artifacts/drawing.svg](/workspace/artifacts/drawing.svg)',
  );
  fixture.componentRef.setInput('availableFiles', ['uploads/chat/file/drawing.svg']);
  fixture.detectChanges();
  expect(root.textContent).toContain('drawing.svg');
  expect(root.textContent).not.toContain('/workspace/artifacts/');
}

it('replaces a raw workspace path used as link text with the file name',
  replacesRawWorkspacePath);

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
  const withoutRelativePath = hostile.replace('[relative](/settings)', 'File not available');
  const expected = withoutRelativePath.replace('[file](file:///example)', 'File not available');
  expect(root.textContent).toBe(expected);
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

async function keepsIndentedCodeMarkers() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  for (const indentation of ['    ', '\t', '   \t']) {
    const code = 'keep\n' + indentation + '```\n    [outside](https://example.test)';
    const { root, fixture } = mount('```text\n' + code + '\n```');
    expect(root.querySelectorAll('pre')).toHaveLength(1);
    expect(root.querySelector('pre code')?.textContent).toBe(code);
    expect(root.querySelector('a')).toBeNull();
    root.querySelector('button')?.click();
    await fixture.whenStable();
    expect(writeText).toHaveBeenLastCalledWith(code);
  }
}

function closesIndentedCodeBlocks() {
  for (const indentation of ['', ' ', '  ', '   ']) {
    for (const marker of ['```', '~~~']) {
      const text = marker + 'text\nkeep\n' + indentation + marker + ' \t\n\nAfter';
      const { root } = mount(text);
      expect(root.querySelectorAll('pre')).toHaveLength(1);
      expect(root.querySelector('pre code')?.textContent).toBe('keep');
      expect(root.querySelector('p')?.textContent).toBe('After');
    }
  }
}

function updatesStreamedReply() {
  const { root, fixture } = mount('```js\nconst value = 1;');
  expect(root.querySelector('code')?.textContent).toBe('const value = 1;');
  fixture.componentRef.setInput('text', '```js\nconst value = 1;\n```\n\n## Finished');
  fixture.detectChanges();
  expect(root.querySelector('h2')?.textContent).toBe('Finished');
}

async function keepsCopyFeedbackDuringStreaming() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const reply = '```text\nsame code\n```\n\n```text\nsame code\n```\n\nLater prose';
  const { root, fixture } = mount(reply);
  const codeBlocks = root.querySelectorAll('.code-block');
  const copiedBlock = codeBlocks[1];
  copiedBlock?.querySelector('button')?.click();
  await fixture.whenStable();
  expect(copiedBlock?.querySelector('[role=status]')?.textContent).toBe('Copied');
  fixture.componentRef.setInput('text', reply + ' continues.');
  fixture.detectChanges();
  expect(root.querySelectorAll('.code-block')[1]).toBe(copiedBlock);
  expect(copiedBlock?.querySelector('[role=status]')?.textContent).toBe('Copied');
  expect(codeBlocks[0]?.querySelector('[role=status]')).toBeNull();
  fixture.componentRef.setInput('text',
    '```text\nsame code\n```\n\n```text\nchanged code\n```\n\nLater prose continues.');
  fixture.detectChanges();
  expect(copiedBlock?.querySelector('[role=status]')).toBeNull();
  expect(writeText).toHaveBeenCalledWith('same code');
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

async function rendersMermaidAsAnImage() {
  const { root } = mount('```mermaid\ngraph LR\nA[Start] --> B[Done]\n```');
  function imageAppears() {
    const image = root.querySelector<HTMLImageElement>('img[alt="Diagram"]');
    expect(image?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  }
  await vi.waitFor(imageAppears);
  expect(root.querySelector('iframe, svg, script, a')).toBeNull();
}

async function showsSourceWhenMermaidFails() {
  const source = 'this is not a diagram';
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const { root, fixture } = mount('```mermaid\n' + source + '\n```');
  function sourceAppears() {
    expect(root.querySelector('pre code')?.textContent).toBe(source);
  }
  await vi.waitFor(sourceAppears);
  expect(root.querySelector('img')).toBeNull();
  root.querySelector('button')?.click();
  await fixture.whenStable();
  expect(writeText).toHaveBeenCalledWith(source);
  expect(root.querySelector('[role="status"]')?.textContent).toBe('Copied');
}

function keepsNestedMermaidFenceAsCode() {
  const source = '```mermaid\ngraph LR\nA --> B\n```';
  const { root } = mount('````text\n' + source + '\n````');
  expect(root.querySelector('pre code')?.textContent).toBe(source);
  expect(root.querySelector('img, oc-mermaid-diagram')).toBeNull();
}

it('renders headings, paragraphs, ordered and unordered lists and block quotes', rendersBlocks);

it('renders inline code, bold, italic and permitted links', rendersInline);

it('keeps bold formatting across a line break', rendersMultilineBold);

it('keeps HTML and unsafe links as text', keepsHostileText);

it('keeps nested fences, HTML and Mermaid inside code, with exact copying', copiesCode);

it('offers another try when copying is refused', handlesCopyRefusal);

it('keeps deeply indented code markers and following links inside copied code',
  keepsIndentedCodeMarkers);

it('allows up to three leading spaces and trailing whitespace on closing code markers',
  closesIndentedCodeBlocks);

it('renders unfinished streamed code and updates when the reply grows', updatesStreamedReply);

it('keeps copy feedback on the copied block while unchanged code precedes streamed prose',
  keepsCopyFeedbackDuringStreaming);

it('keeps very long replies and unmatched markers without truncation', keepsLongReplies);

it('keeps citations and the existing interactive placeholder outside code', keepsExistingElements);

it('renders a Mermaid block as an inert image', rendersMermaidAsAnImage);

it('shows the Mermaid source as code when rendering fails', showsSourceWhenMermaidFails);

it('keeps a nested Mermaid fence inside its outer code block', keepsNestedMermaidFenceAsCode);

async function settleDiagram(fixture: ComponentFixture<AssistantMarkdown>) {
  function nextTask(resolve: (value: void) => void) {
    setTimeout(resolve, 0);
  }
  await new Promise<void>(nextTask);
  fixture.detectChanges();
  await fixture.whenStable();
}

function resetRenderer() {
  renderMermaid.mockReset();
  renderMermaid.mockImplementation(render);
  const provider = { provide: MERMAID_RENDERER, useValue: renderMermaid };
  const testingModule = { providers: [provider] };
  TestBed.configureTestingModule(testingModule);
}

beforeEach(resetRenderer);

async function waitsForClosedMermaidFence() {
  renderMermaid.mockClear();
  const { root, fixture } = mount('```mermaid\ngraph LR\nA --> B');
  const deltas = ['\nB --> C[', 'Done]', '\n``', '`'];
  let text = '```mermaid\ngraph LR\nA --> B';
  for (const delta of deltas) {
    await settleDiagram(fixture);
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('pre code')).not.toBeNull();
    text += delta;
    fixture.componentRef.setInput('text', text);
    fixture.detectChanges();
  }
  function diagramAppears() {
    expect(root.querySelector('img')).not.toBeNull();
  }
  await vi.waitFor(diagramAppears);
  expect(renderMermaid).toHaveBeenCalledTimes(1);
}

async function refusesOversizedMermaid() {
  renderMermaid.mockClear();
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = { clipboard: { writeText } };
  vi.stubGlobal('navigator', clipboard);
  const source = 'graph LR\nA["' + 'x'.repeat(51000) + '"]';
  const { root, fixture } = mount('```mermaid\n' + source + '\n```');
  await settleDiagram(fixture);
  expect(renderMermaid).not.toHaveBeenCalled();
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelector('pre code')?.textContent).toBe(source);
  root.querySelector('button')?.click();
  await settleDiagram(fixture);
  expect(writeText).toHaveBeenCalledWith(source);
}

async function refusesWarningImage() {
  const warningSvg = '<svg><text><tspan>Maximum text size in</tspan>'
    + '<tspan>diagram exceeded</tspan></text></svg>';
  const warning = { svg: warningSvg };
  renderMermaid.mockResolvedValueOnce(warning);
  const source = 'graph LR\nA --> B';
  const { root, fixture } = mount('```mermaid\n' + source + '\n```');
  await settleDiagram(fixture);
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelector('pre code')?.textContent).toBe(source);
  expect(root.querySelector('button')?.textContent).toBe('Copy code');
}

async function keepsNewestDiagram(lateFailure: boolean) {
  let resolveRender!: (result: { svg: string; diagramType: string }) => void;
  let rejectRender!: (reason: Error) => void;
  function holdRender(
    resolve: typeof resolveRender, reject: typeof rejectRender,
  ) {
    resolveRender = resolve;
    rejectRender = reject;
  }
  const pending = new Promise<{ svg: string; diagramType: string }>(holdRender);
  renderMermaid.mockReturnValueOnce(pending);
  const { root, fixture } = mount('```mermaid\ngraph LR\nOld --> Reply\n```');
  await settleDiagram(fixture);
  fixture.componentRef.setInput('text', '```mermaid\ngraph LR\nNew --> Reply\n```');
  fixture.detectChanges();
  function newDiagramAppears() {
    expect(root.querySelector('img')).not.toBeNull();
  }
  await vi.waitFor(newDiagramAppears);
  const currentSource = root.querySelector('img')?.getAttribute('src');
  if (lateFailure) {
    rejectRender(new Error('Old render failed'));
  } else {
    const oldResult = { svg: '<svg>Old reply</svg>', diagramType: 'flowchart' };
    resolveRender(oldResult);
  }
  await settleDiagram(fixture);
  expect(root.querySelector('img')?.getAttribute('src')).toBe(currentSource);
}

async function ignoresLateSuccess() {
  await keepsNewestDiagram(false);
}

async function ignoresLateFailure() {
  await keepsNewestDiagram(true);
}

async function handlesMermaidCopyRefusal() {
  const writeText = vi.fn().mockRejectedValue(new Error('Refused'));
  const clipboard = { clipboard: { writeText } };
  vi.stubGlobal('navigator', clipboard);
  const { root, fixture } = mount('```mermaid\nthis is not a diagram\n```');
  await settleDiagram(fixture);
  root.querySelector('button')?.click();
  await settleDiagram(fixture);
  expect(root.querySelector('[role=status]')?.textContent).toBe('Could not copy. Try again.');
  expect(root.querySelector('button')?.disabled).toBe(false);
}

it('waits for the closing fence through successive Mermaid deltas', waitsForClosedMermaidFence);
it('keeps oversized Mermaid source copyable without rendering', refusesOversizedMermaid);
it('keeps source when Mermaid resolves with a warning image', refusesWarningImage);
it('ignores an older successful render after a newer diagram', ignoresLateSuccess);
it('ignores an older failed render after a newer diagram', ignoresLateFailure);
it('offers another try when Mermaid source copying is refused', handlesMermaidCopyRefusal);

async function cancelsPrivateDiagramWhenRemoved(): Promise<void> {
  let finish!: (result: { svg: string }) => void;
  let cancellation: AbortSignal | undefined;
  function hold(resolve: typeof finish): void {
    finish = resolve;
  }
  const pending = new Promise<{ svg: string }>(hold);
  function draw(_code: string, signal?: AbortSignal): Promise<{ svg: string }> {
    cancellation = signal;
    return pending;
  }
  renderMermaid.mockImplementationOnce(draw);
  const fixture = TestBed.createComponent(AssistantMarkdown);
  fixture.componentRef.setInput('volatile', true);
  fixture.componentRef.setInput('text', '```mermaid\ngraph LR\nPrivate --> Plan\n```');
  fixture.detectChanges();
  await settleDiagram(fixture);
  expect(cancellation?.aborted).toBe(false);
  fixture.componentRef.setInput('text', '');
  fixture.detectChanges();
  expect(cancellation?.aborted).toBe(true);
  finish({ svg: '<svg>Private plan</svg>' });
  await settleDiagram(fixture);
  const root: HTMLElement = fixture.nativeElement;
  expect(root.querySelector('img, oc-mermaid-diagram, [role=status]')).toBeNull();
  expect(root.textContent).not.toContain('Private');
}
it('cancels a private diagram and ignores its completion after removal',
  cancelsPrivateDiagramWhenRemoved);
