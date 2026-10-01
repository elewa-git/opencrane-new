import { record as asRecord } from './record.ts';
// toolset.changed (owner decision 9): an admin published a computer profile
// whose tools differ, either a new computer image or changed Codex built-in tool
// settings. It is about the computer's own tools; a registered MCP server's tools
// are mcp.tools_changed. Every negative test starts from the registry's valid
// example and changes one field, so it passes only if the schema refuses that field.
import { describe, expect, it } from 'vitest';
import { getEventDefinition } from '../src/registry.ts';
import { parseEventByType } from '../src/parse.ts';

const found = getEventDefinition('toolset.changed');
if (!found) {
  throw new Error('toolset.changed is not in the registry');
}
const { dataSchema, stream } = found;
const example = asRecord(found.example);
const hex = '0123456789abcdef'.repeat(4);
const settings = (...tools: Array<[tool: string, enabled: boolean]>) => tools.map(([tool, enabled]) => ({ tool, enabled }));

/** The names of the fields the schema rejected when `patch` is applied to the valid example, or [] if it accepted it. */
function rejectedFields(patch: Record<string, unknown>): string[] {
  expect(dataSchema.safeParse(example).success).toBe(true); // so any failure below is the patch's
  const result = dataSchema.safeParse({ ...example, ...patch });
  if (result.success) {
    return [];
  }
  const names = result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : [String(issue.path[0])],
  );
  return [...new Set(names)].sort();
}

describe('toolset.changed', () => {
  it('goes on the profile stream, so one admin command is one append for every computer using it', () => {
    expect(stream).toBe('toolset');
  });

  it('parses through parseEventByType as a whole event', () => {
    const result = parseEventByType({
      id: 'evt_1',
      type: 'toolset.changed',
      source: 'opencrane-server',
      time: '2026-10-01T10:00:00.000Z',
      subject: 'toolset-profile_default',
      silo: 'acme',
      data: example,
    });
    expect(result.success).toBe(true);
  });

  it('carries the whole profile: its id, image, Codex version, built-in tool settings, inventory and publisher', () => {
    expect(Object.keys(example).sort()).toEqual(
      ['builtInTools', 'codexVersion', 'imageDigest', 'inventoryDigest', 'profileId', 'publishedBy'].sort(),
    );
  });

  it.each(['profileId', 'imageDigest', 'codexVersion', 'builtInTools', 'inventoryDigest', 'publishedBy'])(
    'refuses a profile with no %s',
    (field) => {
      expect(rejectedFields({ [field]: undefined })).toEqual([field]);
    },
  );

  it.each(['profileId', 'publishedBy'])('refuses an empty %s', (field) => {
    expect(rejectedFields({ [field]: '' })).toEqual([field]);
  });

  describe('imageDigest', () => {
    it.each([`sha256:${hex}`, `sha256:${'ab'.repeat(32)}`])('accepts %j', (imageDigest) => {
      expect(rejectedFields({ imageDigest })).toEqual([]);
    });

    it.each([
      'ghcr.io/elewa-git/computer:latest', // a tag can be moved to other contents
      hex, // no algorithm prefix
      `sha256:${hex.slice(1)}`, // one character short
      `sha256:${hex.toUpperCase()}`,
      `sha512:${hex}`,
      `ghcr.io/elewa-git/computer@sha256:${hex}`, // a full image reference, not a digest
      `sha256:${hex}\n`,
      ` sha256:${hex}`,
      'sha256:',
    ])('rejects %j', (imageDigest) => {
      expect(rejectedFields({ imageDigest })).toEqual(['imageDigest']);
    });
  });

  describe('inventoryDigest', () => {
    it('accepts a sha-256 hex digest', () => {
      expect(rejectedFields({ inventoryDigest: 'ab'.repeat(32) })).toEqual([]);
    });

    it.each(['not-a-digest', hex.toUpperCase(), hex.slice(1), `sha256:${hex}`, ''])('rejects %j', (inventoryDigest) => {
      expect(rejectedFields({ inventoryDigest })).toEqual(['inventoryDigest']);
    });
  });

  describe('codexVersion', () => {
    it.each(['0.46.0', '1.0.0', '10.20.30', '0.47.0-alpha.3'])('accepts %j', (codexVersion) => {
      expect(rejectedFields({ codexVersion })).toEqual([]);
    });

    it.each(['latest', '0.46', 'v0.46.0', 'rust-v0.46.0', '0.46.0 ', '0.46.0\n', '0.46.0-', '0.46.0-a b', '', `1.0.0-${'a'.repeat(64)}`])(
      'rejects %j',
      (codexVersion) => {
        expect(rejectedFields({ codexVersion })).toEqual(['codexVersion']);
      },
    );
  });

  describe('builtInTools', () => {
    it('accepts each Codex built-in tool, on or off, in any order', () => {
      const all = settings(
        ['view_image', true],
        ['spawn_agent', false],
        ['shell', true],
        ['web_search', false],
        ['apply_patch', true],
      );
      expect(rejectedFields({ builtInTools: all })).toEqual([]);
    });

    it('accepts a profile that states only some of the tools', () => {
      expect(rejectedFields({ builtInTools: settings(['shell', false]) })).toEqual([]);
    });

    it.each<[why: string, builtInTools: unknown]>([
      ['an empty list', []],
      ['not a list', { shell: true }],
      ['a tool Codex does not have in this list', settings(['curl', true])],
      ['a tool name in the wrong case', settings(['Shell', true])],
      ['the same tool twice, on and off', settings(['shell', true], ['shell', false])],
      ['the same tool twice, both on', settings(['web_search', true], ['web_search', true])],
      ['an enabled flag that is not a boolean', [{ tool: 'shell', enabled: 'yes' }]],
      ['an entry with no enabled flag', [{ tool: 'shell' }]],
      ['an entry with no tool', [{ enabled: true }]],
      ['a bare tool name instead of a setting', ['shell']],
    ])('rejects %s', (_why, builtInTools) => {
      expect(rejectedFields({ builtInTools })).toEqual(['builtInTools']);
    });
  });

  it('refuses an extra field on a built-in tool setting, so an argument list cannot ride along', () => {
    const builtInTools = [{ tool: 'shell', enabled: true, args: '--dangerous' }];
    expect(rejectedFields({ builtInTools })).toEqual(['args']);
  });

  it('refuses a field the profile does not have, such as a raw list of programs or a command line', () => {
    expect(rejectedFields({ inventory: ['git', 'node', 'playwright'] })).toEqual(['inventory']);
    expect(rejectedFields({ command: 'apt-get install curl' })).toEqual(['command']);
  });
});
