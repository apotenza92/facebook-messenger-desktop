#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export async function createUpdateMetadata({
  artifactPath,
  outputPath,
  version,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid update version: ${version}`);
  }
  const artifactName = path.basename(artifactPath);
  if (!artifactName || artifactName.includes("\\") || artifactName === ".") {
    throw new Error(`Unsafe update artifact name: ${artifactName}`);
  }
  const bytes = await readFile(artifactPath);
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile()) {
    throw new Error("Update artifact must be a regular file.");
  }
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const document = {
    version,
    files: [{ url: artifactName, sha512, size: artifactStat.size }],
    path: artifactName,
    sha512,
  };
  await writeFile(
    outputPath,
    `${yaml.dump(document, { lineWidth: -1, noRefs: true }).trimEnd()}\n`,
  );
  return document;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export async function main(argv = process.argv.slice(2)) {
  const artifactPath = option(argv, "--artifact");
  const outputPath = option(argv, "--output");
  const version = option(argv, "--version");
  if (!artifactPath || !outputPath || !version) {
    throw new Error(
      "Usage: create-update-metadata.mjs --artifact FILE --output FILE --version VERSION",
    );
  }
  await createUpdateMetadata({
    artifactPath: path.resolve(artifactPath),
    outputPath: path.resolve(outputPath),
    version,
  });
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
