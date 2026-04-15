import { execFileSync, spawnSync, SpawnSyncOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT_DIR = path.resolve(__dirname, "..");
const AUTOPILOT_ROOT = path.join(ROOT_DIR, ".tmp", "issue49-autopilot");
const CLONE_DIR = path.join(AUTOPILOT_ROOT, "repo");
const RUNS_DIR = path.join(AUTOPILOT_ROOT, "runs");
const SESSION_DIR = path.join(AUTOPILOT_ROOT, "pi-sessions");
const STATE_PATH = path.join(AUTOPILOT_ROOT, "state.json");
const STATUS_MD_PATH = path.join(AUTOPILOT_ROOT, "status.md");
const LOG_PATH = path.join(AUTOPILOT_ROOT, "autopilot.log");

type AutopilotStatus =
  | "ready-for-beta"
  | "needs-human"
  | "no-action";

type AutopilotResult = {
  status: AutopilotStatus;
  summary: string[];
  confidence: "high" | "medium" | "low";
  releaseVersion: string | null;
  commitMessage?: string;
  replyPath?: string;
  notes?: string[];
};

const QUICK_FOLLOW_UP_BATCH_WINDOW_MS = 30 * 60 * 1000;

type TrackedCommentState = {
  commentId: number;
  author: string;
  createdAt: string;
  status: AutopilotStatus | "failed";
  runDir: string;
  releaseVersion?: string | null;
  commitSha?: string;
  releaseUrl?: string;
  issueCommentUrl?: string;
  error?: string;
  updatedAt: string;
};

type AutopilotState = {
  issueNumber: number;
  cycleCount: number;
  handledComments: Record<string, TrackedCommentState>;
  bootstrapComplete?: boolean;
  lastSeenWatchedCommentId?: number;
  lastCheckedAt?: string;
  stoppedReason?: string;
};

type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  html_url: string;
  user?: { login?: string };
};

type GitHubIssueComment = {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: { login?: string; type?: string };
};

let statusOptions: CliOptions | null = null;

type CliOptions = {
  loop: boolean;
  dryRun: boolean;
  publicActions: boolean;
  pollSeconds: number;
  maxCycles: number;
  issueNumber: number;
  watchUsers: string[];
  once: boolean;
  replayHistory: boolean;
  model?: string;
  thinking?: string;
};

function getPendingWatchedComments(
  comments: GitHubIssueComment[],
  state: AutopilotState,
  ownerLogin: string,
  watchUsers: string[],
): GitHubIssueComment[] {
  return comments.filter((comment) => {
    if (!shouldWatchComment(comment, ownerLogin, watchUsers)) {
      return false;
    }
    if (
      typeof state.lastSeenWatchedCommentId === "number" &&
      comment.id <= state.lastSeenWatchedCommentId
    ) {
      return false;
    }
    return !state.handledComments[String(comment.id)];
  });
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function log(message: string, payload?: unknown): void {
  ensureDir(AUTOPILOT_ROOT);
  const timestamp = new Date().toISOString();
  const rendered = payload === undefined ? "" : ` ${JSON.stringify(payload)}`;
  const line = `[issue49-autopilot] ${timestamp} ${message}${rendered}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions & { cwd?: string; allowFailure?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT_DIR,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const status = result.status ?? 0;
  if (status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${status}\n${stdout}\n${stderr}`,
    );
  }
  return { stdout, stderr, status };
}

function ghJson<T>(args: string[]): T {
  const { stdout } = runCommand("gh", args, { cwd: ROOT_DIR });
  return JSON.parse(stdout) as T;
}

