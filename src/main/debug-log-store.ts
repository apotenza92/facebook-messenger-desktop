import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

// Debug logs are on by default in beta builds and users are asked to send
// them with bug reports, so nothing written here may identify a person or a
// conversation. Records are redacted before they reach disk, and again on
// export for logs written by older versions:
// - strings under text-like keys (title, body, preview, name, label, ...)
//   become "[redacted N chars]";
// - Facebook/Messenger URLs keep their host and route shape, with ids and
//   query strings replaced;
// - runs of five or more digits (thread and user ids) become a salted hash,
//   stable for one installation so events about one chat can be correlated;
// - the home directory becomes "~", hiding the account name.

export const DEBUG_LOG_MAX_BYTES = 2 * 1024 * 1024;
const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 10;
const SALT_FILE_NAME = "debug-log-salt";

const TEXT_KEY_PATTERN =
  /title|body|text|preview|name|label|snippet|content|caption|sender|author|draft|search|query|corpus|message|alt$/i;
// Text-like key names whose values are app-defined codes or file names.
const SAFE_TEXT_KEYS = new Set([
  "eventname",
  "tagname",
  "classname",
  "hostname",
  "pathname",
  "filename",
  "sourcelabel",
  "servicename",
  "applicationname",
  "snappackagename",
  "linuxpackagename",
  "titlebarstyle",
  // Relative times such as "2h", needed to debug late-sync decisions.
  "timelabel",
]);

// Numeric values under these keys are Facebook ids, not counts or times.
const ID_KEY_PATTERN = /thread|user|account|actor|fbid|uid|profile|sender/i;

const URL_PATTERN = /^(?:https?:)?\/\/|^\/(?:t|e2ee|messages|marketplace)\//i;
const DIGIT_RUN_PATTERN = /\d{5,}/g;

export type DebugLogRedactor = (value: unknown) => unknown;

export function readOrCreateDebugLogSalt(userDataDir: string): string {
  const saltPath = path.join(userDataDir, SALT_FILE_NAME);
  try {
    const existing = fs.readFileSync(saltPath, "utf8").trim();
    if (/^[0-9a-f]{24,}$/.test(existing)) return existing;
  } catch {
    // Created below.
  }
  const salt = randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(saltPath, salt, { mode: 0o600 });
  } catch {
    // An unsaved salt still redacts; ids just won't correlate across runs.
  }
  return salt;
}

export function createDebugLogRedactor(options: {
  salt: string;
  homeDir?: string;
}): DebugLogRedactor {
  const hashId = (id: string) =>
    `#${createHash("sha256").update(`${options.salt}:${id}`).digest("hex").slice(0, 10)}`;
  const homeDir = options.homeDir && options.homeDir.length > 1
    ? options.homeDir
    : null;

  const scrubUrl = (value: string): string => {
    try {
      const url = new URL(value, "https://www.facebook.com");
      const segments = url.pathname.split("/").map((segment, index, all) => {
        const previous = all[index - 1];
        if (!segment) return segment;
        if (previous === "t" || /\d{5,}/.test(segment) || segment.length > 32) {
          return hashId(segment);
        }
        return segment;
      });
      const pathname = segments.join("/");
      const suffix = url.search || url.hash ? "?…" : "";
      return /^\//.test(value) && !/^\/\//.test(value)
        ? `${pathname}${suffix}`
        : `${url.protocol}//${url.host}${pathname}${suffix}`;
    } catch {
      return "[url]";
    }
  };

  const scrubString = (value: string): string => {
    // One pass per string: a hash is never scanned again, since its hex
    // digits could otherwise look like another id.
    let out: string;
    if (URL_PATTERN.test(value)) {
      out = scrubUrl(value);
    } else {
      out = homeDir ? value.split(homeDir).join("~") : value;
      out = out.replace(DIGIT_RUN_PATTERN, (digits) => hashId(digits));
    }
    return out.length > MAX_STRING_LENGTH
      ? `${out.slice(0, MAX_STRING_LENGTH)}…`
      : out;
  };

  const isTextKey = (key: string): boolean => {
    const lower = key.toLowerCase();
    return !SAFE_TEXT_KEYS.has(lower) && TEXT_KEY_PATTERN.test(lower);
  };

  const redactText = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.length === 0 ? "" : `[redacted ${value.length} chars]`;
    }
    if (Array.isArray(value)) return value.map(redactText);
    return redact(value, null, MAX_DEPTH);
  };

  const redact = (value: unknown, key: string | null, depth: number): unknown => {
    if (key !== null && isTextKey(key)) {
      // Nested objects under a text key (e.g. { title: { text } }) are still
      // walked so their structure stays visible.
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? redact(value, null, depth)
        : redactText(value);
    }
    if (typeof value === "string") return scrubString(value);
    if (
      typeof value === "number" &&
      key !== null &&
      ID_KEY_PATTERN.test(key) &&
      Math.abs(value) >= 10000
    ) {
      return hashId(String(value));
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (depth <= 0) return "[depth]";
    if (Array.isArray(value)) {
      return value.map((item) => redact(item, null, depth - 1));
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) {
        out[scrubString(childKey)] = redact(child, childKey, depth - 1);
      }
      return out;
    }
    return undefined;
  };

  return (value) => redact(value, null, MAX_DEPTH);
}

