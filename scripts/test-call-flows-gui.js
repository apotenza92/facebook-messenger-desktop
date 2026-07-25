const { _electron: electron, chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dialogLoggingHandlers = new WeakMap();

function resolvePositiveIntEnv(name, fallback) {
  const rawValue = Number(process.env[name] || fallback);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return fallback;
  }

  return Math.max(1, Math.round(rawValue));
}

const INCOMING_RING_STABILITY_MS = resolvePositiveIntEnv(
  "CALL_INCOMING_STABILITY_MS",
  6000,
);
const INCOMING_RING_STABILITY_SAMPLE_MS = resolvePositiveIntEnv(
  "CALL_INCOMING_STABILITY_SAMPLE_MS",
  300,
);
const ELECTRON_LAUNCH_ATTEMPTS = resolvePositiveIntEnv(
  "CALL_ELECTRON_LAUNCH_ATTEMPTS",
  2,
);

function handleFatalHarnessError(error) {
  console.error(error);
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  handleFatalHarnessError(reason);
});

process.on("uncaughtException", (error) => {
  handleFatalHarnessError(error);
});

const INCOMING_ANSWER_SELECTORS = [
  '[aria-label*="Answer" i]',
  '[aria-label*="Accept call" i]',
  '[aria-label*="Accept video call" i]',
  '[aria-label*="Accept audio call" i]',
];

const INCOMING_DECLINE_SELECTORS = [
  '[aria-label*="Ignore call" i]',
  '[aria-label*="Decline call" i]',
  '[aria-label*="Decline video call" i]',
  '[aria-label*="Decline audio call" i]',
];

const INCOMING_JOIN_PATTERN = /join (?:the )?(?:audio |video )?(?:call|chat)/i;

const IN_CALL_HANGUP_INCLUDE_PATTERNS = [
  /end call/i,
  /hang up/i,
  /leave call/i,
  /disconnect/i,
];

const IN_CALL_ACTIVE_INCLUDE_PATTERNS = [
  /end call/i,
  /hang up/i,
  /leave call/i,
  /disconnect/i,
  /mute/i,
  /unmute/i,
  /turn off camera/i,
  /turn on camera/i,
  /speaker/i,
];

const TOP_BAR_CHROME_SELECTORS = [
  '[role="banner"] [aria-label="Menu" i]',
  '[role="banner"] [aria-label="Messenger" i]',
  '[role="banner"] [aria-label*="Notifications" i]',
  '[role="banner"] [aria-label*="Account controls and settings" i]',
  '[role="banner"] [aria-label="Your profile" i]',
  '[role="banner"] [aria-label="Facebook" i]',
  '[role="banner"] a[href="/"]',
  '[role="banner"] a[href="https://www.facebook.com/"]',
  '[role="banner"] a[href*="/notifications/"]',
  '[role="banner"] a[href="/messages/"]',
];

const CALL_START_INCLUDE_PATTERNS = [
  /start video call/i,
  /start audio call/i,
  /video call/i,
  /audio call/i,
  /voice call/i,
  /call/i,
];

const CALL_START_EXCLUDE_PATTERN =
  /answer|accept|decline|ignore|join|cancel|end call|hang up|mute|unmute|video on|video off/i;

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

async function withPrimaryWebContents(electronApp, fn, payload) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, { fnSource, payload }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No main window available");
      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      const runner = eval(`(${fnSource})`);
      return runner(wc, payload);
    },
    { fnSource: fn.toString(), payload },
  );
}

async function ensureElectronOnUrl(electronApp, targetUrl) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, payload) => {
      await wc.loadURL(payload.targetUrl);
      return wc.getURL();
    },
    { targetUrl },
  );
}

async function evaluateInElectronPage(electronApp, scriptBody) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, payload) => {
      return wc.executeJavaScript(payload.script, true);
    },
    { script: scriptBody },
  );
}

async function evaluateInElectronWindows(electronApp, scriptBody) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, { script }) => {
      const wins = BrowserWindow.getAllWindows();
      const results = [];

      for (let index = 0; index < wins.length; index += 1) {
        const win = wins[index];
        if (!win || win.isDestroyed()) {
          results.push({
            index,
            error: "window-destroyed",
          });
          continue;
        }

        const views = win.getBrowserViews();
        const wc = views.length > 0 ? views[0].webContents : win.webContents;
        if (!wc || wc.isDestroyed()) {
          results.push({
            index,
            windowTitle: win.getTitle(),
            windowVisible: win.isVisible(),
            focused: win.isFocused(),
            error: "webcontents-destroyed",
          });
          continue;
        }
        try {
          const value = await wc.executeJavaScript(script, true);
          results.push({
            index,
            windowTitle: win.getTitle(),
            windowVisible: win.isVisible(),
            focused: win.isFocused(),
            currentUrl: wc.getURL(),
            value,
          });
        } catch (error) {
          results.push({
            index,
            windowTitle: win.getTitle(),
            windowVisible: win.isVisible(),
            focused: win.isFocused(),
            currentUrl: wc.getURL(),
            error: String((error && error.message) || error),
          });
        }
      }

      return results;
    },
    { script: scriptBody },
  );
}

async function getElectronBrowserWindowState(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().map((win, index) => ({
      index,
      destroyed: win.isDestroyed(),
      visible: !win.isDestroyed() && win.isVisible(),
      focused: !win.isDestroyed() && win.isFocused(),
      title: !win.isDestroyed() ? win.getTitle() : "",
      bounds: !win.isDestroyed() ? win.getBounds() : null,
    }));
  });
}

async function waitForPrimaryElectronWindow(electronApp, timeoutMs) {
  const result = await waitFor(
    async () => {
      const pages = electronApp.windows();
      if (pages.length <= 0) {
        return false;
      }

      const page = pages[0];
      return {
        page,
        pageCount: pages.length,
      };
    },
    Math.max(30_000, timeoutMs),
    500,
    "Electron main window to appear",
  );

  if (result.ok && result.lastResult?.page) {
    return result.lastResult.page;
  }

  const browserWindows = await getElectronBrowserWindowState(electronApp).catch(
    () => [],
  );
  throw new Error(
    `Electron main window did not appear within timeout. Last state: ${JSON.stringify(
      {
        description: result.description,
        elapsedMs: result.elapsedMs,
        pageCount: result.lastResult?.pageCount ?? 0,
        browserWindows,
      },
    )}`,
  );
}

async function focusPrimaryElectronWindow(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return false;
    }

    if (win.isMinimized()) {
      win.restore();
    }

    win.show();
    win.focus();

    const views = win.getBrowserViews();
    const wc = views.length > 0 ? views[0].webContents : win.webContents;
    wc?.focus();
    return true;
  });
}

async function evaluateInElectronWindowByIndex(electronApp, index, scriptBody) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, { index: targetIndex, script }) => {
      const win = BrowserWindow.getAllWindows()[targetIndex];
      if (!win || win.isDestroyed()) {
        throw new Error(`No Electron window at index ${targetIndex}`);
      }
      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      if (!wc || wc.isDestroyed()) {
        throw new Error(
          `No live webContents for Electron window at index ${targetIndex}`,
        );
      }
      return wc.executeJavaScript(script, true);
    },
    { index, script: scriptBody },
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

function getIncomingCallNotifications(notifications) {
  return (Array.isArray(notifications) ? notifications : []).filter((entry) => {
    const title = String(entry?.title || "");
    const body = String(entry?.body || "");
    const tag = String(entry?.tag || "");
    return (
      /incoming call/i.test(title) ||
      /is calling you/i.test(body) ||
      /^incoming-call:/i.test(tag)
    );
  });
}