function parseRemoteOwnerRepo(): {
  owner: string;
  repo: string;
  remoteUrl: string;
} {
  const { stdout } = runCommand(
    "git",
    ["remote", "get-url", "origin"],
    { cwd: ROOT_DIR },
  );
  const remote = stdout.trim();
  const match = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/i);
  if (!match) {
    throw new Error(`Could not parse GitHub owner/repo from remote: ${remote}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    remoteUrl: remote,
  };
}

function loadState(issueNumber: number): AutopilotState {
  ensureDir(AUTOPILOT_ROOT);
  if (!fs.existsSync(STATE_PATH)) {
    return {
      issueNumber,
      cycleCount: 0,
      handledComments: {},
    };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as AutopilotState;
}

function renderStatusMarkdown(state: AutopilotState): string {
  const options = statusOptions;
  const handled = Object.values(state.handledComments).sort(
    (left, right) => left.commentId - right.commentId,
  );
  const recentHandled = handled.slice(-10).reverse();

  const lines = [
    "# Issue #49 autopilot status",
    "",
    `Updated: ${new Date().toISOString()}`,
    `Mode: ${options?.publicActions ? "public-actions" : "dry-run"}`,
    `Polling: every ${options?.pollSeconds ?? "?"} seconds`,
    `Max cycles: ${options?.maxCycles ?? "?"}`,
    `Cycle count: ${state.cycleCount}`,
    `Bootstrap complete: ${state.bootstrapComplete === true ? "yes" : "no"}`,
    `Last seen watched comment ID: ${state.lastSeenWatchedCommentId ?? "none"}`,
    `Last checked: ${state.lastCheckedAt ?? "never"}`,
    `Stopped reason: ${state.stoppedReason ?? "running"}`,
    `Watch users: ${options?.watchUsers?.length ? options.watchUsers.join(", ") : "any non-owner commenter"}`,
    "",
    "## Runtime files",
    "",
    `- State JSON: ${STATE_PATH}`,
    `- Log: ${LOG_PATH}`,
    `- Sessions: ${SESSION_DIR}`,
    `- Runs: ${RUNS_DIR}`,
    "",
    "## Recent handled comments",
    "",
  ];

  if (recentHandled.length === 0) {
    lines.push("- none yet", "");
  } else {
    lines.push(
      "| Comment ID | Author | Status | Release | Updated |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const entry of recentHandled) {
      lines.push(
        `| ${entry.commentId} | ${entry.author} | ${entry.status} | ${entry.releaseVersion ?? "-"} | ${entry.updatedAt} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Notes",
    "",
    "- This file is rewritten automatically by the issue #49 autopilot.",
    "- The watcher is bounded; it stops after the configured max cycles or if the issue closes.",
    "- Public actions means the autopilot may push to `main`, create beta releases, and post issue replies.",
    "",
  );

  return lines.join("\n");
}

