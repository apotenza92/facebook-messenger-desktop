import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(predicate)
    .map((name) => path.join(dir, name));
}

function findSquashfsOffsets(file: string): number[] {
  const bytes = fs.readFileSync(file);
  const marker = Buffer.from('hsqs');
  const offsets: number[] = [];

  for (let index = 0; index <= bytes.length - marker.length; index += 1) {
    if (bytes.subarray(index, index + marker.length).equals(marker)) {
      offsets.push(index);
    }
  }

  return offsets;
}

function extractSquashfs(file: string, entries: string[]): string {
  const offsets = findSquashfsOffsets(file);
  assert(offsets.length > 0, `${path.basename(file)} has no SquashFS marker`);

  let lastError = '';
  for (const offset of offsets) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-artifact-'));
    try {
      execFileSync('unsquashfs', [
        '-quiet',
        '-offset',
        String(offset),
        '-d',
        outDir,
        file,
        ...entries,
      ], { stdio: 'pipe' });
      return outDir;
    } catch (error) {
      fs.rmSync(outDir, { recursive: true, force: true });
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Could not extract ${path.basename(file)}: ${lastError}`);
}

function executableNameForArtifact(file: string): string {
  return path.basename(file).includes('-beta')
    ? 'facebook-messenger-desktop-beta'
    : 'facebook-messenger-desktop';
}

function assertAppImage(file: string): void {
  const executableName = executableNameForArtifact(file);
  const outDir = extractSquashfs(file, [
    'AppRun',
    `${executableName}.desktop`,
    executableName,
    `${executableName}.bin`,
  ]);

  try {
    const appRun = fs.readFileSync(path.join(outDir, 'AppRun'), 'utf8');
    const desktop = fs.readFileSync(path.join(outDir, `${executableName}.desktop`), 'utf8');
    const wrapper = fs.readFileSync(path.join(outDir, executableName), 'utf8');
    const wrappedBinary = path.join(outDir, `${executableName}.bin`);

    assert.match(
      appRun,
      new RegExp(`BIN="\\$APPDIR/${executableName}"`),
      `${path.basename(file)} AppRun must target the wrapper executable`,
    );
    assert.doesNotMatch(
      appRun,
      new RegExp(`BIN="\\$APPDIR/${executableName}\\.bin"`),
      `${path.basename(file)} AppRun must not bypass the wrapper`,
    );
    assert.match(
      desktop,
      /Exec=AppRun --no-sandbox %U/,
      `${path.basename(file)} desktop metadata must pass --no-sandbox`,
    );
    assert.match(
      wrapper,
      new RegExp(`exec "\\$DIR/${executableName}\\.bin" --no-sandbox "\\$@"`),
      `${path.basename(file)} wrapper must pass --no-sandbox to Electron`,
    );
    assert.equal(
      fs.existsSync(wrappedBinary),
      true,
      `${path.basename(file)} must contain the renamed Electron binary`,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function assertSnap(file: string): void {
  const outDir = extractSquashfs(file, [
    'opt/Messenger/facebook-messenger-desktop',
    'opt/Messenger/node_modules/electron-updater/package.json',
    'meta/snap.yaml',
  ]);

  try {
    const launcher = fs.readFileSync(
      path.join(outDir, 'opt/Messenger/facebook-messenger-desktop'),
      'utf8',
    );
    const updaterPackage = path.join(
      outDir,
      'opt/Messenger/node_modules/electron-updater/package.json',
    );

    assert.match(
      launcher,
      /exec \.\/electron\/electron --no-sandbox dist\/main\/main\.js "\$@"/,
      `${path.basename(file)} Snap launcher must pass --no-sandbox`,
    );
    assert.equal(
      fs.existsSync(updaterPackage),
      true,
      `${path.basename(file)} must include electron-updater runtime dependency`,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function run(): void {
  const requireSnap = process.argv.includes('--require-snap');
  const explicitArtifacts = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith('--'))
    .map((arg) => path.resolve(arg));

  const appImages = explicitArtifacts.length > 0
    ? explicitArtifacts.filter((file) => file.endsWith('.AppImage'))
    : listFiles(releaseDir, (name) => name.endsWith('.AppImage'));
  const snaps = explicitArtifacts.length > 0
    ? explicitArtifacts.filter((file) => file.endsWith('.snap'))
    : [
        ...listFiles(releaseDir, (name) => name.endsWith('.snap')),
        ...listFiles(projectRoot, (name) => name.endsWith('.snap')),
      ];

  if (explicitArtifacts.length > 0) {
    assert(
      appImages.length > 0 || snaps.length > 0,
      'No Linux artifacts found to inspect',
    );
  } else {
    assert(appImages.length > 0, 'No AppImage artifacts found to inspect');
  }

  for (const appImage of appImages) {
    assertAppImage(appImage);
    console.log(`✓ AppImage inspected: ${path.basename(appImage)}`);
  }

  if (requireSnap) {
    assert(snaps.length > 0, 'No Snap artifacts found to inspect');
  }

  for (const snap of snaps) {
    assertSnap(snap);
    console.log(`✓ Snap inspected: ${path.basename(snap)}`);
  }

  console.log('✓ Linux artifact checks passed');
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✗ ${message}`);
  process.exit(1);
}
