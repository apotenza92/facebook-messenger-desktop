// Deterministic notification DOM harness.
//
// Runs the app's real injected page scripts (dist/, prepared exactly as the
// main process injects them) inside Electron against a Messenger-shaped
// fixture chat list, with a fake clock. Every notification the page decides
// to send is captured and then passed through the main-process display
// boundary, so each scenario asserts what the user would actually see.
//
// Scenarios marked knownFailure document current wrong behaviour. They are
// reported as XFAIL and keep the run green; if one starts passing, the run
// fails so the marker is removed together with the fix.
//
// Usage: node scripts/test-notification-dom.cjs [--only <scenario-id>] [--verbose]

const path = require("path");
const { spawnSync } = require("child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const HARNESS_MAIN = path.join(__dirname, "notification-dom/harness-main.cjs");

// Linux CI runners have no display; re-run under a virtual one.
if (
  process.platform === "linux" &&
  !process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY &&
  !process.env.MD_HARNESS_UNDER_XVFB
) {
  const result = spawnSync(
    "xvfb-run",
    ["-a", process.execPath, __filename, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, MD_HARNESS_UNDER_XVFB: "1" },
    },
  );
  if (result.error) {
    console.error(
      "[NotificationDOM] No display and xvfb-run is unavailable:",
      result.error.message,
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const { _electron: electron } = require("playwright");
const { FIXTURE_SOURCE } = require("./notification-dom/fixture.cjs");
const {
  buildPageBridgePrelude,
  loadPreparedPageScripts,
} = require(path.join(APP_ROOT, "dist/main/page-script-bundle.js"));
const { resolveNotificationDisplayBoundary } = require(
  path.join(APP_ROOT, "dist/main/notification-handler.js"),
);

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const ONLY = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const VERBOSE = args.includes("--verbose");

const START_TIME = new Date("2026-10-01T09:00:00Z");
const STARTUP_SETTLE_MS = 15_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const thread = (id) => `/messages/t/${id}/`;

// ---------------------------------------------------------------------------
// Scenario driver
// ---------------------------------------------------------------------------

const createDriver = (page) => ({
  page,
  run: (ms) => page.clock.runFor(ms),
  // Jump the wall clock as if the machine slept; due timers fire once.
  sleepFor: (ms) => page.clock.fastForward(ms),
  mount: (rows) => page.evaluate((r) => window.__fx.mountSidebar(r), rows),
  update: (row, options) =>
    page.evaluate(([r, o]) => window.__fx.updateRow(r, o), [row, options]),
  replace: (row) => page.evaluate((r) => window.__fx.replaceRow(r), row),
  remove: (href) => page.evaluate((h) => window.__fx.removeRow(h), href),
  // Re-render the preview node with identical text, as React does when
  // unrelated row state (presence, typing, avatars) changes.
  touch: (href) =>
    page.evaluate((h) => {
      const node = document.querySelector(
        '[role="row"][data-fx-href="' + h + '"] .body',
      );
      if (node) node.textContent = String(node.textContent);
    }, href),
  setUnread: (href, unread) =>
    page.evaluate(([h, u]) => window.__fx.setUnread(h, u), [href, unread]),
  setFocused: (focused) =>
    page.evaluate((f) => window.__fx.setFocused(f), focused),
  power: (state) =>
    page.evaluate(
      (s) =>
        window.postMessage(
          { type: "electron-power-state", data: { state: s, timestamp: Date.now() } },
          "*",
        ),
      state,
    ),
  captured: () => page.evaluate(() => window.__fx.captured.slice()),
});

const FOCUS_SOURCE = String.raw`
(() => {
  let focused = false;
  Document.prototype.hasFocus = function () { return focused; };
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (focused ? "visible" : "hidden"),
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => !focused,
  });
  window.__fx.setFocused = (next) => {
    focused = Boolean(next);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(focused ? "focus" : "blur"));
  };
})();
`;

const launchScenarioPage = async (scenario) => {
  const app = await electron.launch({ args: [HARNESS_MAIN] });
  const page = await app.firstWindow();
  await page.waitForLoadState("load");
  if (VERBOSE) {
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[Notif")) console.log(`    ${text.slice(0, 240)}`);
    });
  }
  await page.clock.install({ time: START_TIME });
  await page.evaluate(FIXTURE_SOURCE);
  await page.evaluate(FOCUS_SOURCE);
  if (scenario.locale) {
    await page.evaluate((l) => window.__fx.setLocale(l), scenario.locale);
  }
  await page.evaluate(buildPageBridgePrelude(VERBOSE));
  await page.evaluate(
    "window.__electronNotificationBridge = window.__mdHarnessCapture;",
  );
  return { app, page };
};

const injectAppScripts = async (page) => {
  for (const script of loadPreparedPageScripts(path.join(APP_ROOT, "dist/main"))) {
    if (script.code === null) {
      throw new Error(`Missing built page script: ${script.scriptPath} (run npm run build)`);
    }
    await page.evaluate(script.code);
  }
};

// Apply the main-process display boundary to what the page sent.
const toDisplayed = (captured) =>
  captured
    .map((data) => resolveNotificationDisplayBoundary(data))
    .filter((decision) => !decision.suppress)
    .map((decision) => ({
      title: decision.normalizedData.title,
      body: decision.normalizedData.body,
    }));

const sameNotifications = (actual, expected) =>
  actual.length === expected.length &&
  actual.every(
    (item, index) =>
      item.title === expected[index].title && item.body === expected[index].body,
  );

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// A quiet chat list the user has already read, used as the starting state.
const readList = () => [
  { href: thread(1001), title: "Tester A", body: "see you tomorrow", time: "2h", unread: false },
  { href: thread(1002), title: "Tester B", body: "thanks!", time: "5h", unread: false },
  { href: thread(1003), title: "Group C", body: "Tester D: lunch?", time: "1d", unread: false },
];

// Deliver an incoming message to a thread while the window is in the
// background, as Messenger does: move the row up, patch text, mark unread.
const incoming = async (d, href, title, body, extra = {}) => {
  await d.update({ href, title, body, time: "now", unread: true, ...extra });
  await d.run(SECOND);
};

const messageScenario = (id, description, body, knownFailure) => ({
  id,
  description,
  knownFailure,
  steps: async (d) => {
    await incoming(d, thread(1002), "Tester B", body);
  },
  expect: [{ title: "Tester B", body }],
});

const SCENARIOS = [
  // --- Baseline behaviour that must keep working -------------------------
  {
    id: "baseline-incoming",
    description: "an incoming message in the background notifies once",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      await d.run(10 * SECOND);
    },
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
  },
  {
    id: "baseline-no-repeat",
    description: "an unrelated row change does not repeat a notification",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      await d.run(10 * SECOND);
      await d.update(
        { href: thread(1001), title: "Tester A", body: "see you tomorrow", time: "3h", unread: false },
        { moveToTop: false },
      );
      await d.run(10 * SECOND);
    },
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
  },
  {
    id: "baseline-self-sent-prefixed",
    description: "a self-sent preview Messenger prefixes with You: is silent",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "You: on my way");
    },
    expect: [],
  },
  {
    id: "baseline-startup-unread",
    description: "rows already unread at startup are not announced",
    initialRows: [
      { href: thread(1001), title: "Tester A", body: "ping", time: "4h", unread: true },
      ...readList().slice(1),
    ],
    steps: async (d) => {
      await d.run(10 * SECOND);
    },
    expect: [],
  },

  // --- Symptom: ordinary words trigger hardcoded call/mute/self rules ----
  messageScenario(
    "words-join-the-call",
    "a message mentioning joining a call is delivered unchanged",
    "Did you join the call?",
    "call-history regex matches ordinary message text and drops it",
  ),
  messageScenario(
    "words-called-you",
    "a message saying someone called is delivered unchanged",
    "she called you earlier",
    "call-history regex matches ordinary message text and drops it",
  ),
  messageScenario(
    "words-is-calling",
    "a message containing 'is calling' is delivered unchanged",
    "Dad is calling the plumber",
    "incoming-call regex rewrites the body in the main-process boundary",
  ),
  messageScenario(
    "words-muted",
    "a message mentioning muting is delivered",
    "I muted the group chat lol",
    "mute detection searches the whole row text including the preview",
  ),
  messageScenario(
    "words-you-up",
    "an incoming 1:1 message starting with 'you' is delivered",
    "you up?",
    "self-authored rule treats any preview starting with 'you' as sent by the user",
  ),

  // --- Symptom: notifications for messages the user sent -----------------
  {
    id: "self-reply-race",
    description:
      "replying from another device while the row is still unread does not notify",
    knownFailure:
      "the reply's preview lands before the read marker clears and passes every check",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      await d.run(8 * SECOND);
      // The user answers from their phone. Messenger patches the preview
      // first and clears the unread marker a moment later.
      await d.update(
        { href: thread(1002), title: "Tester B", body: "yes, 7pm works", time: "now", unread: true },
      );
      await d.run(300);
      await d.setUnread(thread(1002), false);
      await d.run(5 * SECOND);
    },
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
  },
  // --- Symptom: replays after the computer wakes -------------------------
  {
    id: "wake-old-message-inline-time",
    description:
      "after wake, an older message synced late is not announced when its time is not in its own text node",
    knownFailure:
      "freshness only parses English times in their own [dir=auto] node; anything else counts as new",
    steps: async (d) => {
      await d.power("suspend");
      await d.sleepFor(2 * HOUR);
      await d.power("resume");
      await d.run(12 * SECOND);
      await incoming(d, thread(1001), "Tester A", "sent while you were away", {
        time: "47m",
        timeStyle: "inline",
      });
    },
    expect: [],
  },
  {
    id: "wake-without-resume-event",
    description:
      "after a sleep with no resume event (Modern Standby), an older synced message is not announced",
    knownFailure:
      "wake protection depends on Electron's resume event and the English time parser",
    steps: async (d) => {
      await d.sleepFor(2 * HOUR);
      await incoming(d, thread(1001), "Tester A", "sent while you were away", {
        time: "52m",
        timeStyle: "inline",
      });
    },
    expect: [],
  },
  {
    id: "wake-read-elsewhere",
    description:
      "after wake, a message already read on another device is not announced",
    knownFailure:
      "the row is briefly unread with new text before Messenger applies the read state",
    steps: async (d) => {
      await d.power("suspend");
      await d.sleepFor(3 * HOUR);
      await d.power("resume");
      await d.run(12 * SECOND);
      await incoming(d, thread(1001), "Tester A", "did you see the photos?");
      await d.run(250);
      await d.setUnread(thread(1001), false);
      await d.run(5 * SECOND);
    },
    expect: [],
  },
  {
    id: "wake-self-sent-catch-up",
    description: "after wake, the user's own message from another device is silent",
    steps: async (d) => {
      await d.power("suspend");
      await d.sleepFor(2 * HOUR);
      await d.power("resume");
      await d.run(12 * SECOND);
      await incoming(d, thread(1001), "Tester A", "You: see you then");
    },
    expect: [],
  },
  {
    id: "rerender-after-focus",
    description:
      "a notified row that leaves and re-enters the list is not announced again",
    knownFailure:
      "focus clears notification records for rows not currently rendered",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      await d.run(10 * SECOND);
      // The list virtualises the row away, the user glances at the window,
      // then the row renders again unchanged.
      await d.remove(thread(1002));
      await d.setFocused(true);
      await d.run(SECOND);
      await d.setFocused(false);
      await d.run(SECOND);
      await d.replace({
        href: thread(1002),
        title: "Tester B",
        body: "are you free tonight?",
        time: "1m",
        timeStyle: "inline",
        unread: true,
      });
      await d.run(SECOND);
      await d.touch(thread(1002));
      await d.run(10 * SECOND);
    },
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
  },

  // --- Non-English layouts ---------------------------------------------------
  {
    id: "locale-french",
    description:
      "in a French layout, incoming messages notify and the user's own do not",
    knownFailure: "unread detection only recognises English labels",
    locale: {
      chatsLabel: "Discussions",
      unreadText: "Message non lu :",
      markAsReadLabel: "Marquer comme lu",
    },
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "tu es libre ce soir ?");
      await d.run(10 * SECOND);
      // The user's own reply from another device must stay silent too.
      await incoming(d, thread(1001), "Tester A", "Vous : j'arrive");
    },
    expect: [{ title: "Tester B", body: "tu es libre ce soir ?" }],
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const runScenario = async (scenario) => {
  const { app, page } = await launchScenarioPage(scenario);
  try {
    const driver = createDriver(page);
    await driver.mount(scenario.initialRows || readList());
    await injectAppScripts(page);
    await driver.run(STARTUP_SETTLE_MS);
    await scenario.steps(driver);
    const captured = await driver.captured();
    return { captured, displayed: toDisplayed(captured) };
  } finally {
    await app.close();
  }
};

