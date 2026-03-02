import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ReleaseResult = {
  code: number;
  output: string;
};

function createTempRepo(version: string): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-confirmation-test-'));
  const scriptsDir = path.join(repoDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const sourceReleaseScript = path.resolve(__dirname, 'release.sh');
  const targetReleaseScript = path.join(scriptsDir, 'release.sh');
  fs.copyFileSync(sourceReleaseScript, targetReleaseScript);
  fs.chmodSync(targetReleaseScript, 0o755);

  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'release-test', version }, null, 2) + '\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoDir, 'CHANGELOG.md'),
    `# Changelog\n\n## [${version}] - 2026-03-02\n\n- Test release entry\n`,
    'utf8'
  );

  execSync('git init', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.email "release-tests@example.com"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.name "Release Tests"', { cwd: repoDir, stdio: 'ignore' });

  const currentBranch = execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();
  if (currentBranch !== 'main') {
    execSync('git checkout -b main', { cwd: repoDir, stdio: 'ignore' });
  }

  execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
  execSync('git commit -m "test fixture"', { cwd: repoDir, stdio: 'ignore' });

  return repoDir;
}

function runRelease(repoDir: string, version: string, input?: string): Promise<ReleaseResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['./scripts/release.sh', version, '--dry-run'], {
      cwd: repoDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });

    if (typeof input === 'string') {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function testStableWrongPhraseFails(): Promise<void> {
  const repoDir = createTempRepo('1.2.3');
  try {
    const result = await runRelease(repoDir, '1.2.3', 'no\n');
    assert(result.code !== 0, 'Expected stable release with wrong phrase to fail');
    assert(
      result.output.includes('Error: Stable releases require exact confirmation phrase.'),
      'Expected stable release error message for wrong confirmation phrase'
    );
    console.log('✓ stable + wrong confirmation fails');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

async function testStableCorrectPhrasePassesInDryRun(): Promise<void> {
  const repoDir = createTempRepo('1.2.3');
  try {
    const result = await runRelease(repoDir, '1.2.3', 'yes do it\n');
    assert(result.code === 0, 'Expected stable release with exact phrase to pass in --dry-run');
    assert(result.output.includes('✓ Stable release confirmation accepted'), 'Expected stable confirmation success');
    assert(result.output.includes('[DRY RUN] Would create tag v1.2.3'), 'Expected dry-run create-tag output');
    assert(result.output.includes('[DRY RUN] Would push tag v1.2.3 to origin'), 'Expected dry-run push-tag output');
    console.log('✓ stable + exact confirmation passes in dry-run');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

async function testPrereleaseDoesNotRequirePhrase(): Promise<void> {
  const repoDir = createTempRepo('1.2.3-beta.1');
  try {
    const result = await runRelease(repoDir, '1.2.3-beta.1');
    assert(result.code === 0, 'Expected prerelease to pass in --dry-run without stable phrase');
    assert(!result.output.includes('Type "yes do it" to continue:'), 'Did not expect stable confirmation prompt');
    assert(result.output.includes('[DRY RUN] Would create tag v1.2.3-beta.1'), 'Expected dry-run create-tag output');
    assert(result.output.includes('[DRY RUN] Would push tag v1.2.3-beta.1 to origin'), 'Expected dry-run push-tag output');
    console.log('✓ prerelease bypasses stable confirmation phrase');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  await testStableWrongPhraseFails();
  await testStableCorrectPhrasePassesInDryRun();
  await testPrereleaseDoesNotRequirePhrase();
}

run()
  .then(() => {
    console.log('✓ Release confirmation tests passed');
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${message}`);
    process.exit(1);
  });