async function isElectronAuthenticated(electronApp) {
  const script = `(() => {
    const url = window.location.href || '';
    const hasLoginForm = Boolean(
      document.querySelector('input[name="email"], input[name="pass"], #login_form, [data-testid="royal_login_form"]')
    );
    return {
      url,
      authenticated: !/facebook\\.com\\/login/i.test(url) && !hasLoginForm,
    };
  })();`;
  return evaluateInElectronPage(electronApp, script);
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

function readOnePasswordFacebookCredentials({ item, vault }) {
  const escapedItem = JSON.stringify(String(item));
  const escapedVault =
    vault && String(vault).trim() ? JSON.stringify(String(vault).trim()) : "";

  const command = escapedVault
    ? `op signin >/dev/null && op item get ${escapedItem} --vault ${escapedVault} --format json`
    : `op signin >/dev/null && op item get ${escapedItem} --format json`;

  let output;
  try {
    output = execFileSync("/bin/bash", ["-lc", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail =
      (error && error.stderr && String(error.stderr).trim()) ||
      (error && error.message) ||
      "unknown 1Password CLI error";
    throw new Error(
      `Unable to read 1Password item \"${item}\". Ensure 1Password app integration is enabled and authorize when prompted. Detail: ${detail}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(output));
  } catch {
    throw new Error(`Failed to parse 1Password item JSON for \"${item}\".`);
  }

  const fields = Array.isArray(parsed.fields) ? parsed.fields : [];

  const pickFieldValue = (predicate) => {
    const field = fields.find(predicate);
    if (!field) return undefined;
    if (typeof field.value === "string" && field.value.trim())
      return field.value.trim();
    return undefined;
  };

  const username = pickFieldValue(
    (field) =>
      field.purpose === "USERNAME" ||
      /user(name)?|email|login/i.test(`${field.label || ""} ${field.id || ""}`),
  );

  const password = pickFieldValue(
    (field) =>
      field.purpose === "PASSWORD" ||
      /pass(word)?/i.test(`${field.label || ""} ${field.id || ""}`),
  );

  const otp = pickFieldValue(
    (field) =>
      field.type === "OTP" ||
      /otp|one[- ]time|totp|2fa|auth/i.test(
        `${field.label || ""} ${field.id || ""}`,
      ),
  );

  if (!username || !password) {
    throw new Error(
      `1Password item \"${item}\" is missing username/password fields.`,
    );
  }

  return { username, password, otp };
}

async function attemptTesterBLoginWithOnePassword(page, { item, vault }) {
  console.log(
    `[Setup] TesterB session unauthenticated, attempting 1Password login via item: ${item}`,
  );

  const credentials = readOnePasswordFacebookCredentials({ item, vault });

  await page.goto(
    "https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2Fmessages%2F",
    {
      waitUntil: "domcontentloaded",
    },
  );

  await page.locator('input[name="email"]').first().fill(credentials.username);
  await page.locator('input[name="pass"]').first().fill(credentials.password);

  let submitClicked = await page.evaluate(() => {
    const selectors = [
      'button[name="login"]',
      "#loginbutton",
      'button[type="submit"]',
      'input[name="login"]',
      'input[type="submit"]',
      '[role="button"][aria-label*="log in" i]',
      '[role="button"][aria-label*="login" i]',
    ];

    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    };

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      for (const el of candidates) {
        const disabled =
          el.hasAttribute("disabled") ||
          el.getAttribute("aria-disabled") === "true";
        if (disabled || !isVisible(el)) continue;
        el.click();
        return true;
      }
    }

    const form = document.querySelector("form");
    if (form) {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      return true;
    }

    return false;
  });

  if (!submitClicked) {
    try {
      await page
        .locator('input[name="pass"]')
        .first()
        .press("Enter", { timeout: 1500 });
      submitClicked = true;
    } catch {
      // ignore
    }
  }

  if (!submitClicked) {
    throw new Error("Could not submit Facebook login form in TesterB session.");
  }

  await page.waitForLoadState("domcontentloaded");
  await wait(1500);

  const needsOtp = await page.evaluate(() => {
    return Boolean(
      document.querySelector(
        'input[name="approvals_code"], input[name="code"], input[autocomplete="one-time-code"]',
      ),
    );
  });

  if (needsOtp) {
    if (!credentials.otp) {
      throw new Error(
        "Facebook requested OTP but 1Password item has no OTP field configured.",
      );
    }

    const otpInput = page
      .locator(
        'input[name="approvals_code"], input[name="code"], input[autocomplete="one-time-code"]',
      )
      .first();
    await otpInput.fill(credentials.otp);

    const otpSubmitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      '[name="submit[Continue]"]',
    ];
    for (const selector of otpSubmitSelectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      try {
        await locator.click({ timeout: 1500 });
        break;
      } catch {
        // try next selector
      }
    }

    await page.waitForLoadState("domcontentloaded");
    await wait(1500);
  }

  const authState = await isBrowserAuthenticated(page);
  if (!authState.authenticated) {
    throw new Error(
      `TesterB 1Password login did not complete. Current URL: ${authState.url}`,
    );
  }

  console.log("[Setup] TesterB login via 1Password succeeded.");
}

function attachDialogLogging(page, label) {
  if (!page || dialogLoggingHandlers.has(page)) return;

  const handler = async (dialog) => {
    try {
      console.log(`[Dialog] ${label}: ${dialog.type()} ${dialog.message()}`);
    } catch {
      /* intentionally empty */
    }
    try {
      await dialog.dismiss();
    } catch {
      /* intentionally empty */
    }
  };

  dialogLoggingHandlers.set(page, handler);
  page.on("dialog", handler);
}

function detachDialogLogging(page) {
  if (!page) return;
  const handler = dialogLoggingHandlers.get(page);
  if (!handler) return;
  page.removeListener("dialog", handler);
  dialogLoggingHandlers.delete(page);
}

async function closeBrowserContextPages(context) {
  if (!context) return;

  const pages = context.pages().slice();
  for (const page of pages) {
    await page.close({ runBeforeUnload: false }).catch(() => {});
  }
}

async function shutdownElectronApp(electronApp) {
  if (!electronApp) return;

  const childProcess =
    typeof electronApp.process === "function" ? electronApp.process() : null;
  const waitForExit =
    childProcess &&
    typeof childProcess.once === "function" &&
    !childProcess.killed
      ? new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          childProcess.once("exit", finish);
          setTimeout(finish, 2000);
        })
      : Promise.resolve();

  await electronApp
    .evaluate(async ({ app, BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) {
            win.destroy();
          }
        } catch {
          // ignore
        }
      }

      try {
        app.exit(0);
      } catch {
        // ignore
      }

      return true;
    })
    .catch(() => {});

  await waitForExit.catch?.(() => {});
}

function buildElectronLaunchOptions({ executablePath, appEntry }) {
  return executablePath
    ? {
        executablePath,
        env: {
          ...process.env,
          MESSENGER_TEST_CAPTURE_NOTIFICATIONS: "1",
        },
      }
    : {
        args: [appEntry],
        env: {
          ...process.env,
          NODE_ENV: "development",
          MESSENGER_TEST_CAPTURE_NOTIFICATIONS: "1",
        },
      };
}

async function launchElectronAppWithRetries({
  executablePath,
  appEntry,
  timeoutMs,
  maxAttempts = ELECTRON_LAUNCH_ATTEMPTS,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    let electronApp = null;

    try {
      electronApp = await electron.launch(
        buildElectronLaunchOptions({ executablePath, appEntry }),
      );
      const testerAWindow = await waitForPrimaryElectronWindow(
        electronApp,
        timeoutMs,
      );
      return { electronApp, testerAWindow, attempt };
    } catch (error) {
      lastError = error;
      console.log(
        `[Setup] Electron launch attempt ${attempt} failed: ${error?.message || error}`,
      );
      if (electronApp) {
        await shutdownElectronApp(electronApp);
      }
      if (attempt < Math.max(1, maxAttempts)) {
        await wait(1500);
      }
    }
  }

  throw lastError || new Error("Electron launch failed");
}

async function waitForTesterBManualLogin(page, timeoutMs) {
  const waitMs = Math.max(0, Number(timeoutMs || 0));
  if (waitMs <= 0) return false;

  console.log(
    `[Setup] Waiting up to ${waitMs}ms for manual TesterB login completion (solve any checkpoint/2FA in browser window)...`,
  );

  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const auth = await isBrowserAuthenticated(page);
    if (auth.authenticated) {
      return true;
    }
    await wait(2000);
  }

  return false;
}

