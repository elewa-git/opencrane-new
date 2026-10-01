import type { FastifyInstance } from 'fastify';
import type { WebSocketServer } from 'ws';
import { shutdownTelemetry } from '@opencrane/observability';

export function installShutdown(app: FastifyInstance, sockets: WebSocketServer, graceMs: number, closeResources: () => Promise<void>) {
  let closing = false;
  let timedOut = false;
  // A request can become idle after close() has already swept keep-alive sockets.
  app.server.on('request', (_request, response) => {
    response.once('finish', () => {
      if (closing) setImmediate(() => app.server.closeIdleConnections());
    });
  });
  let cleanup: Promise<PromiseSettledResult<void>[]> | undefined;
  const clean = () => cleanup ??= Promise.allSettled([
    closeResources(),
    shutdownTelemetry((error) => { throw new Error('Telemetry shutdown failed', { cause: error }); }),
  ]);
  const stop = () => {
    if (closing) process.exit(1);
    closing = true;
    app.log.info('server shutdown started');
    // No cleanup reserve: a request gets the entire advertised grace period.
    const deadline = setTimeout(() => {
      timedOut = true;
      app.log.error('server shutdown timed out');
      app.server.closeAllConnections();
      for (const socket of sockets.clients) socket.terminate();
      // Invoke each closer even if HTTP never drained. A stuck closer cannot hold the process open.
      void clean();
      setImmediate(() => process.exit(1));
    }, graceMs);
    for (const socket of sockets.clients) socket.close(1001, 'server shutting down');
    const websocketClosed = new Promise<void>((resolve, reject) => {
      sockets.close((error) => error ? reject(error) : resolve());
    });
    const httpClosed = app.close();
    app.server.closeIdleConnections();
    void Promise.allSettled([httpClosed, websocketClosed]).then(async (results) => {
      const resources = await clean();
      clearTimeout(deadline);
      // allSettled above keeps cleanup running even when one close fails.
      const failed = timedOut || results.some((result) => result.status === 'rejected')
        || resources.some((result) => result.status === 'rejected');
      if (failed) app.log.error('server shutdown failed');
      process.exit(failed ? 1 : 0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
