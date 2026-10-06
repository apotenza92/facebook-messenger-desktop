const path = require("path");
const { EventEmitter } = require("events");

const APP_ROOT = process.env.MESSENGER_APP_ROOT
  ? path.resolve(process.env.MESSENGER_APP_ROOT)
  : path.resolve(__dirname, "..");

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) {
    throw new Error(
      `${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`,
    );
  }
};

const flushImmediates = (rounds = 5): Promise<void> =>
  new Promise((resolve) => {
    let remaining = rounds;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else setImmediate(step);
    };
    setImmediate(step);
  });

const runProcessErrorGuardTests = async () => {
  const { installPipeErrorGuards, isBrokenPipeError } = require(
    path.join(APP_ROOT, "src/main/process-error-guards.ts"),
  );

  const fakeProcess = new EventEmitter();
  fakeProcess.stdout = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  const reports: string[] = [];
  installPipeErrorGuards(fakeProcess, (message: string) =>
    reports.push(message),
  );

  // An ordinary uncaught exception must be reported exactly once. The old
  // handler re-threw from setImmediate, which re-entered the handler forever.
  const realUncaught = process.listeners("uncaughtException");
  let escaped = 0;
  const trap = () => {
    escaped += 1;
  };
  process.on("uncaughtException", trap);
  try {
    fakeProcess.emit("uncaughtException", new Error("boom"));
    await flushImmediates();
  } finally {
    process.removeListener("uncaughtException", trap);
  }
  assertEqual(escaped, 0, "guard must not re-throw uncaught exceptions");
  assertEqual(reports.length, 1, "uncaught exception reported once");
  assert(
    reports[0].startsWith("[App] Uncaught exception:") &&
      reports[0].includes("boom"),
    "uncaught exception report uses the [App] prefix and includes the error",
  );
  assertEqual(
    process.listeners("uncaughtException").length,
    realUncaught.length,
    "test trap removed",
  );

  fakeProcess.emit("unhandledRejection", new Error("load aborted"));
  assertEqual(reports.length, 2, "unhandled rejection reported");
  assert(
    reports[1].startsWith("[App] Unhandled rejection:"),
    "unhandled rejection report uses the [App] prefix",
  );

  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  fakeProcess.emit("uncaughtException", epipe);
  fakeProcess.stdout.emit("error", epipe);
  fakeProcess.stderr.emit("error", new Error("write EPIPE"));
  assertEqual(reports.length, 2, "broken pipes are swallowed silently");
  assert(isBrokenPipeError(epipe), "EPIPE code detected");
  assert(!isBrokenPipeError(new Error("other")), "other errors not EPIPE");

  const throwingReporterProcess = new EventEmitter();
  installPipeErrorGuards(throwingReporterProcess, () => {
    throw new Error("stderr closed");
  });
  throwingReporterProcess.emit("uncaughtException", new Error("boom"));

  console.log("PASS process error guards");
};

const runPageBridgePolicyTests = () => {
  const { isTrustedPageBridgeMessage } = require(
    path.join(APP_ROOT, "src/preload/page-bridge-policy.ts"),
  );
  const ownWindow = {};
  const otherFrame = {};

  assert(
    isTrustedPageBridgeMessage(
      { source: ownWindow, origin: "https://www.facebook.com" },
      ownWindow,
    ),
    "messages from the app's own Facebook window are trusted",
  );
  assert(
    isTrustedPageBridgeMessage(
      { source: ownWindow, origin: "https://www.messenger.com" },
      ownWindow,
    ),
    "messages from the app's own Messenger window are trusted",
  );
  assert(
    !isTrustedPageBridgeMessage(
      { source: otherFrame, origin: "https://www.facebook.com" },
      ownWindow,
    ),
    "messages posted by another frame are rejected even on a Facebook origin",
  );
  assert(
    !isTrustedPageBridgeMessage({ source: null, origin: "" }, ownWindow),
    "messages without a source are rejected",
  );
  for (const origin of [
    "https://evil.example",
    "http://www.facebook.com",
    "https://facebook.com.evil.example",
    "null",
  ]) {
    assert(
      !isTrustedPageBridgeMessage({ source: ownWindow, origin }, ownWindow),
      `origin ${origin} is rejected`,
    );
  }

  console.log("PASS page bridge policy");
};

const fakeElement = (
  tagName: string,
  attributes: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) => ({
  tagName: tagName.toUpperCase(),
  textContent: "draft: meet me at 6, door code 4821",
  getAttribute: (name: string) =>
    Object.prototype.hasOwnProperty.call(attributes, name)
      ? attributes[name]
      : null,
  ...extra,
});

