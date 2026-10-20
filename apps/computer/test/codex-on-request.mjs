// Capture native requests with the packaged config and a local model only.
process.argv.push('--on-request');
await import('./codex-mcp-resume.mjs');