function saveState(state: AutopilotState): void {
  ensureDir(AUTOPILOT_ROOT);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  fs.writeFileSync(STATUS_MD_PATH, renderStatusMarkdown(state), "utf8");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    loop: true,
    dryRun: false,
    publicActions: process.env.ISSUE49_AUTOPILOT_PUBLIC === "1",
    pollSeconds: Number(process.env.ISSUE49_AUTOPILOT_POLL_SECONDS || 300),
    maxCycles: Number(process.env.ISSUE49_AUTOPILOT_MAX_CYCLES || 8),
    issueNumber: Number(process.env.ISSUE49_AUTOPILOT_ISSUE || 49),
    watchUsers: String(process.env.ISSUE49_AUTOPILOT_WATCH_USERS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    once: false,
    replayHistory: process.env.ISSUE49_AUTOPILOT_REPLAY_HISTORY === "1",
    model: process.env.ISSUE49_AUTOPILOT_PI_MODEL || undefined,
    thinking: process.env.ISSUE49_AUTOPILOT_PI_THINKING || undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--once":
        options.once = true;
        options.loop = false;
        break;
      case "--loop":
        options.loop = true;
        options.once = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--public-actions":
        options.publicActions = true;
        break;
      case "--poll-seconds":
        options.pollSeconds = Number(argv[index + 1] || 300);
        index += 1;
        break;
      case "--max-cycles":
        options.maxCycles = Number(argv[index + 1] || 8);
        index += 1;
        break;
      case "--issue":
        options.issueNumber = Number(argv[index + 1] || 49);
        index += 1;
        break;
      case "--watch-user":
        options.watchUsers.push(String(argv[index + 1] || "").trim());
        index += 1;
        break;
      case "--replay-history":
        options.replayHistory = true;
        break;
      case "--model":
        options.model = String(argv[index + 1] || "").trim() || undefined;
        index += 1;
        break;
      case "--thinking":
        options.thinking = String(argv[index + 1] || "").trim() || undefined;
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node -r ./scripts/register-ts.js scripts/issue49-autopilot.ts [options]\n\nOptions:\n  --once                 Run one poll cycle and exit\n  --loop                 Keep polling (default)\n  --dry-run              Analyze only, never push/release/comment\n  --public-actions       Allow push to main, beta release, and issue comment\n  --poll-seconds <n>     Poll interval in seconds (default: 300)\n  --max-cycles <n>       Stop after this many handled comments (default: 8)\n  --issue <n>            Issue number to monitor (default: 49)\n  --watch-user <login>   Restrict handling to specific reporter login(s)\n  --replay-history       Process existing watched comments instead of baselining the latest one on first run\n  --model <pattern>      Pass a specific pi model\n  --thinking <level>     Pass a specific pi thinking level\n`);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.watchUsers = Array.from(new Set(options.watchUsers.filter(Boolean)));
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds < 15) {
    throw new Error(`Invalid --poll-seconds value: ${options.pollSeconds}`);
  }
  if (!Number.isFinite(options.maxCycles) || options.maxCycles < 1) {
    throw new Error(`Invalid --max-cycles value: ${options.maxCycles}`);
  }
  return options;
}

function ensureTooling(): void {
  runCommand("gh", ["--version"]);
  runCommand("git", ["--version"]);
  runCommand("pi", ["--version"]);
}

function ensureCloneSynced(owner: string, repo: string, remoteUrl: string): void {
  ensureDir(AUTOPILOT_ROOT);
  if (!fs.existsSync(path.join(CLONE_DIR, ".git"))) {
    log("Cloning dedicated autopilot repo", { cloneDir: CLONE_DIR, remoteUrl });
    runCommand("git", ["clone", remoteUrl, CLONE_DIR]);
  }

  runCommand("git", ["fetch", "origin"], { cwd: CLONE_DIR });
  runCommand("git", ["checkout", "main"], { cwd: CLONE_DIR });
  runCommand("git", ["reset", "--hard", "origin/main"], { cwd: CLONE_DIR });
  runCommand("git", ["clean", "-fd"], { cwd: CLONE_DIR });
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function collectAttachmentUrls(body: string): string[] {
  const matches = body.match(/https?:\/\/[^\s)\]>]+/g) || [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const value = raw.replace(/[)"'>.,]+$/, "");
    const interesting =
      /githubusercontent\.com/i.test(value) ||
      /user-attachments/i.test(value) ||
      /\.(zip|png|jpg|jpeg|gif|webp|txt|log|json)$/i.test(value);
    if (!interesting || seen.has(value)) {
      continue;
    }
    seen.add(value);
    urls.push(value);
  }
  return urls;
}

function sanitizeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function downloadFile(url: string, targetPath: string): void {
  ensureDir(path.dirname(targetPath));
  runCommand("bash", ["-lc", `curl -L --fail --silent --show-error ${JSON.stringify(url)} -o ${JSON.stringify(targetPath)}`]);
}

function buildIssueContext(issue: GitHubIssue, comments: GitHubIssueComment[]): string {
  const recent = comments.slice(-8);
  const sections = [
    `# Issue #${issue.number}`,
    "",
    `Title: ${issue.title}`,
    `State: ${issue.state}`,
    `URL: ${issue.html_url}`,
    "",
    "## Issue body",
    "",
    issue.body || "(empty)",
    "",
    "## Recent comments",
    "",
  ];

  for (const comment of recent) {
    sections.push(
      `### Comment ${comment.id} by ${comment.user?.login || "unknown"} at ${comment.created_at}`,
      "",
      comment.body || "(empty)",
      "",
      `Link: ${comment.html_url}`,
      "",
    );
  }

  return sections.join("\n");
}

