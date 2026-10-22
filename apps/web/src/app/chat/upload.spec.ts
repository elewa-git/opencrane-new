import { sendUpload } from './upload';

let request: XMLHttpRequest;

afterEach(function restoreUploadFixture() {
  vi.restoreAllMocks();
});

function captureUpload() {
  function ignoreRequest() {}
  function captureRequest(this: XMLHttpRequest) {
    request = this;
  }
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(ignoreRequest);
  vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation(ignoreRequest);
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(captureRequest);
}

function acknowledgeUpload() {
  Object.defineProperty(request, 'status', { value: 201 });
  Object.defineProperty(request, 'responseText', { value: JSON.stringify({ fileId: 'file' }) });
  request.dispatchEvent(new Event('load'));
}

async function waitsForFileList() {
  captureUpload();
  let makeAvailable: (response: Response) => void = function unavailableResolver() {
    throw new Error('File-list fixture is not ready');
  };
  function captureResolver(resolve: (response: Response) => void) {
    makeAvailable = resolve;
  }
  const available = new Promise<Response>(captureResolver);
  let reads = 0;
  function readFiles() {
    reads += 1;
    if (reads === 1) {
      return Promise.resolve(new Response(JSON.stringify({ status: 'applying' }), { status: 425 }));
    }
    return available;
  }
  const fetcher = vi.spyOn(globalThis, 'fetch');
  fetcher.mockImplementation(readFiles);
  const file = new File(['Meeting at ten.'], 'notes.txt');
  function ignoreProgress() {}
  const upload = sendUpload('conversation', file, 'upload', ignoreProgress);
  let ready = false;
  function markReady() {
    ready = true;
  }
  void upload.completed.then(markReady);
  acknowledgeUpload();
  function expectRetry() {
    expect(reads).toBe(2);
  }
  await vi.waitFor(expectRetry);
  expect(ready).toBe(false);
  makeAvailable(new Response(JSON.stringify({ rows: [{ fileId: 'file' }] })));
  await expect(upload.completed).resolves.toBe('file');
  expect(fetcher).toHaveBeenCalledWith('/api/conversations/conversation/files',
    expect.objectContaining({ signal: expect.any(AbortSignal) }));
}
it('keeps an acknowledged upload pending until the file list finishes applying', waitsForFileList);

async function cancelsFileListRetry() {
  captureUpload();
  function applyingFiles() {
    return Promise.resolve(new Response('{}', { status: 425 }));
  }
  const fetcher = vi.spyOn(globalThis, 'fetch');
  fetcher.mockImplementation(applyingFiles);
  function ignoreProgress() {}
  const file = new File(['Meeting at ten.'], 'notes.txt');
  const upload = sendUpload('conversation', file, 'upload', ignoreProgress);
  const rejected = expect(upload.completed).rejects.toThrow('Upload acknowledgement unavailable');
  acknowledgeUpload();
  function expectFirstRead() {
    expect(fetcher).toHaveBeenCalledOnce();
  }
  await vi.waitFor(expectFirstRead);
  upload.abort();
  await rejected;
  expect(fetcher).toHaveBeenCalledOnce();
}
it('cancels file-list retries when an acknowledged upload is aborted', cancelsFileListRetry);

async function refusesFileList() {
  captureUpload();
  function refusedFiles() {
    return Promise.resolve(new Response('{}', { status: 403 }));
  }
  const fetcher = vi.spyOn(globalThis, 'fetch');
  fetcher.mockImplementation(refusedFiles);
  function ignoreProgress() {}
  const file = new File(['Meeting at ten.'], 'notes.txt');
  const upload = sendUpload('conversation', file, 'upload', ignoreProgress);
  acknowledgeUpload();
  await expect(upload.completed).rejects.toThrow('Upload acknowledgement unavailable');
  expect(fetcher).toHaveBeenCalledOnce();
}
it('does not retry a refused file-list read or mark its upload ready', refusesFileList);
