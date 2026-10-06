import { config } from 'zod';

// Set this before importing schemas because the browser blocks generated validator code.
config({ jitless: true });
