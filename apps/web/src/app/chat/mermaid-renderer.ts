let renderer: Promise<HTMLIFrameElement> | undefined;
let nextDiagramId = 0;
const renderTimeoutMs = 15_000;
const abortListenerOptions = { once: true };

function createRenderer(signal?: AbortSignal): Promise<HTMLIFrameElement> {
  const frame = document.createElement('iframe');
  frame.title = 'Diagram renderer';
  frame.className = 'oc-mermaid-renderer';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = new URL('mermaid-renderer.html', document.baseURI).href;

  function waitForReady(
    resolve: (frame: HTMLIFrameElement) => void, reject: (reason: Error) => void,
  ): void {
    function stopWaiting(): void {
      clearTimeout(timer);
      window.removeEventListener('message', receiveReady);
      signal?.removeEventListener('abort', cancelled);
    }
    function cancelled(): void {
      stopWaiting();
      frame.remove();
      reject(new Error('Diagram rendering cancelled'));
    }
    function timedOut(): void {
      stopWaiting();
      frame.remove();
      if (!signal) {
        renderer = undefined;
      }
      reject(new Error('Diagram renderer did not start'));
    }
    const timer = setTimeout(timedOut, renderTimeoutMs);
    function receiveReady(event: MessageEvent<unknown>): void {
      if (event.source !== frame.contentWindow || event.data !== 'mermaid-ready') {
        return;
      }
      stopWaiting();
      resolve(frame);
    }
    window.addEventListener('message', receiveReady);
    signal?.addEventListener('abort', cancelled, abortListenerOptions);
    document.body.append(frame);
  }
  return new Promise(waitForReady);
}

export async function renderMermaid(code: string, signal?: AbortSignal): Promise<{ svg: string }> {
  // Keep the library and its document absent until a complete diagram needs them.
  signal?.throwIfAborted();
  let pendingRenderer: Promise<HTMLIFrameElement>;
  if (signal) {
    // Destroy private library state with its document; leave ordinary diagrams alone.
    pendingRenderer = createRenderer(signal);
  } else {
    renderer ??= createRenderer();
    pendingRenderer = renderer;
  }
  const frame = await pendingRenderer;
  nextDiagramId += 1;
  const id = nextDiagramId;

  function waitForDiagram(
    resolve: (result: { svg: string }) => void, reject: (reason: Error) => void,
  ): void {
    function stopWaiting(): void {
      clearTimeout(timer);
      window.removeEventListener('message', receiveDiagram);
      signal?.removeEventListener('abort', cancelled);
    }
    function cancelled(): void {
      stopWaiting();
      reject(new Error('Diagram rendering cancelled'));
    }
    function timedOut(): void {
      stopWaiting();
      reject(new Error('Diagram rendering timed out'));
    }
    const timer = setTimeout(timedOut, renderTimeoutMs);
    function receiveDiagram(event: MessageEvent<unknown>): void {
      const result = event.data;
      if (event.source !== frame.contentWindow || typeof result !== 'object' || result === null
        || !('id' in result) || result.id !== id) {
        return;
      }
      stopWaiting();
      if ('svg' in result && typeof result.svg === 'string') {
        const diagram = { svg: result.svg };
        resolve(diagram);
      } else {
        reject(new Error('Diagram could not be drawn'));
      }
    }
    window.addEventListener('message', receiveDiagram);
    signal?.addEventListener('abort', cancelled, abortListenerOptions);
    // Use a wildcard because sandboxed documents have an opaque origin. Check the window on reply.
    const request = { id, code };
    frame.contentWindow?.postMessage(request, '*');
  }
  try {
    signal?.throwIfAborted();
    return await new Promise(waitForDiagram);
  } finally {
    if (signal) {
      frame.remove();
    }
  }
}
