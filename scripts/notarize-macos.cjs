const { spawnSync } = require("node:child_process");
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`,
    );
  }
  return result;
}

function parseJson(result, label) {
  for (const value of [result.stdout, result.stderr]) {
    if (!value?.trim()) continue;
    try {
      return JSON.parse(value);
    } catch {
      // notarytool can place non-JSON diagnostics on either stream.
    }
  }
  throw new Error(`${label} did not return valid JSON`);
}

module.exports = async function notarizeMacApplication(context) {
  if (process.env.MESSENGER_REQUIRE_RELEASE_SIGNING !== "true") return;

  const { resolveMacReleaseContract, validateNotarizationRecord } =
    await import("./macos-release-contract.mjs");
  const channel = process.env.MESSENGER_RELEASE_CHANNEL;
  const arch = process.env.MESSENGER_RELEASE_ARCH;
  const contract = resolveMacReleaseContract(channel, arch);
  for (const name of [
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ]) {
    if (!process.env[name]?.trim()) {
      throw new Error(
        `Required notarization environment variable is missing: ${name}`,
      );
    }
  }

  const appPath = join(context.appOutDir, contract.appName);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "messenger-notary-"));
  chmodSync(temporaryDirectory, 0o700);
  const submissionPath = join(
    temporaryDirectory,
    `${contract.productName}.zip`,
  );
  const authorization = [
    "--key",
    process.env.APPLE_API_KEY,
    "--key-id",
    process.env.APPLE_API_KEY_ID,
    "--issuer",
    process.env.APPLE_API_ISSUER,
  ];

  try {
    run(
      "ditto",
      [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        contract.appName,
        submissionPath,
      ],
      {
        cwd: context.appOutDir,
      },
    );
    const submissionResult = run(
      "xcrun",
      [
        "notarytool",
        "submit",
        submissionPath,
        ...authorization,
        "--wait",
        "--output-format",
        "json",
      ],
      { allowFailure: true },
    );
    const submission = parseJson(submissionResult, "Notarization submission");
    if (typeof submission.id !== "string") {
      throw new Error(
        `Notarization submission did not return an ID: ${JSON.stringify(submission)}`,
      );
    }

    const logResult = run(
      "xcrun",
      [
        "notarytool",
        "log",
        submission.id,
        ...authorization,
        "--output-format",
        "json",
      ],
      { allowFailure: true },
    );
    const log = parseJson(logResult, `Notarization log ${submission.id}`);
    const record = validateNotarizationRecord({ submission, log });
    for (const issue of Array.isArray(log.issues) ? log.issues : []) {
      const severity = String(issue?.severity ?? "unknown").toLowerCase();
      const issuePath = issue?.path ? ` (${issue.path})` : "";
      console.warn(
        `Notarization ${severity}${issuePath}: ${issue?.message ?? "No message"}`,
      );
    }
    if (submissionResult.status !== 0 || logResult.status !== 0) {
      throw new Error(
        `Notarization command failed for submission ${submission.id}`,
      );
    }

    writeFileSync(
      join(context.outDir, contract.notarizationName),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o644 },
    );
    run("xcrun", ["stapler", "staple", appPath]);
    run("xcrun", ["stapler", "validate", appPath]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};
