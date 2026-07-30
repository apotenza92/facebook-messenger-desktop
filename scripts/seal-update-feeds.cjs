#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  signUpdateRepository,
} = require("./sign-tuf-update-repository.cjs");

const CHANNELS = new Set(["stable", "beta"]);

function channelsForRelease(releaseChannel) {
  if (!CHANNELS.has(releaseChannel)) {
    throw new Error(`Unsupported release channel: ${releaseChannel}`);
  }
  return releaseChannel === "stable" ? ["stable", "beta"] : ["beta"];
}

function copyRegularFile(source, destination) {
  const entry = fs.lstatSync(source);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${source} must be a regular non-symlink file.`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function copyDirectory(source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Update feed history cannot contain symlinks: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      copyRegularFile(sourcePath, destinationPath);
    } else {
      throw new Error(`Unsupported update feed history entry: ${sourcePath}`);
    }
  }
}

function sealUpdateFeeds({
  inputRoot,
  now = new Date(),
  outputRoot,
  previousRoot,
  privateKeys,
  releaseChannel,
  forceRefresh = false,
  rootPath = path.join(
    __dirname,
    "..",
    "build",
    "update-trust",
    "root.json",
  ),
}) {
  if (fs.existsSync(outputRoot)) {
    throw new Error("Sealed update feed output must not already exist.");
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, ".nojekyll"), "", {
    flag: "wx",
  });
  const sealed = [];
  for (const channel of channelsForRelease(releaseChannel)) {
    for (const arch of ["arm64", "x64"]) {
      const macSource = path.join(
        inputRoot,
        channel,
        "darwin",
        arch,
        "latest-mac.yml",
      );
      const macDestination = path.join(
        outputRoot,
        channel,
        "darwin",
        arch,
        "latest-mac.yml",
      );
      copyRegularFile(macSource, macDestination);
      sealed.push(path.relative(outputRoot, macDestination));

      for (const [platform, targetName] of [
        ["win32", "latest.yml"],
        [
          "linux",
          arch === "arm64"
            ? "latest-linux-arm64.yml"
            : "latest-linux.yml",
        ],
      ]) {
        const inputDirectory = path.join(
          inputRoot,
          channel,
          platform,
          arch,
        );
        const previousMetadataDirectory = previousRoot
          ? path.join(
              previousRoot,
              channel,
              platform,
              arch,
              "metadata",
            )
          : null;
        const usablePrevious =
          previousMetadataDirectory &&
          fs.existsSync(
            path.join(previousMetadataDirectory, "timestamp.json"),
          )
            ? previousMetadataDirectory
            : null;
        const outputDirectory = path.join(
          outputRoot,
          channel,
          platform,
          arch,
        );
        const targetPath = path.join(inputDirectory, targetName);
        const previousDirectory = usablePrevious
          ? path.dirname(usablePrevious)
          : null;
        const previousTargetPath = previousDirectory
          ? path.join(previousDirectory, "targets", targetName)
          : null;
        if (
          !forceRefresh &&
          previousTargetPath &&
          fs.existsSync(previousTargetPath) &&
          fs.readFileSync(previousTargetPath).equals(fs.readFileSync(targetPath))
        ) {
          fs.mkdirSync(outputDirectory, { recursive: true });
          copyDirectory(previousDirectory, outputDirectory);
        } else {
          signUpdateRepository({
            now,
            outputDirectory,
            previousMetadataDirectory: usablePrevious,
            privateKeys,
            rootPath,
            targetName,
            targetPath,
          });
        }
        sealed.push(path.relative(outputRoot, outputDirectory));
      }
    }
  }
  fs.writeFileSync(
    path.join(outputRoot, "feed-manifest.json"),
    `${JSON.stringify(
      {
        releaseChannel,
        sealed: sealed.sort(),
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  return sealed;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const inputRoot = option(argv, "--input");
  const outputRoot = option(argv, "--output");
  const previousRoot = option(argv, "--previous");
  const releaseChannel = option(argv, "--release-channel");
  const forceRefresh = argv.includes("--refresh-metadata");
  if (!inputRoot || !outputRoot || !releaseChannel) {
    throw new Error(
      "Usage: seal-update-feeds.cjs --input DIR --output NEW_DIR " +
        "--release-channel CHANNEL [--previous DIR]",
    );
  }
  const privateKeys = Object.fromEntries(
    ["targets", "snapshot", "timestamp"].map((role) => {
      const name =
        `MESSENGER_TUF_${role.toUpperCase()}_PRIVATE_KEY_PEM`;
      if (!env[name]) throw new Error(`Missing ${name}.`);
      return [role, env[name]];
    }),
  );
  const now = env.MESSENGER_TUF_METADATA_NOW
    ? new Date(env.MESSENGER_TUF_METADATA_NOW)
    : new Date();
  const sealed = sealUpdateFeeds({
    inputRoot: path.resolve(inputRoot),
    now,
    outputRoot: path.resolve(outputRoot),
    previousRoot: previousRoot ? path.resolve(previousRoot) : null,
    privateKeys,
    releaseChannel,
    forceRefresh,
  });
  process.stdout.write(`Sealed ${sealed.length} update feed paths.\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  sealUpdateFeeds,
};
