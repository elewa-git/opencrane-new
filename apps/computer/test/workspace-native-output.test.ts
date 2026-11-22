import { expect, it } from 'vitest';
import { uploadComputer } from '../../server/test/support/upload-computer.ts';
import { nativeOutputProbe } from './support/native-output-probe.ts';

async function keepsNativeOutput(mode: string) {
  const computer = await uploadComputer();
  try {
    const output = await computer.exec('node', '--experimental-strip-types',
      '--input-type=module', '-e', nativeOutputProbe, mode);
    expect(JSON.parse(output)).toEqual({ exitCode: 0, text: 'Willow-47\n' });
  } finally {
    await computer.close();
  }
}

async function keepsOutputAfterEmptyRead() {
  await keepsNativeOutput('immediate');
}

async function keepsOutputWithDelayedReader() {
  await keepsNativeOutput('delayed');
}

it('keeps native executor output that arrives after an empty poll', keepsOutputAfterEmptyRead, 30_000);
it('keeps native output when the reader waits for another native poll',
  keepsOutputWithDelayedReader, 30_000);
