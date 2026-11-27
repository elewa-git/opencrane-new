interface InlinePart {
  kind: 'text' | 'code' | 'bold' | 'italic' | 'link' | 'workspace-file'
    | 'workspace-image' | 'citation' | 'app-link';
  text: string;
  href?: string;
  children?: InlinePart[];
}

export interface MarkdownBlock {
  kind: 'paragraph' | 'heading' | 'quote' | 'ul' | 'ol' | 'code' | 'a2ui';
  text: string;
  lines: InlinePart[][];
  level: number;
  start: number;
  language: string;
  closed: boolean;
}

function appLink(value: string): string | undefined {
  if (/[\\\s]/u.test(value) || value.startsWith('//')) {
    return undefined;
  }
  try {
    const relativePath = /^(?:\/(?!\/)|\.{1,2}\/|[?#])/u.test(value);
    if (!relativePath && value.includes(':') && !/^https:/iu.test(value)) {
      return undefined;
    }
    const url = new URL(value, globalThis.location.href);
    if (url.origin === globalThis.location.origin) {
      return url.pathname + url.search + url.hash;
    }
  } catch {
    // Leave malformed destinations as text.
  }
  return undefined;
}

function safeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function workspaceFileLink(value: string): boolean {
  if (/^file:/iu.test(value) || value.startsWith('/tmp/')) {
    return true;
  }
  if (value.startsWith('/workspace/')) {
    return !/^\/workspace\/(?:direct|shared|conversations)(?:[/?#]|$)/u.test(value);
  }
  return !value.includes(':') && !value.startsWith('/')
    && /\.[a-z0-9]+(?:[?#]|$)/iu.test(value);
}

function localFileLink(value: string): boolean {
  if (/^file:/iu.test(value)) return true;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return true;
  }
  if (value.includes(':')) return false;
  return /\.[a-z0-9]+(?:[?#]|$)/iu.test(value);
}

function describeImageMatch(label: string, href: string, whole: string): InlinePart {
  if (!localFileLink(href)) return { kind: 'text', text: whole };
  if (/\.(?:png|jpe?g|webp|gif)$/iu.test(href)) {
    return { kind: 'workspace-image', text: label, href };
  }
  return { kind: 'workspace-file', text: label, href };
}

function describeLinkMatch(label: string, href: string, whole: string): InlinePart {
  if (workspaceFileLink(href)) {
    return { kind: 'workspace-file', text: label, href };
  }
  const destination = appLink(href);
  if (destination !== undefined) {
    return { kind: 'app-link', text: label, href: destination };
  }
  if (safeLink(href)) {
    return { kind: 'link', text: label, href };
  }
  return { kind: 'text', text: whole };
}

function describeInlineMatch(match: RegExpMatchArray): InlinePart {
  const groups = match.groups ?? {};
  const whole = match[0];
  if (groups['code'] !== undefined) {
    return { kind: 'code', text: groups['code'] };
  }
  const formatted = groups['bold'] ?? groups['italic'] ?? groups['underscoreItalic'];
  if (formatted !== undefined) {
    const kind = groups['bold'] !== undefined ? 'bold' : 'italic';
    return { kind, text: formatted, children: parseInline(formatted) };
  }
  if (groups['imageLabel'] !== undefined) {
    return describeImageMatch(groups['imageLabel'], groups['imageHref'] ?? '', whole);
  }
  if (groups['label'] !== undefined) {
    return describeLinkMatch(groups['label'], groups['href'] ?? '', whole);
  }
  if (groups['citation'] !== undefined) {
    return { kind: 'citation', text: groups['citation'] };
  }
  return { kind: 'text', text: whole };
}

function describeBareAddress(address: string): InlinePart {
  let href = address;
  if (/^www\./iu.test(address)) {
    href = 'https://' + address;
  } else if (!address.includes(':') && address.includes('@')) {
    href = 'mailto:' + address;
  }
  return describeLinkMatch(address, href, address);
}

function parseInline(text: string): InlinePart[] {
  // Match whole schemes before addresses so refused links cannot hide a clickable suffix.
  const code = /(?<marker>`+)(?<code>[\s\S]*?)\k<marker>(?!`)/.source;
  const bold = /\*\*(?<bold>[^*]+)\*\*/.source;
  const italic = /\*(?<italic>[^*\n]+)\*|_(?<underscoreItalic>[^_\n]+)_/.source;
  const image = /!\[(?<imageLabel>[^[\]\n]*)\]\((?<imageHref>[^()\s]+)\)/.source;
  const link = /\[(?<label>[^[\]\n]+)\]\((?<href>[^()\s]+)\)/.source;
  const citation = /\[(?<citation>\d+)\]/.source;
  const scheme = /[a-z][a-z0-9+.-]*:[^\s<>"`*]+/.source;
  const web = /www\.[^\s<>"`*]+/.source;
  const relative = /\/(?:workspace|org|account|history|welcome|claim)(?:[/?#][^\s<>"`*]*)?/.source;
  const email = /[a-z0-9.!#$%&'*+/=?^_{}|~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/.source;
  const addresses = [scheme, web, relative, email].join('|');
  const address = '(?<![\\w@/.:+-])(?<address>' + addresses + ')';
  const alternatives = [code, bold, italic, image, link, citation, address].join('|');
  const pattern = new RegExp(alternatives, 'giu');
  const parts: InlinePart[] = [];
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > position) {
      parts.push({ kind: 'text', text: text.slice(position, match.index) });
    }
    const bare = match.groups?.['address'];
    if (bare !== undefined) {
      const trimmed = bare.replace(/[.,!?;:)\]}]+$/u, '');
      parts.push(describeBareAddress(trimmed));
      if (trimmed.length < bare.length) {
        parts.push({ kind: 'text', text: bare.slice(trimmed.length) });
      }
    } else {
      parts.push(describeInlineMatch(match));
    }
    position = match.index + match[0].length;
  }
  if (position < text.length) {
    parts.push({ kind: 'text', text: text.slice(position) });
  }
  return parts;
}

function describeLine(line: string, inlineOnly?: boolean): MarkdownBlock {
  const formattedLine = inlineOnly ? '' : line;
  const heading = /^(#{1,6})\s+(.+)$/.exec(formattedLine);
  const ordered = /^\s{0,3}(\d{1,9})[.)]\s+(.+)$/.exec(formattedLine);
  const unordered = /^\s{0,3}[-+*]\s+(.+)$/.exec(formattedLine);
  const quote = /^>\s?(.*)$/.exec(formattedLine);
  let kind: MarkdownBlock['kind'] = 'paragraph';
  let text = line;
  if (heading) {
    kind = 'heading';
    text = heading[2] ?? '';
  } else if (ordered) {
    kind = 'ol';
    text = ordered[2] ?? '';
  } else if (unordered) {
    kind = 'ul';
    text = unordered[1] ?? '';
  } else if (quote) {
    kind = 'quote';
    text = quote[1] ?? '';
  }
  return {
    kind, text, lines: [parseInline(text)], level: heading?.[1]?.length ?? 0,
    start: Number(ordered?.[1] ?? 1), language: '', closed: true,
  };
}

function closesFence(line: string, fence: string): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  const closing = match?.[1];
  if (!closing) {
    return false;
  }
  const sameMarker = closing[0] === fence[0];
  return sameMarker && closing.length >= fence.length;
}

function appendBlock(
  blocks: MarkdownBlock[], block: MarkdownBlock, previous: MarkdownBlock | undefined,
): MarkdownBlock {
  if (previous?.kind !== block.kind || block.kind === 'heading') {
    blocks.push(block);
    return block;
  }
  if (block.kind === 'paragraph' || block.kind === 'quote') {
    previous.text += '\n' + block.text;
  } else {
    previous.lines.push(block.lines[0] ?? []);
  }
  return previous;
}

export function parseMarkdown(text: string, inlineOnly?: boolean): MarkdownBlock[] {
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  const blocks: MarkdownBlock[] = [];
  let fenced: MarkdownBlock | undefined;
  let fence = '';
  let previous: MarkdownBlock | undefined;
  for (const line of lines) {
    if (fenced) {
      if (closesFence(line, fence)) {
        fenced.closed = true;
        fenced = undefined;
      } else {
        fenced.text += line + '\n';
      }
      continue;
    }
    const opening = /^\s{0,3}(`{3,}|~{3,})([^`~]*)$/.exec(line);
    if (opening) {
      fence = opening[1] ?? '';
      const language = (opening[2] ?? '').trim();
      fenced = { kind: language === 'a2ui' && !inlineOnly ? 'a2ui' : 'code', text: '',
        language, lines: [], level: 0, start: 1, closed: false };
      blocks.push(fenced);
      previous = undefined;
      continue;
    }
    if (!line.trim()) {
      previous = undefined;
      continue;
    }
    const block = describeLine(line, inlineOnly);
    previous = appendBlock(blocks, block, previous);
  }
  for (const block of blocks) {
    if (block.kind === 'paragraph' || block.kind === 'quote') {
      block.lines = [parseInline(block.text)];
    }
    if (block.kind === 'code' || block.kind === 'a2ui') {
      block.text = block.text.replace(/\n$/, '');
    }
  }
  return blocks;
}
