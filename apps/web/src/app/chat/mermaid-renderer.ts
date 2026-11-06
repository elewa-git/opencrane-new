let renderer: Promise<HTMLIFrameElement> | undefined;
let nextDiagramId = 0;
const renderTimeoutMs = 15_000;
const abortListenerOptions = { once: true };

class DiagramRenderTimeout extends Error {}

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

async function sharedRenderer(): Promise<HTMLIFrameElement> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    renderer ??= createRenderer();
    const pendingRenderer = renderer;
    try {
      const frame = await pendingRenderer;
      if (frame.isConnected) {
        return frame;
      }
    } catch (error) {
      if (renderer === pendingRenderer) {
        renderer = undefined;
      }
      if (attempt === 1) {
        throw error;
      }
      continue;
    }
    // Discard the cached promise when the hidden document has been removed.
    if (renderer === pendingRenderer) {
      renderer = undefined;
    }
  }
  throw new Error('Diagram renderer was removed');
}

export async function renderMermaid(code: string, signal?: AbortSignal): Promise<{ svg: string }> {
  try {
    return await renderOnce(code, signal);
  } catch (error) {
    if (signal || !(error instanceof DiagramRenderTimeout)) {
      throw error;
    }
    // Give a valid reply one fresh renderer when the old document stops answering.
    return renderOnce(code);
  }
}

async function renderOnce(code: string, signal?: AbortSignal): Promise<{ svg: string }> {
  // Keep the library and its document absent until a complete diagram needs them.
  signal?.throwIfAborted();
  let frame: HTMLIFrameElement;
  if (signal) {
    // Destroy private library state with its document; leave ordinary diagrams alone.
    frame = await createRenderer(signal);
  } else {
    frame = await sharedRenderer();
  }
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
      if (!signal && frame.isConnected) {
        frame.remove();
        renderer = undefined;
      }
      reject(new DiagramRenderTimeout('Diagram rendering timed out'));
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
