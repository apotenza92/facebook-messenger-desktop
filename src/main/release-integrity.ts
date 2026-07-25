import { createHash } from "crypto";
import * as fs from "fs";

export function verifyReleaseAssetChecksum(
  checksums: string,
  assetName: string,
  assetPath: string,
): string {
  if (!assetName || assetName.includes("/") || assetName.includes("\\")) {
    throw new Error(`Invalid release asset name: ${assetName}`);
  }

  const entries = checksums
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})[ ]{2}([^/\\\0]+)$/);
      if (!match) {
        throw new Error(`SHA256SUMS contains a malformed entry: ${line}`);
      }
      return { digest: match[1], name: match[2] };
    });
  const matches = entries.filter((entry) => entry.name === assetName);
  if (matches.length !== 1) {
    throw new Error(
      `SHA256SUMS must contain exactly one entry for ${assetName}`,
    );
  }

  const actual = createHash("sha256")
    .update(fs.readFileSync(assetPath))
    .digest("hex");
  if (matches[0].digest !== actual) {
    throw new Error(`SHA256SUMS does not authenticate ${assetName}`);
  }
  return actual;
}
