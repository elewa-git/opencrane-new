import { runJourney } from './journey.ts';

const chunks = [];
let size = 0;
let finished = false;
function finish(result) {
  if (finished) {
    return;
  }
  finished = true;
  process.stdin.destroy();
  process.stdout.end(`${JSON.stringify(result)}\n`, exit);
}
function exit() {
  process.exit(1);
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
function ended() {
  const bytes = Buffer.concat(chunks);
  const input = bytes.toString('utf8');
  const result = runJourney(input);
  finish(result);
}

process.stdout.on('error', exit);
if (process.argv.length !== 2) {
  refuse();
} else {
  process.stdin.on('data', receive);
  process.stdin.on('end', ended);
  process.stdin.on('error', refuse);
}
