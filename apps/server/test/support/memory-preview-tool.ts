import { losslessJson } from '@opencrane/events/lossless-json';

export function previewRecallTool() {
  const definition = losslessJson('{"name":"recall","inputSchema":{"type":"object"}}');
  return { name: 'recall', revision: definition.digest, definition: definition.canonical,
    reviewed: true, costCents: 0,
    review: { action: 'Recall saved memory', consequence: 'Return facts to the requester',
      targetArgument: 'scopeId', fields: ['scopeId'], stepUp: false } };
}
