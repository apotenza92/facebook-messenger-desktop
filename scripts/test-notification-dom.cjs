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
const { buildPageBridgePrelude, loadPreparedPageScripts } = require(
  path.join(APP_ROOT, "dist/main/page-script-bundle.js"),
);
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

// Realistic-length thread ids (Messenger's are 15-17 digits).
const threadId = (id) => `10000000000${id}`;
const thread = (id) => `/messages/t/${threadId(id)}/`;
const PROBE_SALT = "harness-salt";

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
          {
            type: "electron-power-state",
            data: { state: s, timestamp: Date.now() },
          },
          "*",
        ),
      state,
    ),
  // Show an in-page toast shaped like Facebook's (recorded Oct 2026): an
  // item in a toast stack directly under <body> holding an alert, a link
  // and a close button. Returns the toast's id for isToastVisible.
  showToast: (href) =>
    page.evaluate((h) => {
      let stack = document.querySelector("[data-fx-toast-stack]");
      if (!stack) {
        const layer = document.createElement("div");
        layer.setAttribute("data-visualcompletion", "ignore");
        stack = document.createElement("ul");
        stack.setAttribute("data-fx-toast-stack", "");
        layer.append(stack);
        document.body.append(layer);
      }
      const id = "toast-" + stack.children.length;
      const item = document.createElement("li");
      item.id = id;
      item.innerHTML =
        '<div><div><div aria-labelledby="' + id + '-label">' +
        '<span id="' + id + '-label">Tester E</span>' +
        '<a href="' + h + '"><span role="alert">Tester E reacted.</span></a>' +
        '<div role="button" tabindex="0"><svg viewBox="0 0 20 20"><path d="M1 1"></path></svg></div>' +
        "</div></div></div>";
      stack.append(item);
      return id;
    }, href),
  isToastVisible: (id) =>
    page.evaluate((toastId) => {
      const toast = document.getElementById(toastId);
      return Boolean(toast) && getComputedStyle(toast).display !== "none";
    }, id),
  captured: () => page.evaluate(() => window.__fx.captured.slice()),
  probeEvents: () => page.evaluate(() => window.__fx.probeEvents.slice()),
  // Fire a notification the way Facebook's page code does.
  facebookNotify: (title, options) =>
    page.evaluate(
      ([t, o]) => {
        window.__fx.lastNative = new Notification(t, o);
      },
      [title, options],
    ),
  facebookClose: () => page.evaluate(() => window.__fx.lastNative?.close()),
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
  const app = await electron.launch({
    // Ubuntu runners block the unprivileged user namespaces Chromium's
    // sandbox needs; the app itself always runs with --no-sandbox on Linux
    // (see linux-sandbox-policy and after-pack). The harness only loads
    // in-memory fixture pages.
    args:
      process.platform === "linux"
        ? ["--no-sandbox", HARNESS_MAIN]
        : [HARNESS_MAIN],
  });
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
  await page.evaluate(
    buildPageBridgePrelude(VERBOSE, scenario.probe ? PROBE_SALT : null),
  );
  await page.evaluate(
    "window.__electronNotificationBridge = window.__mdHarnessCapture;",
  );
  return { app, page };
};

