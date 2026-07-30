import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { assembleUpdateMetadata } from "./assemble-update-metadata.mjs";
import { createUpdateMetadata } from "./create-update-metadata.mjs";
import contractModule from "../release-contract.cjs";

const { metadataFileName, releaseContract } = contractModule;

test("release contract isolates channels, platforms, and architectures", () => {
  const stable = releaseContract({
    channel: "stable",
    platform: "win32",
    arch: "x64",
  });
  const beta = releaseContract({
    channel: "beta",
    platform: "win32",
    arch: "x64",
  });
  assert.equal(stable.productName, "Messenger");
  assert.equal(beta.productName, "Messenger Beta");
  assert.notEqual(stable.appId, beta.appId);
  assert.notEqual(stable.feedUrl, beta.feedUrl);
  assert.equal(metadataFileName("darwin", "arm64"), "latest-mac.yml");
  assert.equal(metadataFileName("win32", "arm64"), "latest.yml");
  assert.equal(
    metadataFileName("linux", "arm64"),
    "latest-linux-arm64.yml",
  );
});

test("metadata assembly authenticates local artifacts and pins release URLs", async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "messenger-update-metadata-"),
  );
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const artifactDir = path.join(temporary, "artifacts");
  const artifactName = "Messenger-Beta-windows-x64-setup.exe";
  const artifact = Buffer.from("installer");
  await mkdir(artifactDir);
  await writeFile(path.join(artifactDir, artifactName), artifact);
  const input = path.join(temporary, "beta.yml");
  await writeFile(
    input,
    yaml.dump({
      version: "1.3.1-beta.45",
      files: [
        {
          url: artifactName,
          sha512: createHash("sha512").update(artifact).digest("base64"),
          size: artifact.length,
        },
      ],
      path: artifactName,
      sha512: createHash("sha512").update(artifact).digest("base64"),
    }),
  );
  const result = await assembleUpdateMetadata({
    arch: "x64",
    artifactDir,
    auditOutput: path.join(temporary, "audit", "latest.yml"),
    channel: "beta",
    input,
    outputRoot: path.join(temporary, "updates"),
    platform: "win32",
    repository: "apotenza92/facebook-messenger-desktop",
    tag: "v1.3.1-beta.45",
  });
  const output = yaml.load(await readFile(result.output, "utf8"));
  assert.equal(
    output.files[0].url,
    "https://github.com/apotenza92/facebook-messenger-desktop/releases/download/v1.3.1-beta.45/Messenger-Beta-windows-x64-setup.exe",
  );
  assert.equal(output.path, output.files[0].url);
});

test("metadata assembly rejects version, digest, and traversal mismatches", async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "messenger-update-metadata-bad-"),
  );
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const artifactDir = path.join(temporary, "artifacts");
  await mkdir(artifactDir);
  await writeFile(path.join(artifactDir, "update.exe"), "installer");
  const input = path.join(temporary, "latest.yml");
  await writeFile(
    input,
    yaml.dump({
      version: "1.3.1-beta.44",
      files: [{ url: "update.exe", sha512: "wrong" }],
    }),
  );
  await assert.rejects(
    assembleUpdateMetadata({
      arch: "x64",
      artifactDir,
      auditOutput: path.join(temporary, "audit.yml"),
      channel: "beta",
      input,
      outputRoot: path.join(temporary, "updates"),
      platform: "win32",
      repository: "apotenza92/facebook-messenger-desktop",
      tag: "v1.3.1-beta.45",
    }),
    /does not match/,
  );
});

test("metadata creation produces a full-download electron-updater document", async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "messenger-update-metadata-create-"),
  );
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const artifactPath = path.join(temporary, "Messenger-windows-x64-setup.exe");
  const outputPath = path.join(temporary, "latest.yml");
  await writeFile(artifactPath, "installer");
  await createUpdateMetadata({
    artifactPath,
    outputPath,
    version: "1.3.1-beta.45",
  });
  const document = yaml.load(await readFile(outputPath, "utf8"));
  assert.equal(document.version, "1.3.1-beta.45");
  assert.equal(document.files[0].url, path.basename(artifactPath));
  assert.equal(document.files[0].size, 9);
  assert.equal(document.path, path.basename(artifactPath));
  assert.equal(document.sha512, document.files[0].sha512);
});
