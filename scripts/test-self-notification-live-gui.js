const { _electron: electron, chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    threadUrl: "",
    message: "test for messenger desktop app",
    loginTimeoutMs: 120000,
    notificationTimeoutMs: 12000,
    browserProfileDir: path.join(os.tmpdir(), `md-selfnotif-${Date.now()}`),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--thread-url") {
      args.threadUrl = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--message") {
      args.message = String(argv[i + 1] || "").trim() || args.message;
      i += 1;
    } else if (arg === "--login-timeout-ms") {
      args.loginTimeoutMs = Number(argv[i + 1] || args.loginTimeoutMs);
      i += 1;
    } else if (arg === "--notification-timeout-ms") {
      args.notificationTimeoutMs = Number(
        argv[i + 1] || args.notificationTimeoutMs,
      );
      i += 1;
    } else if (arg === "--browser-profile-dir") {
      args.browserProfileDir =
        String(argv[i + 1] || "").trim() || args.browserProfileDir;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/test-self-notification-live-gui.js --thread-url <facebook messages url> [--message text] [--login-timeout-ms 120000] [--notification-timeout-ms 12000] [--browser-profile-dir dir]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.threadUrl) {
    throw new Error("--thread-url is required");
  }

  return args;
}

async function ensureElectronOnUrl(electronApp, targetUrl) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, payload) => {
      const windows = BrowserWindow.getAllWindows();
      const win =
        windows.find((entry) => entry.getBrowserViews().length > 0) ||
        windows[0];
      if (!win || win.isDestroyed()) {
        throw new Error("No main window available");
      }
      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      if (!wc || wc.isDestroyed()) {
        throw new Error("No primary webContents available");
      }
      await wc.loadURL(payload.targetUrl);
      return wc.getURL();
    },
    { targetUrl },
  );
}

async function evaluateInElectronPage(electronApp, scriptBody) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, payload) => {
      const windows = BrowserWindow.getAllWindows();
      const win =
        windows.find((entry) => entry.getBrowserViews().length > 0) ||
        windows[0];
      if (!win || win.isDestroyed()) {
        throw new Error("No main window available");
      }
      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      if (!wc || wc.isDestroyed()) {
        throw new Error("No primary webContents available");
      }
      return wc.executeJavaScript(payload.script, true);
    },
    { script: scriptBody },
  );
}

async function isElectronAuthenticated(electronApp) {
  return evaluateInElectronPage(
    electronApp,
    `(() => {
      const url = window.location.href || '';
      const hasLoginForm = Boolean(
        document.querySelector('input[name="email"], input[name="pass"], #login_form, [data-testid="royal_login_form"]')
      );
      return {
        url,
        authenticated: !/facebook\\.com\\/login/i.test(url) && !hasLoginForm,
      };
    })();`,
  );
}

async function readCapturedNotifications(electronApp) {
  return electronApp.evaluate(() => {
    return Array.isArray(globalThis.__mdNotificationEvents)
      ? [...globalThis.__mdNotificationEvents]
      : [];
  });
}

async function clearCapturedNotifications(electronApp) {
  await electronApp.evaluate(() => {
    globalThis.__mdNotificationEvents = [];
  });
}

async function isBrowserAuthenticated(page) {
  return page.evaluate(() => {
    const url = window.location.href || "";
    const hasLoginForm = Boolean(
      document.querySelector(
        'input[name="email"], input[name="pass"], #login_form, [data-testid="royal_login_form"]',
      ),
    );
    return {
      url,
      authenticated: !/facebook\.com\/login/i.test(url) && !hasLoginForm,
    };
  });
}

function buildVisibilityHelpers() {
  return {
    isVisibleSource: `
      (el) => {
        if (!el) return false;
        const target = el instanceof HTMLElement ? el : null;
        if (!target) return false;
        if (target.closest('[aria-hidden="true"]') || target.closest('[hidden]')) return false;
        const style = window.getComputedStyle(target);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0' ||
          style.pointerEvents === 'none'
        ) {
          return false;
        }
        const rect = target.getBoundingClientRect();
        return rect.width >= 4 && rect.height >= 4;
      }
    `,
  };
}

function buildThreadReadyScript() {
  const helpers = buildVisibilityHelpers();
  return `(() => {
    const isVisible = ${helpers.isVisibleSource};
    const callPatterns = [/start video call/i, /start audio call/i, /video call/i, /audio call/i];
    const pinPromptPatterns = [/pin this conversation/i, /pin conversation/i, /keep in sidebar/i];
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    const labels = buttons
      .filter((el) => isVisible(el))
      .map((el) => String(el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const composers = Array.from(
      document.querySelectorAll('div[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label*="message" i], div[contenteditable="true"]')
    ).filter((el) => isVisible(el));
    return {
      url: window.location.href,
      hasComposer: composers.length > 0,
      hasCallButtons: labels.some((label) => callPatterns.some((pattern) => pattern.test(label))),
      hasPinPrompt: labels.some((label) => pinPromptPatterns.some((pattern) => pattern.test(label))),
      labels: labels.slice(0, 12),
    };
  })();`;
}

