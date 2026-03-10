const { _electron: electron, chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INCOMING_ANSWER_SELECTORS = [
  '[aria-label*="Answer" i]',
  '[aria-label*="Accept" i]',
  '[aria-label*="Accept call" i]',
  '[aria-label*="Join call" i]',
  '[aria-label*="Accept video call" i]',
  '[aria-label*="Accept audio call" i]',
];

const INCOMING_DECLINE_SELECTORS = [
  '[aria-label*="Decline" i]',
  '[aria-label*="Ignore call" i]',
  '[aria-label*="Decline call" i]',
];

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
      if (!win) throw new Error('No main window available');
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
        const views = win.getBrowserViews();
        const wc = views.length > 0 ? views[0].webContents : win.webContents;
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

async function evaluateInElectronWindowByIndex(electronApp, index, scriptBody) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, { index: targetIndex, script }) => {
      const win = BrowserWindow.getAllWindows()[targetIndex];
      if (!win) {
        throw new Error(`No Electron window at index ${targetIndex}`);
      }
      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
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
    const url = window.location.href || '';
    const hasLoginForm = Boolean(
      document.querySelector('input[name="email"], input[name="pass"], #login_form, [data-testid="royal_login_form"]'),
    );
    return {
      url,
      authenticated: !/facebook\.com\/login/i.test(url) && !hasLoginForm,
    };
  });
}

function readOnePasswordFacebookCredentials({ item, vault }) {
  const escapedItem = JSON.stringify(String(item));
  const escapedVault = vault && String(vault).trim() ? JSON.stringify(String(vault).trim()) : '';

  const command = escapedVault
    ? `op signin >/dev/null && op item get ${escapedItem} --vault ${escapedVault} --format json`
    : `op signin >/dev/null && op item get ${escapedItem} --format json`;

  let output;
  try {
    output = execFileSync('/bin/bash', ['-lc', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail =
      (error && error.stderr && String(error.stderr).trim()) ||
      (error && error.message) ||
      'unknown 1Password CLI error';
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
    if (typeof field.value === 'string' && field.value.trim()) return field.value.trim();
    return undefined;
  };

  const username = pickFieldValue(
    (field) =>
      field.purpose === 'USERNAME' ||
      /user(name)?|email|login/i.test(`${field.label || ''} ${field.id || ''}`),
  );

  const password = pickFieldValue(
    (field) => field.purpose === 'PASSWORD' || /pass(word)?/i.test(`${field.label || ''} ${field.id || ''}`),
  );

  const otp = pickFieldValue(
    (field) => field.type === 'OTP' || /otp|one[- ]time|totp|2fa|auth/i.test(`${field.label || ''} ${field.id || ''}`),
  );

  if (!username || !password) {
    throw new Error(
      `1Password item \"${item}\" is missing username/password fields.`,
    );
  }

  return { username, password, otp };
}

async function attemptMichaelLoginWithOnePassword(page, { item, vault }) {
  console.log(`[Setup] Michael session unauthenticated, attempting 1Password login via item: ${item}`);

  const credentials = readOnePasswordFacebookCredentials({ item, vault });

  await page.goto('https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2Fmessages%2F', {
    waitUntil: 'domcontentloaded',
  });

  await page.locator('input[name="email"]').first().fill(credentials.username);
  await page.locator('input[name="pass"]').first().fill(credentials.password);

  let submitClicked = await page.evaluate(() => {
    const selectors = [
      'button[name="login"]',
      '#loginbutton',
      'button[type="submit"]',
      'input[name="login"]',
      'input[type="submit"]',
      '[role="button"][aria-label*="log in" i]',
      '[role="button"][aria-label*="login" i]',
    ];

    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    };

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      for (const el of candidates) {
        const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
        if (disabled || !isVisible(el)) continue;
        el.click();
        return true;
      }
    }

    const form = document.querySelector('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    }

    return false;
  });

  if (!submitClicked) {
    try {
      await page.locator('input[name="pass"]').first().press('Enter', { timeout: 1500 });
      submitClicked = true;
    } catch {
      // ignore
    }
  }

  if (!submitClicked) {
    throw new Error('Could not submit Facebook login form in Michael session.');
  }

  await page.waitForLoadState('domcontentloaded');
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
        'Facebook requested OTP but 1Password item has no OTP field configured.',
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

    await page.waitForLoadState('domcontentloaded');
    await wait(1500);
  }

  const authState = await isBrowserAuthenticated(page);
  if (!authState.authenticated) {
    throw new Error(
      `Michael 1Password login did not complete. Current URL: ${authState.url}`,
    );
  }

  console.log('[Setup] Michael login via 1Password succeeded.');
}

