import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const kubectl = String.raw`#!/usr/bin/env node
import { createServer } from 'node:http';

if (!process.argv.includes('proxy')) {
  process.stdout.write('{"items":[]}');
} else {
  function emptyResources(_request, response) {
    response.setHeader('content-type', 'application/json');
    response.end('{"items":[]}');
  }
  const server = createServer(emptyResources);
  function listening() {
    const address = server.address();
    process.stdout.write('Starting to serve on 127.0.0.1:' + address.port + '\n');
  }
  function stop() { server.close(); }
  process.once('SIGTERM', stop);
  server.listen(0, '127.0.0.1', listening);
}
`;

/** Run the real bridge watcher against an empty Kubernetes service in process fixtures. */
export async function bridgeProcessSettings(directory: string): Promise<NodeJS.ProcessEnv> {
  const bin = join(directory, 'bridge-bin');
  await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, 'kubectl'), kubectl, { mode: 0o700 });
  const options = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
  const pair = generateKeyPairSync('ec', options);
  const key = join(directory, 'bridge-signing.pem');
  await writeFile(key, pair.privateKey, { mode: 0o600 });
  return { KUBECONFIG: '/unused-test-kubeconfig', KUBE_NAMESPACE: 'fixture',
    TOKEN_SIGNING_KEY_FILE: key, TOKEN_ISSUER: 'https://bridge.test/',
    PATH: `${bin}:${process.env['PATH']}` };
}
