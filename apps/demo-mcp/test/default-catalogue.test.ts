import { expect, it } from 'vitest';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { catalogue } from '../src/tools.ts';

function retainsDefaultCatalogue() {
  const tools = [];
  for (const tool of catalogue.tools) {
    tools.push({ name: tool.name, revision: losslessJson(JSON.stringify(tool)).digest });
  }
  expect(catalogueDigest(tools))
    .toBe('51d3cf7b1be76c944cef472f37073c06abd87d0f22c47e509023df8019e1cb7d');
}
it('retains the credential-free catalogue digest from before the personal-key mode',
  retainsDefaultCatalogue);