const injectAppScripts = async (page, scenario) => {
  for (const script of loadPreparedPageScripts(
    path.join(APP_ROOT, "dist/main"),
    { includeProbe: Boolean(scenario.probe) },
  )) {
    if (script.code === null) {
      throw new Error(
        `Missing built page script: ${script.scriptPath} (run npm run build)`,
      );
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
      item.title === expected[index].title &&
      item.body === expected[index].body,
  );

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// A quiet chat list the user has already read, used as the starting state.
const readList = () => [
  {
    href: thread(1001),
    title: "Tester A",
    body: "see you tomorrow",
    time: "2h",
    unread: false,
  },
  {
    href: thread(1002),
    title: "Tester B",
    body: "thanks!",
    time: "5h",
    unread: false,
  },
  {
    href: thread(1003),
    title: "Group C",
    body: "Tester D: lunch?",
    time: "1d",
    unread: false,
    avatarLabel: "Group chat: Group C",
  },
];

// Deliver an incoming message to a thread while the window is in the
// background, as Messenger does: move the row up, patch text, mark unread.
const incoming = async (d, href, title, body, extra = {}) => {
  await d.update({ href, title, body, time: "now", unread: true, ...extra });
  await d.run(SECOND);
};

const messageScenario = (id, description, body) => ({
  id,
  description,
  steps: async (d) => {
    await incoming(d, thread(1002), "Tester B", body);
    await d.run(5 * SECOND);
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
        {
          href: thread(1001),
          title: "Tester A",
          body: "see you tomorrow",
          time: "3h",
          unread: false,
        },
        { moveToTop: false },
      );
      await d.run(10 * SECOND);
    },
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
  },
  // Sending a message, from any device, advances the user's read marker, so
  // Messenger renders the row read (Facebook's MWThreadAddOnSecondary shows
  // the unread badge and the viewer's own last message exclusively). The
  // engine relies on that state, not on a language-specific "You:" prefix.
  {
    id: "baseline-self-sent",
    description: "the user's own message from another device is silent",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "You: on my way", {
        unread: false,
      });
      await d.run(5 * SECOND);
    },
    expect: [],
  },
  {
    id: "baseline-startup-unread",
    description: "rows already unread at startup are not announced",
    initialRows: [
      {
        href: thread(1001),
        title: "Tester A",
        body: "ping",
        time: "4h",
        unread: true,
      },
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
  ),
  messageScenario(
    "words-called-you",
    "a message saying someone called is delivered unchanged",
    "she called you earlier",
  ),
  messageScenario(
    "words-is-calling",
    "a message containing 'is calling' is delivered unchanged",
    "Dad is calling the plumber",
  ),
  messageScenario(
    "words-muted",
    "a message mentioning muting is delivered",
    "I muted the group chat lol",
  ),
  messageScenario(
    "words-you-up",
    "an incoming 1:1 message starting with 'you' is delivered",
    "you up?",
  ),

  // --- Symptom: notifications for messages the user sent -----------------
  {
    id: "self-reply-race",
    description:
      "replying from another device while the row is still unread does not notify",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      await d.run(8 * SECOND);
      // The user answers from their phone. Messenger patches the preview
      // first and clears the unread marker a moment later.
      await d.update({
        href: thread(1002),
        title: "Tester B",
        body: "yes, 7pm works",
        time: "now",
        unread: true,
      });
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
    description:
      "after wake, the user's own message from another device is silent",
    steps: async (d) => {
      await d.power("suspend");
      await d.sleepFor(2 * HOUR);
      await d.power("resume");
      await d.run(12 * SECOND);
      await incoming(d, thread(1001), "Tester A", "You: see you then", {
        unread: false,
      });
      await d.run(5 * SECOND);
    },
    expect: [],
  },
  {
    id: "rerender-after-focus",
    description:
      "a notified row that leaves and re-enters the list is not announced again",
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

  // --- Diagnostics probe ------------------------------------------------------
  {
    id: "probe-records-structure-only",
    description:
      "the diagnostics probe records Facebook's notifications without showing them or capturing content",
    probe: true,
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      // Let the sidebar engine's settle delay pass so its send comes first.
      await d.run(2 * SECOND);
      await d.facebookNotify("Tester B", {
        body: "are you free tonight?",
        tag: threadId(1002),
        data: { url: `https://www.facebook.com${thread(1002)}` },
        icon: "https://scontent.example.net/avatar.jpg",
        timestamp: Date.parse("2026-10-01T09:00:10Z"),
      });
      await d.run(2 * SECOND);
      await d.facebookClose();
      await d.run(31 * SECOND);
    },
    // Only the app's own sidebar notification is shown.
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
    check: async (d) => {
      const events = await d.probeEvents();
      const serialized = JSON.stringify(events);
      for (const secret of [
        "Tester",
        "free tonight",
        threadId(1002),
        "facebook.com/messages",
        "scontent",
        "see you tomorrow",
      ]) {
        if (serialized.includes(secret)) {
          return `probe events leak content: found ${JSON.stringify(secret)}`;
        }
      }
      const byName = (name) => events.filter((event) => event.event === name);
      const constructed = byName("native-constructed")[0];
      if (!constructed) return "no native-constructed event";
      if (!constructed.threadHash || !constructed.tagHasThreadId) {
        return `thread id not detected in tag: ${JSON.stringify(constructed.tag)}`;
      }
      if (
        constructed.tag?.form !== "N" ||
        constructed.data?.url?.form !== "a://a.a.a/a/a/N/"
      ) {
        return `unexpected tag/data shapes: ${JSON.stringify([constructed.tag, constructed.data])}`;
      }
      if (constructed.rowMatch !== "thread-id") {
        return `row not matched by thread id: ${constructed.rowMatch}`;
      }
      if (
        !constructed.textComparison?.titleMatchesRow ||
        !constructed.textComparison?.bodyEqualsPreview
      ) {
        return `text comparison wrong: ${JSON.stringify(constructed.textComparison)}`;
      }
      if (typeof constructed.msSinceAppSendForThread !== "number") {
        return "native notification not correlated with the app's send";
      }
      const closed = byName("native-closed")[0];
      if (!closed || closed.id !== constructed.id) return "close() not recorded";
      if (byName("native-followup").length !== 3) {
        return "expected three follow-up row checks";
      }
      if (byName("app-sent").length !== 1) return "app send not recorded";
      if (byName("row-shape").length === 0) return "no row shapes recorded";
      const row = constructed.row;
      if (
        !row ||
        !Array.isArray(row.icons) ||
        typeof row.mutedHeuristic?.muted !== "boolean" ||
        typeof row.mutedHeuristic?.method !== "string"
      ) {
        return `row mute signals missing: ${JSON.stringify(row)}`;
      }
      return null;
    },
  },

  // --- Non-English layouts ---------------------------------------------------
  {
    id: "locale-french",
    description:
      "in a French layout, incoming messages notify and the user's own do not",
    // Likely cause of #104 (Polish layout: no notifications, sound or badge).
    locale: {
      chatsLabel: "Discussions",
      unreadText: "Message non lu :",
      markAsReadLabel: "Marquer comme lu",
    },
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "tu es libre ce soir ?");
      await d.run(10 * SECOND);
      // The user's own reply from another device must stay silent too.
      await incoming(d, thread(1001), "Tester A", "Vous : j'arrive", {
        unread: false,
      });
      await d.run(5 * SECOND);
    },
    expect: [{ title: "Tester B", body: "tu es libre ce soir ?" }],
  },
  // --- Bugs found in the October 2026 diagnostics run ------------------------
  {
    id: "locked-screen-message",
    description:
      "a message arriving while the screen is locked (computer awake) notifies once",
    steps: async (d) => {
      await d.power("lock-screen");
      await d.run(10 * MINUTE);
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      await d.run(10 * SECOND);
      await d.power("unlock-screen");
      await d.run(15 * SECOND);
    },
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
  },
  {
    id: "suspend-without-resume",
    description:
      "notifications resume when a suspend is never followed by a resume event",
    steps: async (d) => {
      await d.power("suspend");
      await d.run(4 * MINUTE);
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      await d.run(5 * SECOND);
    },
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
  },
  {
    id: "group-photo",
    description: "a photo sent to a group notifies",
    steps: async (d) => {
      await incoming(d, thread(1003), "Group C", "Tester D sent a photo.", {
        avatarLabel: "Group chat: Group C",
      });
      await d.run(5 * SECOND);
    },
    expect: [{ title: "Group C", body: "Tester D sent a photo." }],
  },
  {
    id: "group-short-emoji",
    description: "a short emoji-only group message notifies",
    steps: async (d) => {
      await incoming(d, thread(1003), "Group C", "🙏", {
        avatarLabel: "Group chat: Group C",
      });
      await d.run(5 * SECOND);
    },
    expect: [{ title: "Group C", body: "🙏" }],
  },
  {
    id: "muted-conversation",
    description: "a message in a muted conversation is silent (#105)",
    initialRows: [
      ...readList().slice(0, 2),
      { ...readList()[2], muted: true },
    ],
    steps: async (d) => {
      await incoming(d, thread(1003), "Group C", "Tester D: lunch today?");
      await d.run(5 * SECOND);
    },
    expect: [],
  },
  {
    id: "repeat-after-read",
    description:
      "the same text sent again after the conversation was read notifies again",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "ok");
      await d.run(5 * SECOND);
      await d.setUnread(thread(1002), false);
      await d.run(5 * SECOND);
      await incoming(d, thread(1002), "Tester B", "ok");
      await d.run(5 * SECOND);
    },
    expect: [
      { title: "Tester B", body: "ok" },
      { title: "Tester B", body: "ok" },
    ],
  },
  {
    id: "burst-while-unread",
    description: "each new message to a conversation that is still unread notifies",
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "first");
      await d.run(5 * SECOND);
      await incoming(d, thread(1002), "Tester B", "second");
      await d.run(5 * SECOND);
    },
    expect: [
      { title: "Tester B", body: "first" },
      { title: "Tester B", body: "second" },
    ],
  },
  {
    id: "hidden-timer-throttling",
    description:
      "minute-long timer gaps in a hidden window are not mistaken for sleep",
    steps: async (d) => {
      for (let i = 0; i < 5; i += 1) await d.sleepFor(61 * SECOND);
      await incoming(d, thread(1002), "Tester B", "are you free tonight?");
      await d.run(5 * SECOND);
    },
    expect: [{ title: "Tester B", body: "are you free tonight?" }],
  },
  {
    id: "locale-polish",
    description: "in a Polish layout, incoming messages notify (#104)",
    locale: {
      chatsLabel: "Czaty",
      unreadText: "Nieprzeczytana wiadomość:",
      markAsReadLabel: "Oznacz jako przeczytane",
    },
    steps: async (d) => {
      await incoming(d, thread(1002), "Tester B", "jesteś wolny dziś wieczorem?", {
        time: "teraz",
      });
      await d.run(5 * SECOND);
    },
    expect: [{ title: "Tester B", body: "jesteś wolny dziś wieczorem?" }],
  },
  {
    id: "facebook-activity-toast",
    description:
      "Facebook's in-page toast for activity elsewhere on Facebook is hidden (#105)",
    steps: async (d) => {
      d.toastId = await d.showToast(
        "https://www.facebook.com/photo/?fbid=1&set=a.1&notif_id=1&notif_t=feedback_comment",
      );
      await d.run(SECOND);
    },
    expect: [],
    check: async (d) =>
      (await d.isToastVisible(d.toastId))
        ? "the Facebook activity toast is still visible"
        : null,
  },
  {
    id: "messenger-toast-kept",
    description: "an in-page toast linking to a Messenger chat stays visible",
    steps: async (d) => {
      d.toastId = await d.showToast(`https://www.facebook.com${thread(1002)}`);
      await d.run(SECOND);
    },
    expect: [],
    check: async (d) =>
      (await d.isToastVisible(d.toastId))
        ? null
        : "a Messenger toast was hidden",
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
    await injectAppScripts(page, scenario);
    await driver.run(STARTUP_SETTLE_MS);
    await scenario.steps(driver);
    const captured = await driver.captured();
    const displayed = toDisplayed(captured);
    const checkError = scenario.check
      ? await scenario.check(driver, { captured, displayed })
      : null;
    return { captured, displayed, checkError };
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
    const { captured, displayed, checkError } = await runScenario(scenario);
    const ok = sameNotifications(displayed, scenario.expect) && !checkError;
    const detail = checkError
      ? checkError
      : `expected ${JSON.stringify(scenario.expect)}, displayed ${JSON.stringify(displayed)}`;
    if (VERBOSE) console.log(`    captured ${JSON.stringify(captured)}`);

    if (ok && !scenario.knownFailure) {
      results.pass += 1;
      console.log(`PASS  ${scenario.id}: ${scenario.description}`);
    } else if (!ok && scenario.knownFailure) {
      results.xfail += 1;
      console.log(
        `XFAIL ${scenario.id}: ${scenario.knownFailure}\n        ${detail}`,
      );
    } else if (ok && scenario.knownFailure) {
      results.fail.push(scenario.id);
      console.log(
        `FAIL  ${scenario.id}: now behaves correctly; remove its knownFailure marker`,
      );
    } else {
      results.fail.push(scenario.id);
      console.log(
        `FAIL  ${scenario.id}: ${scenario.description}\n        ${detail}`,
      );
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