function buildIncomingVisibleScript() {
  const helpers = buildVisibilityHelpers();
  return `(() => {
    const isVisible = ${helpers.isVisibleSource};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const collectVisibleLabels = (elements) => {
      const labels = [];
      for (const el of elements) {
        if (!isVisible(el)) continue;
        const label = normalize(el.getAttribute('aria-label') || el.textContent || '');
        if (!label) continue;
        labels.push(label);
      }
      return Array.from(new Set(labels));
    };
    const hasVisible = (selectors) => {
      const all = Array.from(document.querySelectorAll(selectors.join(', ')));
      return all.some((el) => isVisible(el));
    };
    const collectMatches = (selectors) =>
      Array.from(document.querySelectorAll(selectors.join(', ')));

    const answerSelectors = ${JSON.stringify(INCOMING_ANSWER_SELECTORS)};
    const declineSelectors = ${JSON.stringify(INCOMING_DECLINE_SELECTORS)};
    const topBarSelectors = ${JSON.stringify(TOP_BAR_CHROME_SELECTORS)};
    const answerMatches = collectMatches(answerSelectors);
    const declineMatches = collectMatches(declineSelectors);

    const hasAnswer = answerMatches.some((el) => isVisible(el));
    const hasDecline = declineMatches.some((el) => isVisible(el));
    const visibleButtonLabels = collectVisibleLabels(
      Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]')),
    );
    const hasJoinAction = visibleButtonLabels.some((label) =>
      ${INCOMING_JOIN_PATTERN}.test(label),
    );
    const topBarChromeVisibleLabels = collectVisibleLabels(
      Array.from(document.querySelectorAll(topBarSelectors.join(', '))),
    );

    return {
      hasAnswer,
      hasDecline,
      hasJoinAction,
      visible: hasAnswer && hasDecline,
      actionableVisible: (hasAnswer && hasDecline) || hasJoinAction,
      url: window.location.href,
      title: document.title,
      answerNodeCount: answerMatches.length,
      declineNodeCount: declineMatches.length,
      visibleButtonLabels: visibleButtonLabels.slice(0, 40),
      topBarChromeVisible: topBarChromeVisibleLabels.length > 0,
      topBarChromeVisibleLabels: topBarChromeVisibleLabels.slice(0, 20),
    };
  })();`;
}

function buildCallSurfaceStateScript() {
  const helpers = buildVisibilityHelpers();
  return `(() => {
    const isVisible = ${helpers.isVisibleSource};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const resolveMutedState = (labels) => {
      const normalizedLabels = labels.map((label) => normalize(label).toLowerCase());
      if (normalizedLabels.some((label) => label.includes('unmute'))) {
        return true;
      }
      if (normalizedLabels.some((label) => label.includes('mute'))) {
        return false;
      }
      return null;
    };
    const collectVisibleLabels = (elements) => {
      const labels = [];
      for (const el of elements) {
        if (!isVisible(el)) continue;
        const label = normalize(el.getAttribute('aria-label') || el.textContent || '');
        if (!label) continue;
        labels.push(label);
      }
      return Array.from(new Set(labels));
    };
    const hasVisible = (selectors) => {
      const all = Array.from(document.querySelectorAll(selectors.join(', ')));
      return all.some((el) => isVisible(el));
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    const visibleButtonLabels = collectVisibleLabels(buttons);
    const answerSelectors = ${JSON.stringify(INCOMING_ANSWER_SELECTORS)};
    const declineSelectors = ${JSON.stringify(INCOMING_DECLINE_SELECTORS)};
    const hangupPatterns = ${JSON.stringify(IN_CALL_HANGUP_INCLUDE_PATTERNS.map((r) => r.source))}
      .map((source) => new RegExp(source, 'i'));
    const activePatterns = ${JSON.stringify(IN_CALL_ACTIVE_INCLUDE_PATTERNS.map((r) => r.source))}
      .map((source) => new RegExp(source, 'i'));
    const topBarSelectors = ${JSON.stringify(TOP_BAR_CHROME_SELECTORS)};

    const hasAnswer = hasVisible(answerSelectors);
    const hasDecline = hasVisible(declineSelectors);
    const hasJoin = visibleButtonLabels.some((label) => /join call|join audio call|join video call/i.test(label));
    const incomingVisible = (hasAnswer && hasDecline) || (hasAnswer && hasJoin);
    const hangupLabels = visibleButtonLabels.filter((label) =>
      hangupPatterns.some((pattern) => pattern.test(label)),
    );
    const activeLabels = visibleButtonLabels.filter((label) =>
      activePatterns.some((pattern) => pattern.test(label)),
    );

    const topBarChromeVisibleLabels = collectVisibleLabels(
      Array.from(document.querySelectorAll(topBarSelectors.join(', '))),
    );

    const root = document.querySelector('[data-pagelet="root"]');
    const rootStyle = root instanceof HTMLElement ? window.getComputedStyle(root) : null;
    const bodyText = normalize(document.body?.innerText || '');
    const statusMatch = bodyText.match(
      /(ongoing call|calling|ringing|call ended|call declined|no answer|busy|answered elsewhere)/i,
    );

    return {
      url: window.location.href,
      title: document.title,
      incomingVisible,
      hasAnswer,
      hasDecline,
      hasJoin,
      canHangUp: hangupLabels.length > 0,
      hasInCallControls: activeLabels.length > 0,
      isMuted: resolveMutedState(activeLabels),
      hangupLabels: hangupLabels.slice(0, 10),
      activeLabels: activeLabels.slice(0, 20),
      visibleButtonLabels: visibleButtonLabels.slice(0, 40),
      incomingCallCleanClass: document.documentElement.classList.contains('md-fb-incoming-call-clean'),
      topBarChromeVisible: topBarChromeVisibleLabels.length > 0,
      topBarChromeVisibleLabels: topBarChromeVisibleLabels.slice(0, 20),
      rootMarginTop: rootStyle ? rootStyle.marginTop : null,
      rootPaddingTop: rootStyle ? rootStyle.paddingTop : null,
      statusText: statusMatch ? statusMatch[0] : null,
    };
  })();`;
}

function buildClickCallStartScript() {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const includePatterns = ${JSON.stringify(
      CALL_START_INCLUDE_PATTERNS.map((r) => r.source),
    )}.map((source) => new RegExp(source, 'i'));
    const excludePattern = new RegExp(${JSON.stringify(CALL_START_EXCLUDE_PATTERN.source)}, 'i');

    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      if (excludePattern.test(label)) continue;
      if (!includePatterns.some((re) => re.test(label))) continue;

      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { clicked: true, label };
    }

    return { clicked: false, label: null };
  })();`;
}

function buildThreadReadyScript() {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    const visibleLabels = buttons
      .filter((el) => isVisible(el))
      .map((el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);

    const hasCallButtons = visibleLabels.some((label) =>
      /start a voice call|start a video call|audio call|video chat|voice call/i.test(label),
    );
    const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const hasPinPrompt = /enter your pin to restore your chat history|restore now|forgot pin/i.test(bodyText);

    return {
      url: window.location.href,
      title: document.title,
      hasCallButtons,
      hasPinPrompt,
      visibleLabels: visibleLabels.slice(0, 40),
    };
  })();`;
}

function buildClickDeclineScript() {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const selectors = ${JSON.stringify(INCOMING_DECLINE_SELECTORS)};
    const all = Array.from(document.querySelectorAll(selectors.join(', ')));
    for (const el of all) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { clicked: true, label };
    }
    return { clicked: false, label: null };
  })();`;
}

function buildClickAnswerScript() {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const selectors = ${JSON.stringify(INCOMING_ANSWER_SELECTORS)};
    const all = Array.from(document.querySelectorAll(selectors.join(', ')));
    for (const el of all) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { clicked: true, label };
    }

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    for (const el of buttons) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!/answer|accept|accept call|join call|accept video call|accept audio call/i.test(label)) continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { clicked: true, label };
    }

    return { clicked: false, label: null };
  })();`;
}

function buildClickHangupScript() {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const includePatterns = ${JSON.stringify(
      IN_CALL_HANGUP_INCLUDE_PATTERNS.map((r) => r.source),
    )}.map((source) => new RegExp(source, 'i'));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));

    for (const el of buttons) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!label) continue;
      if (!includePatterns.some((re) => re.test(label))) continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { clicked: true, label };
    }

    return { clicked: false, label: null };
  })();`;
}

function buildClickMuteToggleScript(expectMuted) {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    const includePattern = new RegExp(${JSON.stringify(
      expectMuted ? "\\bunmute\\b" : "\\bmute\\b",
    )}, 'i');
    const excludePattern = new RegExp(${JSON.stringify(
      expectMuted ? "\\bmute\\b" : "\\bunmute\\b",
    )}, 'i');

    for (const el of buttons) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!label) continue;
      if (excludePattern.test(label)) continue;
      if (!includePattern.test(label)) continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { clicked: true, label };
    }

    return { clicked: false, label: null };
  })();`;
}

