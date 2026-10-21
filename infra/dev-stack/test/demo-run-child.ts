import * as runner from '../demo-smoke-run.ts';
import { browserRecording } from './demo-browser-recording.ts';

const options = JSON.parse(process.env['DEMO_OPTIONS']!);
const output = process.env['DEMO_OUTPUT']!;
const browser = browserRecording(process.env['DEMO_INTERRUPT'] === '1');
try {
  await runner.runDemoSmoke(browser, options, 700, output, 'fixture-sha');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
