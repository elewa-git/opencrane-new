import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('binds a fresh listener even when the port picked by the CLI is already occupied', async () => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  try {
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('No occupied port');
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--experimental-strip-types', '--import', new URL('./support/ephemeral-ports.ts', import.meta.url).href,
      '--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import { createServer } from 'node:http';
        import { once } from 'node:events';
        const occupied = Number(process.argv[1]);
        for (const option of [occupied, { port: occupied, host: '127.0.0.1' }]) {
          const server = createServer();
          server.listen(option);
          await once(server, 'listening');
          const address = server.address();
          assert(address && typeof address !== 'string');
          assert(address.port > 0 && address.port !== occupied);
          await new Promise(resolve => server.close(resolve));
        }
        console.log('listeners bound');
      `, String(address.port),
    ]);
    expect(stdout.trim()).toBe('listeners bound');
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});
