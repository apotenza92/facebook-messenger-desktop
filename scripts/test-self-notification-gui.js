const { _electron: electron } = require("playwright");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    mode: "list",
    titleContains: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      args.mode = String(argv[i + 1] || "").trim() || "list";
      i += 1;
    } else if (arg === "--title-contains") {
      args.titleContains = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/test-self-notification-gui.js [--mode list] [--title-contains text]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function getElectronSurfaceState(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const win =
      windows.find((entry) => entry.getBrowserViews().length > 0) || windows[0];
    if (!win || win.isDestroyed()) {
      throw new Error("No live Electron window");
    }

    const views = win.getBrowserViews();
    const wc = views.length > 0 ? views[0].webContents : win.webContents;
    if (!wc || wc.isDestroyed()) {
      throw new Error("No live webContents");
    }

    return wc.executeJavaScript(
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
      true,
    );
  });
}

async function listNonE2EEThreads(electronApp, titleContains) {
  return electronApp.evaluate(async ({ BrowserWindow }, needleInput) => {
    const windows = BrowserWindow.getAllWindows();
    const win =
      windows.find((entry) => entry.getBrowserViews().length > 0) || windows[0];
    if (!win || win.isDestroyed()) {
      throw new Error("No live Electron window");
    }

    const views = win.getBrowserViews();
    const wc = views.length > 0 ? views[0].webContents : win.webContents;
    if (!wc || wc.isDestroyed()) {
      throw new Error("No live webContents");
    }

    const needle = String(needleInput || "")
      .toLowerCase()
      .trim();
    return wc.executeJavaScript(
      `(() => {
        const needle = ${JSON.stringify(needle)};
        const rows = Array.from(document.querySelectorAll('[role="navigation"] [role="row"], [role="navigation"] [role="listitem"]'));
        const results = [];
        for (const row of rows) {
          const anchors = Array.from(row.querySelectorAll('a[href]'));
          const link = anchors.find((node) => {
            const href = node.getAttribute('href') || '';
            return href.includes('/messages/t/') || href.includes('/t/');
          });
          if (!link) continue;

          const href = link.href || link.getAttribute('href') || '';
          if (!href || href.includes('/e2ee/')) continue;

          const texts = Array.from(row.querySelectorAll('[dir="auto"]'))
            .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          const title = texts[0] || '';
          const body = texts[1] || '';
          if (needle && !title.toLowerCase().includes(needle) && !body.toLowerCase().includes(needle)) {
            continue;
          }

          results.push({ href, title, body });
        }

        return {
          currentUrl: window.location.href,
          results: results.slice(0, 20),
        };
      })()`,
      true,
    );
  }, titleContains);
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

async function triggerSyntheticSelfNotification(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const win =
      windows.find((entry) => entry.getBrowserViews().length > 0) || windows[0];
    if (!win || win.isDestroyed()) {
      throw new Error("No live Electron window");
    }

    const views = win.getBrowserViews();
    const wc = views.length > 0 ? views[0].webContents : win.webContents;
    if (!wc || wc.isDestroyed()) {
      throw new Error("No live webContents");
    }

    return wc.executeJavaScript(
      `(() => {
        try {
          new Notification("Regression probe", {
            body: "You: synthetic self-notification probe",
          });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String((error && error.message) || error) };
        }
      })()`,
      true,
    );
  });
}

async function main() {
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
    await wait(5000);

    const surface = await getElectronSurfaceState(electronApp);
    if (!surface.authenticated) {
      throw new Error(
        `Electron app session is not authenticated. Current URL: ${surface.url}`,
      );
    }

    if (args.mode === "list") {
      const data = await listNonE2EEThreads(electronApp, args.titleContains);
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (args.mode === "synthetic-self-native") {
      await clearCapturedNotifications(electronApp);
      const triggerResult = await triggerSyntheticSelfNotification(electronApp);
      await wait(1500);
      const notifications = await readCapturedNotifications(electronApp);
      console.log(
        JSON.stringify(
          {
            surface,
            triggerResult,
            notifications,
            suppressed: notifications.length === 0,
          },
          null,
          2,
        ),
      );
      return;
    }

    throw new Error(`Unsupported mode: ${args.mode}`);
  } finally {
    await electronApp.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("FAIL self-notification GUI helper:", error?.message || error);
  process.exit(1);
});
