import { expect, it } from 'vitest';
import { uploadComputer } from '../../server/test/support/upload-computer.ts';

async function keepsDelayedNativeOutput() {
  const computer = await uploadComputer();
  try {
    const script = `
import { workspaceProcess } from '/app/src/files.ts';
process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
// Emit after the executor's first one-second output poll has finished.
const program = 'import time; time.sleep(1.5); print("Willow-47")';
const result = await workspaceProcess(['/opt/python/bin/python', '-c', program], Buffer.alloc(0));
process.stdout.write(JSON.stringify({ exitCode: result.exitCode, text: result.output.toString() }));
`;
    const output = await computer.exec('node', '--experimental-strip-types',
      '--input-type=module', '-e', script);
    expect(JSON.parse(output)).toEqual({ exitCode: 0, text: 'Willow-47\n' });
  } finally {
    await computer.close();
  }
}

it('keeps native executor output that arrives after an empty poll', keepsDelayedNativeOutput, 30_000);
