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
  // The route only serves uploaded files and screenshots that the viewer can read.
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
): string {
  if (createdBy !== 'you') return 'Captured by another participant';
  return `Captured by you · ${utcDateTime(facts.capturedAt)} · ${imageSize(facts.width, facts.height)}`;
}