const main = async () => {
  const scenarios = ONLY
    ? SCENARIOS.filter((scenario) => scenario.id === ONLY)
    : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`No scenario named ${ONLY}`);

  const results = { pass: 0, xfail: 0, fail: [] };
  for (const scenario of scenarios) {
    const { captured, displayed } = await runScenario(scenario);
    const ok = sameNotifications(displayed, scenario.expect);
    const detail = `expected ${JSON.stringify(scenario.expect)}, displayed ${JSON.stringify(displayed)}`;
    if (VERBOSE) console.log(`    captured ${JSON.stringify(captured)}`);

    if (ok && !scenario.knownFailure) {
      results.pass += 1;
      console.log(`PASS  ${scenario.id}: ${scenario.description}`);
    } else if (!ok && scenario.knownFailure) {
      results.xfail += 1;
      console.log(`XFAIL ${scenario.id}: ${scenario.knownFailure}\n        ${detail}`);
    } else if (ok && scenario.knownFailure) {
      results.fail.push(scenario.id);
      console.log(
        `FAIL  ${scenario.id}: now behaves correctly; remove its knownFailure marker`,
      );
    } else {
      results.fail.push(scenario.id);
      console.log(`FAIL  ${scenario.id}: ${scenario.description}\n        ${detail}`);
    }
  }

  console.log(
    `\n[NotificationDOM] ${results.pass} passed, ${results.xfail} known failures, ${results.fail.length} failed`,
  );
  if (results.fail.length > 0) {
    process.exitCode = 1;
  } else {
    console.log("PASS notification DOM harness");
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
