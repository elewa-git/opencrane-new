import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { computerCredentials, type tokenIssuer } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { history } from '@opencrane/models';

/** Exercise the delivered credential and private computer proxy without invoking Codex or a paid provider. */
export async function modelJourney(store: EventStore, tokens: Awaited<ReturnType<typeof tokenIssuer>>, input: {
  silo: string; namespace: string; assistantId: string; computerId: string; conversationId: string; turnId: string; requesterId: string;
}) {
  const turn = await computerCredentials(store, tokens, input.silo).turn(input);
  const script = `
    const fs = require('node:fs'), http = require('node:http');
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', async () => {
      try {
        const grant = JSON.parse(data), computer = JSON.parse(fs.readFileSync('/run/codex/computer.json', 'utf8'));
        const send = (options, body) => new Promise((resolve, reject) => {
          const req = http.request(options, res => {
            let text = ''; res.on('data', c => text += c);
            res.on('end', () => resolve({ status: res.statusCode, text }));
          });
          req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('timeout')));
          req.end(JSON.stringify(body));
        });
        const installed = await send({ socketPath: '/run/codex/control.sock', path: '/grant', method: 'POST' },
          { thread: grant.conversationId, computer: computer.value, token: grant.turn.value, expires: grant.turn.expiresAt });
        if (installed.status !== 200) throw new Error('grant refused');
        const result = await send({ hostname: '127.0.0.1', port: 8080, path: '/v1/responses', method: 'POST', headers: {
          authorization: 'Bearer ' + fs.readFileSync('/home/codex/caller', 'utf8').trim(),
          'session-id': grant.conversationId, 'content-type': 'application/json' } },
          { model: 'gpt-5-nano', input: 'Stub journey', max_output_tokens: 128, stream: true });
        process.stdout.write(JSON.stringify({ status: result.status, completed: result.text.includes('response.completed') }));
      } catch { process.stderr.write('Computer model journey failed'); process.exitCode = 1; }
    });`;
  const child = spawn('kubectl', ['-n', input.namespace, 'exec', '-i', input.computerId, '--',
    'setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', 'node', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.resume();
  child.stdin.on('error', () => child.kill());
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    child.stdin.end(JSON.stringify({ turn, conversationId: input.conversationId }));
    assert.equal(await exited, 0, 'Computer model request completed');
    assert.deepEqual(JSON.parse(output), { status: 200, completed: true });
    const reservations = await history(store, `budget-${input.silo}`, input.silo);
    assert(reservations.some(({ event }) => event.type === 'budget.reserved' &&
      JSON.stringify(event.data).includes(input.turnId)), 'Gateway decision reserved this turn');
    console.log('PASS Ready computer → lifecycle turn credential → private proxy → gateway decision → stub response');
  } finally { clearTimeout(timeout); }
}
