import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "js-yaml";
import {
  createTufVerifiedUpdateFeed,
  validateTufRepositoryUrl,
} from "../src/main/tuf-update-feed";

type ReleaseContractModule = {
  metadataFileName: (platform: string, arch: string) => string;
};
const { metadataFileName } = require(
  "../release-contract.cjs",
) as ReleaseContractModule;

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function channelsForRelease(releaseChannel: string): string[] {
  if (releaseChannel === "stable") return ["stable", "beta"];
  if (releaseChannel === "beta") return ["beta"];
  throw new Error(`Unsupported release channel: ${releaseChannel}`);
}

function expectedArtifact(
  channel: string,
  platform: string,
  arch: string,
): string {
  const beta = channel === "beta";
  if (platform === "win32") {
    return `${beta ? "Messenger-Beta" : "Messenger"}-windows-${arch}-setup.exe`;
  }
  const linuxArch = arch === "x64" ? "x86_64" : "arm64";
  return `facebook-messenger-desktop${beta ? "-beta" : ""}-${linuxArch}.AppImage`;
}

async function verifyDocument(
  bytes: Buffer,
  {
    arch,
    channel,
    platform,
    repository,
    tag,
  }: {
    arch: string;
    channel: string;
    platform: string;
    repository: string;
    tag: string | null;
  },
): Promise<void> {
  const document = yaml.load(bytes.toString("utf8")) as {
    files?: Array<{ size?: number; url?: string }>;
    version?: string;
  };
  if (tag) assert.equal(document.version, tag.slice(1));
  assert.match(
    document.version || "",
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  );
  assert.ok(Array.isArray(document.files) && document.files.length > 0);
  const effectiveTag = tag || `v${document.version}`;
  const releaseBase =
    `https://github.com/${repository}/releases/download/${encodeURIComponent(effectiveTag)}/`;
  const expected =
    platform === "darwin"
      ? null
      : expectedArtifact(channel, platform, arch);
  let foundExpected = expected === null;
  for (const file of document.files) {
    assert.equal(typeof file.url, "string");
    assert.ok(file.url.startsWith(releaseBase));
    const artifactName = decodeURIComponent(
      path.posix.basename(new URL(file.url).pathname),
    );
    if (artifactName === expected) foundExpected = true;
    const response = await fetch(file.url, {
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
    });
    assert.ok(
      response.ok || response.status === 206,
      `${artifactName} was not publicly readable`,
    );
    await response.arrayBuffer();
  }
  assert.equal(
    foundExpected,
    true,
    `Feed omitted ${expected} for ${channel}/${platform}/${arch}`,
  );
}

async function main(): Promise<void> {
  const baseUrl = option("--base-url");
  const releaseChannel = option("--release-channel");
  const repository = option("--repository");
  const tag = option("--tag");
  if (!baseUrl || !releaseChannel || !repository) {
    throw new Error(
      "Usage: verify-published-update-feeds.ts --base-url URL " +
        "--release-channel CHANNEL --repository OWNER/REPO [--tag TAG]",
    );
  }
  const normalizedBaseUrl = validateTufRepositoryUrl(baseUrl);
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "messenger-live-update-feed-"),
  );
  try {
    for (const channel of channelsForRelease(releaseChannel)) {
      for (const arch of ["arm64", "x64"]) {
        for (const platform of ["darwin", "win32", "linux"]) {
          const repositoryUrl =
            `${normalizedBaseUrl}/${channel}/${platform}/${arch}`;
          const targetName = metadataFileName(platform, arch);
          let bytes: Buffer;
          if (platform === "darwin") {
            const response = await fetch(`${repositoryUrl}/${targetName}`, {
              redirect: "error",
            });
            assert.equal(response.status, 200);
            bytes = Buffer.from(await response.arrayBuffer());
          } else {
            const feed = await createTufVerifiedUpdateFeed({
              embeddedRootPath: path.join(
                __dirname,
                "..",
                "build",
                "update-trust",
                "root.json",
              ),
              repositoryUrl,
              targetName,
              trustDir: path.join(
                temporary,
                channel,
                platform,
                arch,
              ),
            });
            try {
              bytes = fs.readFileSync(feed.targetPath);
            } finally {
              await feed.close();
            }
          }
          await verifyDocument(bytes, {
            arch,
            channel,
            platform,
            repository,
            tag,
          });
        }
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
