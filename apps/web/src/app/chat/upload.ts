import { z } from 'zod';
import { fileRefusalWords } from './file-refusal-words.ts';
import { fetchConversationRead } from './direct-chat-api';

const uploadReceipt = z.object({ fileId: z.string() });
const uploadRefusals: Record<number, string> = {
  400: 'Invalid filename or empty file.',
  413: 'File too large. Maximum size is 20 MiB.',
  415: 'File type is unsupported or does not match its contents.',
  422: 'File refused: malware detected.',
  401: 'Sign in to upload files.',
  403: 'You cannot attach files to this session.',
};
const unavailable = 'Upload unavailable. Retry when the connection returns.';

const refusalDetails = z.object({ reason: z.string() });

function uploadRefusal(xhr: XMLHttpRequest) {
  const fallback = uploadRefusals[xhr.status] ?? unavailable;
  if (xhr.status !== 400 && xhr.status !== 415) return fallback;
  try {
    const details = refusalDetails.parse(JSON.parse(xhr.responseText) as unknown);
    return fileRefusalWords(details.reason, fallback);
  } catch {
    return fallback;
  }
}

/** Keep the file and request key for a retry until the server confirms the upload. */
export function sendUpload(conversation: string, file: File, key: string,
  progress: (percent: number) => void) {
  const xhr = new XMLHttpRequest();
  const applying = new AbortController();
  const url = `/api/conversations/${encodeURIComponent(conversation)}/files`;
  const completed = new Promise<string>(startUpload);

  function startUpload(resolve: (fileId: string) => void, reject: (error: Error) => void) {
    function reportProgress(event: ProgressEvent) {
      if (event.lengthComputable) {
        progress(Math.round(event.loaded / event.total * 100));
      }
    }
    async function confirmUpload() {
      try {
        const saved = uploadReceipt.parse(JSON.parse(xhr.responseText) as unknown);
        // Keep Ready pending until the saved upload can appear in the file list.
        const response = await fetchConversationRead(url, { signal: applying.signal });
        await response.body?.cancel();
        applying.signal.throwIfAborted();
        if (!response.ok) throw new Error('File list unavailable');
        resolve(saved.fileId);
      } catch {
        reject(new Error('Upload acknowledgement unavailable. Retry.'));
      }
    }
    function receiveUpload() {
      if (xhr.status === 201) {
        void confirmUpload();
        return;
      }
      const refusal = uploadRefusal(xhr);
      reject(new Error(refusal));
    }
    function failUpload() {
      reject(new Error(unavailable));
    }
    xhr.open('POST', url);
    xhr.timeout = 120_000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', file.name);
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.upload.onprogress = reportProgress;
    xhr.onload = receiveUpload;
    xhr.onerror = failUpload;
    xhr.ontimeout = failUpload;
    xhr.onabort = failUpload;
    xhr.send(file);
  }
  function abort() {
    applying.abort();
    xhr.abort();
  }
  return { completed, abort };
}
