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

// Stable releases build each branded variant (stable and the beta-branded
// copy for beta users) in its own job. This joins one architecture's variant
// artifacts back into the single input directory the assembly steps expect,
// failing instead of letting one variant overwrite another's file.

function fail(message) {
  throw new Error(message);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export function releaseVariants(releaseChannel) {
  if (releaseChannel === "stable") return ["stable", "beta"];
  if (releaseChannel === "beta") return ["beta"];
  return fail(`Unsupported release channel ${releaseChannel}`);
}

export function mergeReleaseVariants({
  inputDirectory,
  outputDirectory,
  prefix,
  arch,
  releaseChannel,
}) {
  const expected = releaseVariants(releaseChannel).map(
    (variant) => `${prefix}-${arch}-${variant}`,
  );
  const present = existsSync(inputDirectory)
    ? readdirSync(inputDirectory)
        .filter((name) => name.startsWith(`${prefix}-${arch}-`))
        .sort()
    : [];
  if (JSON.stringify(present) !== JSON.stringify([...expected].sort()))
    fail(
      `${prefix} ${arch} variants ${present.join(", ") || "missing"} do not exactly match ${expected.join(", ")}`,
    );

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const name of expected) {
    const source = join(inputDirectory, name);
    const files = readdirSync(source);
    if (files.length === 0) fail(`${name} is empty`);
    for (const file of files) {
      const from = join(source, file);
      if (!statSync(from).isFile()) fail(`${name}/${file} is not a regular file`);
      const to = join(outputDirectory, file);
      if (existsSync(to)) fail(`${prefix} ${arch} variants collide on ${file}`);
      copyFileSync(from, to);
    }
  }
}

const invoked =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  mergeReleaseVariants({
    inputDirectory: resolve(option("--input-dir") ?? fail("--input-dir is required")),
    outputDirectory: resolve(option("--output-dir") ?? fail("--output-dir is required")),
    prefix: option("--prefix") ?? fail("--prefix is required"),
    arch: option("--arch") ?? fail("--arch is required"),
    releaseChannel: option("--release-channel"),
  });
}
