#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleUpdateMetadata } from "./assemble-update-metadata.mjs";
import { createUpdateMetadata } from "./create-update-metadata.mjs";

function channelsForRelease(releaseChannel) {
  if (releaseChannel === "stable") return ["stable", "beta"];
  if (releaseChannel === "beta") return ["beta"];
  throw new Error(`Unsupported release channel: ${releaseChannel}`);
}

function updaterArtifact(channel, platform, arch) {
  const beta = channel === "beta";
  if (platform === "win32") {
    return `${beta ? "Messenger-Beta" : "Messenger"}-windows-${arch}-setup.exe`;
  }
  if (platform === "linux") {
    const linuxArch = arch === "x64" ? "x86_64" : "arm64";
    return `facebook-messenger-desktop${beta ? "-beta" : ""}-${linuxArch}.AppImage`;
  }
  throw new Error(`No generated updater artifact for ${platform}.`);
}

export async function assembleReleaseUpdateFeeds({
  auditDirectory,
  outputRoot,
  releaseChannel,
  releaseDirectory,
  repository,
  tag,
  temporaryDirectory,
}) {
  const version = tag.replace(/^v/, "");
  const outputs = [];
  await mkdir(temporaryDirectory, { recursive: true });
  for (const channel of channelsForRelease(releaseChannel)) {
    for (const arch of ["arm64", "x64"]) {
      const macInput = path.join(
        releaseDirectory,
        channel === "beta" ? "beta-mac.yml" : "latest-mac.yml",
      );
      outputs.push(
        await assembleUpdateMetadata({
          arch,
          artifactDir: releaseDirectory,
          auditOutput: path.join(
            auditDirectory,
            channel,
            "darwin",
            arch,
            "latest-mac.yml",
          ),
          channel,
          input: macInput,
          outputRoot,
          platform: "darwin",
          repository,
          tag,
        }),
      );

      for (const platform of ["win32", "linux"]) {
        const artifactName = updaterArtifact(channel, platform, arch);
        const generatedInput = path.join(
          temporaryDirectory,
          `${channel}-${platform}-${arch}.yml`,
        );
        await createUpdateMetadata({
          artifactPath: path.join(releaseDirectory, artifactName),
          outputPath: generatedInput,
          version,
        });
        outputs.push(
          await assembleUpdateMetadata({
            arch,
            artifactDir: releaseDirectory,
            auditOutput: path.join(
              auditDirectory,
              channel,
              platform,
              arch,
              "update.yml",
            ),
            channel,
            input: generatedInput,
            outputRoot,
            platform,
            repository,
            tag,
          }),
        );
      }
    }
  }
  return outputs;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export async function main(argv = process.argv.slice(2)) {
  const releaseDirectory = option(argv, "--release-dir");
  const outputRoot = option(argv, "--output");
  const auditDirectory = option(argv, "--audit-output");
  const temporaryDirectory = option(argv, "--temporary");
  const releaseChannel = option(argv, "--release-channel");
  const repository = option(argv, "--repository");
  const tag = option(argv, "--tag");
  if (
    !releaseDirectory ||
    !outputRoot ||
    !auditDirectory ||
    !temporaryDirectory ||
    !releaseChannel ||
    !repository ||
    !tag
  ) {
    throw new Error(
      "Usage: assemble-release-update-feeds.mjs --release-dir DIR --output DIR " +
        "--audit-output DIR --temporary DIR --release-channel CHANNEL " +
        "--repository OWNER/REPO --tag TAG",
    );
  }
  const outputs = await assembleReleaseUpdateFeeds({
    auditDirectory: path.resolve(auditDirectory),
    outputRoot: path.resolve(outputRoot),
    releaseChannel,
    releaseDirectory: path.resolve(releaseDirectory),
    repository,
    tag,
    temporaryDirectory: path.resolve(temporaryDirectory),
  });
  process.stdout.write(`Assembled ${outputs.length} update feed projections.\n`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
