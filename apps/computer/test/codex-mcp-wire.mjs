// Check the packaged config and proxy with local fixtures and no external model.
process.argv.push('--wire');
await import('./codex-mcp-resume.mjs');
