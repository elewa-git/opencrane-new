// Tests for the AsyncAPI generator: the document it builds covers every
// event and stream in the registry, and the file already committed at
// docs/architecture/asyncapi.yaml is exactly what `npm run gen:asyncapi`
// would write today (the same check CI runs as `check:asyncapi`).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocument, renderDocument, subjectPattern, toComponentName } from '../gen-asyncapi.mjs';
import { eventRegistry } from '../../libs/events/src/registry.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('toComponentName', () => {
  it('turns a dotted, underscored event type into a camelCase identifier', () => {
    expect(toComponentName('member.joined')).toBe('memberJoined');
    expect(toComponentName('mcp.tool_list_changed')).toBe('mcpToolListChanged');
  });
});

describe('subjectPattern', () => {
  it('documents a single-field stream', () => {
    const memberJoined = eventRegistry.find((entry) => entry.type === 'member.joined');
    expect(memberJoined && subjectPattern(memberJoined)).toBe('member-<memberId>');
  });

  it('documents the composite connection stream', () => {
    const connectionCreated = eventRegistry.find((entry) => entry.type === 'connection.created');
    expect(connectionCreated && subjectPattern(connectionCreated)).toBe('connection-<userId>-<serverId>-<profile>');
  });

  it('documents a silo-keyed stream', () => {
    const orgCreated = eventRegistry.find((entry) => entry.type === 'org.created');
    expect(orgCreated && subjectPattern(orgCreated)).toBe('org-<silo>');
  });
});

describe('buildDocument', () => {
  it('has one message and one schema per event in the registry', () => {
    const document = buildDocument() as { components: { messages: Record<string, unknown>; schemas: Record<string, unknown> } };
    expect(Object.keys(document.components.messages)).toHaveLength(eventRegistry.length);
    expect(Object.keys(document.components.schemas)).toHaveLength(eventRegistry.length);
  });

  it('has one channel per distinct stream in the registry', () => {
    const document = buildDocument() as { channels: Record<string, unknown> };
    const expectedStreams = new Set(eventRegistry.map((entry) => entry.stream));
    expect(Object.keys(document.channels).sort()).toEqual([...expectedStreams].sort());
  });
});

describe('the committed docs/architecture/asyncapi.yaml', () => {
  it('matches what the generator builds from the registry right now', async () => {
    const committed = await readFile(path.join(repoRoot, 'docs/architecture/asyncapi.yaml'), 'utf8');
    expect(committed).toBe(renderDocument());
  });
});
