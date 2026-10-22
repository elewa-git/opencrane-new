import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { BaseSequencer } from 'vitest/node';

export default class DurationSequencer extends BaseSequencer {
  async sort(files) {
    const root = this.ctx.config.root;
    const timingsPath = resolve(root, 'scripts/ci/test-timings.json');
    const timings = JSON.parse(readFileSync(timingsPath, 'utf8'));
    function duration(file) {
      const name = relative(root, file.moduleId);
      return timings[name] ?? 30_000;
    }
    function compareFiles(first, second) {
      const difference = duration(second) - duration(first);
      if (difference !== 0) {
        return difference;
      }
      if (first.moduleId < second.moduleId) {
        return -1;
      }
      if (first.moduleId > second.moduleId) {
        return 1;
      }
      return 0;
    }
    return [...files].sort(compareFiles);
  }

  async shard(files) {
    const { index, count } = this.ctx.config.shard;
    const root = this.ctx.config.root;
    const timingsPath = resolve(root, 'scripts/ci/test-timings.json');
    const timings = JSON.parse(readFileSync(timingsPath, 'utf8'));
    const groups = [];
    for (let shard = 0; shard < count; shard++) {
      groups.push({ files: [], duration: 0 });
    }
    const ordered = await this.sort(files);
    for (const file of ordered) {
      let lightest = groups[0];
      for (const group of groups) {
        if (group.duration < lightest.duration) {
          lightest = group;
        }
      }
      lightest.files.push(file);
      lightest.duration += timings[relative(root, file.moduleId)] ?? 30_000;
    }
    return groups[index - 1].files;
  }
}
