import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const changelogPath = 'CHANGELOG.md';
const fragmentDirectory = 'changes/unreleased';
const gatheredStart = '<!-- Gathered release notes start -->';
const gatheredEnd = '<!-- Gathered release notes end -->';

function splitChangelog(changelog) {
  const unreleasedHeading = '## Unreleased';
  const headingStart = changelog.indexOf(unreleasedHeading);
  if (headingStart < 0) {
    throw new Error('CHANGELOG.md has no Unreleased section.');
  }

  const contentStart = headingStart + unreleasedHeading.length;
  const nextHeading = changelog.indexOf('\n## ', contentStart);
  const contentEnd = nextHeading < 0 ? changelog.length : nextHeading;
  return {
    before: changelog.slice(0, contentStart),
    unreleased: changelog.slice(contentStart, contentEnd),
    after: changelog.slice(contentEnd),
  };
}

function replaceGatheredNotes(unreleased, notes) {
  const withoutGatheredNotes = removeGatheredNotes(unreleased);
  const trimmedUnreleased = withoutGatheredNotes.trimEnd();
  return `${trimmedUnreleased}\n\n${gatheredStart}\n${notes}\n${gatheredEnd}\n`;
}

async function readFragments() {
  const filenames = await readdir(fragmentDirectory);
  const markdownFilenames = filenames.filter(isMarkdownFilename);
  markdownFilenames.sort();

  const fragmentContents = [];
  for (const filename of markdownFilenames) {
    const fragmentPath = join(fragmentDirectory, filename);
    const fragment = await readFile(fragmentPath, 'utf8');
    const trimmedFragment = fragment.trim();
    if (trimmedFragment.length === 0) {
      throw new Error(`${fragmentPath} is empty.`);
    }
    fragmentContents.push(trimmedFragment);
  }

  return { markdownFilenames, fragmentContents };
}

function isMarkdownFilename(filename) {
  return filename.endsWith('.md');
}

async function gather() {
  const { markdownFilenames, fragmentContents } = await readFragments();
  if (markdownFilenames.length === 0) {
    throw new Error(`No Markdown files found in ${fragmentDirectory}.`);
  }

  const changelog = await readFile(changelogPath, 'utf8');
  const sections = splitChangelog(changelog);
  const notes = fragmentContents.join('\n\n');
  const updatedUnreleased = replaceGatheredNotes(sections.unreleased, notes);
  const updatedChangelog = `${sections.before}${updatedUnreleased}${sections.after}`;
  await writeFile(changelogPath, updatedChangelog);

  for (const filename of markdownFilenames) {
    await unlink(join(fragmentDirectory, filename));
  }
}

function removeGatheredNotes(unreleased) {
  const start = unreleased.indexOf(gatheredStart);
  const end = unreleased.indexOf(gatheredEnd);
  if (start < 0 && end < 0) {
    return unreleased;
  }
  if (start < 0 || end < start) {
    throw new Error('The gathered changelog markers are incomplete.');
  }

  const endAfterMarker = end + gatheredEnd.length;
  return `${unreleased.slice(0, start)}${unreleased.slice(endAfterMarker)}`;
}

function getBaseChangelog() {
  const baseBranch = process.env.GITHUB_BASE_REF;
  let baseReference = 'origin/main';
  if (baseBranch) {
    baseReference = `origin/${baseBranch}`;
  }
  return execFileSync('git', ['show', `${baseReference}:${changelogPath}`], {
    encoding: 'utf8',
  });
}

async function check() {
  const baseChangelog = getBaseChangelog();
  const currentChangelog = await readFile(changelogPath, 'utf8');
  const baseSections = splitChangelog(baseChangelog);
  const currentSections = splitChangelog(currentChangelog);
  const baseUnreleased = removeGatheredNotes(baseSections.unreleased);
  const currentUnreleased = removeGatheredNotes(currentSections.unreleased);

  if (baseUnreleased.trimEnd() !== currentUnreleased.trimEnd()) {
    throw new Error(
      'Edit release notes in changes/unreleased/*.md, then gather them with the script.',
    );
  }
}

const requestedAction = process.argv[2];
if (requestedAction === '--check') {
  await check();
} else if (requestedAction) {
  throw new Error(`Unknown option: ${requestedAction}`);
} else {
  await gather();
}
