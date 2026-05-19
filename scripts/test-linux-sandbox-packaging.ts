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
    /exec \.\/electron\/electron --no-sandbox dist\/main\/main\.js "\$@"/,
    'Snap launcher must pass --no-sandbox before the app entrypoint',
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
