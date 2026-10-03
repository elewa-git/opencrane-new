import { config } from 'zod';

// Run before schema imports: strict CSP forbids optional validator code generation.
config({ jitless: true });
