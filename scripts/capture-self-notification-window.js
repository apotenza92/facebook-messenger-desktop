const { _electron: electron } = require("playwright");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    armDelayMs: 5000,
    captureMs: 20000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--arm-delay-ms") {
      args.armDelayMs = Number(argv[i + 1] || args.armDelayMs);
      i += 1;
    } else if (arg === "--capture-ms") {
      args.captureMs = Number(argv[i + 1] || args.captureMs);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/capture-self-notification-window.js [--arm-delay-ms 5000] [--capture-ms 20000]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function evaluateInElectronPage(electronApp, scriptBody) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, payload) => {
      const windows = BrowserWindow.getAllWindows();
      const win =
        windows.find((entry) => entry.getBrowserViews().length > 0) ||
        windows[0];
      if (!win || win.isDestroyed()) {
        throw new Error("No live Electron window");
      }

      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      if (!wc || wc.isDestroyed()) {
        throw new Error("No live webContents");
      }

      return wc.executeJavaScript(payload.script, true);
    },
    { script: scriptBody },
  );
}

async function ensureElectronOnUrl(electronApp, targetUrl) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, payload) => {
      const windows = BrowserWindow.getAllWindows();
      const win =
        windows.find((entry) => entry.getBrowserViews().length > 0) ||
        windows[0];
      if (!win || win.isDestroyed()) {
        throw new Error("No live Electron window");
      }

      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      if (!wc || wc.isDestroyed()) {
        throw new Error("No live webContents");
      }

      await wc.loadURL(payload.targetUrl);
      return wc.getURL();
    },
    { targetUrl },
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
    })()`,
  );
}

async function clearCapturedNotifications(electronApp) {
  await electronApp.evaluate(() => {
    globalThis.__mdNotificationEvents = [];
  });
}

async function readCapturedNotifications(electronApp) {
  return electronApp.evaluate(() => {
    return Array.isArray(globalThis.__mdNotificationEvents)
      ? [...globalThis.__mdNotificationEvents]
      : [];
  });
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

  try {
    console.log("[Capture] Launching instrumented app window...");
    await wait(args.armDelayMs);

    const auth = await isElectronAuthenticated(electronApp);
    if (!auth.authenticated) {
      throw new Error(
        `Instrumented app is not authenticated. Current URL: ${auth.url}`,
      );
    }

    const currentUrl = await ensureElectronOnUrl(
      electronApp,
      "https://www.facebook.com/messages/",
    );
    await clearCapturedNotifications(electronApp);

    console.log(`[Capture] Armed on ${currentUrl}`);
    console.log(
      `[Capture] Send exactly one browser message now. Waiting ${args.captureMs}ms...`,
    );

    await wait(args.captureMs);

    const notifications = await readCapturedNotifications(electronApp);
    console.log(
      JSON.stringify(
        {
          armedUrl: currentUrl,
          captureMs: args.captureMs,
          notificationCount: notifications.length,
          notifications,
          suppressed: notifications.length === 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await electronApp.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error("FAIL self-notification capture:", error?.message || error);
  process.exit(1);
});
