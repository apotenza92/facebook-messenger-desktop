import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {buildPublication} from './build-homebrew-publication.mjs';
import {stage} from './stage-homebrew-publication.mjs';

test('staged casks preserve Homebrew stanza groups', () => {
  const root = mkdtempSync(join(tmpdir(), 'messenger-homebrew-stage-'));
  try {
    const assets = join(root, 'assets'); const output = join(root, 'output'); mkdirSync(assets);
    for (const prefix of ['Messenger-macos', 'Messenger-Beta-macos']) {
      for (const arch of ['arm64', 'x64']) writeFileSync(join(assets, `${prefix}-${arch}.zip`), `${prefix}-${arch}`);
    }
    stage({channel: 'stable', tag: 'v1.2.3', assetsDirectory: assets, outputDirectory: output, commit: 'c'.repeat(40), runId: 4, runAttempt: 2});
    for (const name of ['facebook-messenger-desktop.rb', 'facebook-messenger-desktop@beta.rb']) {
      const cask = readFileSync(join(output, 'publication', 'Casks', name), 'utf8');
      assert.match(cask, /  depends_on :macos\n\n  app /);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('standard stable bundle seals both identities and architectures', () => {
  const root = mkdtempSync(join(tmpdir(), 'messenger-homebrew-'));
  try {
    const casks = join(root, 'casks'); const output = join(root, 'output'); mkdirSync(casks); const assets = [];
    for (const [channel, filename, prefix] of [['stable', 'facebook-messenger-desktop.rb', 'Messenger'], ['beta', 'facebook-messenger-desktop@beta.rb', 'Messenger-Beta']]) {
      const lines = ['cask "x" do', '  version "1.2.3"'];
      for (const [architecture, scope] of [['arm64', 'arm'], ['x64', 'intel']]) {
        const digest = (channel === 'stable' ? 'a' : 'b').repeat(64); const name = `${prefix}-macos-${architecture}.zip`;
        lines.push(`  on_${scope} do`, `    sha256 "${digest}"`, `    url "https://github.com/apotenza92/facebook-messenger-desktop/releases/download/v#{version}/${name}"`, '  end');
        assets.push({name, size: 42, digest: `sha256:${digest}`});
      }
      lines.push('end'); writeFileSync(join(casks, filename), `${lines.join('\n')}\n`);
    }
    const manifest = buildPublication({channel: 'stable', tag: 'v1.2.3', commit: 'c'.repeat(40), runId: 4, runAttempt: 2, casksDirectory: casks, releaseAssets: {assets}, outputDirectory: output});
    assert.deepEqual(manifest.casks, ['facebook-messenger-desktop.rb', 'facebook-messenger-desktop@beta.rb']);
    assert.equal(manifest.artifacts.length, 4); assert.equal(manifest.minimum_macos, '12.0');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('standard bundle rejects public digest drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'messenger-homebrew-'));
  try {
    const casks = join(root, 'casks'); mkdirSync(casks);
    writeFileSync(join(casks, 'facebook-messenger-desktop@beta.rb'), 'cask "x" do\n version "1.2.3-beta.1"\nend\n');
    assert.throws(() => buildPublication({channel: 'beta', tag: 'v1.2.3-beta.1', commit: 'c'.repeat(40), runId: 1, runAttempt: 1, casksDirectory: casks, releaseAssets: {assets: []}, outputDirectory: join(root, 'out')}));
  } finally { rmSync(root, {recursive: true, force: true}); }
});
