import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LINUX_NO_SANDBOX_ARG,
  withLinuxNoSandboxArg,
} from '../src/main/linux-sandbox-policy';

function readRootFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function run(): void {
  const snapcraft = readRootFile('snapcraft.yaml');
  assert.match(
    snapcraft,
    /^base: core24$/m,
    'Snap base must match the Ubuntu 24 staged runtime libraries used by local and CI builds',
  );
  assert.match(
    snapcraft,
    /^platforms:$/m,
    'core24 Snap builds must use platforms instead of architectures',
  );
  assert.doesNotMatch(
    snapcraft,
    /^architectures:$/m,
    'core24 Snap builds must not use the core22 architectures key',
  );
  assert.match(
    snapcraft,
    /exec \.\/electron\/electron --no-sandbox dist\/main\/main\.js "\$@"/,
    'Snap launcher must pass --no-sandbox before the app entrypoint',
  );
  assert.match(
    snapcraft,
    /-\s+libasound2t64/,
    'Snap must stage Noble real ALSA so liboss4-salsa2 does not shadow required ALSA symbols',
  );
  assert.match(
    snapcraft,
    /-\s+libgl1/,
    'Snap must stage libGL.so.1 for Electron GPU process initialization under core24',
  );
  assert.match(
    snapcraft,
    /-\s+liboss4-salsa2/,
    'Snap must stage liboss4-salsa2 so Electron can load libOSSlib.so under core24',
  );
  assert.match(
    snapcraft,
    /for lib_dir[\s\S]*?for oss_lib_dir/,
    'Snap launcher must add normal library directories before appending the OSS ALSA compatibility directory',
  );
  assert.match(
    snapcraft,
    /ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts/,
    'Snap install tree must include production runtime node_modules',
  );

  const mainProcess = readRootFile('src/main/main.ts');
  assert.match(
    mainProcess,
    /!app\.isPackaged && !process\.env\.FLATPAK_ID && !process\.env\.SNAP/,
    'Snap runtime must not be classified as dev just because it launches raw Electron',
  );
  assert.match(
    mainProcess,
    /process\.env\.SNAP_USER_COMMON[\s\S]*?process\.env\.SNAP_USER_DATA[\s\S]*?app\.getPath\("appData"\)/,
    'Snap runtime must use the writable Snap user data directory before falling back to appData',
  );
  assert.match(
    mainProcess,
    /fs\.mkdirSync\(app\.getPath\("userData"\), \{ recursive: true \}\);[\s\S]*?app\.requestSingleInstanceLock\(\)/,
    'Main process must create userData before requesting the single-instance lock',
  );

  const linuxRuntimeSmoke = readRootFile('scripts/test-issue53-linux-vm-smoke.sh');
  for (const pattern of [
    'SingletonLock',
    'Lock acquired: false',
    'Another instance is already running',
    'Messenger-Dev',
  ]) {
    assert.match(
      linuxRuntimeSmoke,
      new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `Linux runtime smoke must fail on ${pattern}`,
    );
  }
  assert.match(
    linuxRuntimeSmoke,
    /\[SingleInstance\] Lock acquired: true/,
    'Linux runtime smoke must require the single-instance lock success marker',
  );

  const prlctlRuntimeSmoke = readRootFile('scripts/test-linux-runtime-prlctl.js');
  assert.match(
    prlctlRuntimeSmoke,
    /RUNTIME_SNAP_DISPLAY/,
    'Parallels runtime smoke must expose a selectable Snap display mode',
  );
  assert.match(
    prlctlRuntimeSmoke,
    /real-x11/,
    'Parallels runtime smoke must support the real GNOME X11/XWayland session without Xvfb',
  );
  assert.match(
    prlctlRuntimeSmoke,
    /XAUTHORITY/,
    'Parallels real-display smoke must pass Xauthority from the active graphical session',
  );

  const electronBuilderConfig = readRootFile('electron-builder.config.js');
  const appImageSandboxArgs = electronBuilderConfig.match(
    /appImage:\s*\{[\s\S]*?executableArgs:\s*\[\s*'--no-sandbox'\s*\]/g,
  );
  assert.equal(
    appImageSandboxArgs?.length,
    2,
    'Stable and beta AppImage config must both set executableArgs to --no-sandbox',
  );

  const afterPack = readRootFile('scripts/after-pack.js');
  assert.match(
    afterPack,
    /function wrapLinuxExecutable/,
    'afterPack must wrap Linux executables before AppImage packaging',
  );
  assert.match(
    afterPack,
    /fs\.renameSync\(executablePath, wrappedExecutablePath\)/,
    'Linux wrapper must rename the real Electron binary behind the launcher',
  );
  assert.match(
    afterPack,
    /exec "\$DIR\/\$\{executableName\}\.bin" --no-sandbox "\$@"/,
    'Linux wrapper must pass --no-sandbox before user arguments',
  );

  const releaseWorkflow = readRootFile('.github/workflows/release.yml');
  assert.match(
    releaseWorkflow,
    /issue53-x64-smoke:/,
    'Release workflow must include an independent Issue #53 x64 smoke job',
  );
  assert.match(
    releaseWorkflow,
    /test-issue53-linux-vm-smoke\.sh appimage "\$appimage"/,
    'Release workflow must smoke-launch x64 AppImages before upload',
  );

  const x64SmokeWorkflow = readRootFile('.github/workflows/issue53-linux-x64-smoke.yml');
  assert.match(
    x64SmokeWorkflow,
    /runs-on: ubuntu-24\.04/,
    'Issue #53 x64 smoke workflow must run on hosted Ubuntu x64',
  );
  assert.match(
    x64SmokeWorkflow,
    /test "\$\(uname -m\)" = "x86_64"/,
    'Issue #53 x64 smoke workflow must assert the hosted runner architecture',
  );
  assert.match(
    x64SmokeWorkflow,
    /electron-builder --config electron-builder\.config\.js --linux AppImage --x64 --publish=never/,
    'Issue #53 x64 smoke workflow must build the x64 AppImage locally on the x64 runner',
  );
  assert.match(
    x64SmokeWorkflow,
    /test-issue53-linux-vm-smoke\.sh appimage "\$appimage"/,
    'Issue #53 x64 smoke workflow must launch the x64 AppImage under Xvfb',
  );

  assert.deepEqual(
    withLinuxNoSandboxArg([]),
    [LINUX_NO_SANDBOX_ARG],
    'Direct AppImage child args must add --no-sandbox when no args are present',
  );
  assert.deepEqual(
    withLinuxNoSandboxArg(['--reset-window']),
    [LINUX_NO_SANDBOX_ARG, '--reset-window'],
    'Direct AppImage child args must preserve existing app args',
  );
  assert.deepEqual(
    withLinuxNoSandboxArg([LINUX_NO_SANDBOX_ARG, '--reset-window']),
    [LINUX_NO_SANDBOX_ARG, '--reset-window'],
    'Direct AppImage child args must not duplicate --no-sandbox',
  );

  console.log('✓ Linux sandbox packaging checks passed');
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✗ ${message}`);
  process.exit(1);
}
