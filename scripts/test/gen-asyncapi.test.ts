// Tests for the AsyncAPI generator: the document it builds covers every
// event and stream in the registry, and the file already committed at
// docs/architecture/asyncapi.yaml is exactly what `npm run gen:asyncapi`
// would write today (the same check CI runs as `check:asyncapi`).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildDocument, renderDocument, subjectPattern, toComponentName } from '../gen-asyncapi.mjs';
import { parseEventByType } from '../../libs/events/src/parse.ts';
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

interface GeneratedMessage {
  name: string;
  payload: { allOf: [{ $ref: string }, { properties: { type: { const: string }; data: { $ref: string } } }] };
  examples: [{ payload: unknown }];
}
interface GeneratedDocument {
  channels: Record<string, unknown>;
  components: {
    messages: Record<string, GeneratedMessage>;
    schemas: Record<string, { required?: string[] }>;
  };
}

describe('buildDocument', () => {
  const document = buildDocument() as unknown as GeneratedDocument;

  it('has one message and one data schema per event, plus the shared envelope schema', () => {
    expect(Object.keys(document.components.messages)).toHaveLength(eventRegistry.length);
    expect(Object.keys(document.components.schemas)).toHaveLength(eventRegistry.length + 1);
  });

  it('describes the whole envelope, not just data', () => {
    expect(document.components.schemas['EventEnvelope']?.required).toEqual(
      expect.arrayContaining(['id', 'type', 'source', 'time', 'subject', 'silo', 'data']),
    );
    for (const message of Object.values(document.components.messages)) {
      const [envelope, specifics] = message.payload.allOf;
      expect(envelope.$ref).toBe('#/components/schemas/EventEnvelope');
      expect(specifics.properties.type.const).toBe(message.name);
      expect(specifics.properties.data.$ref).toMatch(/^#\/components\/schemas\/\w+Data$/);
    }
  });

  it('gives every message an example that is a real, valid event on its own stream subject', () => {
    for (const message of Object.values(document.components.messages)) {
      const result = parseEventByType(message.examples[0].payload);
      expect(result.success, message.name).toBe(true);
    }
  });

  it('reads back unchanged with a YAML 1.1 reader (no timestamp turned into a date, no "yes" into a boolean)', () => {
    expect(parse(renderDocument(), { version: '1.1' })).toEqual(JSON.parse(JSON.stringify(document)));
  });

  it('has one channel per distinct stream in the registry', () => {
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
