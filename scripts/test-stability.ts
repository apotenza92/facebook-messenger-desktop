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
    const readLines = () =>
      fs.existsSync(log.path)
        ? fs.readFileSync(log.path, "utf8").trim().split("\n")
        : [];
    for (let waited = 0; readLines().length < 2 && waited < 2000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const lines = readLines();
    assertEqual(lines.length, 2, "probe log appends ndjson lines");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("PASS notification probe log");
};

const runDebugLogStoreTests = () => {
  const fs = require("fs");
  const os = require("os");
  const {
    DebugLogStore,
    createDebugLogRedactor,
    readOrCreateDebugLogSalt,
    getRotatedDebugLogPath,
    purgeLegacyDebugLogs,
  } = require(path.join(APP_ROOT, "src/main/debug-log-store.ts"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-debug-log-"));
  try {
    const salt = readOrCreateDebugLogSalt(dir);
    assertEqual(readOrCreateDebugLogSalt(dir), salt, "salt persists per install");

    const home = "/Users/tester-a";
    const redact = createDebugLogRedactor({ salt, homeDir: home });
    const event = {
      event: "Sidebar notification skipped - muted conversation",
      source: "preload",
      url: "https://www.facebook.com/messages/t/1234567890123?ref=x",
      payload: {
        href: "/t/1234567890123",
        title: "Tester A",
        body: "door code 4821",
        preview: "see you at 6",
        realNames: ["Tester A", "Tester B"],
        ariaLabel: "Chat with Tester B",
        sourceLabel: "MUTATION",
        timeLabel: "2h",
        reason: "group-row-non-message-shape",
        previewLength: 12,
        unread: true,
        nested: { title: { text: "Tester C" } },
        threadId: 1234567890123,
        threadCountAfter: 3,
      },
      stack: `Error at ${home}/AppData/app.js:10`,
    };
    const out = redact(event);
    const serialized = JSON.stringify(out);
    for (const secret of [
      "Tester",
      "door code",
      "see you",
      "1234567890123",
      "tester-a",
      "ref=x",
    ]) {
      assert(!serialized.includes(secret), `redacted output leaks ${secret}`);
    }
    assertEqual(out.event, event.event, "app event names are kept");
    assertEqual(out.payload.sourceLabel, "MUTATION", "source codes are kept");
    assertEqual(out.payload.timeLabel, "2h", "relative times are kept");
    assertEqual(out.payload.reason, event.payload.reason, "reasons are kept");
    assertEqual(out.payload.previewLength, 12, "numbers are kept");
    assertEqual(out.payload.threadCountAfter, 3, "small counts are kept");
    assertEqual(
      out.payload.threadId,
      out.payload.href.slice(3),
      "numeric thread ids hash like string ones",
    );
    assertEqual(out.payload.title, "[redacted 8 chars]", "titles are redacted");
    assert(
      /^\/t\/#[0-9a-f]{10}$/.test(out.payload.href),
      "thread keys keep their shape",
    );
    assertEqual(
      out.url,
      `https://www.facebook.com/messages/t/${out.payload.href.slice(3)}?…`,
      "one thread hashes the same in every field",
    );
    assert(out.stack.includes("~/AppData"), "home directory becomes ~");
    const otherSalt = createDebugLogRedactor({ salt: "0".repeat(32) })(event);
    assert(
      otherSalt.payload.href !== out.payload.href,
      "hashes depend on the installation salt",
    );

    const logPath = path.join(dir, "notification-debug.ndjson");
    const store = new DebugLogStore(redact, 1500);
    for (let i = 0; i < 6; i += 1) store.append(logPath, event);
    assert(fs.existsSync(getRotatedDebugLogPath(logPath)), "log rotates at cap");
    assert(fs.statSync(logPath).size <= 1500, "current log stays under cap");
    assert(
      !fs.readFileSync(logPath, "utf8").includes("Tester"),
      "records are redacted on disk",
    );

    // Logs written raw by older versions are redacted on export.
    fs.writeFileSync(
      getRotatedDebugLogPath(logPath),
      `${JSON.stringify(event)}\n{"truncated":\n`,
    );
    const exported = path.join(dir, "export.ndjson");
    const count = store.exportTo(logPath, exported);
    const exportedText = fs.readFileSync(exported, "utf8");
    assert(count >= 2, "export includes both generations");
    assert(!exportedText.includes("Tester"), "export redacts old raw lines");
    assert(!exportedText.includes('{"truncated":'), "partial lines are dropped");

    const legacy = path.join(dir, "reload-debug.ndjson");
    fs.writeFileSync(legacy, `${JSON.stringify(event)}\n`);
    fs.writeFileSync(getRotatedDebugLogPath(legacy), "raw\n");
    assertEqual(
      purgeLegacyDebugLogs(dir, [legacy]),
      true,
      "pre-redaction logs are purged once",
    );
    assert(
      !fs.existsSync(legacy) && !fs.existsSync(getRotatedDebugLogPath(legacy)),
      "both generations are removed",
    );
    store.append(legacy, event);
    assertEqual(
      purgeLegacyDebugLogs(dir, [legacy]),
      false,
      "redacted logs are kept on later launches",
    );
    assert(fs.existsSync(legacy), "new log survives the next launch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("PASS debug log store");
};

const run = async () => {
  await runProcessErrorGuardTests();
  runPageBridgePolicyTests();
  runDebugRedactionTests();
  runRendererDebugFlagTests();
  await runNotificationProbeLogTests();
  runDebugLogStoreTests();
  console.log("PASS stability tests");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
