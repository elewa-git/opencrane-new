import { createStageBCollector } from './stage-b-collector.ts';
import { readStageBQuote } from './stage-b-readback.ts';

const output = process.argv[2]!;
const socket = process.argv[3]!;
const revision = process.argv[4]!;
const collector = createStageBCollector(output);
await readStageBQuote(collector, socket, revision, 'before');
process.send!('first readback received');
// Stay open without a final save, as a browser response can do during collection.
process.stdin.resume();
