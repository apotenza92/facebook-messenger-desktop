import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function installerName(channel, arch) {
  return `${channel === "beta" ? "Messenger-Beta" : "Messenger"}-windows-${arch}-setup.exe`;
}

export function expectedWindowsInputNames(releaseChannel, arch) {
  if (!["stable", "beta"].includes(releaseChannel))
    fail(`Unsupported Windows release channel ${releaseChannel}`);
  if (!["x64", "arm64"].includes(arch))
    fail(`Unsupported Windows architecture ${arch}`);
  const channels = releaseChannel === "stable" ? ["stable", "beta"] : ["beta"];
  return channels
    .map((channel) => installerName(channel, arch))
    .sort();
}

function assertExactDirectory(directory, expectedNames, label) {
  if (!existsSync(directory)) fail(`Missing ${label}`);
  const actual = readdirSync(directory).sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} files ${actual.join(", ") || "missing"} do not exactly match ${expected.join(", ")}`);
  for (const name of actual) {
    if (!statSync(join(directory, name)).isFile())
      fail(`${label}/${name} is not a regular file`);
  }
}

export function assembleWindowsRelease({
  inputDirectory,
  outputDirectory,
  releaseChannel,
}) {
  const sources = ["x64", "arm64"].map((arch) => ({
    arch,
    directory: join(inputDirectory, `windows-input-${arch}`),
  }));
  for (const source of sources)
    assertExactDirectory(
      source.directory,
      expectedWindowsInputNames(releaseChannel, source.arch),
      `${source.arch} Windows input`,
    );

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const source of sources) {
    for (const name of expectedWindowsInputNames(releaseChannel, source.arch)) {
      const destination = join(outputDirectory, name);
      if (existsSync(destination)) fail(`Windows outputs collide on ${name}`);
      copyFileSync(join(source.directory, name), destination);
    }
  }
}

const invoked =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const inputDirectory = resolve(option("--input-dir") ?? "artifacts/windows");
  const outputDirectory = resolve(
    option("--output-dir") ?? "artifacts/windows-assembled",
  );
  assembleWindowsRelease({
    inputDirectory,
    outputDirectory,
    releaseChannel: option("--release-channel"),
  });
  console.log(`Assembled exact unsigned Windows installer set in ${outputDirectory}`);
}
