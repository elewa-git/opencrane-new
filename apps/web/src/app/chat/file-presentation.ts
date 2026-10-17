export function fileName(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

export function fileType(path: string): string {
  const parts = fileName(path).split('.');
  const extension = parts.at(-1) ?? 'FILE';
  return extension.toUpperCase().slice(0, 5);
}

export function fileUrl(conversationId: string, path: string, preview = false): string {
  // Show only uploaded files and screenshots this person can read.
  const conversation = encodeURIComponent(conversationId);
  const encodedPath = encodeURIComponent(path);
  const previewQuery = preview ? '&preview=true' : '';
  return `/api/conversations/${conversation}/files/view?path=${encodedPath}${previewQuery}`;
}

export function shortTime(value: string): string {
  const date = new Date(value);
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export interface ScreenshotFacts {
  computerId: string;
  generation: number;
  capturedAt: string;
  width: number;
  height: number;
  size: number;
}

const UTC_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  timeZone: 'UTC', hourCycle: 'h23',
};

export function utcDateTime(iso: string): string {
  return `${new Date(iso).toLocaleString('en-GB', UTC_DATE_OPTIONS)} UTC`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function imageSize(width: number, height: number): string {
  return `${width} × ${height}`;
}

export function screenshotCaption(computerId: string): string {
  return `Screenshot of ${computerId}. No description of its contents is generated.`;
}

export function capturedByLine(
  createdBy: 'you' | 'participant' | 'assistant',
  facts: ScreenshotFacts,
  includeImageSize = true,
): string {
  if (createdBy !== 'you') return 'Captured by another participant';
  const capturedAt = utcDateTime(facts.capturedAt);
  if (!includeImageSize) return `Captured by you · ${capturedAt}`;
  return `Captured by you · ${capturedAt} · ${imageSize(facts.width, facts.height)}`;
}
import type { ChatAttachment, Turn } from './chat-state';
import type { ChatConversation } from '@opencrane/protocol';

export function isOwnedAgentFile(
  path: string, files: string[], selectedId: string,
  conversations: ChatConversation[], memberId: string,
): boolean {
  if (!files.includes(path)) return false;
  for (const conversation of conversations) {
    if (conversation.conversationId === selectedId) {
      return conversation.createdBy === memberId;
    }
  }
  return false;
}

export function screenshotIdFromFile(file: ChatAttachment): string {
  return file.fileId;
}

function screenshotWithId(fileId: string, file: ChatAttachment): boolean {
  return file.fileId === fileId;
}

export function hasTranscriptScreenshot(
  fileId: string,
  screenshots: ChatAttachment[],
  turns: Turn[],
): boolean {
  const screenshot = screenshots.find(screenshotWithId.bind(undefined, fileId));
  const screenshotPath = screenshot?.path ?? '';
  for (const turn of turns) {
    if (turn.files.includes(screenshotPath)) return true;
  }
  return false;
}

export function isScreenshotAttachment(file: ChatAttachment): boolean {
  return Boolean(file.screenshot);
}

export function screenshotFacts(file: ChatAttachment): ScreenshotFacts | undefined {
  if (!file.screenshot) return undefined;
  return { ...file.screenshot, size: file.size };
}

export function screenshotFactsForPath(
  path: string, attachments: ChatAttachment[],
): ScreenshotFacts | undefined {
  for (const file of attachments) {
    if (file.path === path) return screenshotFacts(file);
  }
  return undefined;
}

export function fileScreenshotCreator(
  path: string, attachments: ChatAttachment[], memberId: string,
): 'you' | 'participant' {
  for (const file of attachments) {
    if (file.path === path && file.uploadedBy === memberId) return 'you';
  }
  return 'participant';
}

export function hasScreenshotFile(files: string[], screenshots: ChatAttachment[]): boolean {
  for (const path of files) {
    for (const screenshot of screenshots) {
      if (screenshot.path === path) return true;
    }
  }
  return false;
}

export function displayTextParts(text: string): {
  text: string; kind: 'text' | 'bold' | 'citation' | 'a2ui';
}[] {
  const spaced = text.replace(/\s+(?=\[\d+\])/g, '\u00a0');
  const parts = spaced.split(/(\*\*[^*]+\*\*|\[\d+\]|```a2ui[\s\S]*?(?:```|$))/g);
  const visible = parts.filter(Boolean);
  return visible.map(describeDisplayPart);
}

function describeDisplayPart(part: string): {
  text: string; kind: 'text' | 'bold' | 'citation' | 'a2ui';
} {
  if (part.startsWith('```a2ui')) return { text: part, kind: 'a2ui' };
  if (part.startsWith('**')) return { text: part.slice(2, -2), kind: 'bold' };
  if (/^\[\d+\]$/.test(part)) return { text: part, kind: 'citation' };
  return { text: part, kind: 'text' };
}
