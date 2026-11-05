import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import { mock } from 'node:test';
import { issueCertificate } from '../../libs/event-store/test/certificates.ts';

export const backupHostname = 'backup-store.opencrane-package-1.svc';
const connect = tls.connect;
export const attempts: tls.TLSSocket[] = [];

export function mapServiceDNS() {
  function lookup(_hostname: string, _options: unknown,
    callback: (error: null, addresses: Array<{ address: string; family: number }>) => void) {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  }
  function mapped(options: tls.ConnectionOptions) {
    assert.equal(options.host, backupHostname);
    assert.equal(options.servername, backupHostname);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.checkServerIdentity, undefined);
    const mappedOptions = { ...options, lookup };
    const socket = connect(mappedOptions);
    attempts.push(socket);
    return socket;
  }
  mock.method(tls, 'connect', mapped);
}

export async function datedLeaf(directory: string, name: string, year: number) {
  const extensions = `subjectAltName=DNS:${backupHostname}\nextendedKeyUsage=serverAuth\n`;
  await issueCertificate(directory, name, '/CN=fixture', extensions);
  const config = `[ca]
default_ca = fixture
[fixture]
database = ${name}.index
serial = ${name}.serial
new_certs_dir = .
certificate = ca.crt
private_key = ca.key
default_md = sha256
policy = subject
[subject]
commonName = supplied
`;
  await writeFile(`${directory}/${name}.conf`, config);
  await writeFile(`${directory}/${name}.index`, '');
  await writeFile(`${directory}/${name}.serial`, '01\n');
  const args = ['ca', '-batch', '-notext', '-config', `${name}.conf`,
    '-in', `${name}.csr`, '-out', `${name}.crt`, '-extfile', `${name}.ext`,
    '-startdate', `${year}0101000000Z`, '-enddate', `${year}0102000000Z`];
  const options = { cwd: directory };
  const result = spawnSync('openssl', args, options);
  assert.equal(result.status, 0);
}

export async function peer(directory: string, name = 'matching', onHello?: () => void) {
  const sockets = new Set<net.Socket>();
  const received: Buffer[] = [];
  function data(bytes: Buffer) {
    received.push(bytes);
  }
  function connected(socket: net.Socket) {
    sockets.add(socket);
  }
  function secure(socket: tls.TLSSocket) {
    socket.on('data', data);
  }
  function hello(_name: string, callback: (error: null, context: tls.SecureContext) => void) {
    onHello?.();
    callback(null, context);
  }
  let server: net.Server;
  let context: tls.SecureContext;
  if (name === 'stalled' || name === 'plaintext') {
    server = net.createServer();
    function plain(socket: net.Socket) {
      socket.resume();
      if (name === 'plaintext') {
        socket.end('HTTP/1.1 200 OK\r\n\r\n');
      }
      onHello?.();
    }
    server.on('connection', plain);
  } else {
    const cert = await readFile(`${directory}/${name}.crt`);
    const key = await readFile(`${directory}/${name}.key`);
    const options = { cert, key, SNICallback: hello };
    context = tls.createSecureContext(options);
    server = tls.createServer(options, secure);
  }
  server.on('connection', connected);
  function listen(resolve: () => void) {
    server.listen(0, '127.0.0.1', resolve);
  }
  await new Promise<void>(listen);
  const port = (server.address() as net.AddressInfo).port;
  async function close() {
    for (const socket of sockets) {
      socket.destroy();
    }
    function closed(resolve: () => void) {
      server.close(resolve);
    }
    await new Promise<void>(closed);
  }
  return { port, close, received };
}
