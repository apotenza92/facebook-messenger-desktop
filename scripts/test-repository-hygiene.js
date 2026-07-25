const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

function fail(message) {
  throw new Error(message);
}

function listTrackedExistingFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
    cwd: projectRoot,
    encoding: "utf8",
    },
  );

  return output
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)));
}

function checkReleaseConfiguration(trackedFiles) {
  const releaseFiles = trackedFiles.filter(
    (relativePath) =>
      relativePath.startsWith(".github/workflows/") ||
      relativePath === "electron-builder.config.js" ||
      relativePath === "package.json" ||
      /^scripts\/(?:build|notarize|verify|assemble|create-winget|test-macos|test-winget)/.test(
        relativePath,
      ),
  );
  const retiredSecretNames =
    /\b(?:APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|CSC_LINK|CSC_KEY_PASSWORD|WINGET_TOKEN)\b/;

  for (const relativePath of releaseFiles) {
    const text = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    if (!relativePath.startsWith("scripts/test-") && retiredSecretNames.test(text)) {
      fail(`retired release secret name remains in ${relativePath}`);
    }
    if (!relativePath.startsWith(".github/workflows/")) continue;

    for (const match of text.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
      const action = match[1];
      if (!action.startsWith("./") && !/@[a-f0-9]{40}$/.test(action)) {
        fail(`third-party action is not pinned to a full commit in ${relativePath}: ${action}`);
      }
    }

    const referencedPaths = [
      ...text.matchAll(
        /(?:^|[\s'"`])(\.?\/?scripts\/[A-Za-z0-9._/-]+\.(?:js|mjs|cjs|ts|sh|ps1))/gm,
      ),
      ...text.matchAll(/uses:\s+(\.\/[A-Za-z0-9._/-]+\.ya?ml)\s*$/gm),
    ].map((match) => match[1].replace(/^\.\//, ""));
    for (const referencedPath of referencedPaths) {
      if (!fs.existsSync(path.join(projectRoot, referencedPath))) {
        fail(`${relativePath} references missing path: ${referencedPath}`);
      }
    }
  }
}

function checkObsoletePaths(trackedFiles) {
  const staleBasenames = new Set([
    "memory.md",
    "plan.md",
    "now.md",
    "worklog.md",
    "backlog.md",
    "roadmap.md",
    "handoff.md",
  ]);

  for (const relativePath of trackedFiles) {
    const normalized = relativePath.replaceAll("\\", "/");
    const basename = path.posix.basename(normalized).toLowerCase();
    if (
      staleBasenames.has(basename) ||
      normalized.startsWith("plans/") ||
      normalized.startsWith("evidence/")
    ) {
      fail(`obsolete planning or evidence file is tracked: ${relativePath}`);
    }
  }
}

function checkPackageScriptPaths() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const scripts = packageJson.scripts || {};
  const referencePattern = /(?:^|[\s"'])((?:\.\/)?scripts\/[A-Za-z0-9._/-]+)/g;

  for (const [name, command] of Object.entries(scripts)) {
    for (const match of String(command).matchAll(referencePattern)) {
      const relativePath = match[1].replace(/^\.\//, "");
      if (!fs.existsSync(path.join(projectRoot, relativePath))) {
        fail(`package script ${name} references missing path: ${relativePath}`);
      }
    }
  }
}

function checkRetiredToolingReferences(trackedFiles) {
  const forbidden = [
    ["dangerous Codex sandbox bypass", "--dangerously-bypass-approvals-and-sandbox"],
    ["Parallels-only tooling", "prlctl"],
    ["retired Ralphy integration", "ralphy"],
    ["retired issue autopilot", "issue49-autopilot"],
  ];

  for (const relativePath of trackedFiles) {
    if (
      relativePath === "CHANGELOG.md" ||
      relativePath === "scripts/test-repository-hygiene.js"
    )
      continue;
    const absolutePath = path.join(projectRoot, relativePath);
    const contents = fs.readFileSync(absolutePath);
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");

    for (const [label, needle] of forbidden) {
      if (text.toLowerCase().includes(needle.toLowerCase())) {
        fail(`${label} reference remains in ${relativePath}`);
      }
    }
  }
}

function run() {
  const trackedFiles = listTrackedExistingFiles();
  checkObsoletePaths(trackedFiles);
  checkPackageScriptPaths();
  checkRetiredToolingReferences(trackedFiles);
  checkReleaseConfiguration(trackedFiles);
  console.log("✓ Repository hygiene checks passed");
}

try {
  run();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
