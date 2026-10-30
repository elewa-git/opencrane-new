interface InlinePart {
  kind: 'text' | 'code' | 'bold' | 'italic' | 'link' | 'citation';
  text: string;
  href?: string;
}

export interface MarkdownBlock {
  kind: 'paragraph' | 'heading' | 'quote' | 'ul' | 'ol' | 'code' | 'a2ui';
  text: string;
  lines: InlinePart[][];
  level: number;
  start: number;
  language: string;
}

function safeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function parseInline(text: string): InlinePart[] {
  // Keep each alternative bounded by its own delimiter, including unmatched input.
  const pattern = /`([^`\n]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|\[([^[\]\n]+)\]\(([^()\s]+)\)|\[(\d+)\]/g;
  const parts: InlinePart[] = [];
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > position) {
      parts.push({ kind: 'text', text: text.slice(position, match.index) });
    }
    const [whole, code, bold, starItalic, underscoreItalic, label, href, citation] = match;
    let part: InlinePart = { kind: 'text', text: whole };
    if (code !== undefined) {
      part = { kind: 'code', text: code };
    } else if (bold !== undefined) {
      part = { kind: 'bold', text: bold };
    } else if (starItalic !== undefined || underscoreItalic !== undefined) {
      part = { kind: 'italic', text: starItalic ?? underscoreItalic ?? '' };
    } else if (label !== undefined && href !== undefined && safeLink(href)) {
      part = { kind: 'link', text: label, href };
    } else if (citation !== undefined) {
      part = { kind: 'citation', text: citation };
    }
    parts.push(part);
    position = match.index + whole.length;
  }
  if (position < text.length) parts.push({ kind: 'text', text: text.slice(position) });
  return parts;
}

function describeLine(line: string): MarkdownBlock {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  const ordered = /^\s{0,3}(\d{1,9})[.)]\s+(.+)$/.exec(line);
  const unordered = /^\s{0,3}[-+*]\s+(.+)$/.exec(line);
  const quote = /^>\s?(.*)$/.exec(line);
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
    start: Number(ordered?.[1] ?? 1), language: '',
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

export function parseMarkdown(text: string): MarkdownBlock[] {
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  const blocks: MarkdownBlock[] = [];
  let fenced: MarkdownBlock | undefined;
  let fence = '';
  let previous: MarkdownBlock | undefined;
  for (const line of lines) {
    if (fenced) {
      if (closesFence(line, fence)) {
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
      fenced = { kind: language === 'a2ui' ? 'a2ui' : 'code', text: '',
        language, lines: [], level: 0, start: 1 };
      blocks.push(fenced);
      previous = undefined;
      continue;
    }
    if (!line.trim()) {
      previous = undefined;
      continue;
    }
    const block = describeLine(line);
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