const runDebugRedactionTests = () => {
  const { describeInteractionTarget } = require(
    path.join(APP_ROOT, "src/preload/debug-redaction-policy.ts"),
  );

  const composer = describeInteractionTarget(
    fakeElement(
      "div",
      {
        role: "textbox",
        "aria-label": "Message Tester A",
        contenteditable: "true",
      },
      { isContentEditable: true },
    ),
  );
  const serializedComposer = JSON.stringify(composer);
  assert(
    !serializedComposer.includes("door code") &&
      !serializedComposer.includes("Tester A"),
    "composer description must not include draft text or its label",
  );
  assertEqual(composer.role, "textbox", "composer role kept");
  assertEqual(composer.editable, true, "composer marked editable");

  const textarea = describeInteractionTarget(
    fakeElement("textarea", { title: "Reply to Tester B" }),
  );
  assert(
    !JSON.stringify(textarea).includes("Tester B"),
    "textarea title dropped",
  );

  const button = describeInteractionTarget(
    fakeElement("button", { "aria-label": "Close", role: "button" }),
  );
  assertEqual(button.ariaLabel, "Close", "button labels are kept");
  assert(
    !JSON.stringify(button).includes("door code"),
    "text content is never recorded",
  );

  const link = describeInteractionTarget(
    fakeElement("a", {}, { href: "https://www.facebook.com/messages/" }),
  );
  assertEqual(
    link.href,
    "https://www.facebook.com/messages/",
    "link href kept",
  );
  assertEqual(describeInteractionTarget(null), null, "null target");

  console.log("PASS debug redaction policy");
};

const runRendererDebugFlagTests = () => {
  const { encodeRendererDebugFlags, decodeRendererDebugFlags } = require(
    path.join(APP_ROOT, "src/shared/debug-flags.ts"),
  );
  const off = decodeRendererDebugFlags(
    encodeRendererDebugFlags({ mediaOverlay: false, reload: false }),
  );
  assertEqual(off.mediaOverlay, false, "media overlay flag off round-trips");
  assertEqual(off.reload, false, "reload flag off round-trips");
  const on = decodeRendererDebugFlags([
    "electron",
    ...encodeRendererDebugFlags({ mediaOverlay: true, reload: true }),
  ]);
  assertEqual(on.mediaOverlay, true, "media overlay flag on round-trips");
  assertEqual(on.reload, true, "reload flag on round-trips");
  const missing = decodeRendererDebugFlags(["electron", "--type=renderer"]);
  assertEqual(
    missing.mediaOverlay || missing.reload,
    false,
    "absent flags default to off",
  );
  console.log("PASS renderer debug flags");
};

const runNotificationProbeLogTests = async () => {
  const fs = require("fs");
  const os = require("os");
  const {
    readNotificationProbeEnabled,
    writeNotificationProbeEnabled,
    sanitizeNotificationProbeEvent,
    NotificationProbeLog,
  } = require(path.join(APP_ROOT, "src/main/notification-probe.ts"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-probe-"));
  try {
    assertEqual(readNotificationProbeEnabled(dir, {}), false, "probe off by default");
    writeNotificationProbeEnabled(dir, true);
    assertEqual(readNotificationProbeEnabled(dir, {}), true, "probe setting persists");
    assertEqual(
      readNotificationProbeEnabled(dir, { MESSENGER_NOTIFICATION_PROBE: "0" }),
      false,
      "env can force the probe off",
    );

    assertEqual(sanitizeNotificationProbeEvent(null), null, "null rejected");
    assertEqual(
      sanitizeNotificationProbeEvent({ event: "Bad Name" }),
      null,
      "event names are restricted",
    );
    const long = sanitizeNotificationProbeEvent(
      { event: "native-constructed", note: "x".repeat(5000) },
      123,
    );
    assert(
      String(long.note).length <= 201 && long.receivedAt === 123,
      "long strings are clamped and a receive time is stamped",
    );
    const huge = sanitizeNotificationProbeEvent({
      event: "row-shape",
      shape: Array.from({ length: 200 }, () => ({ a: "y".repeat(200) })),
    });
    assertEqual(huge.truncated, true, "oversized events are truncated");

    const log = new NotificationProbeLog(dir);
    log.append({ event: "marker", marker: 1 });
    log.append({ event: "marker", marker: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = fs.readFileSync(log.path, "utf8").trim().split("\n");
    assertEqual(lines.length, 2, "probe log appends ndjson lines");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("PASS notification probe log");
};

const run = async () => {
  await runProcessErrorGuardTests();
  runPageBridgePolicyTests();
  runDebugRedactionTests();
  runRendererDebugFlagTests();
  await runNotificationProbeLogTests();
  console.log("PASS stability tests");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
