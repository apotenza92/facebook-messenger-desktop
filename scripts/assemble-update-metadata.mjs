#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import contractModule from "../release-contract.cjs";

const { metadataFileName } = contractModule;
const CHANNELS = new Set(["stable", "beta"]);
const PLATFORMS = new Set(["darwin", "win32", "linux"]);
const ARCHITECTURES = new Set(["arm64", "x64"]);

function requireChoice(label, value, choices) {
  if (!choices.has(value)) {
    throw new Error(`${label} must be one of ${[...choices].join(", ")}.`);
  }
}

function artifactNameFromUrl(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("Every update file must have a URL.");
  }
  const candidate = /^https?:\/\//.test(value)
    ? new URL(value).pathname
    : value;
  const decoded = decodeURIComponent(path.posix.basename(candidate));
  if (
    !decoded ||
    decoded !== path.posix.basename(decoded) ||
    decoded.includes("\\")
  ) {
    throw new Error(`Unsafe update artifact name: ${value}`);
  }
  return decoded;
}

async function digest(filePath, algorithm, encoding) {
  return createHash(algorithm)
    .update(await readFile(filePath))
    .digest(encoding);
}

export async function assembleUpdateMetadata({
  arch,
  artifactDir,
  auditOutput,
  channel,
  input,
  outputRoot,
  platform,
  repository,
  tag,
}) {
  requireChoice("channel", channel, CHANNELS);
  requireChoice("platform", platform, PLATFORMS);
  requireChoice("architecture", arch, ARCHITECTURES);
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must use owner/name form.");
  }

  const source = yaml.load(await readFile(input, "utf8"));
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Update metadata must be a mapping.");
  }
  if (source.version !== tag.slice(1)) {
    throw new Error(`Update version ${source.version} does not match ${tag}.`);
  }
  if (!Array.isArray(source.files) || source.files.length === 0) {
    throw new Error("Update metadata contains no files.");
  }

  const seen = new Set();
  const releaseBase =
    `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const files = [];
  for (const file of source.files) {
    const name = artifactNameFromUrl(file.url);
    if (seen.has(name)) throw new Error(`Duplicate update artifact: ${name}`);
    seen.add(name);
    const target = path.resolve(artifactDir, name);
    const relative = path.relative(path.resolve(artifactDir), target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Artifact escapes directory: ${name}`);
    }
    const targetStat = await stat(target).catch(() => null);
    if (!targetStat?.isFile()) {
      throw new Error(`Referenced update artifact is missing: ${name}`);
    }
    const actualSha512 = await digest(target, "sha512", "base64");
    if (actualSha512 !== file.sha512) {
      throw new Error(`SHA-512 mismatch for ${name}.`);
    }
    if (file.size !== undefined && file.size !== targetStat.size) {
      throw new Error(`Size mismatch for ${name}.`);
    }
    files.push({
      ...file,
      url: `${releaseBase}/${encodeURIComponent(name)}`,
    });
  }

  const rewritten = { ...source, files };
  if (source.path) {
    const legacyName = artifactNameFromUrl(source.path);
    if (!seen.has(legacyName)) {
      throw new Error("Legacy update path does not match a files entry.");
    }
    rewritten.path = `${releaseBase}/${encodeURIComponent(legacyName)}`;
  }
  const contents = `${yaml.dump(rewritten, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }).trimEnd()}\n`;
  const output = path.join(
    outputRoot,
    channel,
    platform,
    arch,
    metadataFileName(platform, arch),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, contents);
  if (auditOutput) {
    await mkdir(path.dirname(auditOutput), { recursive: true });
    await writeFile(auditOutput, contents);
  }
  return { artifacts: [...seen], output };
}

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must use --name value pairs.");
    }
    values[key.slice(2)] = value;
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  for (const name of [
    "input",
    "artifact-dir",
    "output-root",
    "audit-output",
    "channel",
    "platform",
    "arch",
    "tag",
    "repository",
  ]) {
    if (!args[name]) throw new Error(`Missing --${name}.`);
  }
  const result = await assembleUpdateMetadata({
    input: path.resolve(args.input),
    artifactDir: path.resolve(args["artifact-dir"]),
    outputRoot: path.resolve(args["output-root"]),
    auditOutput: path.resolve(args["audit-output"]),
    channel: args.channel,
    platform: args.platform,
    arch: args.arch,
    tag: args.tag,
    repository: args.repository,
  });
  process.stdout.write(`${result.output}\n`);
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
