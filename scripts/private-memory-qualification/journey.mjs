import { runJourney } from './journey.ts';

const chunks = [];
let size = 0;
let finished = false;
function finish(result) {
  if (finished) {
    return;
  }
  finished = true;
  process.exitCode = result.result === 'FAIL' ? 1 : 0;
  process.stdin.destroy();
  process.stdout.end(`${JSON.stringify(result)}\n`, exit);
}
function exit() {
  process.exit(process.exitCode ?? 1);
}
function refuse() {
  const result = { result: 'FAIL', reason: 'input_invalid' };
  finish(result);
}
function receive(chunk) {
  size += chunk.length;
  if (size > 4096) {
    refuse();
    return;
  }
  chunks.push(chunk);
}
async function ended() {
  const bytes = Buffer.concat(chunks);
  const input = bytes.toString('utf8');
  const result = await runJourney(input);
  finish(result);
}

function endedInput() {
  ended().catch(refuse);
}
process.stdout.on('error', exit);
if (process.argv.length !== 2) {
  refuse();
} else {
  process.stdin.on('data', receive);
  process.stdin.on('end', endedInput);
  process.stdin.on('error', refuse);
}