function buildSendMessageScript(message) {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const desiredMessage = ${JSON.stringify(message)};
    const candidates = Array.from(
      document.querySelectorAll(
        'div[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label*="message" i], div[contenteditable="true"]'
      ),
    );

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('insertText', false, desiredMessage);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: desiredMessage, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      return { sent: true };
    }

    return { sent: false };
  })();`;
}

async function waitFor(fn, timeoutMs, intervalMs) {
  const start = Date.now();
  let lastResult;
  while (Date.now() - start < timeoutMs) {
    lastResult = await fn();
    if (lastResult) {
      return { ok: true, elapsedMs: Date.now() - start, lastResult };
    }
    await wait(intervalMs);
  }
  return { ok: false, elapsedMs: Date.now() - start, lastResult };
}

async function waitForBrowserManualLogin(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const auth = await isBrowserAuthenticated(page);
    if (auth.authenticated) {
      return { ok: true, auth, elapsedMs: Date.now() - started };
    }
    await wait(2000);
  }

  return {
    ok: false,
    auth: await isBrowserAuthenticated(page),
    elapsedMs: Date.now() - started,
  };
}

async function waitForThreadReady(target, timeoutMs) {
  const script = buildThreadReadyScript();
  return waitFor(
    async () => {
      const state = await target.evaluate(script);
      return state.hasComposer && !state.hasPinPrompt ? state : false;
    },
    timeoutMs,
    1000,
  );
}

async function waitForNotificationPredicate(electronApp, predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const notifications = await readCapturedNotifications(electronApp);
    if (predicate(notifications)) {
      return { ok: true, notifications, elapsedMs: Date.now() - started };
    }
    await wait(250);
  }
  return {
    ok: false,
    notifications: await readCapturedNotifications(electronApp),
    elapsedMs: Date.now() - started,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const electronApp = await electron.launch({
    args: [path.join(__dirname, "../dist/main/main.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
      SKIP_SINGLE_INSTANCE_LOCK: "true",
      MESSENGER_TEST_SKIP_STARTUP_PERMISSIONS: "true",
      MESSENGER_TEST_CAPTURE_NOTIFICATIONS: "1",
    },
  });

  let browserContext = null;
  try {
    await wait(5000);
    console.log("[Setup] Electron launched");

    const electronAuth = await isElectronAuthenticated(electronApp);
    console.log("[Setup] Electron auth state:", electronAuth);
    if (!electronAuth.authenticated) {
      throw new Error(
        `Electron app session is not authenticated. Current URL: ${electronAuth.url}`,
      );
    }

    console.log("[Setup] Navigating Electron home");
    await ensureElectronOnUrl(
      electronApp,
      "https://www.facebook.com/messages/",
    );
    console.log("[Setup] Clearing captured notifications");
    await clearCapturedNotifications(electronApp);

    fs.mkdirSync(args.browserProfileDir, { recursive: true });
    console.log("[Setup] Launching browser context:", args.browserProfileDir);
    browserContext = await chromium.launchPersistentContext(
      args.browserProfileDir,
      {
        headless: false,
        viewport: { width: 1440, height: 900 },
      },
    );

    const page = browserContext.pages()[0] || (await browserContext.newPage());
    console.log("[Setup] Opening browser thread:", args.threadUrl);
    await page.goto(args.threadUrl, { waitUntil: "domcontentloaded" });
    await wait(1500);

    let browserAuth = await isBrowserAuthenticated(page);
    console.log("[Setup] Browser auth state:", browserAuth);
    if (!browserAuth.authenticated) {
      console.log(
        `[Setup] Browser session needs manual login on the SAME account as the desktop app. Waiting up to ${args.loginTimeoutMs}ms...`,
      );
      const loginResult = await waitForBrowserManualLogin(
        page,
        args.loginTimeoutMs,
      );
      browserAuth = loginResult.auth;
      if (!loginResult.ok) {
        throw new Error(
          `Browser session did not finish same-account login. Current URL: ${browserAuth.url}`,
        );
      }
    }

    const threadReady = await waitForThreadReady(
      page,
      Math.max(30000, args.loginTimeoutMs),
    );
    console.log("[Setup] Browser thread ready result:", threadReady);
    if (!threadReady.ok) {
      throw new Error(
        `Browser thread was not ready for the one-shot send. Last state: ${JSON.stringify(threadReady.lastResult)}`,
      );
    }

    console.log("[Run] Sending one message");
    const sendResult = await page.evaluate(
      buildSendMessageScript(args.message),
    );
    console.log("[Run] Send result:", sendResult);
    if (!sendResult.sent) {
      throw new Error(
        "Failed to send the single test message from browser session.",
      );
    }

    console.log("[Run] Waiting for notifications");
    const notificationResult = await waitForNotificationPredicate(
      electronApp,
      (notifications) => notifications.length > 0,
      args.notificationTimeoutMs,
    );

    const output = {
      threadUrl: args.threadUrl,
      message: args.message,
      browserUrlAfterSend: page.url(),
      notificationResult,
      passed: notificationResult.notifications.length === 0,
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browserContext?.close().catch(() => {});
    await electronApp.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error(
    "FAIL self-notification live GUI test:",
    error?.message || error,
  );
  process.exit(1);
});