function buildPrompt(params: {
  issueNumber: number;
  commentIds: number[];
  runDir: string;
  resultPath: string;
  replyPath: string;
  currentVersion: string;
}): string {
  return [
    `You are running the bounded autopilot for issue #${params.issueNumber}.`,
    "",
    "Work in the current git clone only. Never push, never release, and never post a GitHub comment yourself.",
    "",
    `Target reporter comment IDs: ${params.commentIds.join(", ")}`,
    `Current package version before your changes: ${params.currentVersion}`,
    `Run artifacts directory: ${params.runDir}`,
    "",
    "Goals:",
    "1. Decide whether this new reporter comment slice requires a code/test/change response.",
    "2. If a fix is warranted and confidence is high enough, implement the minimum safe patch, add/extend deterministic regression coverage, run the validation commands, and prepare the next beta release in the repo (CHANGELOG.md, package.json, package-lock.json).",
    "3. If confidence is insufficient or the evidence is ambiguous, stop and mark needs-human.",
    "4. Keep public-facing text neutral; do not use real names unless already strictly necessary from URLs or issue references. Use reporter/account aliases in any drafted reply.",
    "",
    "Required validation commands for a ready-for-beta result:",
    "- npm run test:release",
    "- npm run test:issues",
    "- npm run test:issue49:offline",
    "- npm run build",
    "",
    "Always write these two files:",
    `- ${params.resultPath}`,
    `- ${params.replyPath}`,
    "",
    "The result JSON must have this exact shape:",
    "{",
    '  "status": "ready-for-beta" | "needs-human" | "no-action",',
    '  "summary": ["bullet 1", "bullet 2"],',
    '  "confidence": "high" | "medium" | "low",',
    '  "releaseVersion": "1.3.1-beta.X" | null,',
    '  "commitMessage": "fix: ... (#49)",',
    '  "replyPath": "absolute-path-to-reply-md",',
    '  "notes": ["optional extra note"]',
    "}",
    "",
    "Rules for each status:",
    "- ready-for-beta: use only if you implemented the fix, updated release metadata to the next beta prerelease version, and all required validation commands passed in this clone. Set releaseVersion to that beta version and write a ready-to-post reply markdown file that includes the placeholder {{RELEASE_URL}} where the final release link should go.",
    "- needs-human: use if the evidence is ambiguous, the bug is not actionable yet, or you cannot reach a release-quality patch with strong confidence. Do not bump version in this case.",
    "- no-action: use if the new comment does not require code changes or a public follow-up. Do not bump version in this case.",
    "",
    "If multiple quick-succession reporter comments are included in this slice, evaluate them together against the current repo state and the latest beta prepared in the repo. If the newest report is already addressed by the just-prepared beta or by code already on main, prefer `no-action` over another redundant release.",
    "If you touch files, keep the patch minimal and add regression coverage. If you conclude no release should happen, leave the app version unchanged.",
  ].join("\n");
}

function currentPackageVersion(repoDir: string): string {
  const pkg = readJsonFile<{ version: string }>(path.join(repoDir, "package.json"));
  return pkg.version;
}

function isPrereleaseVersion(value: string | null | undefined): boolean {
  return Boolean(value && /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.]+$/.test(value));
}

function renderCommentsMarkdown(comments: GitHubIssueComment[]): string {
  const sections = ["# Target reporter comment slice", ""];
  for (const comment of comments) {
    sections.push(
      `## Comment ${comment.id}`,
      "",
      `Author: ${comment.user?.login || "unknown"}`,
      `Created: ${comment.created_at}`,
      `Updated: ${comment.updated_at}`,
      `URL: ${comment.html_url}`,
      "",
      comment.body || "(empty)",
      "",
    );
  }
  return sections.join("\n");
}

