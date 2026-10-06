import './csp';

// Set Zod before loading the app because the browser blocks generated functions.
import('./startup').catch((error) => console.error(error));
