import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { resolve } from 'node:path';
import { until } from '@opencrane/authz/testing';

/** A fresh Kasm desktop in an ordinary disposable container on the existing daemon. */
export async function screenshotDesktop() {
  const exec = promisify(execFile), name = `screenshot-desktop-${randomUUID()}`;
  const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 120_000, maxBuffer: 2_000_000 })).stdout.trim();
  await docker('run', '-d', '--name', name, '--cap-drop=ALL', '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE',
    '-e', 'POD_UID=screenshot-fixture', '-v', `${resolve('apps/computer/src/desktop.ts')}:/app/src/desktop.ts:ro`,
    '--entrypoint', '/bin/sh', 'ocn-upload-computer:test', '-c', 'chown 1002:1002 /home/desktop; exec node --experimental-strip-types /app/src/desktop.ts');
  const close = () => docker('rm', '-f', '-v', name).then(() => undefined);
  try {
    await until(async () => { try { await docker('exec', name, 'node', '-e', "fetch('http://127.0.0.1:6901').then(()=>{},()=>process.exit(1))"); return true; } catch { return false; } }, 30_000);
    await docker('exec', name, 'sh', '-c', 'DISPLAY=:1 xmessage -geometry 600x250+80+100 "OpenCrane screenshot proof" >/dev/null 2>&1 &');
    const open = () => {
      // Same viewer credential and local WebSocket as the namespace desktop proxy.
      const child = spawn('docker', ['exec', '-i', name, 'node', '--input-type=module', '-e', `
        import {readFileSync} from 'node:fs';
        import WebSocket, {createWebSocketStream} from '/app/node_modules/ws/wrapper.mjs';
        process.setgroups([]);process.setgid(1002);process.setuid(1002);
        const {viewer}=JSON.parse(readFileSync('/home/desktop/credentials.json','utf8'));
        const ws=new WebSocket('ws://127.0.0.1:6901/websockify','binary',{origin:'http://opencrane.local',headers:{authorization:'Basic '+Buffer.from('viewer:'+viewer).toString('base64')},perMessageDeflate:false,maxPayload:4194304});
        const stream=createWebSocketStream(ws);stream.on('error',()=>process.exit(1));ws.on('close',()=>process.exit(0));
        process.stdin.pipe(stream).pipe(process.stdout);process.stdin.on('end',()=>ws.terminate());
      `], { stdio: ['pipe', 'pipe', 'ignore'] });
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
      child.on('error', () => stream.destroy(new Error('Desktop unavailable'))); child.on('exit', () => stream.destroy());
      child.stdin.on('error', () => stream.destroy()); stream.on('error', () => child.kill()); stream.on('close', () => child.kill());
      return Promise.resolve(stream);
    };
    return { open, close, image: await docker('image', 'inspect', 'ocn-upload-computer:test', '--format', '{{.Id}}') };
  } catch (error) { await close(); throw error; }
}
