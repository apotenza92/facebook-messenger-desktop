import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

export function buildPublication({channel, tag, commit, runId, runAttempt, casksDirectory, releaseAssets, outputDirectory}) {
  if (!['stable', 'beta'].includes(channel) || !/^v\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/.test(tag)) throw new Error('Invalid release identity');
  const channels = channel === 'stable' ? ['stable', 'beta'] : ['beta'];
  const casks = channel === 'stable' ? ['facebook-messenger-desktop.rb', 'facebook-messenger-desktop@beta.rb'] : ['facebook-messenger-desktop@beta.rb'];
  const assets = new Map(releaseAssets.assets.map(asset => [asset.name, asset]));
  mkdirSync(join(outputDirectory, 'Casks'), {recursive: true});
  const artifacts = [];
  for (let index = 0; index < channels.length; index += 1) {
    const publicationChannel = channels[index]; const filename = casks[index];
    const text = readFileSync(join(casksDirectory, filename), 'utf8');
    writeFileSync(join(outputDirectory, 'Casks', filename), text);
    const version = text.match(/^\s*version\s+"([^"]+)"/m)?.[1];
    if (`v${version}` !== tag) throw new Error(`Cask version mismatch: ${filename}`);
    const shas = [...text.matchAll(/^\s*sha256\s+"([0-9a-f]{64})"/gm)].map(match => match[1]);
    const urls = [...text.matchAll(/^\s*url\s+"(https:\/\/github\.com\/[^\"]+\/releases\/download\/[^\"]+)"/gm)].map(match => match[1]);
    if (shas.length !== 2 || urls.length !== 2) throw new Error(`Cask architecture mismatch: ${filename}`);
    for (let architectureIndex = 0; architectureIndex < 2; architectureIndex += 1) {
      const architecture = ['arm64', 'x64'][architectureIndex];
      const url = urls[architectureIndex].replace('v#{version}', tag); const name = url.split('/').at(-1);
      const asset = assets.get(name); const digest = shas[architectureIndex];
      if (!asset || asset.digest !== `sha256:${digest}` || !Number.isInteger(asset.size) || asset.size <= 0) throw new Error(`Public release asset mismatch: ${name}`);
      artifacts.push({name, url, size: asset.size, sha256: digest, channel: publicationChannel, architecture});
    }
  }
  const manifest = {
    schema_version: 1, product: 'facebook-messenger-desktop', source_repository: 'apotenza92/facebook-messenger-desktop',
    release_tag: tag, release_commit: commit, channel, casks, artifacts,
    applications: Object.fromEntries(channels.map(value => [value, value === 'stable' ? 'Messenger.app' : 'Messenger Beta.app'])),
    bundle_identifiers: Object.fromEntries(channels.map(value => [value, value === 'stable' ? 'com.facebook.messenger.desktop' : 'com.facebook.messenger.desktop.beta'])),
    architectures: ['arm64', 'x64'], minimum_macos: '12.0',
    native_validation: {workflow_run_id: Number(runId), workflow_run_attempt: Number(runAttempt), jobs: [channel === 'stable' ? 'Prepare Homebrew publication (Stable)' : 'Prepare Homebrew publication (Beta)']},
  };
  writeFileSync(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function option(name) { const index = process.argv.indexOf(name); if (index < 0) throw new Error(`Missing ${name}`); return process.argv[index + 1]; }
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  buildPublication({channel: option('--channel'), tag: option('--tag'), commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    casksDirectory: resolve(option('--casks')), releaseAssets: JSON.parse(readFileSync(resolve(option('--release-assets')), 'utf8')), outputDirectory: resolve(option('--output'))});
}
