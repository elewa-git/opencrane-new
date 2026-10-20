// Test-only faults surround the real NATS adapter; main.ts and the HTTP path stay unchanged.
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (process.env['TEST_CHILD_RECOVERY'] && url.endsWith('/chat/start.ts')) {
      return { ...loaded, source: 'export async function startBridges() { return async () => {}; }' };
    }
    if (process.env['TEST_CHILD_RECOVERY'] && url.endsWith('/chat/child-recovery.ts')) {
      if (!loaded.source) throw new Error('Expected recovery source');
      const original = typeof loaded.source === 'string'
        ? loaded.source : new TextDecoder().decode(loaded.source);
      const source = original.replace('export async function watchChildRequests(',
        'async function testWatchChildRequests(');
      return { ...loaded, source: source + `
        export async function watchChildRequests(options, logger, signal) {
          if (process.env['TEST_CHILD_RECOVERY'] === 'fail') {
            await delay(2000); throw new Error('Worker rejected');
          }
          await testWatchChildRequests(options, logger, signal);
          await delay(100);
          await options.db.query('SELECT 1');
          await options.store.head();
        }
      ` };
    }
    if (!url.endsWith('/libs/event-store/src/jetstream.ts') && !url.endsWith('/libs/observability/src/telemetry.ts')) return loaded;
    if (!loaded.source) throw new Error('Expected TypeScript source');
    const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
    if (url.endsWith('/telemetry.ts')) {
      const signature = 'export async function shutdownTelemetry(onError?: (err: unknown) => void): Promise<void> {';
      if (!source.includes(signature)) throw new Error('Telemetry hook no longer matches');
      return { ...loaded, source: source.replace(signature, `${signature}
        process.stdout.write(JSON.stringify({ msg: 'test telemetry close called' }) + '\\n');
        if (process.env['TEST_TELEMETRY'] === 'fail') throw new Error('injected telemetry failure');
      `) };
    }
    const close = 'close: () => connection.close()';
    const append = 'async append(command: AppendCommand): Promise<AppendResult> {';
    if (!source.includes(close) || !source.includes(append)) throw new Error('Fault hook no longer matches adapter');
    return { ...loaded, source: source.replace(close, `close: async () => {
      process.stdout.write(JSON.stringify({ msg: 'test NATS close called' }) + '\\n');
      if (process.env['TEST_CLOSE'] === 'fail') throw new Error('injected close failure');
      if (process.env['TEST_CLOSE'] === 'hang') await new Promise(() => {});
      await connection.close();
    }`).replace(append, `${append}
      if (process.env['TEST_APPEND_MS']) {
        process.stdout.write(JSON.stringify({ msg: 'test append started' }) + '\\n');
        await new Promise(resolve => setTimeout(resolve, Number(process.env['TEST_APPEND_MS'])));
      }
    `) };
  },
});