function buildSendMessageScript(message) {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const desiredMessage = ${JSON.stringify(message)};
    const candidates = Array.from(
      document.querySelectorAll(
        'div[contenteditable=\"true\"][role=\"textbox\"], div[contenteditable=\"true\"][aria-label*=\"message\" i], div[contenteditable=\"true\"]'
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

async function waitFor(fn, timeoutMs, intervalMs, description) {
  const start = Date.now();
  let lastResult;
  while (Date.now() - start < timeoutMs) {
    lastResult = await fn();
    if (lastResult) {
      return { ok: true, elapsedMs: Date.now() - start, lastResult };
    }
    await wait(intervalMs);
  }
  return { ok: false, elapsedMs: Date.now() - start, lastResult, description };
}

async function verifyStableVisibility(
  checkFn,
  durationMs = 6000,
  intervalMs = 300,
) {
  const startedAt = Date.now();
  let lastVisibleResult = null;
  while (Date.now() - startedAt < durationMs) {
    const result = await checkFn();
    const visible =
      typeof result === "boolean"
        ? result
        : Boolean(
            result && typeof result === "object" && "visible" in result
              ? result.visible
              : result,
          );
    if (!visible) {
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        firstFailure: result ?? null,
        lastVisibleResult,
      };
    }
    lastVisibleResult = result === true ? { visible: true } : result;
    await wait(intervalMs);
  }
  return { ok: true, elapsedMs: Date.now() - startedAt, lastVisibleResult };
}

async function waitForThreadReady(target, timeoutMs, description) {
  const script = buildThreadReadyScript();
  return waitFor(
    async () => {
      const state = await target.evaluate(script);
      return state.hasCallButtons && !state.hasPinPrompt ? state : false;
    },
    timeoutMs,
    1000,
    description,
  );
}

async function waitForElectronThreadReady(electronApp, timeoutMs, description) {
  const script = buildThreadReadyScript();
  return waitFor(
    async () => {
      const state = await evaluateInElectronPage(electronApp, script);
      return state.hasCallButtons && !state.hasPinPrompt ? state : false;
    },
    timeoutMs,
    1000,
    description,
  );
}

async function waitForNotificationPredicate(
  electronApp,
  predicate,
  timeoutMs,
  description,
) {
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
    description,
  };
}

async function getElectronCallSurfaceStates(electronApp) {
  const results = await evaluateInElectronWindows(
    electronApp,
    buildCallSurfaceStateScript(),
  );
  return results.filter((entry) => entry && !entry.error);
}

async function getPrimaryElectronCallSurfaceState(electronApp) {
  const states = await getElectronCallSurfaceStates(electronApp);
  return states.find((entry) => entry.index === 0) || null;
}

async function getBrowserCallSurfaceStates(context) {
  const pages = context.pages();
  return Promise.all(
    pages.map(async (page, index) => {
      try {
        const value = await page.evaluate(buildCallSurfaceStateScript());
        return {
          index,
          currentUrl: page.url(),
          title: await page.title().catch(() => ""),
          value,
        };
      } catch (error) {
        return {
          index,
          currentUrl: page.url(),
          error: String((error && error.message) || error),
        };
      }
    }),
  );
}

async function waitForElectronSurface(
  electronApp,
  predicate,
  timeoutMs,
  description,
) {
  return waitFor(
    async () => {
      const states = await getElectronCallSurfaceStates(electronApp);
      const match = states.find((entry) => predicate(entry.value));
      return match ? { match, states } : false;
    },
    timeoutMs,
    500,
    description,
  );
}

async function waitForPrimaryElectronSurface(
  electronApp,
  predicate,
  timeoutMs,
  description,
) {
  return waitFor(
    async () => {
      const state = await getPrimaryElectronCallSurfaceState(electronApp);
      return state && predicate(state.value) ? state : false;
    },
    timeoutMs,
    500,
    description,
  );
}

async function waitForElectronWindowState(
  electronApp,
  windowIndex,
  predicate,
  timeoutMs,
  description,
) {
  const script = buildCallSurfaceStateScript();
  return waitFor(
    async () => {
      const value = await evaluateInElectronWindowByIndex(
        electronApp,
        windowIndex,
        script,
      );
      return predicate(value) ? value : false;
    },
    timeoutMs,
    500,
    description,
  );
}

async function waitForBrowserSurface(
  context,
  predicate,
  timeoutMs,
  description,
) {
  return waitFor(
    async () => {
      const states = await getBrowserCallSurfaceStates(context);
      const match = states.find(
        (entry) => entry && !entry.error && predicate(entry.value),
      );
      return match ? { match, states } : false;
    },
    timeoutMs,
    500,
    description,
  );
}

async function waitForBrowserNoCallSurface(context, timeoutMs, description) {
  return waitFor(
    async () => {
      const states = await getBrowserCallSurfaceStates(context);
      const active = states.find(
        (entry) =>
          entry &&
          !entry.error &&
          entry.value &&
          (entry.value.canHangUp || entry.value.incomingVisible),
      );
      return active ? false : { states };
    },
    timeoutMs,
    500,
    description,
  );
}

async function getElectronWindowPages(electronApp) {
  return Promise.all(
    electronApp.windows().map(async (page, index) => ({
      index,
      page,
      currentUrl: page.url(),
      title: await page.title().catch(() => ""),
    })),
  );
}

async function waitForElectronWindowPage(
  electronApp,
  predicate,
  timeoutMs,
  description,
) {
  return waitFor(
    async () => {
      const pages = await getElectronWindowPages(electronApp);
      const match = pages.find((entry) => predicate(entry));
      return match ? { match, pages } : false;
    },
    timeoutMs,
    500,
    description,
  );
}

async function clickElectronWindowAction(electronApp, windowIndex, scriptBody) {
  return evaluateInElectronWindowByIndex(electronApp, windowIndex, scriptBody);
}

async function clickElectronWindowButtonViaInput(
  electronApp,
  windowIndex,
  pattern,
) {
  const helpers = buildVisibilityHelpers();
  return electronApp.evaluate(
    async ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[payload.windowIndex];
      if (!win || win.isDestroyed()) {
        throw new Error(`No Electron window at index ${payload.windowIndex}`);
      }

      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      if (!wc || wc.isDestroyed()) {
        throw new Error(
          `No live webContents for Electron window at index ${payload.windowIndex}`,
        );
      }

      const target = await wc.executeJavaScript(
        `(() => {
          const isVisible = ${payload.isVisibleSource};
          const matcher = new RegExp(${JSON.stringify(payload.patternSource)}, ${JSON.stringify(payload.patternFlags)});
          const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
          for (const el of buttons) {
            if (!isVisible(el)) continue;
            const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!label || !matcher.test(label)) continue;
            const rect = el.getBoundingClientRect();
            return {
              clicked: true,
              label,
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          }
          return { clicked: false, label: null };
        })();`,
        true,
      );

      if (
        !target ||
        target.clicked !== true ||
        typeof target.x !== "number" ||
        typeof target.y !== "number"
      ) {
        return { clicked: false, label: target?.label || null };
      }

      const x = Math.round(target.x);
      const y = Math.round(target.y);
      wc.focus();
      wc.sendInputEvent({ type: "mouseMove", x, y, button: "left" });
      wc.sendInputEvent({
        type: "mouseDown",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      wc.sendInputEvent({
        type: "mouseUp",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return { clicked: true, label: target.label, x, y };
    },
    {
      windowIndex,
      patternSource: pattern.source,
      patternFlags: pattern.flags,
      isVisibleSource: helpers.isVisibleSource,
    },
  );
}

async function clickBrowserPageAction(context, pageIndex, scriptBody) {
  const page = context.pages()[pageIndex];
  if (!page) {
    throw new Error(`No browser page at index ${pageIndex}`);
  }
  return page.evaluate(scriptBody);
}

async function closeBrowserPagesMatching(context, predicate) {
  const pages = context.pages();
  for (const page of pages) {
    if (!predicate(page.url())) continue;
    await page.close().catch(() => {});
  }
}

function describeSurface(prefix, entry) {
  const state = entry?.value || {};
  const location = entry.currentUrl || state.url || "unknown";
  const labels = Array.isArray(state.visibleButtonLabels)
    ? state.visibleButtonLabels.slice(0, 8).join(" | ")
    : "";
  return `${prefix} window/page ${entry.index} @ ${location} incoming=${Boolean(state.incomingVisible)} inCall=${Boolean(state.hasInCallControls || state.canHangUp)} clean=${Boolean(state.incomingCallCleanClass)} topBarVisible=${Boolean(state.topBarChromeVisible)} labels=[${labels}]`;
}

function assertTesterAIncomingTopBarState(entry) {
  const state = entry?.value || {};
  if (state.topBarChromeVisible) {
    throw new Error(
      `TesterA incoming overlay still showed Facebook top-bar chrome. State: ${JSON.stringify(state)}`,
    );
  }
  if (!state.incomingVisible) {
    throw new Error(
      `TesterA incoming overlay was not visibly actionable. State: ${JSON.stringify(state)}`,
    );
  }
  if (!state.incomingCallCleanClass) {
    console.log(
      `[Answer TesterA] Incoming-call clean class absent; accepting hidden top-bar state instead. State: ${JSON.stringify(state)}`,
    );
  }
}

async function waitForTesterACleanup(electronApp, timeoutMs, description) {
  return waitForPrimaryElectronSurface(
    electronApp,
    (state) =>
      Boolean(
        state &&
        !state.incomingVisible &&
        !state.canHangUp &&
        !state.incomingCallCleanClass,
      ),
    timeoutMs,
    description,
  );
}

async function waitForElectronPageButtonState(
  page,
  pattern,
  timeoutMs,
  description,
) {
  let lastState = null;
  const result = await waitFor(
    async () => {
      await page.bringToFront().catch(() => {});
      await page.mouse.move(320, 320).catch(() => {});
      const button = page.getByRole("button", { name: pattern }).first();
      const visible = await button.isVisible().catch(() => false);
      const state = await page
        .evaluate(buildCallSurfaceStateScript())
        .catch(() => null);
      lastState = state;
      return visible ? state || { visible: true } : false;
    },
    timeoutMs,
    500,
    description,
  );

  if (result.ok) {
    return result;
  }

  return {
    ...result,
    lastResult: lastState,
  };
}

async function exerciseMuteToggleCycles({
  electronApp,
  timeoutMs,
  prefix,
  cycles = 5,
}) {
  const callWindowPage = await waitForElectronWindowPage(
    electronApp,
    (entry) => /\/groupcall\//i.test(String(entry.currentUrl || "")),
    timeoutMs,
    `${prefix} call window page`,
  );
  if (!callWindowPage.ok) {
    throw new Error(
      `${prefix} could not find a live Electron call window page. Last state: ${JSON.stringify(callWindowPage.lastResult)}`,
    );
  }

  const callPage = callWindowPage.lastResult.match.page;
  await callPage.bringToFront();

  for (let attempt = 0; attempt < cycles; attempt += 1) {
    const muteButton = callPage
      .getByRole("button", { name: /^Mute microphone$/i })
      .first();
    await muteButton.waitFor({
      state: "visible",
      timeout: Math.min(timeoutMs, 15_000),
    });
    const muteLabel =
      (await muteButton.getAttribute("aria-label")) ||
      (await muteButton.textContent()) ||
      "Mute microphone";
    await muteButton.click({ timeout: Math.min(timeoutMs, 15_000) });
    await wait(500);
    console.log(`${prefix} mute cycle ${attempt + 1}: ${muteLabel}`);

    const mutedState = await waitForElectronPageButtonState(
      callPage,
      /^Unmute microphone$/i,
      timeoutMs,
      `${prefix} muted state on cycle ${attempt + 1}`,
    );
    if (!mutedState.ok) {
      throw new Error(
        `${prefix} did not stay in an active muted call state on cycle ${attempt + 1}. Last state: ${JSON.stringify(mutedState.lastResult)}`,
      );
    }

    await wait(1000);
    await callPage.bringToFront().catch(() => {});
    await callPage.mouse.move(320, 320).catch(() => {});

    const unmuteButton = callPage
      .getByRole("button", { name: /^Unmute microphone$/i })
      .first();
    await unmuteButton.waitFor({
      state: "visible",
      timeout: Math.min(timeoutMs, 15_000),
    });
    const unmuteLabel =
      (await unmuteButton.getAttribute("aria-label")) ||
      (await unmuteButton.textContent()) ||
      "Unmute microphone";
    await unmuteButton.click({ timeout: Math.min(timeoutMs, 15_000) });
    await wait(500);
    console.log(`${prefix} unmute cycle ${attempt + 1}: ${unmuteLabel}`);

    const unmutedState = await waitForElectronPageButtonState(
      callPage,
      /^Mute microphone$/i,
      timeoutMs,
      `${prefix} unmuted state on cycle ${attempt + 1}`,
    );
    if (!unmutedState.ok) {
      throw new Error(
        `${prefix} did not recover to an active unmuted call state on cycle ${attempt + 1}. Last state: ${JSON.stringify(unmutedState.lastResult)}`,
      );
    }
  }
}

async function runIncomingTesterBToTesterA({
  electronApp,
  testerBPage,
  timeoutMs,
}) {
  console.log(
    "\n[Incoming] TesterB -> TesterA: triggering call from TesterB web session...",
  );

  const threadReady = await waitForThreadReady(
    testerBPage,
    timeoutMs,
    "TesterB thread to expose call controls",
  );
  if (!threadReady.ok) {
    throw new Error(
      `TesterB thread not ready for calling. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  const clickFromTesterB = await testerBPage.evaluate(
    buildClickCallStartScript(),
  );
  if (!clickFromTesterB.clicked) {
    throw new Error("Failed to click call start button in TesterB session");
  }
  console.log(
    `[Incoming] TesterB call button clicked: ${clickFromTesterB.label}`,
  );

  const incomingVisibleScript = buildIncomingVisibleScript();

  const appeared = await waitFor(
    async () => {
      const state = await evaluateInElectronPage(
        electronApp,
        incomingVisibleScript,
      );
      return state.visible ? state : false;
    },
    timeoutMs,
    500,
    "TesterA incoming call controls to appear",
  );

  if (!appeared.ok) {
    throw new Error(
      "Incoming call controls did not appear in TesterA app within timeout",
    );
  }

  console.log(
    `[Incoming] TesterA incoming controls detected after ${appeared.elapsedMs}ms`,
  );
  await focusPrimaryElectronWindow(electronApp).catch(() => false);

  const stable = await verifyStableVisibility(
    async () => {
      const state = await evaluateInElectronPage(
        electronApp,
        incomingVisibleScript,
      );
      if (!state) {
        return false;
      }

      return {
        ...state,
        visible: Boolean(
          state.actionableVisible && state.topBarChromeVisible === false,
        ),
      };
    },
    INCOMING_RING_STABILITY_MS,
    INCOMING_RING_STABILITY_SAMPLE_MS,
  );

  if (!stable.ok) {
    throw new Error(
      `Incoming call controls disappeared too early on TesterA app (after ${stable.elapsedMs}ms of ${INCOMING_RING_STABILITY_MS}ms). First disappearance: ${JSON.stringify(stable.firstFailure)}. Last visible snapshot: ${JSON.stringify(stable.lastVisibleResult)}`,
    );
  }

  console.log(
    `[Incoming] TesterA incoming controls stayed visible for >= ${INCOMING_RING_STABILITY_MS}ms (sample every ${INCOMING_RING_STABILITY_SAMPLE_MS}ms)`,
  );
  if (
    stable.lastVisibleResult &&
    stable.lastVisibleResult.hasJoinAction &&
    !stable.lastVisibleResult.hasAnswer
  ) {
    console.log(
      "[Incoming] TesterA incoming surface transitioned from Accept/Decline to Join Audio/Video Chat while remaining actionable.",
    );
  }

  const declineOnTesterA = await evaluateInElectronPage(
    electronApp,
    buildClickDeclineScript(),
  );
  if (declineOnTesterA.clicked) {
    console.log(
      `[Incoming] Declined call on TesterA side: ${declineOnTesterA.label || "Decline"}`,
    );
  }
}

async function runOutgoingTesterAToTesterB({
  electronApp,
  testerBPage,
  timeoutMs,
}) {
  console.log(
    "\n[Outgoing] TesterA -> TesterB: triggering call from TesterA desktop app...",
  );

  const threadReady = await waitForThreadReady(
    testerBPage,
    timeoutMs,
    "TesterB thread to expose call controls before outgoing validation",
  );
  if (!threadReady.ok) {
    throw new Error(
      `TesterB thread not ready for outgoing validation. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  const clickFromTesterA = await evaluateInElectronPage(
    electronApp,
    buildClickCallStartScript(),
  );
  if (!clickFromTesterA.clicked) {
    throw new Error("Failed to click call start button in TesterA app");
  }
  console.log(
    `[Outgoing] TesterA call button clicked: ${clickFromTesterA.label}`,
  );

  const appeared = await waitFor(
    async () => {
      const state = await testerBPage.evaluate(buildIncomingVisibleScript());
      return state.visible ? state : false;
    },
    timeoutMs,
    500,
    "TesterB incoming call controls to appear",
  );

  if (!appeared.ok) {
    throw new Error(
      "Incoming call controls did not appear in TesterB session within timeout",
    );
  }

  console.log(
    `[Outgoing] TesterB incoming controls detected after ${appeared.elapsedMs}ms`,
  );

  const declineOnTesterB = await testerBPage.evaluate(
    buildClickDeclineScript(),
  );
  if (declineOnTesterB.clicked) {
    console.log(
      `[Outgoing] Declined call on TesterB side: ${declineOnTesterB.label || "Decline"}`,
    );
  }
}

async function runTesterBToTesterAAnsweredFlow({
  electronApp,
  testerBPage,
  testerAThreadUrl,
  timeoutMs,
}) {
  const testerBContext = testerBPage.context();

  console.log(
    "\n[Answer TesterA] TesterB -> TesterA: ring, answer on TesterA, then hang up...",
  );
  await clearCapturedNotifications(electronApp);

  const threadReady = await waitForThreadReady(
    testerBPage,
    timeoutMs,
    "TesterB thread to expose call controls before TesterA-answer validation",
  );
  if (!threadReady.ok) {
    throw new Error(
      `TesterB thread not ready before TesterA-answer validation. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  const clickFromTesterB = await testerBPage.evaluate(
    buildClickCallStartScript(),
  );
  if (!clickFromTesterB.clicked) {
    throw new Error(
      "Failed to click call start button in TesterB session for TesterA-answer flow",
    );
  }
  console.log(
    `[Answer TesterA] TesterB call button clicked: ${clickFromTesterB.label}`,
  );

  const initialNotification = await waitForNotificationPredicate(
    electronApp,
    (notifications) => getIncomingCallNotifications(notifications).length >= 1,
    Math.min(timeoutMs, 10000),
    "TesterA native incoming-call notification to appear",
  );
  if (!initialNotification.ok) {
    throw new Error(
      `TesterA did not receive an incoming-call notification before answer. Notifications: ${JSON.stringify(initialNotification.notifications)}`,
    );
  }

  const appeared = await waitForElectronSurface(
    electronApp,
    (state) => Boolean(state && state.incomingVisible),
    timeoutMs,
    "TesterA incoming controls to appear for TesterA-answer validation",
  );
  if (!appeared.ok) {
    throw new Error(
      `TesterA incoming controls did not appear for TesterA-answer validation. Last state: ${JSON.stringify(appeared.lastResult)}`,
    );
  }

  console.log(
    describeSurface(
      "[Answer TesterA] TesterA incoming surface",
      appeared.lastResult.match,
    ),
  );
  assertTesterAIncomingTopBarState(appeared.lastResult.match);

  const answerOnTesterA = await clickElectronWindowButtonViaInput(
    electronApp,
    appeared.lastResult.match.index,
    /answer|accept|join call|accept call|accept video call|accept audio call/i,
  );
  if (!answerOnTesterA.clicked) {
    throw new Error("Failed to answer call on TesterA side");
  }
  console.log(`[Answer TesterA] Answered on TesterA: ${answerOnTesterA.label}`);

  await wait(4000);
  const notificationsAfterAnswer = await readCapturedNotifications(electronApp);
  const incomingCallNotificationsAfterAnswer = getIncomingCallNotifications(
    notificationsAfterAnswer,
  );
  if (incomingCallNotificationsAfterAnswer.length !== 1) {
    throw new Error(
      `Expected exactly one incoming-call notification across ring + answer, saw ${incomingCallNotificationsAfterAnswer.length}: ${JSON.stringify(incomingCallNotificationsAfterAnswer)}`,
    );
  }

  const testerAActive = await waitForElectronSurface(
    electronApp,
    (state) => Boolean(state && (state.canHangUp || state.hasInCallControls)),
    timeoutMs,
    "TesterA in-call controls after answering on TesterA",
  );
  if (!testerAActive.ok) {
    throw new Error(
      `TesterA did not transition to in-call controls after answering. Last state: ${JSON.stringify(testerAActive.lastResult)}`,
    );
  }
  console.log(
    describeSurface(
      "[Answer TesterA] TesterA active call surface",
      testerAActive.lastResult.match,
    ),
  );

  await exerciseMuteToggleCycles({
    electronApp,
    windowIndex: testerAActive.lastResult.match.index,
    timeoutMs,
    prefix: "[Answer TesterA] TesterA mute/unmute",
  });

  const testerBActive = await waitForBrowserSurface(
    testerBContext,
    (state) => Boolean(state && (state.canHangUp || state.hasInCallControls)),
    timeoutMs,
    "TesterB in-call controls after TesterA answered",
  );
  if (!testerBActive.ok) {
    throw new Error(
      `TesterB did not show in-call controls after TesterA answered. Last state: ${JSON.stringify(testerBActive.lastResult)}`,
    );
  }
  console.log(
    describeSurface(
      "[Answer TesterA] TesterB active call surface",
      testerBActive.lastResult.match,
    ),
  );

  const hangupOnTesterA = await clickElectronWindowAction(
    electronApp,
    testerAActive.lastResult.match.index,
    buildClickHangupScript(),
  );
  if (!hangupOnTesterA.clicked) {
    throw new Error("Failed to hang up on TesterA side after answering");
  }
  console.log(`[Answer TesterA] Hung up on TesterA: ${hangupOnTesterA.label}`);

  const testerACleanup = await waitForTesterACleanup(
    electronApp,
    Math.max(timeoutMs, 15000),
    "TesterA main window cleanup after TesterA-side hangup",
  );
  if (!testerACleanup.ok) {
    throw new Error(
      `TesterA main window did not clear incoming-call cleanup state after hangup. Last state: ${JSON.stringify(testerACleanup.lastResult)}`,
    );
  }
  console.log(
    describeSurface(
      "[Answer TesterA] TesterA post-hangup main surface",
      testerACleanup.lastResult,
    ),
  );

  await wait(1500);
  const testerBStatesAfter = await getBrowserCallSurfaceStates(testerBContext);
  const testerBStillActive = testerBStatesAfter.find(
    (entry) =>
      entry &&
      !entry.error &&
      entry.value &&
      (entry.value.canHangUp || entry.value.incomingVisible),
  );
  if (testerBStillActive) {
    throw new Error(
      `TesterB still showed active/ringing call UI after TesterA hung up. State: ${JSON.stringify(testerBStillActive)}`,
    );
  }

  await closeBrowserPagesMatching(testerBContext, (url) =>
    /\/groupcall\//i.test(String(url || "")),
  );
  await ensureElectronOnUrl(electronApp, testerAThreadUrl);
  await waitForElectronThreadReady(
    electronApp,
    timeoutMs,
    "TesterA thread to restore call controls after TesterA-answer hangup",
  );
}

async function runTesterAToTesterBAnsweredFlow({
  electronApp,
  testerBPage,
  testerAThreadUrl,
  timeoutMs,
}) {
  const testerBContext = testerBPage.context();

  console.log(
    "\n[Answer TesterB] TesterA -> TesterB: ring, answer on TesterB, then hang up...",
  );

  await ensureElectronOnUrl(electronApp, testerAThreadUrl);
  const testerAThreadReady = await waitForElectronThreadReady(
    electronApp,
    timeoutMs,
    "TesterA thread to expose call controls before TesterB-answer validation",
  );
  if (!testerAThreadReady.ok) {
    throw new Error(
      `TesterA thread not ready before TesterB-answer validation. Last state: ${JSON.stringify(testerAThreadReady.lastResult)}`,
    );
  }

  const threadReady = await waitForThreadReady(
    testerBPage,
    timeoutMs,
    "TesterB thread to expose call controls before TesterB-answer validation",
  );
  if (!threadReady.ok) {
    throw new Error(
      `TesterB thread not ready before TesterB-answer validation. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  const clickFromTesterA = await evaluateInElectronPage(
    electronApp,
    buildClickCallStartScript(),
  );
  if (!clickFromTesterA.clicked) {
    throw new Error(
      "Failed to click call start button in TesterA app for TesterB-answer flow",
    );
  }
  console.log(
    `[Answer TesterB] TesterA call button clicked: ${clickFromTesterA.label}`,
  );

  const testerBIncoming = await waitForBrowserSurface(
    testerBContext,
    (state) => Boolean(state && state.incomingVisible),
    timeoutMs,
    "TesterB incoming controls to appear for TesterB-answer validation",
  );
  if (!testerBIncoming.ok) {
    throw new Error(
      `TesterB incoming controls did not appear for TesterB-answer validation. Last state: ${JSON.stringify(testerBIncoming.lastResult)}`,
    );
  }
  console.log(
    describeSurface(
      "[Answer TesterB] TesterB incoming surface",
      testerBIncoming.lastResult.match,
    ),
  );

  const answerOnTesterB = await clickBrowserPageAction(
    testerBContext,
    testerBIncoming.lastResult.match.index,
    buildClickAnswerScript(),
  );
  if (!answerOnTesterB.clicked) {
    throw new Error("Failed to answer call on TesterB side");
  }
  console.log(`[Answer TesterB] Answered on TesterB: ${answerOnTesterB.label}`);

  const testerAActive = await waitForElectronSurface(
    electronApp,
    (state) => Boolean(state && (state.canHangUp || state.hasInCallControls)),
    timeoutMs,
    "TesterA in-call controls after TesterB answered",
  );
  if (!testerAActive.ok) {
    throw new Error(
      `TesterA did not show in-call controls after TesterB answered. Last state: ${JSON.stringify(testerAActive.lastResult)}`,
    );
  }
  console.log(
    describeSurface(
      "[Answer TesterB] TesterA active call surface",
      testerAActive.lastResult.match,
    ),
  );

  await exerciseMuteToggleCycles({
    electronApp,
    windowIndex: testerAActive.lastResult.match.index,
    timeoutMs,
    prefix: "[Answer TesterB] TesterA mute/unmute",
  });

  const testerBActive = await waitForBrowserSurface(
    testerBContext,
    (state) => Boolean(state && (state.canHangUp || state.hasInCallControls)),
    timeoutMs,
    "TesterB in-call controls after answering on TesterB",
  );
  if (!testerBActive.ok) {
    throw new Error(
      `TesterB did not transition to in-call controls after answering. Last state: ${JSON.stringify(testerBActive.lastResult)}`,
    );
  }
  console.log(
    describeSurface(
      "[Answer TesterB] TesterB active call surface",
      testerBActive.lastResult.match,
    ),
  );

  const hangupOnTesterA = await clickElectronWindowAction(
    electronApp,
    testerAActive.lastResult.match.index,
    buildClickHangupScript(),
  );
  if (!hangupOnTesterA.clicked) {
    throw new Error("Failed to hang up on TesterA side after TesterB answered");
  }
  console.log(
    `[Answer TesterB] Hung up on TesterA after TesterB answered: ${hangupOnTesterA.label}`,
  );

  const testerACleanup = await waitForTesterACleanup(
    electronApp,
    Math.max(timeoutMs, 15000),
    "TesterA main window cleanup after TesterA-side hangup in TesterB-answer flow",
  );
  if (!testerACleanup.ok) {
    throw new Error(
      `TesterA main window did not clear incoming-call cleanup state after TesterA hung up in TesterB-answer flow. Last state: ${JSON.stringify(testerACleanup.lastResult)}`,
    );
  }
  console.log(
    describeSurface(
      "[Answer TesterB] TesterA post-hangup main surface",
      testerACleanup.lastResult,
    ),
  );

  const testerBCleanup = await waitForBrowserNoCallSurface(
    testerBContext,
    Math.max(timeoutMs, 15000),
    "TesterB browser cleanup after TesterA hung up in the TesterB-answer flow",
  );
  if (!testerBCleanup.ok) {
    const testerBStatesAfter =
      await getBrowserCallSurfaceStates(testerBContext);
    const testerBStillActive = testerBStatesAfter.find(
      (entry) =>
        entry &&
        !entry.error &&
        entry.value &&
        (entry.value.canHangUp || entry.value.incomingVisible),
    );
    throw new Error(
      `TesterB still showed active/ringing call UI after TesterA hung up in the TesterB-answer flow. State: ${JSON.stringify(testerBStillActive)}`,
    );
  }

  await closeBrowserPagesMatching(testerBContext, (url) =>
    /\/groupcall\//i.test(String(url || "")),
  );
  await ensureElectronOnUrl(electronApp, testerAThreadUrl);
  await waitForElectronThreadReady(
    electronApp,
    timeoutMs,
    "TesterA thread to restore call controls after TesterB-answer hangup",
  );
}

async function runMessageTesterBToTesterA({
  electronApp,
  testerBPage,
  testerAHomeUrl,
  timeoutMs,
}) {
  console.log(
    "\n[Message] TesterB -> TesterA: sending normal message and checking notifications...",
  );

  const threadReady = await waitForThreadReady(
    testerBPage,
    timeoutMs,
    "TesterB thread to expose composer before message validation",
  );
  if (!threadReady.ok) {
    throw new Error(
      `TesterB thread not ready for message validation. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  await clearCapturedNotifications(electronApp);
  await ensureElectronOnUrl(electronApp, testerAHomeUrl);
  await wait(1200);

  const messageText = `codex message ${Date.now()}`;
  const sent = await testerBPage.evaluate(buildSendMessageScript(messageText));
  if (!sent.sent) {
    throw new Error("Failed to send normal message from TesterB session");
  }

  const result = await waitForNotificationPredicate(
    electronApp,
    (notifications) => notifications.length > 0,
    timeoutMs,
    "TesterA desktop notification after normal message",
  );

  const incomingCallNotification = result.notifications.find(
    (entry) =>
      /incoming call/i.test(String(entry.title || "")) ||
      /calling you on messenger/i.test(String(entry.body || "")),
  );
  if (incomingCallNotification) {
    throw new Error(
      `Normal message scenario produced an incoming-call notification: ${JSON.stringify(incomingCallNotification)}`,
    );
  }

  if (result.ok) {
    console.log(
      `[Message] Captured ${result.notifications.length} desktop notification(s) after normal message.`,
    );
  } else {
    console.log(
      "[Message] No desktop notification captured during timeout window; incoming-call false positive check still passed.",
    );
  }
}

async function runSyntheticGhostCallScenario({
  electronApp,
  timeoutMs,
  recovery = false,
}) {
  const label = recovery ? "Recovery" : "Ghost";
  console.log(
    `\n[${label}] Dispatching synthetic call-like notification with no call UI...`,
  );

  await clearCapturedNotifications(electronApp);

  if (recovery) {
    await evaluateInElectronPage(
      electronApp,
      `(() => {
        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('online'));
        return true;
      })();`,
    );
    await wait(300);
  }

  await evaluateInElectronPage(
    electronApp,
    `(() => {
      try {
        new Notification('Messenger', { body: 'Tester B is calling you' });
        return true;
      } catch (error) {
        return { error: String(error) };
      }
    })();`,
  );

  await wait(Math.min(timeoutMs, 4000));
  const notifications = await readCapturedNotifications(electronApp);
  const incomingCallNotification = notifications.find(
    (entry) =>
      /incoming call/i.test(String(entry.title || "")) ||
      /calling you on messenger/i.test(String(entry.body || "")),
  );
  if (incomingCallNotification) {
    throw new Error(
      `${label} scenario produced a ghost incoming-call notification: ${JSON.stringify(incomingCallNotification)}`,
    );
  }

  console.log(`[${label}] No incoming-call notification was captured.`);
}

async function runSyntheticWakeTopBarScenario({ electronApp, timeoutMs }) {
  console.log(
    "\n[WakeTopBar] Dispatching synthetic wake top bar with call-ish text but no call controls...",
  );

  await clearCapturedNotifications(electronApp);

  await evaluateInElectronPage(
    electronApp,
    `(() => {
      const existing = document.querySelector('[data-md-test="wake-top-bar-callish"]');
      if (existing) existing.remove();

      const banner = document.createElement('div');
      banner.setAttribute('data-md-test', 'wake-top-bar-callish');
      banner.setAttribute('role', 'banner');
      banner.setAttribute('aria-label', 'Incoming call notification preview');
      banner.textContent = 'Incoming call Account A messaged you';
      Object.assign(banner.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '320px',
        height: '56px',
        zIndex: '2147483647',
        background: '#fff',
        color: '#111',
        opacity: '1',
        pointerEvents: 'auto',
      });
      document.body.appendChild(banner);
      window.setTimeout(() => banner.remove(), 3000);
      return true;
    })();`,
  );

  await wait(Math.min(timeoutMs, 4500));
  const notifications = await readCapturedNotifications(electronApp);
  const incomingCallNotification = notifications.find(
    (entry) =>
      /incoming call/i.test(String(entry.title || "")) ||
      /calling you on messenger/i.test(String(entry.body || "")),
  );
  if (incomingCallNotification) {
    throw new Error(
      `Wake top-bar scenario produced a ghost incoming-call notification: ${JSON.stringify(incomingCallNotification)}`,
    );
  }

  console.log("[WakeTopBar] No incoming-call notification was captured.");
}

async function run() {
  const appEntry = path.join(__dirname, "../dist/main/main.js");
  if (!fs.existsSync(appEntry)) {
    throw new Error("dist/main/main.js not found. Run `npm run build` first.");
  }
  const executablePath = String(
    process.env.MESSENGER_EXECUTABLE_PATH || "",
  ).trim();
  if (executablePath && !fs.existsSync(executablePath)) {
    throw new Error(
      `MESSENGER_EXECUTABLE_PATH does not exist: ${executablePath}`,
    );
  }

  const mode = String(process.env.CALL_TEST_MODE || "both").toLowerCase();
  const timeoutMs = Number(process.env.CALL_TEST_TIMEOUT_MS || 30000);

  const threadUrl =
    process.env.CALL_THREAD_URL || "https://www.facebook.com/messages/";
  const testerAThreadUrl = process.env.TESTER_A_THREAD_URL || threadUrl;
  const testerBThreadUrl = process.env.TESTER_B_THREAD_URL || threadUrl;

  const testerBProfileDir =
    process.env.TESTER_B_PROFILE_DIR ||
    path.join(__dirname, "../.tmp/playwright-tester-b-profile");
  const opFacebookItem = String(process.env.OP_FACEBOOK_ITEM || "").trim();
  const opVault = process.env.OP_VAULT || "";
  const autoLoginTesterBWithOp =
    opFacebookItem.length > 0 &&
    String(process.env.TESTER_B_AUTOLOGIN_WITH_OP || "true").toLowerCase() !==
      "false";
  const testerBManualLoginTimeoutMs = Number(
    process.env.TESTER_B_MANUAL_LOGIN_TIMEOUT_MS || 180000,
  );

  let electronApp;
  let testerBContext;
  let testerBContextPageListener = null;

  try {
    console.log("\n🧪 Call flow GUI test (TesterB ↔ TesterA)\n");
    console.log(`Mode: ${mode}`);
    console.log(`TesterA URL: ${testerAThreadUrl}`);
    console.log(`TesterB URL: ${testerBThreadUrl}`);
    console.log(`TesterB profile: ${testerBProfileDir}`);
    console.log(
      `TesterB auto-login with 1Password: ${autoLoginTesterBWithOp ? `enabled (${opFacebookItem})` : "disabled"}`,
    );
    console.log(
      `TesterB manual-login fallback timeout: ${testerBManualLoginTimeoutMs}ms`,
    );

    const requestedModes = new Set(
      mode
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const hasMode = (value) => {
      if (requestedModes.has(value)) return true;
      if (requestedModes.has("both")) {
        return value === "incoming" || value === "outgoing";
      }
      if (requestedModes.has("full")) {
        return (
          value === "incoming" ||
          value === "outgoing" ||
          value === "message" ||
          value === "ghost" ||
          value === "recovery" ||
          value === "wake-top-bar"
        );
      }
      return false;
    };
    const requiresTesterB =
      hasMode("incoming") ||
      hasMode("outgoing") ||
      hasMode("message") ||
      hasMode("answer-tester-a") ||
      hasMode("answer-tester-b");

    const launchedElectron = await launchElectronAppWithRetries({
      executablePath,
      appEntry,
      timeoutMs,
    });
    electronApp = launchedElectron.electronApp;
    if (launchedElectron.attempt > 1) {
      console.log(
        `[Setup] Electron app launched successfully on attempt ${launchedElectron.attempt}.`,
      );
    }

    const testerAWindow = launchedElectron.testerAWindow;
    await testerAWindow.waitForLoadState("domcontentloaded").catch(() => {});
    await wait(2000);

    await ensureElectronOnUrl(electronApp, testerAThreadUrl);

    const testerAAuth = await isElectronAuthenticated(electronApp);
    let testerBPage = null;
    let testerBAuth = { authenticated: true, url: testerBThreadUrl };

    if (!testerAAuth.authenticated) {
      throw new Error(
        `TesterA app session is not authenticated. Current URL: ${testerAAuth.url}`,
      );
    }

    if (requiresTesterB) {
      fs.mkdirSync(testerBProfileDir, { recursive: true });

      testerBContext = await chromium.launchPersistentContext(
        testerBProfileDir,
        {
          headless: false,
          viewport: { width: 1440, height: 900 },
        },
      );

      testerBContextPageListener = (page) => {
        attachDialogLogging(
          page,
          `TesterB page ${testerBContext.pages().length}`,
        );
      };
      testerBContext.on("page", testerBContextPageListener);

      testerBPage =
        testerBContext.pages()[0] || (await testerBContext.newPage());
      for (const [index, page] of testerBContext.pages().entries()) {
        attachDialogLogging(page, `TesterB page ${index}`);
      }

      await testerBPage.goto(testerBThreadUrl, {
        waitUntil: "domcontentloaded",
      });
      await wait(1500);

      testerBAuth = await isBrowserAuthenticated(testerBPage);

      if (!testerBAuth.authenticated && autoLoginTesterBWithOp) {
        try {
          await attemptTesterBLoginWithOnePassword(testerBPage, {
            item: opFacebookItem,
            vault: opVault,
          });
        } catch (error) {
          console.log(
            `[Setup] TesterB 1Password auto-login did not complete: ${error?.message || error}`,
          );
        }
        testerBAuth = await isBrowserAuthenticated(testerBPage);
      }

      if (!testerBAuth.authenticated) {
        const manualOk = await waitForTesterBManualLogin(
          testerBPage,
          testerBManualLoginTimeoutMs,
        );
        if (manualOk) {
          testerBAuth = await isBrowserAuthenticated(testerBPage);
        }
      }

      if (!testerBAuth.authenticated) {
        throw new Error(
          `TesterB browser session is not authenticated. Current URL: ${testerBAuth.url}. ` +
            `Either pre-login this profile or keep manual login window open until authenticated.`,
        );
      }
    }

    console.log(
      requiresTesterB
        ? "[Setup] Both TesterA and TesterB sessions are authenticated."
        : "[Setup] TesterA session is authenticated. TesterB session not required for selected modes.",
    );

    if (hasMode("incoming")) {
      await runIncomingTesterBToTesterA({
        electronApp,
        testerBPage,
        timeoutMs,
      });
    }

    if (hasMode("outgoing")) {
      await runOutgoingTesterAToTesterB({
        electronApp,
        testerBPage,
        timeoutMs,
      });
    }

    if (hasMode("answer-tester-a")) {
      await runTesterBToTesterAAnsweredFlow({
        electronApp,
        testerBPage,
        testerAThreadUrl,
        timeoutMs,
      });
    }

    if (hasMode("answer-tester-b")) {
      await runTesterAToTesterBAnsweredFlow({
        electronApp,
        testerBPage,
        testerAThreadUrl,
        timeoutMs,
      });
    }

    if (hasMode("message")) {
      await runMessageTesterBToTesterA({
        electronApp,
        testerBPage,
        testerAHomeUrl: "https://www.facebook.com/messages/",
        timeoutMs,
      });
    }

    if (hasMode("ghost")) {
      await runSyntheticGhostCallScenario({
        electronApp,
        timeoutMs,
        recovery: false,
      });
    }

    if (hasMode("recovery")) {
      await runSyntheticGhostCallScenario({
        electronApp,
        timeoutMs,
        recovery: true,
      });
    }

    if (hasMode("wake-top-bar")) {
      await runSyntheticWakeTopBarScenario({
        electronApp,
        timeoutMs,
      });
    }

    console.log("\n✅ Call flow GUI test passed.");
  } finally {
    if (testerBContext) {
      if (testerBContextPageListener) {
        testerBContext.removeListener("page", testerBContextPageListener);
      }
      await closeBrowserContextPages(testerBContext);
      for (const page of testerBContext.pages()) {
        detachDialogLogging(page);
      }
      await testerBContext.close().catch(() => {});
    }
    if (electronApp) {
      await shutdownElectronApp(electronApp);
    }
  }
}

run().catch((error) => {
  console.error("\n❌ Call flow GUI test failed:", error?.message || error);
  process.exit(1);
});
