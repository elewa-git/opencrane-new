import { createLogger } from '@opencrane/observability';
import { readFile } from 'node:fs/promises';
import { createScannerService } from '../clamav/service.mjs';
import { packagedScanner } from '../clamav/packaged.mjs';

const logger = createLogger('package-scanner');

async function main() {
  const settings = {
    manifestPath: '/run/scanner/signatures.json',
    releasePath: '/run/scanner/release.json',
    approvedSha: process.env.SCANNER_APPROVED_SHA,
    image: process.env.SCANNER_IMAGE,
    databaseDirectory: '/var/lib/clamav',
  };
  const scanner = await packagedScanner(settings);
  const trustBytes = await readFile('/run/scanner/trust.json', 'utf8');
  const trust = JSON.parse(trustBytes);
  const tls = {
    key: await readFile('/run/scanner/server.key'),
    cert: await readFile('/run/scanner/server.crt'),
  };
  const server = createScannerService({ scanner, tls, trust });
  function shutdown() {
    scanner.stop();
    server.closeAllConnections();
    server.close();
  }
  const remaining = Date.parse(scanner.databaseUpdatedAt) + 86400000 - Date.now();
  const timer = setTimeout(shutdown, Math.max(0, remaining));
  function closed() {
    clearTimeout(timer);
  }
  function listenFailed(cause) {
    failed(cause);
    shutdown();
  }
  server.once('close', closed);
  server.once('error', listenFailed);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(8443, '0.0.0.0');
}

function failed(cause) {
  const err = new Error('Packaged scanner unavailable', { cause });
  logger.error({ err, reason: 'scanner_unavailable' }, 'Packaged scanner unavailable');
  process.exitCode = 1;
}

main().catch(failed);
