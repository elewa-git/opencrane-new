import { tokenIssuer } from '@opencrane/auth';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { until } from '@opencrane/authz/testing';
import { tcpProxy } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { approvalJourneyTool } from '../../../../infra/dev-stack/journey-tool-policy.ts';
import { z } from 'zod';
const exec = promisify(execFile);

/** Disposable runtime image with this branch's sources; no shared-stack Pods or credentials. */
export async function uploadComputer(deliverCredential = true, nodeOptions = '') {
  const capture = await mkdtemp(`${tmpdir()}/upload-requests-`);
  const stub = spawn(process.execPath, ['--experimental-strip-types', 'infra/dev-stack/model-stub.ts'],
    {
      env: {
        ...process.env,
        STUB_PORT: '0',
        MODEL_STUB_CAPTURE: `${capture}/requests.jsonl`,
        MODEL_STUB_MCP_GENERATION: randomUUID(),
        MODEL_STUB_MCP_REVISION: catalogueDigest([approvalJourneyTool()]),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  let output = ''; stub.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  let disk: string | undefined;
  let container: string | undefined, relay: Awaited<ReturnType<typeof tcpProxy>> | undefined;
  const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 120_000 })).stdout.trim();
  const close = async () => { if (container) await docker('rm', '-f', '-v', container); if (disk) await docker('volume', 'rm', disk); await relay?.close(); stub.kill(); await rm(capture, { recursive: true, force: true }); };
  try {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(`${capture}/key`, key.privateKey, { mode: 0o600 });
    async function issue(tokenId = `token:${randomUUID()}`, lifetime = 600) {
      const options = { privateKeyPath: `${capture}/key`, issuer: 'fixture',
        computerTtlSeconds: lifetime };
      const issuer = await tokenIssuer(options);
      const identity = { silo: 'test', computerId: 'computer',
        assistantId: 'assistant', generation: 1, tokenId };
      return issuer.computer(identity);
    }
    const credential = await issue('token:test');
    disk = await docker('volume', 'create', `upload-disk-${randomUUID()}`);
    await until(() => /Stub ready (\d+)/u.test(output));
    const gateway = await docker('network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}');
    relay = await tcpProxy(() => ({ host: '127.0.0.1', port: Number(/Stub ready (\d+)/u.exec(output)![1]) }), gateway);
    // Use the current image command while mounting the current source into the fixture image.
    const dockerfile = await readFile('apps/computer/Dockerfile', 'utf8');
    const commandLine = /^CMD (.+)$/mu.exec(dockerfile)?.[1];
    if (!commandLine) throw new Error('Computer image command missing');
    const command = z.array(z.string()).parse(JSON.parse(commandLine) as unknown);
    let url = '';
    const start = async () => {
      // Match the silo's capabilities; Docker's defaults include CAP_KILL.
      container = await docker('run', '-d', '--name', `upload-computer-${randomUUID()}`, '-p', '127.0.0.1::8081',
        '--cap-drop=ALL', '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE',
        '-v', `${disk}:/home/agent`, '-v', `${resolve('apps/computer/src')}:/app/src:ro`, '-e', 'POD_UID=fixture', '-e', `GATEWAY=http://${gateway}:${relay!.port}`, '-e', `NODE_OPTIONS=${nodeOptions}`,
        'ocn-upload-computer:test', ...command);
      const port = Number((await docker('port', container, '8081/tcp')).split(':')[1]);
      url = `http://127.0.0.1:${port}`;
    };
    await start();
    const ready = () => until(async () => { try { return (await fetch(`${url}/health`)).ok; } catch { return false; } }, 30_000);
    async function install(token: { value: string; id: string; expiresAt: number }, uid = 0) {
      const args = ['exec', '-i', '--user', String(uid), container!,
        '/usr/bin/env', '-u', 'NODE_OPTIONS', '/usr/local/bin/node', '--disable-sigusr1',
        '--experimental-strip-types', '/app/src/install-credential.ts'];
      const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'ignore'] });
      const exited = once(child, 'exit');
      child.stdin.on('error', ignoreClosedInput);
      child.stdin.end(JSON.stringify(token));
      const result: unknown[] = await exited;
      const code = result[0];
      if (code !== 0) throw new Error('Test credential refused');
    }
    const credentials = async () => {
      await ready();
      await install(credential);
    };
    await ready();
    if (deliverCredential) await credentials();
    return { get url() { return url; }, close, install, issue, credential, requests: () => readFile(`${capture}/requests.jsonl`, 'utf8'), async restart() { await docker('rm', '-f', '-v', container!); await start(); await credentials(); },
      exec: (...args: string[]) => docker('exec', container!, ...args),
      pause: () => docker('pause', container!), resume: () => docker('unpause', container!),
      read: (path: string) => docker('exec', container!, 'cat', path),
      write: (path: string, text: string) => docker('exec', '-u', '1001', container!, '/opt/python/bin/python', '-c', 'import pathlib,sys; path=pathlib.Path(sys.argv[1]); path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(sys.argv[2].encode())', path, text),
      mtime: (path: string) => docker('exec', container!, 'stat', '-c', '%Y', path) };
  } catch (error) { await close(); throw error; }
}

function ignoreClosedInput() {}
