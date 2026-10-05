import './csp';

// Load app code after Zod is set to avoid generated functions under the browser CSP.
import('./startup').catch((error) => console.error(error));
