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

const run = async () => {
  await runProcessErrorGuardTests();
  runPageBridgePolicyTests();
  console.log("PASS stability tests");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