const FORMAT_MARKER_NAME = "debug-log-format";
const FORMAT_MARKER_VALUE = "redacted-v1";

// Logs from versions before redaction hold message text; delete them once
// rather than keep them around until rotation pushes them out.
export function purgeLegacyDebugLogs(
  userDataDir: string,
  logPaths: string[],
): boolean {
  const markerPath = path.join(userDataDir, FORMAT_MARKER_NAME);
  try {
    if (fs.readFileSync(markerPath, "utf8").trim() === FORMAT_MARKER_VALUE) {
      return false;
    }
  } catch {
    // No marker yet.
  }
  for (const logPath of logPaths) {
    for (const target of [logPath, getRotatedDebugLogPath(logPath)]) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // Best effort.
      }
    }
  }
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(markerPath, FORMAT_MARKER_VALUE);
  } catch {
    // Retried next launch.
  }
  return true;
}

export function getRotatedDebugLogPath(logPath: string): string {
  const ext = path.extname(logPath);
  return `${logPath.slice(0, logPath.length - ext.length)}.1${ext}`;
}

// Append-only NDJSON with one previous generation: when the current file
// passes the cap it replaces the previous one, so each log keeps between
// one and two caps of recent history across restarts.
export class DebugLogStore {
  private readonly sizes = new Map<string, number>();

  constructor(
    readonly redact: DebugLogRedactor,
    private readonly maxBytes = DEBUG_LOG_MAX_BYTES,
  ) {}

  append(logPath: string, record: unknown): void {
    const line = `${JSON.stringify(this.redact(record))}\n`;
    let size = this.sizes.get(logPath);
    if (size === undefined) {
      try {
        size = fs.statSync(logPath).size;
      } catch {
        size = 0;
      }
    }
    if (size > 0 && size + line.length > this.maxBytes) {
      try {
        fs.renameSync(logPath, getRotatedDebugLogPath(logPath));
      } catch {
        // Keep appending; a failed rotation only costs disk.
      }
      size = 0;
    }
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, "utf8");
    this.sizes.set(logPath, size + Buffer.byteLength(line));
  }

  // Previous generation then current, every line re-redacted. Lines that
  // are not JSON (truncated writes) are dropped rather than copied raw.
  exportTo(logPath: string, destinationPath: string): number {
    const lines: string[] = [];
    for (const source of [getRotatedDebugLogPath(logPath), logPath]) {
      let content = "";
      try {
        content = fs.readFileSync(source, "utf8");
      } catch {
        continue;
      }
      for (const raw of content.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        try {
          lines.push(JSON.stringify(this.redact(JSON.parse(raw))));
        } catch {
          // Skip partial lines.
        }
      }
    }
    fs.writeFileSync(
      destinationPath,
      lines.length > 0 ? `${lines.join("\n")}\n` : "",
      "utf8",
    );
    return lines.length;
  }
}
