import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const dockerfiles = [
  new URL('../Dockerfile', import.meta.url),
  new URL('./upload-base.Dockerfile', import.meta.url),
];

async function readDockerfile(dockerfileUrl: URL): Promise<string> {
  return readFile(dockerfileUrl, 'utf8');
}

describe('computer image apt timeouts', () => {
  it('allows cold downloads while bounding a stalled apt command', async () => {
    const dockerfileContents = await Promise.all(dockerfiles.map(readDockerfile));

    for (const dockerfileContent of dockerfileContents) {
      const aptCommandTimeouts = dockerfileContent.match(/timeout -v -k 10s \S+ apt-get/g) ?? [];

      expect(aptCommandTimeouts.length).toBeGreaterThan(0);
      expect(aptCommandTimeouts.every(hasTwentyFiveMinuteTimeout)).toBe(true);
      expect(dockerfileContent).toContain("'Acquire::http::Timeout \"30\";'");
      expect(dockerfileContent).toContain("'Acquire::https::Timeout \"30\";'");
      expect(dockerfileContent).toContain("'Acquire::Retries \"5\";'");
    }
  });
});

function hasTwentyFiveMinuteTimeout(command: string): boolean {
  return command.endsWith(' 25m apt-get');
}
