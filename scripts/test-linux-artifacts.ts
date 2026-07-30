import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const MAX_SUPPORTED_GLIBC = [2, 39] as const;

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

function isElf(file: string): boolean {
  if (!fs.statSync(file).isFile()) return false;
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(4);
    return (
      fs.readSync(descriptor, header, 0, header.length, 0) === header.length &&
      header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walk(candidate);
    return entry.isFile() ? [candidate] : [];
  });
}

function glibcVersion(value: string): [number, number] {
  const match = value.match(/^(\d+)\.(\d+)$/);
  assert(match, `Invalid GLIBC version ${value}`);
  return [Number(match[1]), Number(match[2])];
}

function compareVersion(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

function assertNativeDependencyClosure(
  outDir: string,
  wrappedBinary: string,
): void {
  const files = walk(outDir);
  const elfFiles = files.filter(isElf);
  assert(elfFiles.length > 0, 'AppImage contains no ELF files');
  const requiredGlibc = new Set<string>();
  for (const elf of elfFiles) {
    let versionInfo = '';
    try {
      versionInfo = execFileSync('readelf', ['--version-info', elf], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      continue;
    }
    for (const match of versionInfo.matchAll(/\bGLIBC_(\d+\.\d+)\b/g)) {
      requiredGlibc.add(match[1]);
    }
  }
  const highest = [...requiredGlibc]
    .map(glibcVersion)
    .sort(compareVersion)
    .at(-1);
  assert(highest, 'AppImage ELF files expose no GLIBC version contract');
  assert(
    compareVersion(highest, MAX_SUPPORTED_GLIBC) <= 0,
    `AppImage requires GLIBC ${highest.join('.')}, above supported baseline ${MAX_SUPPORTED_GLIBC.join('.')}`,
  );

  const libraryDirectories = [...new Set(
    files
      .filter((file) => /\.so(?:\.|$)/.test(path.basename(file)))
      .map(path.dirname),
  )];
  const closureTargets = [
    wrappedBinary,
    ...files.filter((file) => file.endsWith('.node')),
  ];
  for (const target of closureTargets) {
    const output = execFileSync('ldd', [target], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LD_LIBRARY_PATH: libraryDirectories.join(':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.doesNotMatch(
      output,
      /=>\s+not found\b/,
      `${path.relative(outDir, target)} has unresolved native dependencies`,
    );
  }
  console.log(
    `✓ Native dependency closure and GLIBC <= ${MAX_SUPPORTED_GLIBC.join('.')} verified`,
  );
}

function assertAppImage(file: string): void {
  const executableName = executableNameForArtifact(file);
  const outDir = extractSquashfs(file, []);

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
    assertNativeDependencyClosure(outDir, wrappedBinary);
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
