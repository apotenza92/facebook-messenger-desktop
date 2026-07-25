import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import {
  resolveMacReleaseContract,
  validateNotarizationRecord,
} from "./macos-release-contract.mjs";

function fail(message) {
  throw new Error(message);
}

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hashFile(filePath, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(filePath)).digest(encoding);
}

export function mergeMacUpdateMetadata(documents, channel) {
  if (!Array.isArray(documents) || documents.length !== 2) {
    fail("Exactly one x64 and one arm64 metadata document are required");
  }
  const ordered = ["x64", "arm64"].map((arch) => {
    const item = documents.find((candidate) => candidate.arch === arch);
    if (!item) fail(`Missing ${arch} macOS updater metadata`);
    const contract = resolveMacReleaseContract(channel, arch);
    if (
      item.metadata?.version !== item.version ||
      !Array.isArray(item.metadata?.files)
    ) {
      fail(`${arch} metadata version/files are invalid`);
    }
    const file = item.metadata.files.find(
      (entry) => entry?.url === contract.artifactName,
    );
    if (!file)
      fail(`${arch} metadata does not reference ${contract.artifactName}`);
    if (file.size !== item.size || file.sha512 !== item.sha512) {
      fail(`${arch} metadata does not match the assembled ZIP`);
    }
    return { arch, contract, file, metadata: item.metadata };
  });
  if (ordered[0].metadata.version !== ordered[1].metadata.version) {
    fail("x64 and arm64 updater metadata versions do not match");
  }
  const releaseDates = ordered
    .map((item) => item.metadata.releaseDate)
    .filter(Boolean)
    .sort();
  return {
    version: ordered[0].metadata.version,
    files: ordered.map((item) => item.file),
    // Older electron-updater clients use path/sha512. Preserve the historical
    // x64 fallback while modern clients select the matching entry in files.
    path: ordered[0].file.url,
    sha512: ordered[0].file.sha512,
    ...(releaseDates.length > 0 ? { releaseDate: releaseDates.at(-1) } : {}),
  };
}

export function assembleMacRelease({
  inputDirectory,
  outputDirectory,
  releaseChannel,
}) {
  const channels = releaseChannel === "stable" ? ["stable", "beta"] : ["beta"];
  if (!["stable", "beta"].includes(releaseChannel))
    fail(`Unsupported release channel: ${releaseChannel}`);
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const checksumLines = [];

  for (const channel of channels) {
    const metadataDocuments = [];
    for (const arch of ["x64", "arm64"]) {
      const contract = resolveMacReleaseContract(channel, arch);
      const sourceDirectory = join(inputDirectory, `macos-input-${arch}`);
      const requiredNames = [
        contract.artifactName,
        contract.blockmapName,
        `${contract.artifactName}.sha256`,
        contract.notarizationName,
        contract.metadataName,
      ];
      for (const fileName of requiredNames) {
        if (!existsSync(join(sourceDirectory, fileName)))
          fail(`Missing macOS input: ${arch}/${fileName}`);
      }

      for (const fileName of requiredNames.slice(0, 4)) {
        const sourcePath = join(sourceDirectory, fileName);
        const destinationPath = join(outputDirectory, fileName);
        if (existsSync(destinationPath))
          fail(`Duplicate assembled macOS output: ${fileName}`);
        copyFileSync(sourcePath, destinationPath);
      }
      const artifactPath = join(sourceDirectory, contract.artifactName);
      validateNotarizationRecord(
        JSON.parse(
          readFileSync(
            join(sourceDirectory, contract.notarizationName),
            "utf8",
          ),
        ),
      );
      const actualSha256 = hashFile(artifactPath, "sha256", "hex");
      const checksum = readFileSync(`${artifactPath}.sha256`, "utf8").trim();
      if (checksum !== `${actualSha256}  ${contract.artifactName}`) {
        fail(`${contract.artifactName}.sha256 does not match its ZIP`);
      }
      checksumLines.push(`${actualSha256}  ${contract.artifactName}`);
      metadataDocuments.push({
        arch,
        metadata: yaml.load(
          readFileSync(join(sourceDirectory, contract.metadataName), "utf8"),
        ),
        sha512: hashFile(artifactPath, "sha512", "base64"),
        size: statSync(artifactPath).size,
        version: JSON.parse(
          readFileSync(
            join(resolve(import.meta.dirname, ".."), "package.json"),
            "utf8",
          ),
        ).version,
      });
    }
    const merged = mergeMacUpdateMetadata(metadataDocuments, channel);
    const metadataName = resolveMacReleaseContract(channel, "x64").metadataName;
    writeFileSync(
      join(outputDirectory, metadataName),
      yaml.dump(merged, { lineWidth: -1, noRefs: true }),
      { mode: 0o644 },
    );
  }
  writeFileSync(
    join(outputDirectory, "SHA256SUMS-macos.txt"),
    `${checksumLines.sort().join("\n")}\n`,
    { mode: 0o644 },
  );
}

const invoked =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  assembleMacRelease({
    inputDirectory: resolve(
      readOption("--input-dir", join(repositoryRoot, "artifacts", "macos")),
    ),
    outputDirectory: resolve(
      readOption(
        "--output-dir",
        join(repositoryRoot, "artifacts", "macos-assembled"),
      ),
    ),
    releaseChannel: readOption(
      "--release-channel",
      process.env.MESSENGER_RELEASE_CHANNEL,
    ),
  });
  console.log(
    `Assembled native macOS ${process.env.MESSENGER_RELEASE_CHANNEL ?? readOption("--release-channel")} release metadata.`,
  );
}
