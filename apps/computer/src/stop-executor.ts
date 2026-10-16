import { readFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { record } from './http.ts';

async function boundedJson(stream: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Stop unavailable');
    size += chunk.length;
    if (size > 16_384) throw new Error('Stop unavailable');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return JSON.parse(bytes.toString()) as unknown;
}

async function stop() {
  if (process.getuid?.() !== 0) throw new Error('Root required');
  const input = record(await boundedJson(process.stdin));
  const saved = readFileSync('/run/executor/credentials/computer.json', 'utf8');
  const identity = record(JSON.parse(saved) as unknown);
  if (input['computerId'] !== identity['computer']
    || input['generation'] !== identity['generation']
    || input['podUid'] !== identity['podUid'] || input['podUid'] !== process.env['POD_UID']) {
    throw new Error('Stop unavailable');
  }
  const binding = { generation: input['generation'], podUid: input['podUid'],
    takeoverId: input['takeoverId'], affectedTurnIds: input['affectedTurnIds'] };
  function send(resolve: (value: unknown) => void, reject: (error: Error) => void) {
    function receive(response: IncomingMessage) {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Stop unavailable'));
        return;
      }
      void boundedJson(response).then(resolve, reject);
    }
    const options = { socketPath: '/run/executor/supervisor/control.sock',
      path: '/stop', method: 'POST' };
    const outgoing = request(options, receive);
    function failed() { reject(new Error('Stop unavailable')); }
    outgoing.on('error', failed);
    outgoing.end(JSON.stringify(binding));
  }
  const receipt = await new Promise(send);
  process.stdout.write(JSON.stringify(receipt));
}

function unavailable() {
  process.stderr.write('Stop unavailable\n');
  process.exitCode = 1;
}
function timedOut() { process.exit(1); }
const timer = setTimeout(timedOut, 12_000);
function finished() { clearTimeout(timer); }
void stop().catch(unavailable).finally(finished);