function buildCommentBatch(comments: GitHubIssueComment[]): GitHubIssueComment[] {
  if (comments.length <= 1) {
    return comments;
  }
  const batch: GitHubIssueComment[] = [comments[0]];
  for (let index = 1; index < comments.length; index += 1) {
    const previous = batch[batch.length - 1];
    const current = comments[index];
    const sameAuthor =
      String(previous.user?.login || "") === String(current.user?.login || "");
    const previousAt = Date.parse(previous.created_at);
    const currentAt = Date.parse(current.created_at);
    const withinWindow =
      Number.isFinite(previousAt) &&
      Number.isFinite(currentAt) &&
      currentAt - previousAt <= QUICK_FOLLOW_UP_BATCH_WINDOW_MS;
    if (!sameAuthor || !withinWindow) {
      break;
    }
    batch.push(current);
  }
  return batch;
}

function getRunIdForComments(comments: GitHubIssueComment[]): string {
  const firstComment = comments[0];
  const lastComment = comments[comments.length - 1];
  return comments.length === 1
    ? `comment-${firstComment.id}`
    : `comment-${firstComment.id}-to-${lastComment.id}`;
}

function normalizeReplyBody(replyBody: string, releaseUrl: string | null): string {
  const trimmed = replyBody.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (releaseUrl) {
    return trimmed.replace(/\{\{RELEASE_URL\}\}/g, releaseUrl);
  }
  return trimmed.replace(/\{\{RELEASE_URL\}\}/g, "(release pending)");
}

function fetchIssue(owner: string, repo: string, issueNumber: number): GitHubIssue {
  return ghJson<GitHubIssue>([
    "api",
    `repos/${owner}/${repo}/issues/${issueNumber}`,
  ]);
}

