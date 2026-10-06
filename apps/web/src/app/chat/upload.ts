import { z } from 'zod';
/** Keep the file and request key for a retry until the server confirms the upload. */
export function sendUpload(conversation: string, file: File, key: string, progress: (percent: number) => void) {
  const xhr = new XMLHttpRequest();
  const completed = new Promise<string>((resolve, reject) => {
    xhr.open('POST', `/api/conversations/${encodeURIComponent(conversation)}/files`);
    xhr.timeout = 120_000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', file.name);
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => {
      if (xhr.status === 201) {
        try { resolve(z.object({ fileId: z.string() }).parse(JSON.parse(xhr.responseText) as unknown).fileId); }
        catch { reject(new Error('Upload acknowledgement unavailable. Retry.')); }
      }
      else reject(new Error(({ 400: 'Invalid filename or empty file.', 413: 'File too large. Maximum size is 20 MiB.',
        415: 'File type is unsupported or does not match its contents.', 422: 'File refused: malware detected.',
        401: 'Sign in to upload files.', 403: 'You cannot attach files to this session.' } as Record<number, string>)[xhr.status] ?? 'Upload unavailable. Retry when the connection returns.'));
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('Upload unavailable. Retry when the connection returns.'));
    xhr.send(file);
  });
  return { completed, abort: () => xhr.abort() };
}
