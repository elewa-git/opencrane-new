import { jobsCommand } from './jobs.ts';

const command = process.argv[2];
if (command === 'jobs') {
  await jobsCommand(process.argv.slice(3));
} else if (command === 'upgrade-handlers') {
  await import('./upgrade-handlers.ts');
} else {
  throw new Error('Usage: npm run ops -- upgrade-handlers [options] | jobs [--cancel <id>]');
}