function fetchComments(
  owner: string,
  repo: string,
  issueNumber: number,
): GitHubIssueComment[] {
  return ghJson<GitHubIssueComment[]>([
    "api",
    `repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
  ]);
}

function shouldWatchComment(
  comment: GitHubIssueComment,
  ownerLogin: string,
  watchUsers: string[],
): boolean {
  const login = String(comment.user?.login || "").trim();
  const type = String(comment.user?.type || "").trim();
  if (!login) return false;
  if (type.toLowerCase() === "bot") return false;
  if (watchUsers.length > 0) {
    return watchUsers.includes(login);
  }
  return login !== ownerLogin;
}

function findNextComment(
  comments: GitHubIssueComment[],
  state: AutopilotState,
  ownerLogin: string,
  watchUsers: string[],
): GitHubIssueComment | null {
  return getPendingWatchedComments(comments, state, ownerLogin, watchUsers)[0] ?? null;
}

function gitStatusShort(repoDir: string): string {
  return runCommand("git", ["status", "--short"], { cwd: repoDir }).stdout.trim();
}

function waitForRelease(version: string, timeoutMs = 90 * 60 * 1000): string {
  const started = Date.now();
  const tag = `v${version}`;
  while (Date.now() - started < timeoutMs) {
    const result = runCommand(
      "gh",
      [
        "release",
        "view",
        tag,
        "--json",
        "url,isDraft,isPrerelease,assets",
      ],
      { cwd: CLONE_DIR, allowFailure: true },
    );
    if (result.status === 0) {
      const release = JSON.parse(result.stdout) as {
        url: string;
        isDraft: boolean;
        assets: unknown[];
      };
      if (!release.isDraft && Array.isArray(release.assets) && release.assets.length > 0) {
        return release.url;
      }
    }
    log("Waiting for release to become available", { version });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  }
  throw new Error(`Timed out waiting for release v${version}`);
}

function markHandled(
  state: AutopilotState,
  entry: TrackedCommentState,
): void {
  state.handledComments[String(entry.commentId)] = entry;
  state.lastSeenWatchedCommentId = Math.max(
    entry.commentId,
    state.lastSeenWatchedCommentId || 0,
  );
  state.lastCheckedAt = new Date().toISOString();
  saveState(state);
}

function runPiForComment(params: {
  options: CliOptions;
  commentIds: number[];
  runDir: string;
  issueContextPath: string;
  commentPath: string;
  attachmentPaths: string[];
  resultPath: string;
  replyPath: string;
}): void {
  ensureDir(SESSION_DIR);
  const args = ["--continue", "--session-dir", SESSION_DIR, "-p"];
  if (params.options.model) {
    args.push("--model", params.options.model);
  }
  if (params.options.thinking) {
    args.push("--thinking", params.options.thinking);
  }
  args.push(`@${params.issueContextPath}`, `@${params.commentPath}`);
  for (const attachmentPath of params.attachmentPaths) {
    args.push(`@${attachmentPath}`);
  }
  args.push(
    buildPrompt({
      issueNumber: params.options.issueNumber,
      commentIds: params.commentIds,
      runDir: params.runDir,
      resultPath: params.resultPath,
      replyPath: params.replyPath,
      currentVersion: currentPackageVersion(CLONE_DIR),
    }),
  );

  const piResult = runCommand("pi", args, {
    cwd: CLONE_DIR,
    allowFailure: true,
  });
  writeFile(path.join(params.runDir, "pi-stdout.txt"), piResult.stdout);
  writeFile(path.join(params.runDir, "pi-stderr.txt"), piResult.stderr);
  if (piResult.status !== 0) {
    throw new Error(`pi failed for comment run ${params.runDir}`);
  }
}

function maybeRefreshPackageLock(repoDir: string, beforeVersion: string, afterVersion: string): void {
  if (beforeVersion === afterVersion) {
    return;
  }
  runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
    cwd: repoDir,
  });
}

function validatePreparedRelease(repoDir: string): void {
  const commands = [
    ["npm", ["run", "test:release"]],
    ["npm", ["run", "test:issues"]],
    ["npm", ["run", "test:issue49:offline"]],
    ["npm", ["run", "build"]],
  ] as Array<[string, string[]]>;

  for (const [command, args] of commands) {
    log("Running validation command", { command, args });
    const result = runCommand(command, args, { cwd: repoDir, allowFailure: true });
    const safeName = `${command}-${args.join("_").replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
    writeFile(path.join(AUTOPILOT_ROOT, "last-validation", `${safeName}.stdout.log`), result.stdout);
    writeFile(path.join(AUTOPILOT_ROOT, "last-validation", `${safeName}.stderr.log`), result.stderr);
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed`);
    }
  }
}

function commitPreparedRelease(repoDir: string, commitMessage: string): string {
  runCommand("git", ["add", "-A"], { cwd: repoDir });
  const status = gitStatusShort(repoDir);
  if (!status) {
    throw new Error("No repo changes to commit after ready-for-beta result");
  }
  runCommand("git", ["commit", "-m", commitMessage], { cwd: repoDir });
  return runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir }).stdout.trim();
}

function pushAndRelease(repoDir: string, releaseVersion: string): string {
  runCommand("git", ["push", "origin", "main"], { cwd: repoDir });
  runCommand("bash", ["-lc", `./scripts/release.sh ${releaseVersion}`], { cwd: repoDir });
  return waitForRelease(releaseVersion);
}

function postIssueComment(issueNumber: number, replyBody: string): string {
  const tempFile = path.join(AUTOPILOT_ROOT, `issue-${issueNumber}-reply.md`);
  writeFile(tempFile, replyBody);
  const result = runCommand(
    "gh",
    ["issue", "comment", String(issueNumber), "--body-file", tempFile],
    { cwd: CLONE_DIR },
  );
  return result.stdout.trim();
}

function processCommentBatch(
  issue: GitHubIssue,
  comments: GitHubIssueComment[],
  targetComments: GitHubIssueComment[],
  state: AutopilotState,
  options: CliOptions,
): void {
  const runId = getRunIdForComments(targetComments);
  const runDir = path.join(RUNS_DIR, runId);
  const attachmentsDir = path.join(runDir, "attachments");
  const resultPath = path.join(runDir, "result.json");
  const replyPath = path.join(runDir, "reply.md");
  const issueContextPath = path.join(runDir, "issue-context.md");
  const commentPath = path.join(runDir, "comment.md");
  ensureDir(runDir);
  ensureDir(attachmentsDir);
  writeFile(issueContextPath, buildIssueContext(issue, comments));
  writeFile(commentPath, renderCommentsMarkdown(targetComments));

  const attachmentPaths: string[] = [];
  for (const comment of targetComments) {
    for (const url of collectAttachmentUrls(comment.body || "")) {
      try {
        const pathname = new URL(url).pathname;
        const basename = sanitizeFileComponent(
          path.basename(pathname) || `attachment-${attachmentPaths.length + 1}`,
        );
        const targetPath = path.join(
          attachmentsDir,
          basename || `attachment-${attachmentPaths.length + 1}`,
        );
        downloadFile(url, targetPath);
        attachmentPaths.push(targetPath);
      } catch (error) {
        log("Attachment download failed", {
          commentId: comment.id,
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const beforeVersion = currentPackageVersion(CLONE_DIR);
  runPiForComment({
    options,
    commentIds: targetComments.map((comment) => comment.id),
    runDir,
    issueContextPath,
    commentPath,
    attachmentPaths,
    resultPath,
    replyPath,
  });

  if (!fs.existsSync(resultPath)) {
    throw new Error(`pi did not create result file: ${resultPath}`);
  }

  const result = readJsonFile<AutopilotResult>(resultPath);
  if (!Array.isArray(result.summary)) {
    throw new Error(`Invalid autopilot result summary in ${resultPath}`);
  }
  if (!["ready-for-beta", "needs-human", "no-action"].includes(result.status)) {
    throw new Error(`Invalid autopilot status in ${resultPath}`);
  }

  const afterVersion = currentPackageVersion(CLONE_DIR);
  maybeRefreshPackageLock(CLONE_DIR, beforeVersion, afterVersion);

  if (result.status !== "ready-for-beta") {
    for (const comment of targetComments) {
      markHandled(state, {
        commentId: comment.id,
        author: comment.user?.login || "unknown",
        createdAt: comment.created_at,
        status: result.status,
        runDir,
        releaseVersion: null,
        updatedAt: new Date().toISOString(),
      });
    }
    state.cycleCount += 1;
    saveState(state);
    log("Autopilot finished without public release", {
      commentIds: targetComments.map((comment) => comment.id),
      status: result.status,
      summary: result.summary,
    });
    return;
  }

  if (!isPrereleaseVersion(result.releaseVersion)) {
    throw new Error(`ready-for-beta result is missing valid prerelease version`);
  }
  if (result.releaseVersion === beforeVersion || afterVersion !== result.releaseVersion) {
    throw new Error(
      `ready-for-beta result did not prepare the expected version bump (before=${beforeVersion}, after=${afterVersion}, result=${result.releaseVersion})`,
    );
  }
  if (!fs.existsSync(replyPath)) {
    throw new Error(`ready-for-beta result is missing reply draft: ${replyPath}`);
  }

  validatePreparedRelease(CLONE_DIR);
  const commitMessage =
    String(result.commitMessage || "").trim() ||
    `fix: issue #${options.issueNumber} autopilot follow-up (${comment.id})`;
  const commitSha = commitPreparedRelease(CLONE_DIR, commitMessage);

  let releaseUrl: string | undefined;
  let issueCommentUrl: string | undefined;
  if (!options.dryRun && options.publicActions) {
    releaseUrl = pushAndRelease(CLONE_DIR, result.releaseVersion!);
    const replyBody = normalizeReplyBody(
      fs.readFileSync(replyPath, "utf8"),
      releaseUrl,
    );
    if (replyBody.trim()) {
      issueCommentUrl = postIssueComment(options.issueNumber, replyBody);
    }
  } else {
    log("Dry run / no public actions enabled; skipping push, release, and issue comment", {
      commentIds: targetComments.map((comment) => comment.id),
      releaseVersion: result.releaseVersion,
    });
  }

  for (const comment of targetComments) {
    markHandled(state, {
      commentId: comment.id,
      author: comment.user?.login || "unknown",
      createdAt: comment.created_at,
      status: "ready-for-beta",
      runDir,
      releaseVersion: result.releaseVersion,
      commitSha,
      releaseUrl,
      issueCommentUrl,
      updatedAt: new Date().toISOString(),
    });
  }
  state.cycleCount += 1;
  saveState(state);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  statusOptions = options;
  const { owner, repo, remoteUrl } = parseRemoteOwnerRepo();
  const ownerLogin = owner;
  const state = loadState(options.issueNumber);
  ensureTooling();
  ensureDir(RUNS_DIR);
  ensureDir(SESSION_DIR);
  log("Starting issue autopilot", {
    owner,
    repo,
    issueNumber: options.issueNumber,
    dryRun: options.dryRun,
    publicActions: options.publicActions,
    pollSeconds: options.pollSeconds,
    maxCycles: options.maxCycles,
    watchUsers: options.watchUsers,
    replayHistory: options.replayHistory,
  });

  while (true) {
    const issue = fetchIssue(owner, repo, options.issueNumber);
    state.lastCheckedAt = new Date().toISOString();
    saveState(state);

    if (issue.state === "closed") {
      state.stoppedReason = "issue-closed";
      saveState(state);
      log("Issue is already closed; stopping autopilot", { issueNumber: issue.number });
      return;
    }

    if (state.cycleCount >= options.maxCycles) {
      state.stoppedReason = `max-cycles-reached:${options.maxCycles}`;
      saveState(state);
      log("Reached max bounded autopilot cycles; stopping", {
        cycleCount: state.cycleCount,
        maxCycles: options.maxCycles,
      });
      return;
    }

    ensureCloneSynced(owner, repo, remoteUrl);
    const comments = fetchComments(owner, repo, options.issueNumber);
    if (!state.bootstrapComplete && !options.replayHistory) {
      const watchedComments = comments.filter((comment) =>
        shouldWatchComment(comment, ownerLogin, options.watchUsers),
      );
      const latestWatchedComment = watchedComments[watchedComments.length - 1] || null;
      state.bootstrapComplete = true;
      state.lastSeenWatchedCommentId = latestWatchedComment?.id || 0;
      saveState(state);
      log("Bootstrapped watcher state to latest existing watched comment", {
        lastSeenWatchedCommentId: state.lastSeenWatchedCommentId,
      });
      if (options.once || !options.loop) {
        return;
      }
      await sleep(options.pollSeconds * 1000);
      continue;
    }
    state.bootstrapComplete = true;
    saveState(state);
    const pendingComments = getPendingWatchedComments(
      comments,
      state,
      ownerLogin,
      options.watchUsers,
    );
    const nextComment = pendingComments[0] ?? null;

    if (!nextComment) {
      log("No new reporter comment found", { issueNumber: options.issueNumber });
      if (options.once || !options.loop) {
        return;
      }
      await sleep(options.pollSeconds * 1000);
      continue;
    }

    const targetComments = buildCommentBatch(pendingComments);
    const batchRunId = getRunIdForComments(targetComments);

    log("Processing reporter comment slice", {
      commentIds: targetComments.map((comment) => comment.id),
      author: targetComments[0].user?.login,
      createdAt: targetComments[0].created_at,
      pendingCount: pendingComments.length,
      batchCount: targetComments.length,
    });

    try {
      processCommentBatch(issue, comments, targetComments, state, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Autopilot cycle failed", { commentIds: targetComments.map((comment) => comment.id), error: message });
      for (const comment of targetComments) {
        markHandled(state, {
          commentId: comment.id,
          author: comment.user?.login || "unknown",
          createdAt: comment.created_at,
          status: "failed",
          runDir:
            path.join(RUNS_DIR, batchRunId),
          error: message,
          updatedAt: new Date().toISOString(),
        });
      }
      state.cycleCount += 1;
      saveState(state);
      if (options.once || !options.loop) {
        throw error;
      }
    }

    if (options.once || !options.loop) {
      return;
    }

    const remainingPending = getPendingWatchedComments(
      fetchComments(owner, repo, options.issueNumber),
      state,
      ownerLogin,
      options.watchUsers,
    );
    if (remainingPending.length > 0) {
      log("Draining queued reporter comments without sleeping", {
        nextCommentId: remainingPending[0].id,
        remainingCount: remainingPending.length,
      });
      continue;
    }

    await sleep(options.pollSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
