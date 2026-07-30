#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function channelsForRelease(releaseChannel) {
  if (releaseChannel === "stable") return ["stable", "beta"];
  if (releaseChannel === "beta") return ["beta"];
  throw new Error(`Unsupported release channel: ${releaseChannel}`);
}

function copyRegularFile(source, destination) {
  const entry = fs.lstatSync(source);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${source} must be a regular non-symlink file.`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function prepareRefreshInput({ outputRoot, previousRoot, releaseChannel }) {
  if (fs.existsSync(outputRoot)) {
    throw new Error("Refresh input output must not already exist.");
  }
  for (const channel of channelsForRelease(releaseChannel)) {
    for (const arch of ["arm64", "x64"]) {
      copyRegularFile(
        path.join(
          previousRoot,
          channel,
          "darwin",
          arch,
          "latest-mac.yml",
        ),
        path.join(
          outputRoot,
          channel,
          "darwin",
          arch,
          "latest-mac.yml",
        ),
      );
      for (const [platform, targetName] of [
        ["win32", "latest.yml"],
        [
          "linux",
          arch === "arm64"
            ? "latest-linux-arm64.yml"
            : "latest-linux.yml",
        ],
      ]) {
        copyRegularFile(
          path.join(
            previousRoot,
            channel,
            platform,
            arch,
            "targets",
            targetName,
          ),
          path.join(
            outputRoot,
            channel,
            platform,
            arch,
            targetName,
          ),
        );
      }
    }
  }
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function main(argv = process.argv.slice(2)) {
  const outputRoot = option(argv, "--output");
  const previousRoot = option(argv, "--previous");
  const releaseChannel = option(argv, "--release-channel");
  if (!outputRoot || !previousRoot || !releaseChannel) {
    throw new Error(
      "Usage: prepare-update-feed-refresh.cjs --previous DIR " +
        "--output NEW_DIR --release-channel CHANNEL",
    );
  }
  prepareRefreshInput({
    outputRoot: path.resolve(outputRoot),
    previousRoot: path.resolve(previousRoot),
    releaseChannel,
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { prepareRefreshInput };
