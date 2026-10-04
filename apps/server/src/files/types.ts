import { Worker } from 'node:worker_threads';

/** Keep untrusted parsers off the server event loop and bound their CPU time and heap. */
export function inspectFile(name: string, bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./types-worker.ts', import.meta.url), {
      workerData: { name, bytes }, execArgv: ['--experimental-strip-types'],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let finished = false;
    // Loading parser modules is separate from the deadline for inspecting untrusted bytes.
    let timer = setTimeout(() => finish(new Error('File inspection timed out or exceeded limits')), 5000);
    function finish(result: string | Error) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (result instanceof Error && !['Unsupported file type', 'Unsafe Office document', 'Invalid Office document',
        'File inspection timed out or exceeded limits', 'File inspection failed or exceeded limits', 'File inspection failed'].includes(result.message)) {
        result = new Error('File inspection failed', { cause: result });
      }
      void worker.terminate().then(() => {
        if (result instanceof Error) reject(result); else resolve(result);
      }).catch((error: unknown) => reject(new Error('File inspection failed', { cause: error })));
    }
    worker.on('message', (result: unknown) => {
      if (result === 'ready') {
        clearTimeout(timer); timer = setTimeout(() => finish(new Error('File inspection timed out or exceeded limits')), 1500);
      } else finish(typeof result === 'string' || result instanceof Error ? result : new Error('File inspection failed'));
    });
    worker.once('error', error => finish(new Error('File inspection failed or exceeded limits', { cause: error })));
    worker.once('exit', () => finish(new Error('File inspection failed')));
  });
}
