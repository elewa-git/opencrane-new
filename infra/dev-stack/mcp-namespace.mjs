export function mcpNamespace(value) {
  if (typeof value !== 'string' || value.length > 63 ||
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?-mcp$/.test(value)) {
    throw new Error('Expected MCP namespace');
  }
  return value;
}
