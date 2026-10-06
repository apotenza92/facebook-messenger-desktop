import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

// Opt-in notification structure probe. When enabled, Facebook's own web
// notifications are allowed to fire into the page so their structure and
// lifecycle can be recorded, but they are never shown: the page probe
// records and drops them, and the app's existing sidebar notifications
// stay the only ones the user sees. Events contain shapes, flags, lengths
// and per-run salted hashes only; never titles, bodies, names or ids.

export const NOTIFICATION_PROBE_LOG_NAME = "notification-probe.ndjson";
const SETTINGS_NAME = "notification-probe.json";
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_STRING_LENGTH = 200;

export const getNotificationProbeSettingsPath = (userDataDir: string) =>
  path.join(userDataDir, SETTINGS_NAME);

export const getNotificationProbeLogPath = (logsDir: string) =>
  path.join(logsDir, NOTIFICATION_PROBE_LOG_NAME);

export const readNotificationProbeEnabled = (
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (env.MESSENGER_NOTIFICATION_PROBE === "1") return true;
  if (env.MESSENGER_NOTIFICATION_PROBE === "0") return false;
  try {
    const raw = fs.readFileSync(
      getNotificationProbeSettingsPath(userDataDir),
      "utf8",
    );
    return JSON.parse(raw)?.enabled === true;
  } catch {
    return false;
  }
};

export const writeNotificationProbeEnabled = (
  userDataDir: string,
  enabled: boolean,
): void => {
  fs.writeFileSync(
    getNotificationProbeSettingsPath(userDataDir),
    JSON.stringify({ enabled }),
    "utf8",
  );
};

// Salt for thread hashes, fixed for one app run so events from the page,
// reloads and main can be correlated without revealing thread ids.
export const createNotificationProbeSalt = (): string =>
  randomBytes(12).toString("hex");

const clampValue = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…`
      : value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth <= 0) return "[depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => clampValue(item, depth - 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      out[key.slice(0, 64)] = clampValue(item, depth - 1);
    }
    return out;
  }
  return undefined;
};

// Normalise an event from the page: bounded strings, depth and size, a
// required event name, and a main-process timestamp.
export const sanitizeNotificationProbeEvent = (
  raw: unknown,
  now = Date.now(),
): Record<string, unknown> | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = (raw as Record<string, unknown>).event;
  if (typeof event !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(event)) {
    return null;
  }
  const clamped = clampValue(raw, 8) as Record<string, unknown>;
  const record = { ...clamped, event, receivedAt: now };
  if (JSON.stringify(record).length > MAX_EVENT_BYTES) {
    return { event, receivedAt: now, truncated: true };
  }
  return record;
};

export class NotificationProbeLog {
  private readonly logPath: string;
  private queue: string[] = [];
  private writing = false;

  constructor(logsDir: string) {
    fs.mkdirSync(logsDir, { recursive: true });
    this.logPath = getNotificationProbeLogPath(logsDir);
  }

  get path(): string {
    return this.logPath;
  }

  append(record: Record<string, unknown>): void {
    this.queue.push(`${JSON.stringify(record)}\n`);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.splice(0, this.queue.length).join("");
        await this.rotateIfNeeded();
        await fs.promises.appendFile(this.logPath, chunk, "utf8");
      }
    } catch (error) {
      console.warn("[NotificationProbe] Failed to write probe log:", error);
    } finally {
      this.writing = false;
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.logPath);
      if (stat.size < MAX_LOG_BYTES) return;
      await fs.promises.rename(this.logPath, `${this.logPath}.1`);
    } catch {
      // Missing file: nothing to rotate.
    }
  }
}