function attachDialogLogging(page, label) {
  if (!page || page.__mdDialogLoggingAttached) return;
  page.__mdDialogLoggingAttached = true;
  page.on('dialog', async (dialog) => {
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
  });
}

async function waitForMichaelManualLogin(page, timeoutMs) {
  const waitMs = Math.max(0, Number(timeoutMs || 0));
  if (waitMs <= 0) return false;

  console.log(
    `[Setup] Waiting up to ${waitMs}ms for manual Michael login completion (solve any checkpoint/2FA in browser window)...`,
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
    const hasVisible = (selectors) => {
      const all = Array.from(document.querySelectorAll(selectors.join(', ')));
      return all.some((el) => isVisible(el));
    };

    const answerSelectors = ${JSON.stringify(INCOMING_ANSWER_SELECTORS)};
    const declineSelectors = ${JSON.stringify(INCOMING_DECLINE_SELECTORS)};

    const hasAnswer = hasVisible(answerSelectors);
    const hasDecline = hasVisible(declineSelectors);

    return {
      hasAnswer,
      hasDecline,
      visible: hasAnswer && hasDecline,
      url: window.location.href,
    };
  })();`;
}

function buildCallSurfaceStateScript() {
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

async function verifyStableVisibility(checkFn, durationMs = 6000, intervalMs = 300) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    const visible = await checkFn();
    if (!visible) {
      return { ok: false, elapsedMs: Date.now() - startedAt };
    }
    await wait(intervalMs);
  }
  return { ok: true, elapsedMs: Date.now() - startedAt };
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

async function waitForNotificationPredicate(electronApp, predicate, timeoutMs, description) {
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
  const results = await evaluateInElectronWindows(electronApp, buildCallSurfaceStateScript());
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
          title: await page.title().catch(() => ''),
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

async function waitForElectronSurface(electronApp, predicate, timeoutMs, description) {
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

async function waitForPrimaryElectronSurface(electronApp, predicate, timeoutMs, description) {
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

async function waitForBrowserSurface(context, predicate, timeoutMs, description) {
  return waitFor(
    async () => {
      const states = await getBrowserCallSurfaceStates(context);
      const match = states.find((entry) => entry && !entry.error && predicate(entry.value));
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

async function clickElectronWindowAction(electronApp, windowIndex, scriptBody) {
  return evaluateInElectronWindowByIndex(electronApp, windowIndex, scriptBody);
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
  const location = entry.currentUrl || state.url || 'unknown';
  const labels = Array.isArray(state.visibleButtonLabels) ? state.visibleButtonLabels.slice(0, 8).join(' | ') : '';
  return `${prefix} window/page ${entry.index} @ ${location} incoming=${Boolean(state.incomingVisible)} inCall=${Boolean(state.hasInCallControls || state.canHangUp)} clean=${Boolean(state.incomingCallCleanClass)} topBarVisible=${Boolean(state.topBarChromeVisible)} labels=[${labels}]`;
}

function assertAlexIncomingTopBarState(entry) {
  const state = entry?.value || {};
  if (!state.incomingCallCleanClass) {
    throw new Error(
      `Alex incoming overlay did not apply the incoming-call clean class. State: ${JSON.stringify(state)}`,
    );
  }
  if (state.topBarChromeVisible) {
    throw new Error(
      `Alex incoming overlay still showed Facebook top-bar chrome. State: ${JSON.stringify(state)}`,
    );
  }
}

async function waitForAlexCleanup(electronApp, timeoutMs, description) {
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

async function runIncomingMichaelToAlex({ electronApp, michaelPage, timeoutMs }) {
  console.log('\n[Incoming] Michael -> Alex: triggering call from Michael web session...');

  const threadReady = await waitForThreadReady(
    michaelPage,
    timeoutMs,
    'Michael thread to expose call controls',
  );
  if (!threadReady.ok) {
    throw new Error(
      `Michael thread not ready for calling. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  const clickFromMichael = await michaelPage.evaluate(buildClickCallStartScript());
  if (!clickFromMichael.clicked) {
    throw new Error('Failed to click call start button in Michael session');
  }
  console.log(`[Incoming] Michael call button clicked: ${clickFromMichael.label}`);

  const incomingVisibleScript = buildIncomingVisibleScript();

  const appeared = await waitFor(
    async () => {
      const state = await evaluateInElectronPage(electronApp, incomingVisibleScript);
      return state.visible ? state : false;
    },
    timeoutMs,
    500,
    'Alex incoming call controls to appear',
  );

  if (!appeared.ok) {
    throw new Error('Incoming call controls did not appear in Alex app within timeout');
  }

  console.log(`[Incoming] Alex incoming controls detected after ${appeared.elapsedMs}ms`);

  const stable = await verifyStableVisibility(async () => {
    const state = await evaluateInElectronPage(electronApp, incomingVisibleScript);
    return Boolean(state && state.visible);
  }, 6000, 300);

  if (!stable.ok) {
    throw new Error(
      `Incoming call controls disappeared too early on Alex app (after ${stable.elapsedMs}ms)`,
    );
  }

  console.log('[Incoming] Alex incoming controls stayed visible for >= 6s (no 0.5s flicker)');

  const declineOnAlex = await evaluateInElectronPage(electronApp, buildClickDeclineScript());
  if (declineOnAlex.clicked) {
    console.log(`[Incoming] Declined call on Alex side: ${declineOnAlex.label || 'Decline'}`);
  }
}

