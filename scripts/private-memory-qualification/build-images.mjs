import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;
const syftUrl = 'https://github.com/anchore/syft/releases/download/v1.54.0/'
  + 'syft_1.54.0_linux_amd64.tar.gz';
const syftSha256 = '54a87372498168b2d033e876fd41fa4e8035b872699e525a57046e1f2f09c860';
const osiUrl = 'https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/json/licenses.json';
const osiSha256 = 'f728c534d8bd1044fc515a2ddb2292be99559021d830bfa3281be0bcd36302ee';
const codexSha256 = '1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e';
let activeChild;
let cancelled = false;
const cancellation = new AbortController();

function cancelBuild() {
  cancelled = true;
  cancellation.abort();
  if (activeChild?.pid) {
    try {
      process.kill(-activeChild.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

function run(command, args, options = {}) {
  function startProcess(resolveRun, rejectRun) {
    if (cancelled) {
      rejectRun(new Error('Image build cancelled'));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd ?? worktree,
      detached: true,
      env: { ...process.env, ...options.env },
      stdio: options.input === undefined ? ['ignore', 'pipe', 'inherit'] : ['pipe', 'pipe', 'inherit'],
    });
    activeChild = child;
    const output = [];
    function collect(data) {
      output.push(data);
    }
    function finished(code) {
      if (activeChild === child) activeChild = undefined;
      if (cancelled) {
        rejectRun(new Error('Image build cancelled'));
      } else if (code !== (options.expectedExitCode ?? 0)) {
        rejectRun(new Error(`${command} exited ${code}`));
      } else {
        resolveRun(Buffer.concat(output).toString('utf8'));
      }
    }
    child.stdout.on('data', collect);
    child.on('error', rejectRun);
    child.on('close', finished);
    if (options.input !== undefined) child.stdin.end(options.input);
  }
  return new Promise(startProcess);
}

export function buildPlan(slot, revision, attempt) {
  if (slot !== '1' && slot !== '2') throw new Error('Expected a secondary slot');
  if (!revisionPattern.test(revision)) throw new Error('Expected a full source revision');
  if (!/^[a-zA-Z0-9-]+$/u.test(attempt)) throw new Error('Invalid attempt name');
  const prefix = `opencrane-qualification-${attempt}`;
  return {
    slot,
    revision,
    computer: { context: 'apps/computer', dockerfile: 'apps/computer/Dockerfile',
      tag: `${prefix}-computer` },
    package: { context: '.', dockerfile: 'infra/package/Dockerfile',
      tag: `${prefix}-package` },
  };
}

export function checkedImageIdentity(metadata, inspection, revision, archiveConfiguration) {
  const manifestDigest = metadata['containerimage.digest'];
  if (!digestPattern.test(manifestDigest)) throw new Error('Missing immutable manifest digest');
  if (!digestPattern.test(archiveConfiguration)) {
    throw new Error('Image archive has no configuration digest');
  }
  const metadataConfiguration = metadata['containerimage.config.digest'];
  if (metadataConfiguration && metadataConfiguration !== archiveConfiguration) {
    throw new Error('Image configuration differs from build metadata');
  }
  if (inspection.Id !== archiveConfiguration && inspection.Id !== manifestDigest) {
    throw new Error('Inspected image differs from its manifest and configuration');
  }
  const labels = inspection.Config?.Labels ?? {};
  if (labels['org.opencontainers.image.revision'] !== revision) {
    throw new Error('Image source revision differs from reviewed source');
  }
  return { manifestDigest, configurationDigest: archiveConfiguration };
}

async function checkedSlot(slot) {
  const directory = join(homedir(), '.config/opencrane', `dev-stack-${slot}`);
  if (await realpath(directory) !== directory) throw new Error('Slot directory is a link');
  const markerPath = join(directory, 'stack-owner');
  const markerInfo = await lstat(markerPath);
  if (!markerInfo.isFile()) throw new Error('Slot owner marker is not a file');
  const marker = await readFile(markerPath, 'utf8');
  const firstLine = marker.split('\n')[0];
  const owner = firstLine.startsWith('worktree=') ? firstLine.slice(9) : firstLine;
  if (owner !== worktree) throw new Error('Slot belongs to another worktree');
  return directory;
}

async function checkedSource(revision) {
  const head = (await run('git', ['rev-parse', 'HEAD'])).trim();
  if (head !== revision) throw new Error('Source revision is not the checkout HEAD');
  const changes = await run('git', ['status', '--porcelain', '--untracked-files=normal']);
  if (changes.trim()) throw new Error('Source checkout must be clean');
}

async function extractSource(revision, attemptDirectory) {
  const archive = join(attemptDirectory, 'source.tar');
  const source = join(attemptDirectory, 'source');
  await mkdir(source, { mode: 0o700 });
  await run('git', ['archive', '--format=tar', '-o', archive, revision]);
  await run('tar', ['-xf', archive, '-C', source]);
  await rm(archive);
  return source;
}

function sha256(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

async function checkedBlob(archivePath, digest) {
  if (!digestPattern.test(digest)) throw new Error('Image archive has an invalid digest');
  const name = `blobs/sha256/${digest.slice('sha256:'.length)}`;
  const contents = await run('tar', ['-xOf', archivePath, name]);
  if (sha256(contents) !== digest) throw new Error('Image archive digest differs from its contents');
  return JSON.parse(contents);
}

async function checkedArchiveConfiguration(archivePath, manifestDigest) {
  const manifest = await checkedBlob(archivePath, manifestDigest);
  const configurationDigest = manifest.config?.digest;
  await checkedBlob(archivePath, configurationDigest);
  const savedManifest = JSON.parse(await run('tar', ['-xOf', archivePath, 'manifest.json']));
  if (savedManifest.length !== 1) throw new Error('Save exactly one image');
  const configurationFile = savedManifest[0].Config;
  const configuration = await run('tar', ['-xOf', archivePath, configurationFile]);
  if (sha256(configuration) !== configurationDigest) {
    throw new Error('Docker and OCI image configurations differ');
  }
  return configurationDigest;
}

async function buildImage(source, plan, attemptDirectory) {
  const metadataPath = join(attemptDirectory, `${plan.tag}.metadata.json`);
  const args = ['buildx', 'build', '--load', '--provenance=false',
    '--build-arg', `SOURCE_REVISION=${plan.revision}`,
    '--metadata-file', metadataPath, '--tag', plan.tag,
    '--file', join(source, plan.dockerfile)];
  if (plan.context === 'apps/computer') {
    args.push('--build-context', `project=${source}`, '--target', 'runtime');
  }
  args.push(join(source, plan.context));
  await run('docker', args);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const archivePath = join(attemptDirectory, `${plan.tag}.tar`);
  await run('docker', ['image', 'save', '--output', archivePath, plan.tag]);
  const archiveConfiguration = await checkedArchiveConfiguration(
    archivePath, metadata['containerimage.digest']);
  const inspectionText = await run('docker', ['image', 'inspect', plan.tag]);
  const inspection = JSON.parse(inspectionText)[0];
  const identity = checkedImageIdentity(metadata, inspection, plan.revision, archiveConfiguration);
  return { ...identity, archive: archivePath };
}

async function downloadPinnedTool(url, expectedSha256, destination) {
  await run('curl', ['--fail', '--location', '--silent', '--show-error', url, '--output', destination]);
  const contents = await readFile(destination);
  const actual = createHash('sha256').update(contents).digest('hex');
  if (actual !== expectedSha256) throw new Error('Pinned build tool checksum differs');
}

async function prepareLicenceTools(attemptDirectory) {
  const syftArchive = join(attemptDirectory, 'syft.tar.gz');
  const osiPath = join(attemptDirectory, 'osi.json');
  await downloadPinnedTool(syftUrl, syftSha256, syftArchive);
  await run('tar', ['-xzf', syftArchive, '-C', attemptDirectory, 'syft']);
  await downloadPinnedTool(osiUrl, osiSha256, osiPath);
  return { syft: join(attemptDirectory, 'syft'), osiPath };
}

export function reviewedValidationPaths(source) {
  return {
    noticeCollector: join(source, 'apps/computer/collect-licences.py'),
    computerChecker: join(source, 'apps/computer/check-licences.py'),
    packageChecker: join(source, 'infra/package/check-licences.py'),
    packageLayers: join(source, 'infra/package/image-layers.test.py'),
  };
}

async function scanAndCheckLicences(source, plan, computerIdentity, packageIdentity,
  attemptDirectory, tools) {
  const computerScan = join(attemptDirectory, 'computer-sbom.json');
  const packageScan = join(attemptDirectory, 'package-sbom.json');
  await run(tools.syft, ['scan', `docker:${plan.computer.tag}`, '-o', `syft-json=${computerScan}`]);
  await run(tools.syft, ['scan', `docker:${plan.package.tag}`, '-o', `syft-json=${packageScan}`]);
  await checkedScanIdentity(computerScan, plan.computer.tag, computerIdentity);
  await checkedScanIdentity(packageScan, plan.package.tag, packageIdentity);
  const validationPaths = reviewedValidationPaths(source);
  const noticeCollector = await readFile(validationPaths.noticeCollector);
  const notices = await run('docker', ['run', '--rm', '--network', 'none', '-i',
    '--entrypoint', '/usr/bin/python3', plan.computer.tag, '-', 'notices'],
  { input: noticeCollector });
  const noticePath = join(attemptDirectory, 'computer-notices.json');
  const inventoryPath = join(attemptDirectory, 'computer-licences.json');
  await writeFile(noticePath, notices, { mode: 0o600 });
  await run('python3', [validationPaths.computerChecker, computerScan,
    tools.osiPath, inventoryPath, noticePath], { cwd: source });
  await run('python3', [validationPaths.packageChecker, '--candidate-server', packageScan],
    { cwd: source });
}

async function checkedScanIdentity(path, tag, identity) {
  const scan = JSON.parse(await readFile(path, 'utf8'));
  const source = scan.source;
  const metadata = source?.metadata;
  const expectedPin = `${tag}@${identity.manifestDigest}`;
  if (source?.type !== 'image' || metadata?.imageID !== identity.configurationDigest ||
      !metadata.repoDigests?.includes(expectedPin)) {
    throw new Error('Image scan covers a different build');
  }
}

async function checkImports(source, plan, packageArchive) {
  const computerImport = "await import('/scripts/private-memory-qualification/native-checks.ts');"
    + " await import('/scripts/private-memory-qualification/runner-protection.ts');";
  const packageImport = "await import('/app/scripts/private-memory-qualification/native-checks.ts');"
    + " await import('/app/scripts/private-memory-qualification/runner-protection.ts');";
  for (const [tag, root, imports] of [
    [plan.computer.tag, '/scripts', computerImport],
    [plan.package.tag, '/app/scripts', packageImport],
  ]) {
    await run('docker', ['run', '--rm', '--network', 'none', '--read-only',
      '--entrypoint', 'node', tag, '--experimental-strip-types', '--input-type=module',
      '--eval', imports]);
    const refusal = await run('docker', ['run', '--rm', '--network', 'none', '--read-only',
      '--entrypoint', 'node', tag, '--experimental-strip-types',
      `${root}/private-memory-qualification/native-persistence.ts`],
    { expectedExitCode: 1 });
    if (refusal.trim() !== '{"result":"unknown"}') {
      throw new Error('Native runner did not give its fixed refusal');
    }
  }
  const computerCodex = '/spike/node_modules/@openai/codex-linux-x64/vendor/'
    + 'x86_64-unknown-linux-musl/bin/codex';
  const packageCodex = '/opt/native/node_modules/@openai/codex-linux-x64/vendor/'
    + 'x86_64-unknown-linux-musl/bin/codex';
  for (const [tag, binary] of [[plan.computer.tag, computerCodex],
    [plan.package.tag, packageCodex]]) {
    const checksum = await run('docker', ['run', '--rm', '--network', 'none', '--read-only',
      '--entrypoint', 'sha256sum', tag, binary]);
    if (checksum.split(' ')[0] !== codexSha256) throw new Error('Pinned Codex binary differs');
    await run('docker', ['run', '--rm', '--network', 'none', '--read-only',
      '--entrypoint', 'node', tag, '--eval',
      `require('${tag === plan.computer.tag ? '/scripts' : '/app/scripts'}`
      + `/private-memory-qualification/runner-protection.node')`]);
  }
  const validationPaths = reviewedValidationPaths(source);
  await run('python3', [validationPaths.packageLayers], {
    cwd: source,
    env: { PACKAGE_IMAGE_NAME: plan.package.tag, PACKAGE_IMAGE_ARCHIVE: packageArchive,
      PACKAGE_IMAGE_REVISION: plan.revision },
  });
}

export async function writeCompletedRecord(recordPath, record, signal, write = writeFile) {
  const temporaryPath = `${recordPath}.pending`;
  let published = false;
  try {
    await write(temporaryPath, `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' });
    if (signal.aborted) throw new Error('Image build cancelled');
    // Link the complete file only after every check; an existing record must refuse.
    await link(temporaryPath, recordPath);
    published = true;
    await rm(temporaryPath);
    if (signal.aborted) throw new Error('Image build cancelled');
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (published) await rm(recordPath, { force: true });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--id' || args[2] !== '--revision') {
    throw new Error('Usage: build-images.mjs --id 1|2 --revision <full-commit>');
  }
  const attempt = randomUUID();
  const plan = buildPlan(args[1], args[3], attempt);
  await checkedSource(plan.revision);
  const slotDirectory = await checkedSlot(plan.slot);
  const outputDirectory = join(slotDirectory, 'qualification-images');
  await mkdir(outputDirectory, { mode: 0o700, recursive: true });
  if (await realpath(outputDirectory) !== outputDirectory) {
    throw new Error('Image output directory is a link');
  }
  const attemptDirectory = await mkdtemp(join(outputDirectory, 'attempt-'));
  await chmod(attemptDirectory, 0o700);
  const source = await extractSource(plan.revision, attemptDirectory);
  const computer = await buildImage(source, { ...plan.computer, revision: plan.revision }, attemptDirectory);
  const packageImage = await buildImage(source, { ...plan.package, revision: plan.revision }, attemptDirectory);
  const licenceTools = await prepareLicenceTools(attemptDirectory);
  await scanAndCheckLicences(source, plan, computer, packageImage, attemptDirectory, licenceTools);
  await checkImports(source, plan, packageImage.archive);
  const record = { slot: plan.slot, sourceRevision: plan.revision, computer, package: packageImage,
    computerTag: plan.computer.tag, packageTag: plan.package.tag };
  const recordPath = join(attemptDirectory, 'images.json');
  await writeCompletedRecord(recordPath, record, cancellation.signal);
  process.stdout.write(`${recordPath}\n`);
}

function reportFailure(error) {
  process.stderr.write(`Qualification image build failed: ${error.message}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', cancelBuild);
  process.on('SIGTERM', cancelBuild);
  main().catch(reportFailure);
}
