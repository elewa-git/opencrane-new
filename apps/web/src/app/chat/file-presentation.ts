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