async function runOutgoingAlexToMichael({ electronApp, michaelPage, timeoutMs }) {
  console.log('\n[Outgoing] Alex -> Michael: triggering call from Alex desktop app...');

  const threadReady = await waitForThreadReady(
    michaelPage,
    timeoutMs,
    'Michael thread to expose call controls before outgoing validation',
  );
  if (!threadReady.ok) {
    throw new Error(
      `Michael thread not ready for outgoing validation. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  const clickFromAlex = await evaluateInElectronPage(electronApp, buildClickCallStartScript());
  if (!clickFromAlex.clicked) {
    throw new Error('Failed to click call start button in Alex app');
  }
  console.log(`[Outgoing] Alex call button clicked: ${clickFromAlex.label}`);

  const appeared = await waitFor(
    async () => {
      const state = await michaelPage.evaluate(buildIncomingVisibleScript());
      return state.visible ? state : false;
    },
    timeoutMs,
    500,
    'Michael incoming call controls to appear',
  );

  if (!appeared.ok) {
    throw new Error('Incoming call controls did not appear in Michael session within timeout');
  }

  console.log(`[Outgoing] Michael incoming controls detected after ${appeared.elapsedMs}ms`);

  const declineOnMichael = await michaelPage.evaluate(buildClickDeclineScript());
  if (declineOnMichael.clicked) {
    console.log(`[Outgoing] Declined call on Michael side: ${declineOnMichael.label || 'Decline'}`);
  }
}

async function runMichaelToAlexAnsweredFlow({ electronApp, michaelPage, alexThreadUrl, timeoutMs }) {
  const michaelContext = michaelPage.context();

  console.log('\n[Answer Alex] Michael -> Alex: ring, answer on Alex, then hang up...');

  const threadReady = await waitForThreadReady(
    michaelPage,
    timeoutMs,
    'Michael thread to expose call controls before Alex-answer validation',
  );
  if (!threadReady.ok) {
    throw new Error(
      `Michael thread not ready before Alex-answer validation. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  const clickFromMichael = await michaelPage.evaluate(buildClickCallStartScript());
  if (!clickFromMichael.clicked) {
    throw new Error('Failed to click call start button in Michael session for Alex-answer flow');
  }
  console.log(`[Answer Alex] Michael call button clicked: ${clickFromMichael.label}`);

  const appeared = await waitForElectronSurface(
    electronApp,
    (state) => Boolean(state && state.incomingVisible),
    timeoutMs,
    'Alex incoming controls to appear for Alex-answer validation',
  );
  if (!appeared.ok) {
    throw new Error(
      `Alex incoming controls did not appear for Alex-answer validation. Last state: ${JSON.stringify(appeared.lastResult)}`,
    );
  }

  console.log(describeSurface('[Answer Alex] Alex incoming surface', appeared.lastResult.match));
  assertAlexIncomingTopBarState(appeared.lastResult.match);

  const answerOnAlex = await clickElectronWindowAction(
    electronApp,
    appeared.lastResult.match.index,
    buildClickAnswerScript(),
  );
  if (!answerOnAlex.clicked) {
    throw new Error('Failed to answer call on Alex side');
  }
  console.log(`[Answer Alex] Answered on Alex: ${answerOnAlex.label}`);

  const alexActive = await waitForElectronSurface(
    electronApp,
    (state) => Boolean(state && (state.canHangUp || state.hasInCallControls)),
    timeoutMs,
    'Alex in-call controls after answering on Alex',
  );
  if (!alexActive.ok) {
    throw new Error(
      `Alex did not transition to in-call controls after answering. Last state: ${JSON.stringify(alexActive.lastResult)}`,
    );
  }
  console.log(describeSurface('[Answer Alex] Alex active call surface', alexActive.lastResult.match));

  const michaelActive = await waitForBrowserSurface(
    michaelContext,
    (state) => Boolean(state && (state.canHangUp || state.hasInCallControls)),
    timeoutMs,
    'Michael in-call controls after Alex answered',
  );
  if (!michaelActive.ok) {
    throw new Error(
      `Michael did not show in-call controls after Alex answered. Last state: ${JSON.stringify(michaelActive.lastResult)}`,
    );
  }
  console.log(describeSurface('[Answer Alex] Michael active call surface', michaelActive.lastResult.match));

  const hangupOnAlex = await clickElectronWindowAction(
    electronApp,
    alexActive.lastResult.match.index,
    buildClickHangupScript(),
  );
  if (!hangupOnAlex.clicked) {
    throw new Error('Failed to hang up on Alex side after answering');
  }
  console.log(`[Answer Alex] Hung up on Alex: ${hangupOnAlex.label}`);

  const alexCleanup = await waitForAlexCleanup(
    electronApp,
    Math.max(timeoutMs, 15000),
    'Alex main window cleanup after Alex-side hangup',
  );
  if (!alexCleanup.ok) {
    throw new Error(
      `Alex main window did not clear incoming-call cleanup state after hangup. Last state: ${JSON.stringify(alexCleanup.lastResult)}`,
    );
  }
  console.log(describeSurface('[Answer Alex] Alex post-hangup main surface', alexCleanup.lastResult));

  await wait(1500);
  const michaelStatesAfter = await getBrowserCallSurfaceStates(michaelContext);
  const michaelStillActive = michaelStatesAfter.find(
    (entry) => entry && !entry.error && entry.value && (entry.value.canHangUp || entry.value.incomingVisible),
  );
  if (michaelStillActive) {
    throw new Error(
      `Michael still showed active/ringing call UI after Alex hung up. State: ${JSON.stringify(michaelStillActive)}`,
    );
  }

  await closeBrowserPagesMatching(michaelContext, (url) => /\/groupcall\//i.test(String(url || '')));
  await ensureElectronOnUrl(electronApp, alexThreadUrl);
  await waitForElectronThreadReady(
    electronApp,
    timeoutMs,
    'Alex thread to restore call controls after Alex-answer hangup',
  );
}

async function runAlexToMichaelAnsweredFlow({ electronApp, michaelPage, alexThreadUrl, timeoutMs }) {
  const michaelContext = michaelPage.context();

  console.log('\n[Answer Michael] Alex -> Michael: ring, answer on Michael, then hang up...');

  await ensureElectronOnUrl(electronApp, alexThreadUrl);
  const alexThreadReady = await waitForElectronThreadReady(
    electronApp,
    timeoutMs,
    'Alex thread to expose call controls before Michael-answer validation',
  );
  if (!alexThreadReady.ok) {
    throw new Error(
      `Alex thread not ready before Michael-answer validation. Last state: ${JSON.stringify(alexThreadReady.lastResult)}`,
    );
  }

  const threadReady = await waitForThreadReady(
    michaelPage,
    timeoutMs,
    'Michael thread to expose call controls before Michael-answer validation',
  );
  if (!threadReady.ok) {
    throw new Error(
      `Michael thread not ready before Michael-answer validation. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  const clickFromAlex = await evaluateInElectronPage(electronApp, buildClickCallStartScript());
  if (!clickFromAlex.clicked) {
    throw new Error('Failed to click call start button in Alex app for Michael-answer flow');
  }
  console.log(`[Answer Michael] Alex call button clicked: ${clickFromAlex.label}`);

  const michaelIncoming = await waitForBrowserSurface(
    michaelContext,
    (state) => Boolean(state && state.incomingVisible),
    timeoutMs,
    'Michael incoming controls to appear for Michael-answer validation',
  );
  if (!michaelIncoming.ok) {
    throw new Error(
      `Michael incoming controls did not appear for Michael-answer validation. Last state: ${JSON.stringify(michaelIncoming.lastResult)}`,
    );
  }
  console.log(describeSurface('[Answer Michael] Michael incoming surface', michaelIncoming.lastResult.match));

  const answerOnMichael = await clickBrowserPageAction(
    michaelContext,
    michaelIncoming.lastResult.match.index,
    buildClickAnswerScript(),
  );
  if (!answerOnMichael.clicked) {
    throw new Error('Failed to answer call on Michael side');
  }
  console.log(`[Answer Michael] Answered on Michael: ${answerOnMichael.label}`);

  const alexActive = await waitForElectronSurface(
    electronApp,
    (state) => Boolean(state && (state.canHangUp || state.hasInCallControls)),
    timeoutMs,
    'Alex in-call controls after Michael answered',
  );
  if (!alexActive.ok) {
    throw new Error(
      `Alex did not show in-call controls after Michael answered. Last state: ${JSON.stringify(alexActive.lastResult)}`,
    );
  }
  console.log(describeSurface('[Answer Michael] Alex active call surface', alexActive.lastResult.match));

  const michaelActive = await waitForBrowserSurface(
    michaelContext,
    (state) => Boolean(state && (state.canHangUp || state.hasInCallControls)),
    timeoutMs,
    'Michael in-call controls after answering on Michael',
  );
  if (!michaelActive.ok) {
    throw new Error(
      `Michael did not transition to in-call controls after answering. Last state: ${JSON.stringify(michaelActive.lastResult)}`,
    );
  }
  console.log(describeSurface('[Answer Michael] Michael active call surface', michaelActive.lastResult.match));

  const hangupOnAlex = await clickElectronWindowAction(
    electronApp,
    alexActive.lastResult.match.index,
    buildClickHangupScript(),
  );
  if (!hangupOnAlex.clicked) {
    throw new Error('Failed to hang up on Alex side after Michael answered');
  }
  console.log(
    `[Answer Michael] Hung up on Alex after Michael answered: ${hangupOnAlex.label}`,
  );

  const alexCleanup = await waitForAlexCleanup(
    electronApp,
    Math.max(timeoutMs, 15000),
    'Alex main window cleanup after Alex-side hangup in Michael-answer flow',
  );
  if (!alexCleanup.ok) {
    throw new Error(
      `Alex main window did not clear incoming-call cleanup state after Alex hung up in Michael-answer flow. Last state: ${JSON.stringify(alexCleanup.lastResult)}`,
    );
  }
  console.log(describeSurface('[Answer Michael] Alex post-hangup main surface', alexCleanup.lastResult));

  const michaelCleanup = await waitForBrowserNoCallSurface(
    michaelContext,
    Math.max(timeoutMs, 15000),
    'Michael browser cleanup after Alex hung up in the Michael-answer flow',
  );
  if (!michaelCleanup.ok) {
    const michaelStatesAfter = await getBrowserCallSurfaceStates(michaelContext);
    const michaelStillActive = michaelStatesAfter.find(
      (entry) =>
        entry && !entry.error && entry.value && (entry.value.canHangUp || entry.value.incomingVisible),
    );
    throw new Error(
      `Michael still showed active/ringing call UI after Alex hung up in the Michael-answer flow. State: ${JSON.stringify(michaelStillActive)}`,
    );
  }

  await closeBrowserPagesMatching(michaelContext, (url) => /\/groupcall\//i.test(String(url || '')));
  await ensureElectronOnUrl(electronApp, alexThreadUrl);
  await waitForElectronThreadReady(
    electronApp,
    timeoutMs,
    'Alex thread to restore call controls after Michael-answer hangup',
  );
}

async function runMessageMichaelToAlex({ electronApp, michaelPage, alexHomeUrl, timeoutMs }) {
  console.log('\n[Message] Michael -> Alex: sending normal message and checking notifications...');

  const threadReady = await waitForThreadReady(
    michaelPage,
    timeoutMs,
    'Michael thread to expose composer before message validation',
  );
  if (!threadReady.ok) {
    throw new Error(
      `Michael thread not ready for message validation. Last state: ${JSON.stringify(threadReady.lastResult)}`,
    );
  }

  await clearCapturedNotifications(electronApp);
  await ensureElectronOnUrl(electronApp, alexHomeUrl);
  await wait(1200);

  const messageText = `codex message ${Date.now()}`;
  const sent = await michaelPage.evaluate(buildSendMessageScript(messageText));
  if (!sent.sent) {
    throw new Error('Failed to send normal message from Michael session');
  }

  const result = await waitForNotificationPredicate(
    electronApp,
    (notifications) => notifications.length > 0,
    timeoutMs,
    'Alex desktop notification after normal message',
  );

  const incomingCallNotification = result.notifications.find((entry) =>
    /incoming call/i.test(String(entry.title || '')) ||
    /calling you on messenger/i.test(String(entry.body || '')),
  );
  if (incomingCallNotification) {
    throw new Error(
      `Normal message scenario produced an incoming-call notification: ${JSON.stringify(incomingCallNotification)}`,
    );
  }

  if (result.ok) {
    console.log(`[Message] Captured ${result.notifications.length} desktop notification(s) after normal message.`);
  } else {
    console.log('[Message] No desktop notification captured during timeout window; incoming-call false positive check still passed.');
  }
}

async function runSyntheticGhostCallScenario({ electronApp, timeoutMs, recovery = false }) {
  const label = recovery ? 'Recovery' : 'Ghost';
  console.log(`\n[${label}] Dispatching synthetic call-like notification with no call UI...`);

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
        new Notification('Messenger', { body: 'Michael Potenza is calling you' });
        return true;
      } catch (error) {
        return { error: String(error) };
      }
    })();`,
  );

  await wait(Math.min(timeoutMs, 4000));
  const notifications = await readCapturedNotifications(electronApp);
  const incomingCallNotification = notifications.find((entry) =>
    /incoming call/i.test(String(entry.title || '')) ||
    /calling you on messenger/i.test(String(entry.body || '')),
  );
  if (incomingCallNotification) {
    throw new Error(
      `${label} scenario produced a ghost incoming-call notification: ${JSON.stringify(incomingCallNotification)}`,
    );
  }

  console.log(`[${label}] No incoming-call notification was captured.`);
}

async function run() {
  const appEntry = path.join(__dirname, '../dist/main/main.js');
  if (!fs.existsSync(appEntry)) {
    throw new Error('dist/main/main.js not found. Run `npm run build` first.');
  }

  const mode = String(process.env.CALL_TEST_MODE || 'both').toLowerCase();
  const timeoutMs = Number(process.env.CALL_TEST_TIMEOUT_MS || 30000);

  const threadUrl = process.env.CALL_THREAD_URL || 'https://www.facebook.com/messages/';
  const alexThreadUrl = process.env.ALEX_THREAD_URL || threadUrl;
  const michaelThreadUrl = process.env.MICHAEL_THREAD_URL || threadUrl;

  const michaelProfileDir =
    process.env.MICHAEL_PROFILE_DIR ||
    path.join(__dirname, '../.tmp/playwright-michael-profile');
  const opFacebookItem = String(process.env.OP_FACEBOOK_ITEM || 'Dad Facebook');
  const opVault = process.env.OP_VAULT || '';
  const autoLoginMichaelWithOp =
    String(process.env.MICHAEL_AUTOLOGIN_WITH_OP || 'true').toLowerCase() !== 'false';
  const michaelManualLoginTimeoutMs = Number(
    process.env.MICHAEL_MANUAL_LOGIN_TIMEOUT_MS || 180000,
  );

  let electronApp;
  let michaelContext;

  try {
    console.log('\n🧪 Call flow GUI test (Michael ↔ Alex)\n');
    console.log(`Mode: ${mode}`);
    console.log(`Alex URL: ${alexThreadUrl}`);
    console.log(`Michael URL: ${michaelThreadUrl}`);
    console.log(`Michael profile: ${michaelProfileDir}`);
    console.log(
      `Michael auto-login with 1Password: ${autoLoginMichaelWithOp ? `enabled (${opFacebookItem})` : 'disabled'}`,
    );
    console.log(`Michael manual-login fallback timeout: ${michaelManualLoginTimeoutMs}ms`);

    const requestedModes = new Set(
      mode
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const hasMode = (value) => {
      if (requestedModes.has(value)) return true;
      if (requestedModes.has('both')) {
        return value === 'incoming' || value === 'outgoing';
      }
      if (requestedModes.has('full')) {
        return (
          value === 'incoming' ||
          value === 'outgoing' ||
          value === 'message' ||
          value === 'ghost' ||
          value === 'recovery'
        );
      }
      return false;
    };
    const requiresMichael =
      hasMode('incoming') ||
      hasMode('outgoing') ||
      hasMode('message') ||
      hasMode('answer-alex') ||
      hasMode('answer-michael');

    electronApp = await electron.launch({
      args: [appEntry],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        MESSENGER_TEST_CAPTURE_NOTIFICATIONS: '1',
      },
    });

    await wait(4000);

    await ensureElectronOnUrl(electronApp, alexThreadUrl);

    const alexAuth = await isElectronAuthenticated(electronApp);
    let michaelPage = null;
    let michaelAuth = { authenticated: true, url: michaelThreadUrl };

    if (!alexAuth.authenticated) {
      throw new Error(`Alex app session is not authenticated. Current URL: ${alexAuth.url}`);
    }

    if (requiresMichael) {
      fs.mkdirSync(michaelProfileDir, { recursive: true });

      michaelContext = await chromium.launchPersistentContext(michaelProfileDir, {
        headless: false,
        viewport: { width: 1440, height: 900 },
      });

      michaelContext.on('page', (page) => {
        attachDialogLogging(page, `Michael page ${michaelContext.pages().length}`);
      });

      michaelPage = michaelContext.pages()[0] || (await michaelContext.newPage());
      for (const [index, page] of michaelContext.pages().entries()) {
        attachDialogLogging(page, `Michael page ${index}`);
      }

      await michaelPage.goto(michaelThreadUrl, { waitUntil: 'domcontentloaded' });
      await wait(1500);

      michaelAuth = await isBrowserAuthenticated(michaelPage);

      if (!michaelAuth.authenticated && autoLoginMichaelWithOp) {
        try {
          await attemptMichaelLoginWithOnePassword(michaelPage, {
            item: opFacebookItem,
            vault: opVault,
          });
        } catch (error) {
          console.log(
            `[Setup] Michael 1Password auto-login did not complete: ${error?.message || error}`,
          );
        }
        michaelAuth = await isBrowserAuthenticated(michaelPage);
      }

      if (!michaelAuth.authenticated) {
        const manualOk = await waitForMichaelManualLogin(
          michaelPage,
          michaelManualLoginTimeoutMs,
        );
        if (manualOk) {
          michaelAuth = await isBrowserAuthenticated(michaelPage);
        }
      }

      if (!michaelAuth.authenticated) {
        throw new Error(
          `Michael browser session is not authenticated. Current URL: ${michaelAuth.url}. ` +
            `Either pre-login this profile or keep manual login window open until authenticated.`,
        );
      }
    }

    console.log(
      requiresMichael
        ? '[Setup] Both Alex and Michael sessions are authenticated.'
        : '[Setup] Alex session is authenticated. Michael session not required for selected modes.',
    );

    if (hasMode('incoming')) {
      await runIncomingMichaelToAlex({ electronApp, michaelPage, timeoutMs });
    }

    if (hasMode('outgoing')) {
      await runOutgoingAlexToMichael({ electronApp, michaelPage, timeoutMs });
    }

    if (hasMode('answer-alex')) {
      await runMichaelToAlexAnsweredFlow({
        electronApp,
        michaelPage,
        alexThreadUrl,
        timeoutMs,
      });
    }

    if (hasMode('answer-michael')) {
      await runAlexToMichaelAnsweredFlow({
        electronApp,
        michaelPage,
        alexThreadUrl,
        timeoutMs,
      });
    }

    if (hasMode('message')) {
      await runMessageMichaelToAlex({
        electronApp,
        michaelPage,
        alexHomeUrl: 'https://www.facebook.com/messages/',
        timeoutMs,
      });
    }

    if (hasMode('ghost')) {
      await runSyntheticGhostCallScenario({ electronApp, timeoutMs, recovery: false });
    }

    if (hasMode('recovery')) {
      await runSyntheticGhostCallScenario({ electronApp, timeoutMs, recovery: true });
    }

    console.log('\n✅ Call flow GUI test passed.');
  } finally {
    if (michaelContext) {
      await michaelContext.close().catch(() => {});
    }
    if (electronApp) {
      await electronApp.close().catch(() => {});
    }
  }
}

run().catch((error) => {
  console.error('\n❌ Call flow GUI test failed:', error?.message || error);
  process.exit(1);
});
