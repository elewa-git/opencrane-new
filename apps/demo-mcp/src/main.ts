import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createDemoServer } from './server.ts';

try {
  const port = z.coerce.number().int().min(1024).max(65535).parse(process.env['PORT'] ?? 18445);
  const certPath = process.env['TLS_CERT_PATH'];
  const keyPath = process.env['TLS_KEY_PATH'];
  let https;
  if (certPath !== undefined || keyPath !== undefined) {
    if (!certPath || !keyPath) {
      throw new Error('tls_paths_required');
    }
    https = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  }
  const server = createDemoServer(https);
  const host = https ? '0.0.0.0' : '127.0.0.1';
  await server.listen({ host, port });
  function stop() {
    void server.close().catch(stopFailed);
  }
  function stopFailed() {
    process.stderr.write('Demo server shutdown failed.\n');
    process.exitCode = 1;
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch {
  process.stderr.write('Demo server startup failed.\n');
  process.exitCode = 1;
}
